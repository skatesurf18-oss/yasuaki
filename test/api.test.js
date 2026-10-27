'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

let app, base, dataDir;
// 1x1 の JPEG
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* CSV など */ }
    return { status: res.status, data };
  };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nippo-test-'));
  process.env.ADMIN_PASSWORD = 'adminpass';
  app = createApp({ dataDir });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('日報の一連の流れ', async () => {
  const admin = client();
  assert.equal((await admin('GET', '/api/me')).status, 401);
  assert.equal((await admin('POST', '/api/login', { login_id: 'admin', password: 'x' })).status, 401);
  assert.equal((await admin('POST', '/api/login', { login_id: 'admin', password: 'adminpass' })).status, 200);

  // 社員登録
  const u1 = await admin('POST', '/api/admin/users', { login_id: 'furusawa', name: '古澤 泰明', password: 'pass1234' });
  assert.equal(u1.status, 200);
  await admin('POST', '/api/admin/users', { login_id: 'furukawara', name: '古川原 賢太郎', password: 'pass1234' });
  assert.equal((await admin('POST', '/api/admin/users', { login_id: 'furusawa', name: 'x', password: 'pass1234' })).status, 409);

  const a = client();
  const b = client();
  await a('POST', '/api/login', { login_id: 'furusawa', password: 'pass1234' });
  await b('POST', '/api/login', { login_id: 'furukawara', password: 'pass1234' });

  const items = (await a('GET', '/api/kpi-items')).data;
  assert.ok(items.length >= 3);
  const reform = items[0].id;

  // 月目標
  assert.equal((await a('PUT', '/api/kpi/targets', { month: '2026-10', targets: { [reform]: 4 } })).status, 200);
  assert.equal((await a('PUT', '/api/kpi/targets', { month: '2026-10', user_id: 3, targets: { [reform]: 4 } })).status, 403);

  // 1日目の日報
  const r1 = await a('POST', '/api/reports', {
    report_date: '2026-10-27', todo: '後藤さんアポイント\n群馬銀行面談', done: '群馬銀行面談→完了',
    next_schedule: '青木さん配管工事後埋め戻し\n石井さんトイレ工事',
    clock_in: '07:30', clock_out: '18:30', break_time: '01:00', kpi: { [reform]: 1 }, images: [JPEG],
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal((await a('POST', '/api/reports', { report_date: '2026-10-27' })).status, 409);
  assert.equal((await a('POST', '/api/reports', { report_date: '2026-10-29', clock_in: '25:00' })).status, 400);
  assert.equal((await a('POST', '/api/reports', { report_date: '2026-10-29', images: ['data:image/jpeg;base64,AAAA'] })).status, 400);

  // 翌日の下書きは前日の「翌出社日のスケジュール」を引き継ぐ
  const draft = (await a('GET', '/api/reports/draft?date=2026-10-28')).data;
  assert.equal(draft.todo, '青木さん配管工事後埋め戻し\n石井さんトイレ工事');
  assert.equal(draft.clock_in, '07:30');
  assert.equal((await a('GET', '/api/reports/draft?date=2026-10-27')).data.existing_id, r1.data.id);

  const r2 = await a('POST', '/api/reports', { report_date: '2026-10-28', todo: draft.todo, kpi: { [reform]: 2 } });
  assert.equal(r2.status, 200);

  // 累計・達成率
  const detail = (await b('GET', `/api/reports/${r2.data.id}`)).data;
  const k = detail.kpi.find((x) => x.item_id === reform);
  assert.deepEqual([k.actual, k.cumulative, k.target, k.rate], [2, 3, 4, 75]);
  assert.equal(detail.is_read, false);
  assert.equal(detail.can_edit, false);

  // 未読 → 開封
  assert.equal((await b('GET', '/api/unread')).data.reports, 2);
  await b('POST', `/api/reports/${r2.data.id}/read`);
  assert.equal((await b('GET', '/api/unread')).data.reports, 1);
  const unreadList = (await b('GET', '/api/reports?unread=1')).data.reports;
  assert.deepEqual(unreadList.map((r) => r.id), [r1.data.id]);

  // いいね・スタンプ・コメント・通知
  const liked = (await b('POST', `/api/reports/${r1.data.id}/reactions`, { kind: 'like' })).data;
  assert.equal(liked.reactions[0].count, 1);
  assert.equal(liked.is_read, true);
  assert.equal((await b('POST', `/api/reports/${r1.data.id}/reactions`, { kind: '<script>' })).status, 400);
  await b('POST', `/api/reports/${r1.data.id}/comments`, { body: '荒居さんの件、見積り出しましょう' });
  const notif = (await a('GET', '/api/unread')).data.notifications;
  assert.equal(notif, 2);
  const list = (await a('GET', '/api/notifications')).data;
  assert.equal(list[0].type, 'comment');
  const readerNames = (await a('GET', `/api/reports/${r1.data.id}`)).data.readers.map((u) => u.name);
  assert.deepEqual(readerNames, ['古川原 賢太郎']);

  // 他人の日報は編集不可、本人は編集可（写真削除含む）
  assert.equal((await b('PUT', `/api/reports/${r1.data.id}`, { done: 'x' })).status, 403);
  const att = (await a('GET', `/api/reports/${r1.data.id}`)).data.attachments;
  assert.equal(att.length, 1);
  assert.equal((await fetch(base + att[0].url)).status, 401);
  assert.equal((await a('PUT', `/api/reports/${r1.data.id}`, { done: '修正', remove_attachments: [att[0].id] })).status, 200);
  assert.equal((await a('GET', `/api/reports/${r1.data.id}`)).data.attachments.length, 0);

  // 検索
  const found = (await b('GET', '/api/reports?q=' + encodeURIComponent('修正'))).data.reports;
  assert.deepEqual(found.map((r) => r.id), [r1.data.id]);
  assert.equal((await b('GET', '/api/reports?q=%25')).data.reports.length, 0);

  // 集計・CSV
  const sum = (await b('GET', '/api/kpi/summary?month=2026-10')).data;
  const row = sum.rows.find((r) => r.user.name === '古澤 泰明');
  assert.equal(row.cells.find((c) => c.item_id === reform).actual, 3);
  const csv = await b('GET', '/api/reports/export?month=2026-10');
  assert.match(csv.data, /古澤 泰明/);

  // 管理者以外は管理APIを使えない
  assert.equal((await b('GET', '/api/admin/users')).status, 403);
  // 最後の管理者は降格できない
  assert.equal((await admin('PUT', '/api/admin/users/1', { role: 'member' })).status, 400);
  // 利用停止したユーザーはログアウトされる
  await admin('PUT', '/api/admin/users/3', { active: false });
  assert.equal((await b('GET', '/api/me')).status, 401);

  // 削除
  assert.equal((await a('DELETE', `/api/reports/${r2.data.id}`)).status, 200);
  assert.equal((await a('GET', `/api/reports/${r2.data.id}`)).status, 404);
});

test('静的ファイルとパス制限', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404);
  assert.equal((await fetch(base + '/uploads/../nippo.db')).status, 404);
});
