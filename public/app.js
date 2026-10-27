'use strict';
// 関東燃料 業務日報 — 画面側（フレームワーク不使用のシンプルなSPA）

const SECTIONS = [
  ['todo', '今日やるべきこと'],
  ['done', '今日やったこと・結果'],
  ['review', 'よかったこと・改善点→改善策'],
  ['shared', '共有・連絡事項'],
  ['consult', '相談したいこと'],
  ['resolve', '翌出社日への決意・目標'],
  ['next_schedule', '翌出社日のスケジュール'],
];
const TIMES = [['clock_in', '出社時刻'], ['clock_out', '退社時刻'], ['break_time', '休憩時間']];
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

const state = {
  me: null, today: '', stamps: [], users: [], items: [],
  unread: { reports: 0, notifications: 0 },
  filter: { user_id: '', q: '', unread: false },
};

// ---------- 共通 ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空レスポンス */ }
  if (res.status === 401 && !url.startsWith('/api/login')) { state.me = null; renderLogin(); throw new Error('ログインしてください'); }
  if (!res.ok) throw new Error((data && data.error) || `エラーが発生しました (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function parseTs(s) { return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z'); }
function fmtDate(d) {
  const [y, m, day] = d.split('-').map(Number);
  const w = WEEK[new Date(y, m - 1, day).getDay()];
  return `${m}月${day}日(${w})`;
}
function fmtTs(s) {
  const d = parseTs(s);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return ymd === state.today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function fmtNum(n) { return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100); }
function monthOf(d) { return d.slice(0, 7); }
function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function avatar(u, cls = '') {
  return `<span class="avatar ${cls}" style="background:${esc(u.color)}" title="${esc(u.name)}">${esc((u.name || '?').trim().charAt(0))}</span>`;
}
function store(key, val) {
  try { if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null'); if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch { return null; }
  return null;
}

// ---------- 画面の枠 ----------
function shell(title, content, { back = false, active = '' } = {}) {
  const b = state.unread;
  $('#app').innerHTML = `
    <header class="topbar">
      ${back ? '<button class="icon-btn" data-act="back" aria-label="戻る">←</button>' : ''}
      <h1><span class="brand">関東燃料</span>${esc(title)}</h1>
      ${active === 'home' ? '<button class="icon-btn" data-act="toggle-search" aria-label="検索">🔍</button>' : ''}
    </header>
    <main id="main">${content}</main>
    <nav class="bottomnav">
      <a href="#/" class="${active === 'home' ? 'active' : ''}"><span class="ico">🏠</span>日報${b.reports ? `<span class="badge">${b.reports > 99 ? '99+' : b.reports}</span>` : ''}</a>
      <a href="#/notifications" class="${active === 'notif' ? 'active' : ''}"><span class="ico">🔔</span>通知${b.notifications ? `<span class="badge">${b.notifications}</span>` : ''}</a>
      <a href="#/new" class="fab-wrap" aria-label="日報を書く"><span class="fab">✏️</span></a>
      <a href="#/kpi" class="${active === 'kpi' ? 'active' : ''}"><span class="ico">📊</span>KPI</a>
      <a href="#/menu" class="${active === 'menu' ? 'active' : ''}"><span class="ico">☰</span>メニュー</a>
    </nav>`;
  return $('#main');
}

async function refreshUnread() {
  try { state.unread = await api('GET', '/api/unread'); } catch { /* 無視 */ }
  const nav = $('.bottomnav');
  if (!nav) return;
  const set = (href, n) => {
    const a = $(`a[href="${href}"]`, nav);
    if (!a) return;
    let badge = $('.badge', a);
    if (!n) { if (badge) badge.remove(); return; }
    if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; a.appendChild(badge); }
    badge.textContent = n > 99 ? '99+' : n;
  };
  set('#/', state.unread.reports);
  set('#/notifications', state.unread.notifications);
  const pill = $('#unread-pill b');
  if (pill) pill.textContent = state.unread.reports;
}

// ---------- 日報カード ----------
function reportCard(r, { full = false } = {}) {
  const secs = SECTIONS.filter(([k]) => r[k]).map(([k, label]) =>
    `<div class="sec"><h4>${label}</h4><p>${esc(r[k])}</p></div>`).join('');
  const textLen = SECTIONS.reduce((n, [k]) => n + (r[k] ? r[k].length + 40 : 0), 0);
  const clamp = !full && textLen > 220;
  const times = TIMES.filter(([k]) => r[k]).length
    ? `<div class="timerow">${TIMES.map(([k, l]) => `<div><small>${l}</small><span>${esc(r[k] || '-')}</span></div>`).join('')}</div>` : '';
  const kpi = r.kpi.length ? `<div class="kpi">${r.kpi.map((k) => `
      <div class="kpi-block">
        <div class="name">${esc(k.name)}</div>
        <div class="kpi-grid">
          <div><small>月目標</small><b>${fmtNum(k.target)}</b><span class="unit">${esc(k.unit)}</span></div>
          <div><small>本日実績</small><b>${fmtNum(k.actual)}</b><span class="unit">${esc(k.unit)}</span></div>
          <div><small>月累計</small><b>${fmtNum(k.cumulative)}</b><span class="unit">${esc(k.unit)}</span></div>
          <div><small>達成率</small><b>${k.rate == null ? '-' : k.rate.toFixed(1)}</b><span class="unit">%</span></div>
        </div>
        <div class="rate-bar"><i style="width:${Math.min(k.rate || 0, 100)}%"></i></div>
      </div>`).join('')}</div>` : '';
  const photos = r.attachments.length ? `<div class="photos ${r.attachments.length === 1 ? 'one' : ''}">
      ${r.attachments.map((a) => `<img src="${esc(a.url)}" alt="添付写真" loading="lazy" data-act="view-photo">`).join('')}</div>` : '';
  const readers = r.readers.length ? `<div class="readers"><span class="ok">✓</span>
      <span>${r.readers.slice(0, 8).map((u) => avatar(u, 'sm')).join('')}</span>
      ${r.readers.length > 8 ? `<span>他${r.readers.length - 8}名</span>` : ''}<span>が開封</span></div>` : '';
  const like = r.reactions.find((x) => x.kind === 'like');
  const stamps = r.reactions.filter((x) => x.kind !== 'like');
  const chips = (like || stamps.length) ? `<div class="reaction-chips">
      ${like ? `<button class="chip ${like.mine ? 'mine' : ''}" data-act="react" data-kind="like" title="${esc(like.users.join('、'))}">✅ いいね！ ${like.count}</button>` : ''}
      ${stamps.map((s) => `<button class="chip ${s.mine ? 'mine' : ''}" data-act="react" data-kind="${esc(s.kind)}" title="${esc(s.users.join('、'))}">${esc(s.kind)} ${s.count}</button>`).join('')}
    </div>` : '';
  return `
  <article class="card ${r.is_read ? '' : 'unread'}" data-id="${r.id}">
    <div class="card-head">
      ${avatar(r.user)}
      <div class="card-title">
        <div class="t">${fmtDate(r.report_date)}の日報</div>
        <div class="s"><b>${esc(r.user.name)}</b>${fmtTs(r.created_at)}${r.edited ? '（編集済み）' : ''}</div>
      </div>
      <div class="card-tools">
        ${r.can_edit ? '<button class="icon-btn plain" data-act="card-menu" aria-label="メニュー">⋮</button>' : ''}
        ${full ? '' : `<a class="icon-btn plain" href="#/report/${r.id}" aria-label="詳細">→</a>`}
      </div>
    </div>
    ${secs ? `<div class="card-body ${clamp ? 'clamp' : ''}">${secs}</div>
      ${clamp ? '<button class="more" data-act="expand">▼ すべて表示</button>' : ''}` : ''}
    ${times}${kpi}${photos}${readers}${chips}
    <div class="actions">
      <button data-act="react" data-kind="like" class="${like && like.mine ? 'on' : ''}">✅ いいね！</button>
      <button data-act="comment">💬 コメント${r.comment_count ? ` ${r.comment_count}` : ''}</button>
      <button data-act="stamp">😊 スタンプ</button>
    </div>
    <div class="stamp-picker" hidden>${state.stamps.map((s) => `<button data-act="react" data-kind="${esc(s)}">${esc(s)}</button>`).join('')}</div>
  </article>`;
}

// カード上の操作（いいね・スタンプ・展開・編集削除など）を一括で受け付ける
async function onCardClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const card = el.closest('.card');
  const id = card && card.dataset.id;
  const act = el.dataset.act;
  if (act === 'expand') {
    const body = $('.card-body', card);
    const open = body.classList.toggle('clamp');
    el.textContent = open ? '▼ すべて表示' : '▲ 隠す';
    markRead(card);
  } else if (act === 'react') {
    try {
      const r = await api('POST', `/api/reports/${id}/reactions`, { kind: el.dataset.kind });
      const full = !!card.closest('[data-full]');
      card.outerHTML = reportCard(r, { full });
    } catch (err) { toast(err.message); }
  } else if (act === 'stamp') {
    const p = $('.stamp-picker', card); p.hidden = !p.hidden;
  } else if (act === 'comment') {
    if (location.hash === `#/report/${id}`) $('#comment-body')?.focus();
    else location.hash = `#/report/${id}?comment=1`;
  } else if (act === 'view-photo') {
    const v = document.createElement('div');
    v.className = 'viewer';
    v.innerHTML = `<img src="${esc(el.src)}" alt="写真"><button class="icon-btn" aria-label="閉じる">✕</button>`;
    v.addEventListener('click', () => v.remove());
    document.body.appendChild(v);
  } else if (act === 'card-menu') {
    $$('.menu-pop').forEach((m) => m.remove());
    const m = document.createElement('div');
    m.className = 'menu-pop';
    m.style.top = '52px';
    m.innerHTML = '<button data-act="edit">✏️ 編集する</button><button data-act="delete" class="danger">🗑 削除する</button>';
    card.appendChild(m);
    setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
  } else if (act === 'edit') {
    location.hash = `#/edit/${id}`;
  } else if (act === 'delete') {
    if (!confirm('この日報を削除します。よろしいですか？（元に戻せません）')) return;
    try { await api('DELETE', `/api/reports/${id}`); toast('削除しました'); if (location.hash.startsWith('#/report/')) location.hash = '#/'; else card.remove(); }
    catch (err) { toast(err.message); }
  }
}

// 画面に一定時間表示された日報を「開封」にする
const readTimers = new Map();
const readObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const card = en.target;
    if (en.isIntersecting) {
      if (!readTimers.has(card)) readTimers.set(card, setTimeout(() => markRead(card), 1500));
    } else {
      clearTimeout(readTimers.get(card)); readTimers.delete(card);
    }
  }
}, { threshold: 0.5 });

async function markRead(card) {
  readTimers.delete(card);
  readObserver.unobserve(card);
  if (!card.classList.contains('unread')) return;
  card.classList.remove('unread');
  try { await api('POST', `/api/reports/${card.dataset.id}/read`); refreshUnread(); } catch { /* 無視 */ }
}
function observeUnread(root) { $$('.card.unread', root).forEach((c) => readObserver.observe(c)); }

// ---------- タイムライン ----------
async function viewTimeline() {
  const f = state.filter;
  const main = shell(`業務日報（${state.users.length}名）`, `
    <div class="filters" id="search-row" ${f.q ? '' : 'hidden'}>
      <input type="search" id="q" placeholder="キーワード・氏名で検索" value="${esc(f.q)}">
    </div>
    <div class="filters">
      <select id="f-user" aria-label="投稿者で絞り込み">
        <option value="">全員の日報</option>
        <option value="${state.me.id}" ${String(f.user_id) === String(state.me.id) ? 'selected' : ''}>自分の日報</option>
        ${state.users.filter((u) => u.id !== state.me.id).map((u) => `<option value="${u.id}" ${String(f.user_id) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select>
      <button class="pill ${f.unread ? 'on' : ''}" id="unread-pill">未読の投稿<b>${state.unread.reports}</b>件</button>
    </div>
    <div id="feed"></div>
    <div id="feed-more"></div>`, { active: 'home' });

  const feed = $('#feed');
  feed.addEventListener('click', onCardClick);
  $('[data-act="toggle-search"]').onclick = () => { const r = $('#search-row'); r.hidden = !r.hidden; if (!r.hidden) $('#q').focus(); };
  let qTimer;
  $('#q').oninput = (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { f.q = e.target.value.trim(); load(true); }, 400); };
  $('#f-user').onchange = (e) => { f.user_id = e.target.value; load(true); };
  $('#unread-pill').onclick = () => { f.unread = !f.unread; $('#unread-pill').classList.toggle('on', f.unread); load(true); };

  let cursor = null;
  async function load(reset) {
    if (reset) { cursor = null; feed.innerHTML = ''; }
    const more = $('#feed-more');
    more.innerHTML = '<div class="loading">読み込み中…</div>';
    const p = new URLSearchParams({ limit: 15 });
    if (f.user_id) p.set('user_id', f.user_id);
    if (f.q) p.set('q', f.q);
    if (f.unread) p.set('unread', '1');
    if (cursor) { p.set('before_date', cursor.date); p.set('before_id', cursor.id); }
    try {
      const data = await api('GET', `/api/reports?${p}`);
      feed.insertAdjacentHTML('beforeend', data.reports.map((r) => reportCard(r)).join(''));
      observeUnread(feed);
      const last = data.reports[data.reports.length - 1];
      if (last) cursor = { date: last.report_date, id: last.id };
      if (!feed.children.length) {
        more.innerHTML = `<div class="empty">${f.unread ? '未読の日報はありません 🎉' : 'まだ日報がありません。<br>右下の ✏️ から書いてみましょう'}</div>`;
      } else if (data.has_more) {
        more.innerHTML = '<button class="btn block" id="load-more">さらに読み込む</button>';
        $('#load-more').onclick = () => load(false);
      } else {
        more.innerHTML = `<div class="center muted" style="padding:12px">以上です</div>
          ${f.unread && state.unread.reports ? '<button class="btn block" id="read-all">すべて既読にする</button>' : ''}`;
        const ra = $('#read-all');
        if (ra) ra.onclick = async () => { await api('POST', '/api/reports/read-all'); await refreshUnread(); load(true); };
      }
    } catch (err) { more.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  }
  load(true);
}

// ---------- 日報詳細 ----------
async function viewReport(id, params = new URLSearchParams()) {
  const main = shell('日報', '<div class="loading">読み込み中…</div>', { back: true });
  let r;
  try { r = await api('GET', `/api/reports/${id}`); } catch (err) { main.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  main.innerHTML = `
    <div data-full id="detail">${reportCard(r, { full: true })}</div>
    <div class="card">
      <div class="comments">
        <div class="section-title" style="margin-top:12px">コメント（${r.comments.length}）</div>
        ${r.comments.map((c) => `
          <div class="comment">
            ${avatar(c)}
            <div style="flex:1;min-width:0">
              <div class="who"><b>${esc(c.name)}</b>${fmtTs(c.created_at)}
                ${c.can_delete ? `<button class="icon-btn plain" style="width:28px;height:28px;font-size:13px" data-del-comment="${c.id}" aria-label="削除">🗑</button>` : ''}</div>
              <p>${esc(c.body)}</p>
            </div>
          </div>`).join('') || '<p class="muted">まだコメントはありません</p>'}
        <form class="comment-form" id="comment-form">
          <textarea id="comment-body" placeholder="コメントを書く" rows="2" maxlength="2000"></textarea>
          <button class="btn primary" type="submit">送信</button>
        </form>
      </div>
    </div>`;
  $('#detail').addEventListener('click', onCardClick);
  markRead($('#detail .card'));
  $$('[data-del-comment]').forEach((b) => b.onclick = async () => {
    if (!confirm('このコメントを削除しますか？')) return;
    try { await api('DELETE', `/api/comments/${b.dataset.delComment}`); viewReport(id); } catch (err) { toast(err.message); }
  });
  $('#comment-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = $('#comment-body').value.trim();
    if (!body) return;
    try { await api('POST', `/api/reports/${id}/comments`, { body }); toast('コメントしました'); viewReport(id); } catch (err) { toast(err.message); }
  };
  if (params.get('comment')) { $('#comment-body').focus(); $('#comment-form').scrollIntoView({ block: 'center' }); }
}

// ---------- 日報の作成・編集 ----------
function resizeImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('写真を読み込めませんでした')); };
    img.src = url;
  });
}

async function viewForm(editId, params) {
  const main = shell(editId ? '日報を編集' : '日報を書く', '<div class="loading">読み込み中…</div>', { back: true });
  let r;
  try {
    if (editId) {
      r = await api('GET', `/api/reports/${editId}`);
      if (!r.can_edit) { main.innerHTML = '<div class="empty">この日報は編集できません</div>'; return; }
    } else {
      const date = params.get('date') || state.today;
      const d = await api('GET', `/api/reports/draft?date=${encodeURIComponent(date)}`);
      if (d.existing_id) { toast('この日の日報は投稿済みです。編集画面を開きます'); location.replace(`#/edit/${d.existing_id}`); return; }
      r = { ...d, kpi: [], attachments: [] };
      const saved = store(`nippo-draft:${state.me.id}:${date}`);
      if (saved) Object.assign(r, saved, { restored: true });
    }
  } catch (err) { main.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  const ownerId = editId ? r.user_id : state.me.id;
  let targets = {};
  try {
    const t = await api('GET', `/api/kpi/targets?month=${monthOf(r.report_date)}&user_id=${ownerId}`);
    targets = Object.fromEntries(t.items.map((i) => [i.id, i.target]));
  } catch { /* 目標なし */ }
  const kpiVal = Object.fromEntries((r.kpi || []).map((k) => [k.item_id, k.actual]));
  if (r.kpi_values) Object.assign(kpiVal, r.kpi_values);
  const newImages = [];
  const removeIds = [];

  main.innerHTML = `
    <form class="form" id="report-form" autocomplete="off">
      ${!editId && r.from_date && r.todo && !r.restored ? `<div class="notice">📋 前回（${fmtDate(r.from_date)}）の「翌出社日のスケジュール」を「今日やるべきこと」に引き継ぎました</div>` : ''}
      ${r.restored ? '<div class="notice">📝 書きかけの内容を復元しました</div>' : ''}
      <div class="field"><label for="report_date">日付</label>
        <input type="date" id="report_date" value="${esc(r.report_date)}" required></div>
      ${SECTIONS.map(([k, l]) => `<div class="field"><label for="${k}">${l}</label>
        <textarea id="${k}" rows="3">${esc(r[k] || '')}</textarea></div>`).join('')}
      <div class="row3">
        ${TIMES.map(([k, l]) => `<div class="field"><label for="${k}">${l}</label><input type="time" id="${k}" value="${esc(r[k] || '')}"></div>`).join('')}
      </div>
      <div class="field">
        <label>KPI（本日の実績）<span class="hint">月目標は「KPI」→「目標設定」から</span></label>
        ${state.items.map((i) => `
          <div class="kpi-input">
            <div class="nm">${esc(i.name)}<small>月目標 ${fmtNum(targets[i.id] || 0)}${esc(i.unit)}</small></div>
            <div class="stepper">
              <button type="button" data-step="-1" data-item="${i.id}" aria-label="減らす">−</button>
              <input type="number" inputmode="decimal" min="0" step="any" data-kpi="${i.id}" value="${fmtNum(kpiVal[i.id] || 0)}" aria-label="${esc(i.name)}">
              <button type="button" data-step="1" data-item="${i.id}" aria-label="増やす">＋</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="field">
        <label>写真<span class="hint">最大10枚・自動で縮小して送信します</span></label>
        <input type="file" id="photos" accept="image/*" multiple>
        <div class="thumbs" id="thumbs"></div>
      </div>
      <div class="btns">
        <button type="button" class="btn" data-act="back">キャンセル</button>
        <button type="submit" class="btn primary" id="submit-btn">${editId ? '更新する' : '投稿する'}</button>
      </div>
    </form>`;

  const draftKey = () => `nippo-draft:${state.me.id}:${$('#report_date').value}`;
  function collect() {
    const data = { report_date: $('#report_date').value, kpi: {} };
    for (const [k] of [...SECTIONS, ...TIMES]) data[k] = $(`#${k}`).value;
    for (const inp of $$('[data-kpi]')) data.kpi[inp.dataset.kpi] = Number(inp.value) || 0;
    return data;
  }
  if (!editId) {
    $('#report-form').addEventListener('input', () => {
      const d = collect();
      store(draftKey(), { ...Object.fromEntries([...SECTIONS, ...TIMES].map(([k]) => [k, d[k]])), kpi_values: d.kpi });
    });
  }
  $$('[data-step]').forEach((b) => b.onclick = () => {
    const inp = $(`[data-kpi="${b.dataset.item}"]`);
    inp.value = Math.max(0, (Number(inp.value) || 0) + Number(b.dataset.step));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });

  function drawThumbs() {
    const existing = r.attachments.filter((a) => !removeIds.includes(a.id));
    $('#thumbs').innerHTML = existing.map((a) => `<div class="thumb"><img src="${esc(a.url)}" alt=""><button type="button" data-rm-old="${a.id}" aria-label="削除">✕</button></div>`).join('') +
      newImages.map((src, i) => `<div class="thumb"><img src="${src}" alt=""><button type="button" data-rm-new="${i}" aria-label="削除">✕</button></div>`).join('');
    $$('[data-rm-old]').forEach((b) => b.onclick = () => { removeIds.push(Number(b.dataset.rmOld)); drawThumbs(); });
    $$('[data-rm-new]').forEach((b) => b.onclick = () => { newImages.splice(Number(b.dataset.rmNew), 1); drawThumbs(); });
  }
  drawThumbs();
  $('#photos').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const room = 10 - (r.attachments.length - removeIds.length) - newImages.length;
    if (files.length > room) toast(`写真はあと${Math.max(room, 0)}枚まで追加できます`);
    for (const f of files.slice(0, Math.max(room, 0))) {
      try { newImages.push(await resizeImage(f)); } catch (err) { toast(err.message); }
    }
    drawThumbs();
  };

  $('#report-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#submit-btn');
    btn.disabled = true; btn.textContent = '送信中…';
    const data = { ...collect(), images: newImages, remove_attachments: removeIds };
    try {
      const res = editId ? await api('PUT', `/api/reports/${editId}`, data) : await api('POST', '/api/reports', data);
      if (!editId) store(draftKey(), null);
      toast(editId ? '日報を更新しました' : '日報を投稿しました。おつかれさまでした！');
      location.hash = `#/report/${res.id}`;
    } catch (err) {
      toast(err.message);
      btn.disabled = false; btn.textContent = editId ? '更新する' : '投稿する';
    }
  };
}

// ---------- 通知 ----------
async function viewNotifications() {
  const main = shell('通知', '<div class="loading">読み込み中…</div>', { active: 'notif' });
  try {
    const list = await api('GET', '/api/notifications');
    main.innerHTML = list.length ? `<div class="list">${list.map((n) => `
      <a class="list-item ${n.seen ? '' : 'new'}" href="#/report/${n.report_id}">
        ${avatar({ name: n.actor_name, color: n.actor_color })}
        <div class="grow">
          <div><b>${esc(n.actor_name)}</b> さんが${n.report_owner === state.me.name ? 'あなた' : `${esc(n.report_owner)}さん`}の${fmtDate(n.report_date)}の日報に
            ${n.type === 'comment' ? 'コメントしました' : `「${esc(n.detail)}」しました`}</div>
          ${n.type === 'comment' ? `<small>「${esc(n.detail)}」</small>` : ''}
          <small>${fmtTs(n.created_at)}</small>
        </div>
      </a>`).join('')}</div>` : '<div class="empty">通知はありません</div>';
    if (list.some((n) => !n.seen)) { await api('POST', '/api/notifications/seen'); refreshUnread(); }
  } catch (err) { main.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

// ---------- KPI集計 ----------
async function viewKpi(params) {
  const month = params.get('month') || monthOf(state.today);
  const main = shell('KPI 集計', '<div class="loading">読み込み中…</div>', { active: 'kpi' });
  try {
    const s = await api('GET', `/api/kpi/summary?month=${month}`);
    const [y, m] = month.split('-').map(Number);
    const cell = (c) => `<td>${fmtNum(c.actual)} / ${fmtNum(c.target)}<br>
      <span class="${c.rate == null ? 'muted' : c.rate >= 100 ? 'rate-good' : c.rate < 50 ? 'rate-low' : ''}">${c.rate == null ? '-' : c.rate.toFixed(1)}%</span></td>`;
    main.innerHTML = `
      <div class="month-nav">
        <a class="btn" href="#/kpi?month=${shiftMonth(month, -1)}">◀ 前月</a>
        <strong>${y}年${m}月</strong>
        <a class="btn" href="#/kpi?month=${shiftMonth(month, 1)}">翌月 ▶</a>
      </div>
      <p class="muted" style="font-size:13px;margin:0 4px 8px">各セル：実績 / 月目標（達成率）</p>
      <div class="table-wrap"><table>
        <thead><tr><th>氏名</th>${s.items.map((i) => `<th>${esc(i.name)}</th>`).join('')}</tr></thead>
        <tbody>${s.rows.map((r) => `<tr><td>${esc(r.user.name)}</td>${r.cells.map(cell).join('')}</tr>`).join('')}</tbody>
        <tfoot><tr><td>合計</td>${s.total.map(cell).join('')}</tr></tfoot>
      </table></div>
      <div class="btns">
        <a class="btn primary" href="#/targets?month=${month}">🎯 目標設定</a>
        <a class="btn" href="/api/kpi/summary?month=${month}&format=csv" download>⬇ KPI CSV</a>
      </div>
      <div class="btns" style="margin-top:8px">
        <a class="btn" href="/api/reports/export?month=${month}" download>⬇ ${m}月の日報をCSVで出力（Excel対応）</a>
      </div>`;
  } catch (err) { main.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

async function viewTargets(params) {
  const month = params.get('month') || monthOf(state.today);
  const isAdmin = state.me.role === 'admin';
  const userId = params.get('user_id') || state.me.id;
  const main = shell('月目標の設定', '<div class="loading">読み込み中…</div>', { back: true, active: 'kpi' });
  try {
    const t = await api('GET', `/api/kpi/targets?month=${month}&user_id=${userId}`);
    main.innerHTML = `
      <form class="form" id="target-form">
        <div class="row2">
          <div class="field"><label for="t-month">対象月</label><input type="month" id="t-month" value="${month}"></div>
          <div class="field"><label for="t-user">対象者</label>
            <select id="t-user" ${isAdmin ? '' : 'disabled'}>
              ${state.users.map((u) => `<option value="${u.id}" ${String(u.id) === String(userId) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
            </select></div>
        </div>
        ${!isAdmin ? '<p class="muted" style="font-size:13px">※ 他の人の目標は管理者が設定できます</p>' : ''}
        ${t.items.map((i) => `<div class="kpi-input"><div class="nm">${esc(i.name)}</div>
          <div class="stepper"><input type="number" inputmode="decimal" min="0" step="any" data-target="${i.id}" value="${fmtNum(i.target)}"><span>${esc(i.unit)}</span></div></div>`).join('')}
        <div class="btns"><button class="btn" type="button" data-act="back">戻る</button><button class="btn primary" type="submit">保存する</button></div>
      </form>`;
    const reload = () => { location.hash = `#/targets?month=${$('#t-month').value}&user_id=${$('#t-user').value}`; };
    $('#t-month').onchange = reload;
    $('#t-user').onchange = reload;
    $('#target-form').onsubmit = async (e) => {
      e.preventDefault();
      const targets = Object.fromEntries($$('[data-target]').map((i) => [i.dataset.target, Number(i.value) || 0]));
      try { await api('PUT', '/api/kpi/targets', { month: $('#t-month').value, user_id: Number($('#t-user').value), targets }); toast('目標を保存しました'); }
      catch (err) { toast(err.message); }
    };
  } catch (err) { main.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

// ---------- メニュー ----------
function viewMenu() {
  const me = state.me;
  shell('メニュー', `
    <div class="list">
      <div class="list-item">${avatar(me)}<div class="grow"><b>${esc(me.name)}</b><small>ID: ${esc(me.login_id)}・${me.role === 'admin' ? '管理者' : 'メンバー'}</small></div></div>
    </div>
    <div class="section-title">日報</div>
    <div class="list">
      <a class="list-item" href="#/new">✏️<span class="grow">今日の日報を書く</span>›</a>
      <button class="list-item" id="my-reports">📄<span class="grow">自分の日報一覧</span>›</button>
      <a class="list-item" href="#/targets">🎯<span class="grow">KPIの月目標を設定</span>›</a>
    </div>
    ${me.role === 'admin' ? `<div class="section-title">管理者</div>
    <div class="list">
      <a class="list-item" href="#/admin">⚙️<span class="grow">社員・KPI項目の管理</span>›</a>
    </div>` : ''}
    <div class="section-title">パスワード変更</div>
    <form class="form" id="pw-form">
      <div class="field"><label for="pw-cur">現在のパスワード</label><input type="password" id="pw-cur" autocomplete="current-password" required></div>
      <div class="field"><label for="pw-new">新しいパスワード（6文字以上）</label><input type="password" id="pw-new" autocomplete="new-password" minlength="6" required></div>
      <button class="btn primary block" type="submit">変更する</button>
    </form>
    <div class="btns"><button class="btn danger" id="logout">ログアウト</button></div>`, { active: 'menu' });
  $('#my-reports').onclick = () => { state.filter = { user_id: String(me.id), q: '', unread: false }; location.hash = '#/'; };
  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/me/password', { current: $('#pw-cur').value, next: $('#pw-new').value }); toast('パスワードを変更しました'); e.target.reset(); }
    catch (err) { toast(err.message); }
  };
  $('#logout').onclick = async () => { await api('POST', '/api/logout'); state.me = null; location.hash = '#/'; renderLogin(); };
}

// ---------- 管理 ----------
const COLORS = ['#3f51b5', '#e91e63', '#009688', '#ff9800', '#795548', '#607d8b', '#9c27b0', '#4caf50', '#f44336', '#2196f3'];
async function viewAdmin() {
  if (state.me.role !== 'admin') { location.hash = '#/'; return; }
  const main = shell('管理', '<div class="loading">読み込み中…</div>', { back: true, active: 'menu' });
  let users, items;
  try { [users, items] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/kpi-items')]); }
  catch (err) { main.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  const colorOpts = (sel) => COLORS.map((c) => `<option value="${c}" style="background:${c};color:#fff" ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
  main.innerHTML = `
    <div class="section-title">社員（${users.filter((u) => u.active).length}名が利用中）</div>
    <div class="list">${users.map((u) => `
      <details class="list-item" style="display:block">
        <summary style="display:flex;gap:12px;align-items:center;cursor:pointer">${avatar(u)}
          <span class="grow"><b>${esc(u.name)}</b>${u.active ? '' : '（停止中）'}<small>ID: ${esc(u.login_id)}・${u.role === 'admin' ? '管理者' : 'メンバー'}</small></span></summary>
        <form data-user="${u.id}" style="margin-top:10px">
          <div class="row2">
            <div class="field"><label>氏名</label><input type="text" name="name" value="${esc(u.name)}" required></div>
            <div class="field"><label>権限</label><select name="role"><option value="member">メンバー</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理者</option></select></div>
          </div>
          <div class="row2">
            <div class="field"><label>アイコン色</label><select name="color">${colorOpts(u.color)}</select></div>
            <div class="field"><label>状態</label><select name="active"><option value="1">利用中</option><option value="0" ${u.active ? '' : 'selected'}>停止（退職など）</option></select></div>
          </div>
          <div class="field"><label>パスワード再設定<span class="hint">変更する場合のみ入力</span></label><input type="text" name="password" minlength="6" autocomplete="off"></div>
          <button class="btn primary block" type="submit">保存</button>
        </form>
      </details>`).join('')}</div>
    <div class="section-title">社員を追加</div>
    <form class="form" id="add-user">
      <div class="row2">
        <div class="field"><label>氏名</label><input type="text" name="name" placeholder="古澤 泰明" required></div>
        <div class="field"><label>ログインID（半角）</label><input type="text" name="login_id" placeholder="furusawa" pattern="[A-Za-z0-9._\\-]{2,32}" required></div>
      </div>
      <div class="row2">
        <div class="field"><label>初期パスワード</label><input type="text" name="password" minlength="6" required autocomplete="off"></div>
        <div class="field"><label>権限</label><select name="role"><option value="member">メンバー</option><option value="admin">管理者</option></select></div>
      </div>
      <div class="field"><label>アイコン色</label><select name="color">${colorOpts(COLORS[users.length % COLORS.length])}</select></div>
      <button class="btn primary block" type="submit">追加する</button>
    </form>
    <div class="section-title">KPI項目</div>
    <div class="list">${items.map((i) => `
      <form class="list-item" data-item="${i.id}" style="flex-wrap:wrap">
        <input type="text" name="name" value="${esc(i.name)}" style="flex:3;min-width:140px" aria-label="項目名">
        <input type="text" name="unit" value="${esc(i.unit)}" style="flex:1;min-width:50px" aria-label="単位">
        <input type="number" name="sort" value="${i.sort}" style="flex:1;min-width:60px" aria-label="並び順">
        <select name="active" style="flex:1;min-width:80px"><option value="1">表示</option><option value="0" ${i.active ? '' : 'selected'}>非表示</option></select>
        <button class="btn" type="submit">保存</button>
      </form>`).join('')}</div>
    <p class="muted" style="font-size:12px;margin:4px">並び順の数字が小さいほど上に表示されます。過去の実績を残すため、項目は削除ではなく「非表示」にします。</p>
    <form class="form" id="add-item" style="margin-top:8px">
      <div class="row2">
        <div class="field"><label>新しいKPI項目</label><input type="text" name="name" placeholder="例：提案：LPガス切替" required></div>
        <div class="field"><label>単位</label><input type="text" name="unit" value="件"></div>
      </div>
      <button class="btn primary block" type="submit">追加する</button>
    </form>`;

  const formData = (f) => Object.fromEntries(new FormData(f));
  const done = async (msg) => { toast(msg); await loadMaster(); viewAdmin(); };
  $$('form[data-user]').forEach((f) => f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    try {
      await api('PUT', `/api/admin/users/${f.dataset.user}`, { ...d, active: d.active === '1', password: d.password || undefined });
      done('保存しました');
    } catch (err) { toast(err.message); }
  });
  $('#add-user').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/admin/users', formData(e.target)); done('社員を追加しました'); } catch (err) { toast(err.message); }
  };
  $$('form[data-item]').forEach((f) => f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    try { await api('PUT', `/api/admin/kpi-items/${f.dataset.item}`, { ...d, active: d.active === '1' }); done('保存しました'); } catch (err) { toast(err.message); }
  });
  $('#add-item').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/admin/kpi-items', formData(e.target)); done('KPI項目を追加しました'); } catch (err) { toast(err.message); }
  };
}

// ---------- ログイン ----------
function renderLogin() {
  $('#app').innerHTML = `
    <div class="login">
      <div class="logo"><img src="/icon.svg" alt=""><h1>関東燃料 業務日報</h1><p>社内専用</p></div>
      <form class="form" id="login-form">
        <div class="field"><label for="login_id">ログインID</label><input type="text" id="login_id" autocomplete="username" autocapitalize="off" required></div>
        <div class="field"><label for="password">パスワード</label><input type="password" id="password" autocomplete="current-password" required></div>
        <button class="btn primary block" type="submit">ログイン</button>
      </form>
    </div>`;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/login', { login_id: $('#login_id').value, password: $('#password').value });
      await boot();
    } catch (err) { toast(err.message); }
  };
}

// ---------- ルーティング ----------
async function loadMaster() {
  [state.users, state.items] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/kpi-items')]);
}

function router() {
  if (!state.me) return;
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(qs || '');
  const p = path || '/';
  let m;
  window.scrollTo(0, 0);
  if (p === '/') viewTimeline();
  else if ((m = p.match(/^\/report\/(\d+)$/))) viewReport(m[1], params);
  else if (p === '/new') viewForm(null, params);
  else if ((m = p.match(/^\/edit\/(\d+)$/))) viewForm(m[1], params);
  else if (p === '/notifications') viewNotifications();
  else if (p === '/kpi') viewKpi(params);
  else if (p === '/targets') viewTargets(params);
  else if (p === '/menu') viewMenu();
  else if (p === '/admin') viewAdmin();
  else location.hash = '#/';
}

async function boot() {
  try {
    const me = await api('GET', '/api/me');
    state.me = me.user; state.today = me.today; state.stamps = me.stamps;
    await loadMaster();
    await refreshUnread();
    router();
  } catch { renderLogin(); }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="back"]')) {
    e.preventDefault();
    if (history.length > 1) history.back(); else location.hash = '#/';
  }
});
window.addEventListener('hashchange', router);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) refreshUnread(); });
setInterval(() => { if (state.me && !document.hidden) refreshUnread(); }, 60_000);
boot();
