import { db } from './db.js';

export const REPLY_RULES = {
  group: { windowMs: 5 * 60_000, max: 5 },
  c2c: { windowMs: 60 * 60_000, max: 4 },
};
// 可用 event_id 进行被动回复的事件
export const REPLYABLE_EVENTS = {
  group: ['GROUP_ADD_ROBOT', 'GROUP_MSG_RECEIVE', 'INTERACTION_CREATE'],
  c2c: ['FRIEND_ADD', 'C2C_MSG_RECEIVE', 'INTERACTION_CREATE'],
};
const EVENT_WINDOW_MS = 5 * 60_000;

export function publicBot(row, runtime) {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    avatar: row.avatar,
    botUserId: row.bot_user_id,
    mode: row.mode,
    intents: row.intents,
    apiBase: row.api_base,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    status: runtime?.status || 'offline',
    statusDetail: runtime?.statusDetail || '',
  };
}

export function msgRow(r) {
  if (!r) return null;
  let payload = {};
  try {
    payload = JSON.parse(r.payload || '{}');
  } catch {}
  return {
    id: r.id,
    botId: r.bot_id,
    convType: r.conv_type,
    peerId: r.peer_id,
    direction: r.direction,
    msgId: r.msg_id,
    authorId: r.author_id,
    authorName: r.author_name,
    authorRole: r.author_role,
    kind: r.kind,
    content: r.content,
    payload,
    refIdx: r.ref_idx,
    quoteIdx: r.quote_idx,
    replyUsed: r.reply_used,
    status: r.status,
    error: r.error,
    ts: r.ts,
  };
}

export function convRow(r, displayName) {
  return {
    botId: r.bot_id,
    type: r.type,
    peerId: r.peer_id,
    remark: r.remark,
    name: r.remark || displayName || defaultConvName(r.type, r.peer_id),
    status: r.status,
    lastTs: r.last_ts,
    lastPreview: r.last_preview,
    unread: r.unread,
    atUnread: !!r.at_unread,
    fullSeen: !!r.full_seen,
    hidden: !!r.hidden,
  };
}

export function defaultConvName(type, peer) {
  return `${type === 'group' ? '群' : '用户'} ${peer.slice(0, 6)}`;
}

export function upsertConversation(botId, type, peerId, patch = {}) {
  db.prepare(
    `INSERT INTO conversations (bot_id, type, peer_id) VALUES (?, ?, ?)
     ON CONFLICT (bot_id, type, peer_id) DO NOTHING`,
  ).run(botId, type, peerId);
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'unreadInc') {
      sets.push('unread = unread + ?');
      vals.push(v);
    } else {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE bot_id = ? AND type = ? AND peer_id = ?`).run(
      ...vals,
      botId,
      type,
      peerId,
    );
  }
  return getConversation(botId, type, peerId);
}

export function getConversation(botId, type, peerId) {
  const r = db
    .prepare('SELECT * FROM conversations WHERE bot_id = ? AND type = ? AND peer_id = ?')
    .get(botId, type, peerId);
  if (!r) return null;
  let display = '';
  if (type === 'c2c') {
    const m = db
      .prepare("SELECT author_name FROM messages WHERE bot_id = ? AND conv_type = 'c2c' AND peer_id = ? AND direction = 'in' AND author_name != '' ORDER BY id DESC LIMIT 1")
      .get(botId, peerId);
    display = m?.author_name || '';
  }
  return { ...convRow(r, display), replyWindow: replyWindow(botId, type, peerId), quota: activeQuota(botId, type, peerId) };
}

// 主动消息频控：单个群/用户每分钟 20 条、每天 1000 条
export const ACTIVE_LIMITS = { perMinute: 20, perDay: 1000 };

export function activeQuota(botId, type, peerId) {
  const now = Date.now();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const r = db
    .prepare(
      `SELECT COUNT(*) AS day, SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) AS minute FROM messages
       WHERE bot_id = ? AND conv_type = ? AND peer_id = ? AND direction = 'out' AND ts >= ?
         AND status IN ('ok', 'audit', 'recalled') AND json_extract(payload, '$.sendMode') = 'active'`,
    )
    .get(now - 60_000, botId, type, peerId, dayStart.getTime());
  return { day: r.day || 0, minute: r.minute || 0, ...ACTIVE_LIMITS };
}

export function listConversations(botId) {
  const rows = db
    .prepare('SELECT * FROM conversations WHERE bot_id = ? ORDER BY last_ts DESC')
    .all(botId);
  return rows.map((r) => getConversation(botId, r.type, r.peer_id));
}

export function upsertMember(botId, groupId, member) {
  if (!member?.id) return;
  db.prepare(
    `INSERT INTO members (bot_id, group_id, member_id, username, role, is_bot, in_group, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (bot_id, group_id, member_id) DO UPDATE SET
       username = CASE WHEN excluded.username != '' THEN excluded.username ELSE members.username END,
       role = CASE WHEN excluded.role != '' THEN excluded.role ELSE members.role END,
       is_bot = excluded.is_bot,
       in_group = excluded.in_group,
       last_seen = CASE WHEN excluded.last_seen > members.last_seen THEN excluded.last_seen ELSE members.last_seen END`,
  ).run(
    botId,
    groupId,
    member.id,
    member.username || '',
    member.role || '',
    member.bot ? 1 : 0,
    member.inGroup === false ? 0 : 1,
    member.lastSeen || 0,
  );
}

export function listMembers(botId, groupId) {
  return db
    .prepare('SELECT * FROM members WHERE bot_id = ? AND group_id = ? ORDER BY in_group DESC, last_seen DESC')
    .all(botId, groupId)
    .map((m) => ({
      memberId: m.member_id,
      username: m.username,
      remark: m.remark,
      name: m.remark || m.username || `成员 ${m.member_id.slice(0, 6)}`,
      role: m.role,
      bot: !!m.is_bot,
      inGroup: !!m.in_group,
      lastSeen: m.last_seen,
    }));
}

export function memberName(botId, groupId, memberId) {
  const m = db
    .prepare('SELECT username, remark FROM members WHERE bot_id = ? AND group_id = ? AND member_id = ?')
    .get(botId, groupId, memberId);
  return m?.remark || m?.username || `成员 ${String(memberId).slice(0, 6)}`;
}

export function insertMessage(m) {
  const r = db
    .prepare(
      `INSERT INTO messages (bot_id, conv_type, peer_id, direction, msg_id, author_id, author_name, author_role,
         kind, content, payload, ref_idx, quote_idx, status, error, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      m.botId,
      m.convType,
      m.peerId,
      m.direction,
      m.msgId ?? null,
      m.authorId || '',
      m.authorName || '',
      m.authorRole || '',
      m.kind || 'text',
      m.content || '',
      JSON.stringify(m.payload || {}),
      m.refIdx || '',
      m.quoteIdx || '',
      m.status || 'ok',
      m.error || '',
      m.ts || Date.now(),
    );
  if (!r.changes) return null;
  const row = msgRow(db.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid));
  indexMessage(row);
  return row;
}

export function findMessageByMsgId(botId, msgId) {
  return msgRow(
    db.prepare("SELECT * FROM messages WHERE bot_id = ? AND direction = 'in' AND msg_id = ?").get(botId, msgId),
  );
}

export function getMessage(id) {
  return msgRow(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
}

export function updateMessage(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return getMessage(id);
  db.prepare(`UPDATE messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...keys.map((k) => (typeof patch[k] === 'object' && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k])),
    id,
  );
  return getMessage(id);
}

export function listMessages(botId, type, peerId, { before, limit = 50 } = {}) {
  const rows = before
    ? db
        .prepare('SELECT * FROM messages WHERE bot_id = ? AND conv_type = ? AND peer_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
        .all(botId, type, peerId, before, limit)
    : db
        .prepare('SELECT * FROM messages WHERE bot_id = ? AND conv_type = ? AND peer_id = ? ORDER BY id DESC LIMIT ?')
        .all(botId, type, peerId, limit);
  return rows.reverse().map(msgRow);
}

// 找出可用于被动回复的来源：优先最近一条收到的消息，其次可回复事件
export function findReplySource(botId, type, peerId, { msgRowId } = {}) {
  const rule = REPLY_RULES[type];
  const now = Date.now();
  if (msgRowId) {
    const m = db.prepare("SELECT * FROM messages WHERE id = ? AND direction = 'in'").get(msgRowId);
    if (m && m.msg_id && now - m.ts < rule.windowMs && m.reply_used < rule.max) {
      return { kind: 'msg', row: m, remaining: rule.max - m.reply_used, expiresAt: m.ts + rule.windowMs };
    }
  }
  // 全量模式下优先使用 @机器人 的消息，其次是最近的普通消息
  const m = db
    .prepare(
      `SELECT * FROM messages WHERE bot_id = ? AND conv_type = ? AND peer_id = ? AND direction = 'in'
         AND msg_id IS NOT NULL AND ts > ? AND reply_used < ?
       ORDER BY (json_extract(payload, '$.eventType') = 'GROUP_MESSAGE_CREATE'
                 AND COALESCE(json_extract(payload, '$.atBot'), 0) = 0) ASC, id DESC LIMIT 1`,
    )
    .get(botId, type, peerId, now - rule.windowMs, rule.max);
  if (m) return { kind: 'msg', row: m, remaining: rule.max - m.reply_used, expiresAt: m.ts + rule.windowMs };
  const types = REPLYABLE_EVENTS[type];
  const e = db
    .prepare(
      `SELECT * FROM events WHERE bot_id = ? AND conv_type = ? AND peer_id = ? AND event_id != ''
         AND type IN (${types.map(() => '?').join(',')}) AND ts > ? AND reply_used < ? ORDER BY id DESC LIMIT 1`,
    )
    .get(botId, type, peerId, ...types, now - EVENT_WINDOW_MS, rule.max);
  if (e) return { kind: 'event', row: e, remaining: rule.max - e.reply_used, expiresAt: e.ts + EVENT_WINDOW_MS };
  return null;
}

export function replyWindow(botId, type, peerId) {
  const src = findReplySource(botId, type, peerId);
  if (!src) return null;
  return { kind: src.kind, remaining: src.remaining, expiresAt: src.expiresAt };
}

export function consumeReply(src) {
  const table = src.kind === 'msg' ? 'messages' : 'events';
  db.prepare(`UPDATE ${table} SET reply_seq = reply_seq + 1 WHERE id = ?`).run(src.row.id);
  return db.prepare(`SELECT reply_seq FROM ${table} WHERE id = ?`).get(src.row.id).reply_seq;
}

export function markReplyUsed(src) {
  const table = src.kind === 'msg' ? 'messages' : 'events';
  db.prepare(`UPDATE ${table} SET reply_used = reply_used + 1 WHERE id = ?`).run(src.row.id);
}

// 被动回复被平台拒绝后，不再用这条消息/事件尝试被动回复
export function exhaustReply(src) {
  const table = src.kind === 'msg' ? 'messages' : 'events';
  db.prepare(`UPDATE ${table} SET reply_used = 99 WHERE id = ?`).run(src.row.id);
}

export function insertEvent(e) {
  const r = db
    .prepare(
      `INSERT INTO events (bot_id, event_id, type, conv_type, peer_id, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(e.botId, e.eventId || '', e.type, e.convType || '', e.peerId || '', JSON.stringify(e.data || {}), e.ts || Date.now());
  if (!r.changes) return null;
  return eventRow(db.prepare('SELECT * FROM events WHERE id = ?').get(r.lastInsertRowid));
}

export function eventRow(r) {
  if (!r) return null;
  let data = {};
  try {
    data = JSON.parse(r.data);
  } catch {}
  return {
    id: r.id,
    botId: r.bot_id,
    eventId: r.event_id,
    type: r.type,
    convType: r.conv_type,
    peerId: r.peer_id,
    data,
    handled: r.handled,
    ts: r.ts,
  };
}

export function listEvents(botId, { before, limit = 100, type } = {}) {
  const conds = ['bot_id = ?'];
  const vals = [botId];
  if (before) {
    conds.push('id < ?');
    vals.push(before);
  }
  if (type) {
    conds.push('type = ?');
    vals.push(type);
  }
  return db
    .prepare(`SELECT * FROM events WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...vals, limit)
    .map(eventRow);
}

// ---------------- 搜索 ----------------
export function searchText(content) {
  return String(content || '')
    .replace(/<qqbot-at-user id="[^"]*"\s*\/>/g, ' ')
    .replace(/<@!?[^>]+>/g, ' ')
    .replace(/<qqbot-at-everyone\s*\/>/g, ' ')
    .replace(/<faceType=[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function indexMessage(m) {
  if (!m || m.direction === 'system' && !m.content) return;
  db.prepare('INSERT OR REPLACE INTO messages_fts (rowid, text, author) VALUES (?, ?, ?)').run(
    m.id,
    searchText(m.content),
    m.authorName || '',
  );
}

// 启动时为尚未建索引的历史消息补建索引
export function backfillSearchIndex() {
  const rows = db
    .prepare('SELECT id, content, author_name FROM messages WHERE id > COALESCE((SELECT MAX(rowid) FROM messages_fts), 0) ORDER BY id')
    .all();
  if (!rows.length) return 0;
  const ins = db.prepare('INSERT OR REPLACE INTO messages_fts (rowid, text, author) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const r of rows) ins.run(r.id, searchText(r.content), r.author_name || '');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

export function searchMessages(botId, query, { convType, peerId, limit = 50 } = {}) {
  const q = String(query || '').trim().slice(0, 100);
  if (!q) return [];
  const filters = ['m.bot_id = ?', "m.direction != 'system'"];
  const vals = [botId];
  if (convType && peerId) {
    filters.push('m.conv_type = ? AND m.peer_id = ?');
    vals.push(convType, peerId);
  }
  let rows;
  if ([...q].length >= 3) {
    // 每个词作为短语匹配，避免 FTS 语法注入
    const terms = q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`);
    const short = terms.some((t) => [...t].length < 5);
    if (!short) {
      rows = db
        .prepare(
          `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH ? AND ${filters.join(' AND ')} ORDER BY m.id DESC LIMIT ?`,
        )
        .all(terms.join(' AND '), ...vals, limit);
    }
  }
  if (!rows) {
    // 1~2 个字的关键词 trigram 无法匹配，退回 LIKE 扫描
    const like = `%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
    rows = db
      .prepare(
        `SELECT m.* FROM messages m WHERE ${filters.join(' AND ')}
         AND (m.content LIKE ? ESCAPE '!' OR m.author_name LIKE ? ESCAPE '!') ORDER BY m.id DESC LIMIT ?`,
      )
      .all(...vals, like, like, limit);
  }
  return rows.map(msgRow);
}

export function listMessagesAround(botId, type, peerId, aroundId, limit = 60) {
  const half = Math.floor(limit / 2);
  const before = db
    .prepare('SELECT * FROM messages WHERE bot_id = ? AND conv_type = ? AND peer_id = ? AND id <= ? ORDER BY id DESC LIMIT ?')
    .all(botId, type, peerId, aroundId, half);
  const after = db
    .prepare('SELECT * FROM messages WHERE bot_id = ? AND conv_type = ? AND peer_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
    .all(botId, type, peerId, aroundId, limit - half);
  return [...before.reverse(), ...after].map(msgRow);
}

export function listMessagesAll(botId, type, peerId) {
  return db
    .prepare('SELECT * FROM messages WHERE bot_id = ? AND conv_type = ? AND peer_id = ? ORDER BY id')
    .all(botId, type, peerId)
    .map(msgRow);
}
