import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbFile);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY,
  app_id TEXT NOT NULL UNIQUE,
  secret_enc TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  bot_user_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'websocket',
  intents INTEGER NOT NULL DEFAULT 33554432,
  api_base TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  last_ts INTEGER NOT NULL DEFAULT 0,
  last_preview TEXT NOT NULL DEFAULT '',
  unread INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, type, peer_id)
);

CREATE TABLE IF NOT EXISTS members (
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  is_bot INTEGER NOT NULL DEFAULT 0,
  in_group INTEGER NOT NULL DEFAULT 1,
  last_seen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, group_id, member_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conv_type TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  msg_id TEXT,
  author_id TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  author_role TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  ref_idx TEXT NOT NULL DEFAULT '',
  quote_idx TEXT NOT NULL DEFAULT '',
  reply_used INTEGER NOT NULL DEFAULT 0,
  reply_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (bot_id, conv_type, peer_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_in_dedupe
  ON messages (bot_id, direction, msg_id) WHERE direction = 'in' AND msg_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  conv_type TEXT NOT NULL DEFAULT '',
  peer_id TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  handled TEXT NOT NULL DEFAULT '',
  reply_used INTEGER NOT NULL DEFAULT 0,
  reply_seq INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_bot ON events (bot_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON events (bot_id, event_id) WHERE event_id != '';
`);

db.exec(`
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload',
  source_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stickers (
  id INTEGER PRIMARY KEY,
  media_id INTEGER NOT NULL UNIQUE REFERENCES media(id),
  keywords TEXT NOT NULL DEFAULT '',
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media_uploads (
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conv_type TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  file_info TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, conv_type, peer_id, media_id)
);
`);

function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('conversations', 'at_unread', 'INTEGER NOT NULL DEFAULT 0');
addColumn('conversations', 'full_seen', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'totp_secret_enc', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT -1');
addColumn('users', 'recovery_hashes', "TEXT NOT NULL DEFAULT '[]'");

// 全文搜索：trigram 分词支持中文子串匹配（3 个字及以上）；rowid 即 messages.id
db.exec(`
CREATE TABLE IF NOT EXISTS quick_replies (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  markdown INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, author, tokenize = 'trigram')");

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
