'use strict';
// 関東燃料 社内専用 業務日報アプリ — サーバー本体
// 依存パッケージなし（Node.js 22.5 以上の標準機能のみで動作します）
process.env.TZ = process.env.TZ || 'Asia/Tokyo';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open, hashPassword, verifyPassword } = require('./lib/db');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;
const MAX_BODY = 40 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_TEXT = 5000;
const TEXT_FIELDS = ['todo', 'done', 'review', 'shared', 'consult', 'resolve', 'next_schedule'];
const TIME_FIELDS = ['clock_in', 'clock_out', 'break_time'];
const STAMPS = ['👍', '👏', '🙏', '😊', '💪', '🎉', '😢', '🔥'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const now = () => new Date().toISOString();
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const isTime = (s) => s === '' || (typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
const isColor = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function createApp({ dataDir }) {
  const { db, initialAdmin } = open(dataDir);
  const uploadDir = path.join(dataDir, 'uploads');
  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  // ---------- 認証 ----------
  const loginFailures = new Map();
  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function currentUser(req) {
    const token = parseCookies(req).sid;
    if (!token) return null;
    const row = q(`SELECT u.id, u.login_id, u.name, u.role, u.color, u.created_at, s.expires_at
                   FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token = ? AND u.active = 1`).get(token);
    if (!row || row.expires_at < now()) return null;
    return row;
  }
  function sessionCookie(req, token, maxAge) {
    const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
    return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  // ---------- 日報データの組み立て ----------
  const stmt = {
    user: q('SELECT id, name, color FROM users WHERE id = ?'),
    kpi: q(`SELECT e.item_id, e.actual, e.amount, e.note, i.name, i.unit FROM kpi_entries e JOIN kpi_items i ON i.id = e.item_id
            WHERE e.report_id = ? ORDER BY i.sort, i.id`),
    target: q('SELECT target FROM kpi_targets WHERE user_id = ? AND item_id = ? AND month = ?'),
    cumulative: q(`SELECT COALESCE(SUM(e.actual), 0) AS total, COALESCE(SUM(e.amount), 0) AS amount FROM kpi_entries e JOIN reports r ON r.id = e.report_id
                   WHERE r.user_id = ? AND e.item_id = ? AND r.report_date >= ? AND r.report_date <= ?`),
    attachments: q('SELECT id, filename FROM attachments WHERE report_id = ? ORDER BY id'),
    readers: q(`SELECT u.id, u.name, u.color FROM reads x JOIN users u ON u.id = x.user_id
                WHERE x.report_id = ? AND x.user_id <> ? ORDER BY x.read_at`),
    reactions: q(`SELECT x.kind, x.user_id, u.name FROM reactions x JOIN users u ON u.id = x.user_id
                  WHERE x.report_id = ? ORDER BY x.created_at`),
    commentCount: q('SELECT COUNT(*) AS n FROM comments WHERE report_id = ?'),
    isRead: q('SELECT 1 FROM reads WHERE report_id = ? AND user_id = ?'),
  };

  function hydrate(r, me) {
    const month = r.report_date.slice(0, 7);
    const kpi = stmt.kpi.all(r.id).map((k) => {
      const t = stmt.target.get(r.user_id, k.item_id, month);
      const target = t ? t.target : 0;
      const cum = stmt.cumulative.get(r.user_id, k.item_id, `${month}-01`, r.report_date);
      const cumulative = cum.total;
      return {
        item_id: k.item_id, name: k.name, unit: k.unit, actual: k.actual, target, cumulative,
        amount: k.amount, cumulative_amount: cum.amount, note: k.note,
        rate: target > 0 ? Math.round((cumulative / target) * 1000) / 10 : null,
      };
    }).filter((k) => k.actual || k.target || k.cumulative || k.amount || k.note); // 空の項目は表示しない
    const reactions = {};
    for (const x of stmt.reactions.all(r.id)) {
      const g = (reactions[x.kind] ||= { kind: x.kind, count: 0, mine: false, users: [] });
      g.count++; g.users.push(x.name);
      if (x.user_id === me.id) g.mine = true;
    }
    return {
      ...r,
      user: stmt.user.get(r.user_id),
      kpi,
      attachments: stmt.attachments.all(r.id).map((a) => ({ id: a.id, url: `/uploads/${a.filename}` })),
      readers: stmt.readers.all(r.id, r.user_id),
      reactions: Object.values(reactions),
      comment_count: stmt.commentCount.get(r.id).n,
      is_read: r.user_id === me.id || !!stmt.isRead.get(r.id, me.id),
      edited: Date.parse(r.updated_at) - Date.parse(r.created_at) > 60_000,
      can_edit: r.user_id === me.id || me.role === 'admin',
    };
  }

  function getReport(id) {
    const r = q('SELECT * FROM reports WHERE id = ?').get(Number(id));
    if (!r) throw new HttpError(404, '日報が見つかりません');
    return r;
  }

  function saveImages(reportId, images) {
    if (!Array.isArray(images) || images.length === 0) return;
    const count = q('SELECT COUNT(*) AS n FROM attachments WHERE report_id = ?').get(reportId).n;
    if (count + images.length > MAX_ATTACHMENTS) throw new HttpError(400, `写真は1件の日報につき${MAX_ATTACHMENTS}枚までです`);
    for (const dataUrl of images) {
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
      if (!m) throw new HttpError(400, '写真の形式に対応していません（JPEG / PNG / WebP）');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(400, '写真のサイズが大きすぎます');
      const ok = (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8) ||
        (m[1] === 'png' && buf.subarray(0, 4).toString('hex') === '89504e47') ||
        (m[1] === 'webp' && buf.subarray(8, 12).toString() === 'WEBP');
      if (!ok) throw new HttpError(400, '写真データが正しくありません');
      const filename = `${crypto.randomBytes(16).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
      fs.writeFileSync(path.join(uploadDir, filename), buf);
      q('INSERT INTO attachments (report_id, filename, created_at) VALUES (?, ?, ?)').run(reportId, filename, now());
    }
  }

  function removeAttachments(reportId, ids) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      const a = q('SELECT filename FROM attachments WHERE id = ? AND report_id = ?').get(Number(id), reportId);
      if (!a) continue;
      q('DELETE FROM attachments WHERE id = ?').run(Number(id));
      fs.rmSync(path.join(uploadDir, a.filename), { force: true });
    }
  }

  function validateReport(body) {
    const out = {};
    for (const f of TEXT_FIELDS) {
      const v = body[f] == null ? '' : String(body[f]);
      if (v.length > MAX_TEXT) throw new HttpError(400, `入力が長すぎます（${MAX_TEXT}文字まで）`);
      out[f] = v.replace(/\r\n/g, '\n').trimEnd();
    }
    for (const f of TIME_FIELDS) {
      const v = body[f] == null ? '' : String(body[f]);
      if (!isTime(v)) throw new HttpError(400, '時刻は「07:30」の形式で入力してください');
      out[f] = v;
    }
    return out;
  }

  function saveKpi(reportId, kpi) {
    if (!kpi || typeof kpi !== 'object') return;
    q('DELETE FROM kpi_entries WHERE report_id = ?').run(reportId);
    const ins = q('INSERT INTO kpi_entries (report_id, item_id, actual, amount, note) VALUES (?, ?, ?, ?, ?)');
    for (const [itemId, val] of Object.entries(kpi)) {
      if (!q('SELECT 1 FROM kpi_items WHERE id = ?').get(Number(itemId))) continue;
      // 数値だけ（件数）でも、{ actual, amount, note } でも受け付ける
      const v = val !== null && typeof val === 'object' ? val : { actual: val };
      const n = Number(v.actual || 0);
      const amount = Number(v.amount || 0);
      const note = v.note == null ? '' : String(v.note).replace(/\r\n/g, '\n').trim();
      if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new HttpError(400, 'KPIの件数は0以上の数値で入力してください');
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new HttpError(400, 'KPIの金額は0以上の数値で入力してください');
      if (note.length > 2000) throw new HttpError(400, 'KPIの内容は2000文字までです');
      ins.run(reportId, Number(itemId), n, amount, note);
    }
  }

  function notify(userId, actorId, reportId, type, detail = '') {
    if (userId === actorId) return;
    q('INSERT INTO notifications (user_id, actor_id, report_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, actorId, reportId, type, detail, now());
  }

  function csv(rows) {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
  }

  function requireAdmin(me) {
    if (me.role !== 'admin') throw new HttpError(403, '管理者のみ操作できます');
  }

  // ---------- API ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  };

  route('POST', '/api/login', ({ req, body }) => {
    // クラウド（Render など）では全員が同じ中継サーバー経由になるため、中継サーバーが付けた接続元を使う
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const ip = (process.env.TRUST_PROXY === '1' && forwarded.length ? forwarded[forwarded.length - 1] : req.socket.remoteAddress) || '';
    const f = loginFailures.get(ip);
    if (f && f.count >= 10 && Date.now() - f.at < 15 * 60_000) {
      throw new HttpError(429, 'ログインの失敗が続いたため、しばらく時間をおいてお試しください');
    }
    const u = q('SELECT * FROM users WHERE login_id = ? AND active = 1').get(String(body.login_id || '').trim());
    if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) {
      loginFailures.set(ip, { count: (f && Date.now() - f.at < 15 * 60_000 ? f.count : 0) + 1, at: Date.now() });
      throw new HttpError(401, 'ログインIDまたはパスワードが違います');
    }
    loginFailures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    q('DELETE FROM sessions WHERE expires_at < ?').run(now());
    q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, u.id, expires);
    return { headers: { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) }, body: { ok: true } };
  }, { auth: false });

  route('POST', '/api/logout', ({ req }) => {
    const token = parseCookies(req).sid;
    if (token) q('DELETE FROM sessions WHERE token = ?').run(token);
    return { headers: { 'Set-Cookie': sessionCookie(req, '', 0) }, body: { ok: true } };
  }, { auth: false });

  route('GET', '/api/me', ({ me }) => ({
    user: { id: me.id, login_id: me.login_id, name: me.name, role: me.role, color: me.color },
    today: todayStr(),
    stamps: STAMPS,
  }));

  route('POST', '/api/me/password', ({ me, body }) => {
    const u = q('SELECT password_hash FROM users WHERE id = ?').get(me.id);
    if (!verifyPassword(String(body.current || ''), u.password_hash)) throw new HttpError(400, '現在のパスワードが違います');
    if (String(body.next || '').length < 6) throw new HttpError(400, '新しいパスワードは6文字以上にしてください');
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.next)), me.id);
    return { ok: true };
  });

  // 会社名・ロゴ（ログイン前の画面でも使うため認証不要）
  const getSetting = (k) => { const row = q('SELECT value FROM settings WHERE key = ?').get(k); return row ? row.value : null; };
  route('GET', '/api/settings', () => ({ company_name: getSetting('company_name') || '関東燃料', logo: getSetting('logo') }), { auth: false });

  route('PUT', '/api/admin/settings', ({ me, body }) => {
    requireAdmin(me);
    const set = q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
    if (body.company_name != null) {
      const name = String(body.company_name).trim();
      if (!name || name.length > 40) throw new HttpError(400, '会社名は1〜40文字で入力してください');
      set.run('company_name', name);
    }
    if (body.logo === null) q("DELETE FROM settings WHERE key = 'logo'").run();
    else if (body.logo != null) {
      const logo = String(body.logo);
      if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw new HttpError(400, 'ロゴは PNG / JPEG / WebP / SVG の画像にしてください');
      if (logo.length > 700_000) throw new HttpError(400, 'ロゴ画像が大きすぎます（500KBまで）');
      set.run('logo', logo);
    }
    return { ok: true };
  });

  route('GET', '/api/users', () =>
    q('SELECT id, name, color, role FROM users WHERE active = 1 ORDER BY id').all());

  route('GET', '/api/kpi-items', () =>
    q('SELECT id, name, unit, sort, active FROM kpi_items WHERE active = 1 ORDER BY sort, id').all());

  route('GET', '/api/reports', ({ me, query }) => {
    const where = [];
    const args = [];
    if (query.user_id) { where.push('r.user_id = ?'); args.push(Number(query.user_id)); }
    if (isDate(query.from)) { where.push('r.report_date >= ?'); args.push(query.from); }
    if (isDate(query.to)) { where.push('r.report_date <= ?'); args.push(query.to); }
    if (query.q) {
      const like = `%${String(query.q).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      where.push('(' + TEXT_FIELDS.map((f) => `r.${f} LIKE ? ESCAPE '\\'`).join(' OR ') +
        ` OR u.name LIKE ? ESCAPE '\\')`);
      args.push(...TEXT_FIELDS.map(() => like), like);
    }
    if (query.unread === '1') {
      where.push('r.user_id <> ? AND r.created_at >= ? AND NOT EXISTS (SELECT 1 FROM reads x WHERE x.report_id = r.id AND x.user_id = ?)');
      args.push(me.id, me.created_at, me.id);
    }
    if (isDate(query.before_date) && query.before_id) {
      where.push('(r.report_date < ? OR (r.report_date = ? AND r.id < ?))');
      args.push(query.before_date, query.before_date, Number(query.before_id));
    }
    const limit = Math.min(Math.max(Number(query.limit) || 15, 1), 50);
    const rows = q(`SELECT r.* FROM reports r JOIN users u ON u.id = r.user_id
                    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                    ORDER BY r.report_date DESC, r.id DESC LIMIT ${limit + 1}`).all(...args);
    return { reports: rows.slice(0, limit).map((r) => hydrate(r, me)), has_more: rows.length > limit };
  });

  route('GET', '/api/unread', ({ me }) => {
    const row = q(`SELECT COUNT(*) AS n FROM reports r
                   WHERE r.user_id <> ? AND r.created_at >= ?
                   AND NOT EXISTS (SELECT 1 FROM reads x WHERE x.report_id = r.id AND x.user_id = ?)`)
      .get(me.id, me.created_at, me.id);
    const notif = q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND seen = 0').get(me.id);
    return { reports: row.n, notifications: notif.n };
  });

  route('POST', '/api/reports/read-all', ({ me }) => {
    q(`INSERT OR IGNORE INTO reads (report_id, user_id, read_at)
       SELECT id, ?, ? FROM reports WHERE user_id <> ?`).run(me.id, now(), me.id);
    return { ok: true };
  });

  // 新規作成フォームの初期値（前回の「翌出社日のスケジュール」を「今日やるべきこと」へ自動で引き継ぎ）
  route('GET', '/api/reports/draft', ({ me, query }) => {
    const date = isDate(query.date) ? query.date : todayStr();
    const existing = q('SELECT id FROM reports WHERE user_id = ? AND report_date = ?').get(me.id, date);
    if (existing) return { existing_id: existing.id };
    const prev = q('SELECT * FROM reports WHERE user_id = ? AND report_date < ? ORDER BY report_date DESC LIMIT 1').get(me.id, date);
    return {
      report_date: date,
      todo: prev ? prev.next_schedule : '',
      clock_in: prev ? prev.clock_in : '',
      clock_out: prev ? prev.clock_out : '',
      break_time: prev ? prev.break_time : '01:00',
      from_date: prev ? prev.report_date : null,
    };
  });

  route('GET', '/api/reports/export', ({ me, query }) => {
    if (!isMonth(query.month)) throw new HttpError(400, '月を指定してください');
    const items = q('SELECT id, name FROM kpi_items ORDER BY sort, id').all();
    const rows = q(`SELECT r.*, u.name AS user_name FROM reports r JOIN users u ON u.id = r.user_id
                    WHERE substr(r.report_date, 1, 7) = ? ORDER BY r.report_date, u.id`).all(query.month);
    const entry = q('SELECT actual, amount, note FROM kpi_entries WHERE report_id = ? AND item_id = ?');
    const out = [['日付', '氏名', '今日やるべきこと', '今日やったこと・結果', 'よかったこと・改善点→改善策',
      '共有・連絡事項', '相談したいこと', '翌出社日への決意・目標', '翌出社日のスケジュール',
      '出社時刻', '退社時刻', '休憩時間', ...items.flatMap((i) => [`${i.name} 件数`, `${i.name} 金額(円)`, `${i.name} 内容`])]];
    for (const r of rows) {
      out.push([r.report_date, r.user_name, ...TEXT_FIELDS.map((f) => r[f]), ...TIME_FIELDS.map((f) => r[f]),
        ...items.flatMap((i) => { const e = entry.get(r.id, i.id); return e ? [e.actual, e.amount, e.note] : ['', '', '']; })]);
    }
    return { csv: csv(out), filename: `nippo_${query.month}.csv` };
  });

  route('GET', '/api/reports/:id', ({ me, params }) => {
    const r = hydrate(getReport(params.id), me);
    r.comments = q(`SELECT c.id, c.body, c.created_at, c.user_id, u.name, u.color FROM comments c
                    JOIN users u ON u.id = c.user_id WHERE c.report_id = ? ORDER BY c.id`).all(r.id)
      .map((c) => ({ ...c, can_delete: c.user_id === me.id || me.role === 'admin' }));
    return r;
  });

  route('POST', '/api/reports', ({ me, body }) => {
    const date = isDate(body.report_date) ? body.report_date : null;
    if (!date) throw new HttpError(400, '日付を正しく入力してください');
    const fields = validateReport(body);
    const exists = q('SELECT id FROM reports WHERE user_id = ? AND report_date = ?').get(me.id, date);
    if (exists) throw new HttpError(409, 'この日付の日報はすでに投稿されています。編集してください');
    const id = tx(() => {
      const ts = now();
      const cols = [...TEXT_FIELDS, ...TIME_FIELDS];
      const { lastInsertRowid } = q(`INSERT INTO reports (user_id, report_date, ${cols.join(', ')}, created_at, updated_at)
        VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?, ?)`).run(me.id, date, ...cols.map((c) => fields[c]), ts, ts);
      const rid = Number(lastInsertRowid);
      saveKpi(rid, body.kpi);
      saveImages(rid, body.images);
      return rid;
    });
    return { id };
  });

  route('PUT', '/api/reports/:id', ({ me, params, body }) => {
    const r = getReport(params.id);
    if (r.user_id !== me.id && me.role !== 'admin') throw new HttpError(403, '他の人の日報は編集できません');
    const fields = validateReport(body);
    let date = r.report_date;
    if (body.report_date && body.report_date !== r.report_date) {
      if (!isDate(body.report_date)) throw new HttpError(400, '日付を正しく入力してください');
      if (q('SELECT 1 FROM reports WHERE user_id = ? AND report_date = ? AND id <> ?').get(r.user_id, body.report_date, r.id)) {
        throw new HttpError(409, 'この日付の日報はすでに投稿されています');
      }
      date = body.report_date;
    }
    tx(() => {
      const cols = [...TEXT_FIELDS, ...TIME_FIELDS];
      q(`UPDATE reports SET report_date = ?, ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(date, ...cols.map((c) => fields[c]), now(), r.id);
      saveKpi(r.id, body.kpi);
      removeAttachments(r.id, body.remove_attachments);
      saveImages(r.id, body.images);
    });
    return { id: r.id };
  });

  route('DELETE', '/api/reports/:id', ({ me, params }) => {
    const r = getReport(params.id);
    if (r.user_id !== me.id && me.role !== 'admin') throw new HttpError(403, '他の人の日報は削除できません');
    const files = stmt.attachments.all(r.id);
    q('DELETE FROM reports WHERE id = ?').run(r.id);
    for (const a of files) fs.rmSync(path.join(uploadDir, a.filename), { force: true });
    return { ok: true };
  });

  const markRead = (r, me) => {
    if (r.user_id !== me.id) q('INSERT OR IGNORE INTO reads (report_id, user_id, read_at) VALUES (?, ?, ?)').run(r.id, me.id, now());
  };

  route('POST', '/api/reports/:id/read', ({ me, params }) => {
    const r = getReport(params.id);
    markRead(r, me);
    return { ok: true };
  });

  route('POST', '/api/reports/:id/reactions', ({ me, params, body }) => {
    const r = getReport(params.id);
    markRead(r, me);
    const kind = String(body.kind || '');
    if (kind !== 'like' && !STAMPS.includes(kind)) throw new HttpError(400, '不明なリアクションです');
    const has = q('SELECT 1 FROM reactions WHERE report_id = ? AND user_id = ? AND kind = ?').get(r.id, me.id, kind);
    if (has) {
      q('DELETE FROM reactions WHERE report_id = ? AND user_id = ? AND kind = ?').run(r.id, me.id, kind);
    } else {
      q('INSERT INTO reactions (report_id, user_id, kind, created_at) VALUES (?, ?, ?, ?)').run(r.id, me.id, kind, now());
      notify(r.user_id, me.id, r.id, 'reaction', kind === 'like' ? 'いいね！' : kind);
    }
    return hydrate(getReport(r.id), me);
  });

  route('POST', '/api/reports/:id/comments', ({ me, params, body }) => {
    const r = getReport(params.id);
    const text = String(body.body || '').trim();
    if (!text) throw new HttpError(400, 'コメントを入力してください');
    if (text.length > 2000) throw new HttpError(400, 'コメントは2000文字までです');
    markRead(r, me);
    q('INSERT INTO comments (report_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(r.id, me.id, text, now());
    const targets = new Set([r.user_id, ...q('SELECT DISTINCT user_id FROM comments WHERE report_id = ?').all(r.id).map((c) => c.user_id)]);
    for (const uid of targets) notify(uid, me.id, r.id, 'comment', text.slice(0, 80));
    return { ok: true };
  });

  route('DELETE', '/api/comments/:id', ({ me, params }) => {
    const c = q('SELECT * FROM comments WHERE id = ?').get(Number(params.id));
    if (!c) throw new HttpError(404, 'コメントが見つかりません');
    if (c.user_id !== me.id && me.role !== 'admin') throw new HttpError(403, '他の人のコメントは削除できません');
    q('DELETE FROM comments WHERE id = ?').run(c.id);
    return { ok: true };
  });

  route('GET', '/api/notifications', ({ me }) =>
    q(`SELECT n.id, n.report_id, n.type, n.detail, n.seen, n.created_at, u.name AS actor_name, u.color AS actor_color,
              r.report_date, ru.name AS report_owner
       FROM notifications n JOIN users u ON u.id = n.actor_id JOIN reports r ON r.id = n.report_id
       JOIN users ru ON ru.id = r.user_id
       WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 50`).all(me.id));

  route('POST', '/api/notifications/seen', ({ me }) => {
    q('UPDATE notifications SET seen = 1 WHERE user_id = ?').run(me.id);
    return { ok: true };
  });

  // ---------- KPI 集計・目標 ----------
  route('GET', '/api/kpi/summary', ({ query }) => {
    if (!isMonth(query.month)) throw new HttpError(400, '月を指定してください');
    const items = q('SELECT id, name, unit FROM kpi_items WHERE active = 1 ORDER BY sort, id').all();
    const users = q('SELECT id, name, color FROM users WHERE active = 1 ORDER BY id').all();
    const totals = q(`SELECT r.user_id, e.item_id, SUM(e.actual) AS total, SUM(e.amount) AS amount FROM kpi_entries e
                      JOIN reports r ON r.id = e.report_id WHERE substr(r.report_date, 1, 7) = ?
                      GROUP BY r.user_id, e.item_id`).all(query.month);
    const targets = q('SELECT user_id, item_id, target FROM kpi_targets WHERE month = ?').all(query.month);
    const key = (u, i) => `${u}:${i}`;
    const tMap = new Map(targets.map((t) => [key(t.user_id, t.item_id), t.target]));
    const aMap = new Map(totals.map((t) => [key(t.user_id, t.item_id), t.total]));
    const mMap = new Map(totals.map((t) => [key(t.user_id, t.item_id), t.amount]));
    const rows = users.map((u) => ({
      user: u,
      cells: items.map((i) => {
        const target = tMap.get(key(u.id, i.id)) || 0;
        const actual = aMap.get(key(u.id, i.id)) || 0;
        const amount = mMap.get(key(u.id, i.id)) || 0;
        return { item_id: i.id, target, actual, amount, rate: target > 0 ? Math.round((actual / target) * 1000) / 10 : null };
      }),
    }));
    const total = items.map((i, idx) => {
      const target = rows.reduce((s, r) => s + r.cells[idx].target, 0);
      const actual = rows.reduce((s, r) => s + r.cells[idx].actual, 0);
      const amount = rows.reduce((s, r) => s + r.cells[idx].amount, 0);
      return { item_id: i.id, target, actual, amount, rate: target > 0 ? Math.round((actual / target) * 1000) / 10 : null };
    });
    if (query.format === 'csv') {
      const out = [['氏名', ...items.flatMap((i) => [`${i.name} 目標`, `${i.name} 実績`, `${i.name} 達成率(%)`, `${i.name} 金額(円)`])]];
      for (const r of rows) out.push([r.user.name, ...r.cells.flatMap((c) => [c.target, c.actual, c.rate ?? '-', c.amount])]);
      out.push(['合計', ...total.flatMap((c) => [c.target, c.actual, c.rate ?? '-', c.amount])]);
      return { csv: csv(out), filename: `kpi_${query.month}.csv` };
    }
    return { month: query.month, items, rows, total };
  });

  route('GET', '/api/kpi/targets', ({ me, query }) => {
    if (!isMonth(query.month)) throw new HttpError(400, '月を指定してください');
    const userId = query.user_id ? Number(query.user_id) : me.id;
    const items = q('SELECT id, name, unit FROM kpi_items WHERE active = 1 ORDER BY sort, id').all();
    const t = q('SELECT item_id, target FROM kpi_targets WHERE user_id = ? AND month = ?').all(userId, query.month);
    const map = new Map(t.map((x) => [x.item_id, x.target]));
    return { user_id: userId, month: query.month, items: items.map((i) => ({ ...i, target: map.get(i.id) || 0 })) };
  });

  route('PUT', '/api/kpi/targets', ({ me, body }) => {
    if (!isMonth(body.month)) throw new HttpError(400, '月を指定してください');
    const userId = body.user_id ? Number(body.user_id) : me.id;
    if (userId !== me.id) requireAdmin(me);
    const up = q(`INSERT INTO kpi_targets (user_id, item_id, month, target) VALUES (?, ?, ?, ?)
                  ON CONFLICT (user_id, item_id, month) DO UPDATE SET target = excluded.target`);
    tx(() => {
      for (const [itemId, val] of Object.entries(body.targets || {})) {
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) throw new HttpError(400, '目標は0以上の数値で入力してください');
        if (q('SELECT 1 FROM kpi_items WHERE id = ?').get(Number(itemId))) up.run(userId, Number(itemId), body.month, n);
      }
    });
    return { ok: true };
  });

  // ---------- 管理者 ----------
  route('GET', '/api/admin/users', ({ me }) => {
    requireAdmin(me);
    return q('SELECT id, login_id, name, role, color, active, created_at FROM users ORDER BY id').all();
  });

  route('POST', '/api/admin/users', ({ me, body }) => {
    requireAdmin(me);
    const loginId = String(body.login_id || '').trim();
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    if (!/^[A-Za-z0-9._-]{2,32}$/.test(loginId)) throw new HttpError(400, 'ログインIDは半角英数字2〜32文字にしてください');
    if (!name) throw new HttpError(400, '氏名を入力してください');
    if (password.length < 6) throw new HttpError(400, 'パスワードは6文字以上にしてください');
    if (q('SELECT 1 FROM users WHERE login_id = ?').get(loginId)) throw new HttpError(409, 'そのログインIDはすでに使われています');
    const role = body.role === 'admin' ? 'admin' : 'member';
    const color = isColor(body.color) ? body.color : '#3f51b5';
    const { lastInsertRowid } = q('INSERT INTO users (login_id, name, password_hash, role, color, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(loginId, name, hashPassword(password), role, color, now());
    return { id: Number(lastInsertRowid) };
  });

  route('PUT', '/api/admin/users/:id', ({ me, params, body }) => {
    requireAdmin(me);
    const u = q('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    if (!u) throw new HttpError(404, 'ユーザーが見つかりません');
    const name = body.name != null ? String(body.name).trim() : u.name;
    const role = body.role != null ? (body.role === 'admin' ? 'admin' : 'member') : u.role;
    const active = body.active != null ? (body.active ? 1 : 0) : u.active;
    const color = isColor(body.color) ? body.color : u.color;
    if (!name) throw new HttpError(400, '氏名を入力してください');
    if (u.role === 'admin' && (role !== 'admin' || !active)) {
      const admins = q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
      if (admins <= 1) throw new HttpError(400, '管理者が1人もいなくなるため変更できません');
    }
    q('UPDATE users SET name = ?, role = ?, active = ?, color = ? WHERE id = ?').run(name, role, active, color, u.id);
    if (!active) q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    if (body.password) {
      if (String(body.password).length < 6) throw new HttpError(400, 'パスワードは6文字以上にしてください');
      q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), u.id);
    }
    return { ok: true };
  });

  route('GET', '/api/admin/kpi-items', ({ me }) => {
    requireAdmin(me);
    return q('SELECT id, name, unit, sort, active FROM kpi_items ORDER BY sort, id').all();
  });

  route('POST', '/api/admin/kpi-items', ({ me, body }) => {
    requireAdmin(me);
    const name = String(body.name || '').trim();
    if (!name) throw new HttpError(400, '項目名を入力してください');
    const sort = q('SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM kpi_items').get().s;
    const { lastInsertRowid } = q('INSERT INTO kpi_items (name, unit, sort) VALUES (?, ?, ?)')
      .run(name, String(body.unit || '件').trim() || '件', sort);
    return { id: Number(lastInsertRowid) };
  });

  route('PUT', '/api/admin/kpi-items/:id', ({ me, params, body }) => {
    requireAdmin(me);
    const it = q('SELECT * FROM kpi_items WHERE id = ?').get(Number(params.id));
    if (!it) throw new HttpError(404, '項目が見つかりません');
    const name = body.name != null ? String(body.name).trim() : it.name;
    if (!name) throw new HttpError(400, '項目名を入力してください');
    const unit = body.unit != null ? String(body.unit).trim() || '件' : it.unit;
    const sort = Number.isFinite(Number(body.sort)) && body.sort != null ? Number(body.sort) : it.sort;
    const active = body.active != null ? (body.active ? 1 : 0) : it.active;
    q('UPDATE kpi_items SET name = ?, unit = ?, sort = ?, active = ? WHERE id = ?').run(name, unit, sort, active, it.id);
    return { ok: true };
  });

  // ---------- HTTP ----------
  function send(res, status, body, headers = {}) {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(isStr ? body : JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, '送信データが大きすぎます')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function serveFile(res, file, cache) {
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not Found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': cache,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) {
      const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
      if (!r) return send(res, 404, { error: 'Not Found' });
      const me = currentUser(req);
      if (r.auth && !me) return send(res, 401, { error: 'ログインしてください' });
      let body = {};
      if (req.method !== 'GET') {
        const ct = req.headers['content-type'] || '';
        const raw = await readBody(req);
        if (raw.length) {
          if (!ct.startsWith('application/json')) return send(res, 415, { error: 'JSONで送信してください' });
          try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'JSONが正しくありません' }); }
        }
      }
      const m = r.re.exec(pathname);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const result = await r.handler({ req, me, body, params, query: Object.fromEntries(url.searchParams) });
      if (result && result.csv != null) {
        return send(res, 200, result.csv, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${result.filename}"`,
        });
      }
      if (result && result.headers) return send(res, 200, result.body, result.headers);
      return send(res, 200, result ?? { ok: true });
    }

    if (pathname.startsWith('/uploads/')) {
      if (!currentUser(req)) return send(res, 401, 'Unauthorized');
      const name = path.basename(pathname);
      if (!/^[0-9a-f]{32}\.(jpg|png|webp)$/.test(name)) return send(res, 404, 'Not Found');
      return serveFile(res, path.join(uploadDir, name), 'private, max-age=31536000, immutable');
    }

    const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not Found');
    return serveFile(res, file, 'no-cache');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'サーバーでエラーが発生しました' });
    });
  });

  return { server, db, initialAdmin };
}

if (require.main === module) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const port = Number(process.env.PORT || 3000);
  const { server, initialAdmin } = createApp({ dataDir });
  server.listen(port, () => {
    console.log(`関東燃料 業務日報 起動しました → http://localhost:${port}`);
    console.log(`データ保存先: ${dataDir}`);
    if (initialAdmin) {
      console.log('------------------------------------------------------------');
      console.log(' 初回起動のため管理者アカウントを作成しました');
      console.log(`   ログインID : ${initialAdmin.login_id}`);
      console.log(`   パスワード : ${initialAdmin.password}`);
      console.log(' ログイン後「管理」画面から社員を登録し、パスワードを変更してください');
      console.log('------------------------------------------------------------');
    }
  });
}

module.exports = { createApp };
