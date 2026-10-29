'use strict';
// データベース（SQLite / Node.js 標準の node:sqlite を使用。追加インストール不要）
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  color TEXT NOT NULL DEFAULT '#3f51b5',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  report_date TEXT NOT NULL,
  todo TEXT NOT NULL DEFAULT '',
  done TEXT NOT NULL DEFAULT '',
  review TEXT NOT NULL DEFAULT '',
  shared TEXT NOT NULL DEFAULT '',
  consult TEXT NOT NULL DEFAULT '',
  resolve TEXT NOT NULL DEFAULT '',
  next_schedule TEXT NOT NULL DEFAULT '',
  clock_in TEXT NOT NULL DEFAULT '',
  clock_out TEXT NOT NULL DEFAULT '',
  break_time TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, report_date)
);
CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(report_date DESC, id DESC);
CREATE TABLE IF NOT EXISTS kpi_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '件',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS kpi_entries (
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES kpi_items(id),
  actual REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, item_id)
);
CREATE TABLE IF NOT EXISTS kpi_targets (
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_id INTEGER NOT NULL REFERENCES kpi_items(id),
  month TEXT NOT NULL,
  target REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item_id, month)
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reads (
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (report_id, user_id)
);
CREATE TABLE IF NOT EXISTS reactions (
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (report_id, user_id, kind)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
`;

// 関東燃料の営業KPI初期値（管理画面から追加・変更できます）
const DEFAULT_KPI_ITEMS = [
  ['提案：リフォーム', '件'],
  ['提案：給湯器・エコキュート', '件'],
  ['提案：雑工事', '件'],
  ['受注：リフォーム', '件'],
  ['受注：給湯器・エコキュート', '件'],
  ['受注：雑工事', '件'],
];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(password), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function open(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'nippo.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  if (db.prepare('SELECT COUNT(*) AS n FROM kpi_items').get().n === 0) {
    const ins = db.prepare('INSERT INTO kpi_items (name, unit, sort) VALUES (?, ?, ?)');
    DEFAULT_KPI_ITEMS.forEach(([name, unit], i) => ins.run(name, unit, (i + 1) * 10));
  }

  let initialAdmin = null;
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
    db.prepare("INSERT INTO users (login_id, name, password_hash, role, created_at) VALUES ('admin', '管理者', ?, 'admin', ?)")
      .run(hashPassword(password), new Date().toISOString());
    initialAdmin = { login_id: 'admin', password };
  }
  return { db, initialAdmin };
}

module.exports = { open, hashPassword, verifyPassword };
