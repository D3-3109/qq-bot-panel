// 自动化：定时消息、关键词自动回复、把消息/事件转发给外部程序
import crypto from 'node:crypto';
import { db } from './db.js';
import { HttpError, str } from './http.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { sendMessage } from './sender.js';
import { searchText, getConversation } from './store.js';
import { botLog } from './bots.js';
import { messageHooks, eventHooks } from './events.js';
import { broadcast } from './hub.js';
import { pushAll, countSubscriptions } from './webpush.js';

db.exec(`
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conv_type TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  markdown INTEGER NOT NULL DEFAULT 0,
  sticker_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'once',
  run_at INTEGER NOT NULL DEFAULT 0,
  time_of_day TEXT NOT NULL DEFAULT '',
  weekdays INTEGER NOT NULL DEFAULT 127,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run INTEGER NOT NULL DEFAULT 0,
  last_run INTEGER NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auto_rules (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  match_type TEXT NOT NULL DEFAULT 'contains',
  pattern TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'all',
  peer_id TEXT NOT NULL DEFAULT '',
  require_at INTEGER NOT NULL DEFAULT 1,
  reply_text TEXT NOT NULL DEFAULT '',
  reply_markdown INTEGER NOT NULL DEFAULT 0,
  sticker_id INTEGER,
  cooldown_sec INTEGER NOT NULL DEFAULT 10,
  hits INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);
for (const [col, def] of [
  ['forward_url', "TEXT NOT NULL DEFAULT ''"],
  ['forward_secret_enc', "TEXT NOT NULL DEFAULT ''"],
  ['forward_mode', "TEXT NOT NULL DEFAULT 'at'"],
  ['forward_events', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  const cols = db.prepare('PRAGMA table_info(bots)').all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE bots ADD COLUMN ${col} ${def}`);
}

const CONV_TYPES = ['group', 'c2c'];
const peerOk = (p) => /^[A-Za-z0-9_\-=]{1,128}$/.test(p);

// ================= 定时消息 =================
const MISS_TOLERANCE_MS = 10 * 60_000;

function parseTime(t) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t || ''));
  if (!m) throw new HttpError(400, '时间格式应为 HH:MM');
  return [Number(m[1]), Number(m[2])];
}

// 计算 from 之后的下一次运行时间（服务器本地时区）；返回 0 表示不再运行
export function computeNext(s, from = Date.now()) {
  if (s.kind === 'once') return s.run_at > from ? s.run_at : 0;
  const [hh, mm] = parseTime(s.time_of_day);
  for (let i = 0; i <= 8; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= from) continue;
    if (s.kind === 'weekly' && !(s.weekdays & (1 << d.getDay()))) continue;
    return d.getTime();
  }
  return 0;
}

function scheduleOut(r) {
  if (!r) return null;
  const conv = getConversation(r.bot_id, r.conv_type, r.peer_id);
  return {
    id: r.id,
    botId: r.bot_id,
    convType: r.conv_type,
    peerId: r.peer_id,
    convName: conv?.name || r.peer_id.slice(0, 8),
    name: r.name,
    text: r.text,
    markdown: !!r.markdown,
    stickerId: r.sticker_id,
    kind: r.kind,
    runAt: r.run_at,
    timeOfDay: r.time_of_day,
    weekdays: r.weekdays,
    enabled: !!r.enabled,
    nextRun: r.next_run,
    lastRun: r.last_run,
    lastStatus: r.last_status,
  };
}

export function listSchedules(botId) {
  return db.prepare('SELECT * FROM schedules WHERE bot_id = ? ORDER BY enabled DESC, next_run').all(botId).map(scheduleOut);
}

export function saveSchedule(botId, input, id) {
  const cur = id ? db.prepare('SELECT * FROM schedules WHERE id = ? AND bot_id = ?').get(id, botId) : null;
  if (id && !cur) throw new HttpError(404, '定时消息不存在');
  const s = {
    conv_type: input.convType ?? cur?.conv_type,
    peer_id: input.peerId ?? cur?.peer_id,
    name: str(input.name ?? cur?.name ?? '', 60),
    text: str(input.text ?? cur?.text ?? '', 5000),
    markdown: (input.markdown ?? !!cur?.markdown) ? 1 : 0,
    sticker_id: input.stickerId !== undefined ? Number(input.stickerId) || null : cur?.sticker_id ?? null,
    kind: input.kind ?? cur?.kind ?? 'once',
    run_at: Number(input.runAt ?? cur?.run_at ?? 0),
    time_of_day: String(input.timeOfDay ?? cur?.time_of_day ?? ''),
    weekdays: Number(input.weekdays ?? cur?.weekdays ?? 127) & 127,
    enabled: (input.enabled ?? (cur ? !!cur.enabled : true)) ? 1 : 0,
  };
  if (!CONV_TYPES.includes(s.conv_type) || !peerOk(s.peer_id)) throw new HttpError(400, '请选择会话');
  if (!s.text.trim() && !s.sticker_id) throw new HttpError(400, '请填写内容或选择表情');
  if (!['once', 'daily', 'weekly'].includes(s.kind)) throw new HttpError(400, '重复方式无效');
  if (s.kind === 'once' && !(s.run_at > 0)) throw new HttpError(400, '请选择发送时间');
  if (s.kind !== 'once') parseTime(s.time_of_day);
  if (s.kind === 'weekly' && !s.weekdays) throw new HttpError(400, '请至少选择一天');
  s.next_run = s.enabled ? computeNext(s) : 0;
  if (s.enabled && !s.next_run) throw new HttpError(400, '发送时间已过去');
  const keys = Object.keys(s);
  if (cur) {
    db.prepare(`UPDATE schedules SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => s[k]), id);
  } else {
    const r = db
      .prepare(`INSERT INTO schedules (bot_id, ${keys.join(', ')}, created_at) VALUES (?, ${keys.map(() => '?').join(', ')}, ?)`)
      .run(botId, ...keys.map((k) => s[k]), Date.now());
    id = Number(r.lastInsertRowid);
  }
  return scheduleOut(db.prepare('SELECT * FROM schedules WHERE id = ?').get(id));
}

export function deleteSchedule(botId, id) {
  if (!db.prepare('DELETE FROM schedules WHERE id = ? AND bot_id = ?').run(id, botId).changes) throw new HttpError(404, '定时消息不存在');
}

async function runSchedule(s, now) {
  // 先推进下一次时间，避免发送耗时期间被重复触发
  const next = computeNext(s, now);
  db.prepare('UPDATE schedules SET next_run = ?, enabled = ? WHERE id = ?').run(next, next ? s.enabled : 0, s.id);
  let status;
  if (now - s.next_run > MISS_TOLERANCE_MS) {
    status = `已跳过：错过了 ${new Date(s.next_run).toLocaleString()} 的发送（面板当时未运行）`;
  } else {
    try {
      const msg = await sendMessage(s.bot_id, s.conv_type, s.peer_id, {
        text: s.text,
        markdown: !!s.markdown,
        stickerId: s.sticker_id || undefined,
        replyMode: 'auto',
        origin: 'schedule',
      });
      status = msg.status === 'audit' ? '已提交，等待审核' : '已发送';
    } catch (e) {
      status = `发送失败：${e.message}`;
    }
  }
  db.prepare('UPDATE schedules SET last_run = ?, last_status = ? WHERE id = ?').run(now, status, s.id);
  botLog(s.bot_id, status.startsWith('已发送') ? 'info' : 'warn', `定时消息「${s.name || s.text.slice(0, 20)}」${status}`);
  broadcast('schedules', { botId: s.bot_id });
}

let ticking = false;
export async function tickSchedules(now = Date.now()) {
  if (ticking) return;
  ticking = true;
  try {
    const due = db
      .prepare('SELECT s.* FROM schedules s JOIN bots b ON b.id = s.bot_id WHERE s.enabled = 1 AND s.next_run > 0 AND s.next_run <= ? AND b.enabled = 1')
      .all(now);
    for (const s of due) await runSchedule(s, now);
  } finally {
    ticking = false;
  }
}

// ================= 关键词自动回复 =================
function ruleOut(r) {
  return r && {
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    matchType: r.match_type,
    pattern: r.pattern,
    scope: r.scope,
    peerId: r.peer_id,
    requireAt: !!r.require_at,
    replyText: r.reply_text,
    replyMarkdown: !!r.reply_markdown,
    stickerId: r.sticker_id,
    cooldownSec: r.cooldown_sec,
    hits: r.hits,
  };
}

export function listRules(botId) {
  return db.prepare('SELECT * FROM auto_rules WHERE bot_id = ? ORDER BY sort, id').all(botId).map(ruleOut);
}

export function saveRule(botId, input, id) {
  const cur = id ? db.prepare('SELECT * FROM auto_rules WHERE id = ? AND bot_id = ?').get(id, botId) : null;
  if (id && !cur) throw new HttpError(404, '规则不存在');
  const v = (k, ck, d) => (input[k] !== undefined ? input[k] : cur ? cur[ck] : d);
  const r = {
    name: str(v('name', 'name', ''), 60),
    enabled: v('enabled', 'enabled', true) ? 1 : 0,
    match_type: v('matchType', 'match_type', 'contains'),
    pattern: str(v('pattern', 'pattern', ''), 500),
    scope: v('scope', 'scope', 'all'),
    peer_id: str(v('peerId', 'peer_id', ''), 128),
    require_at: v('requireAt', 'require_at', true) ? 1 : 0,
    reply_text: str(v('replyText', 'reply_text', ''), 5000),
    reply_markdown: v('replyMarkdown', 'reply_markdown', false) ? 1 : 0,
    sticker_id: Number(v('stickerId', 'sticker_id', null)) || null,
    cooldown_sec: Math.max(0, Math.min(86400, Number(v('cooldownSec', 'cooldown_sec', 10)) || 0)),
  };
  if (!['contains', 'exact', 'prefix', 'regex', 'any'].includes(r.match_type)) throw new HttpError(400, '匹配方式无效');
  if (r.match_type !== 'any' && !r.pattern.trim()) throw new HttpError(400, '请填写关键词');
  if (r.match_type === 'regex') {
    try {
      new RegExp(r.pattern, 'i');
    } catch (e) {
      throw new HttpError(400, `正则表达式无效：${e.message}`);
    }
  }
  if (!['all', 'group', 'c2c'].includes(r.scope)) throw new HttpError(400, '适用范围无效');
  if (r.peer_id && !peerOk(r.peer_id)) throw new HttpError(400, '会话 OpenID 格式不正确');
  if (!r.reply_text.trim() && !r.sticker_id) throw new HttpError(400, '请填写回复内容或选择表情');
  const keys = Object.keys(r);
  if (cur) {
    db.prepare(`UPDATE auto_rules SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => r[k]), id);
  } else {
    const res = db
      .prepare(`INSERT INTO auto_rules (bot_id, ${keys.join(', ')}, created_at) VALUES (?, ${keys.map(() => '?').join(', ')}, ?)`)
      .run(botId, ...keys.map((k) => r[k]), Date.now());
    id = Number(res.lastInsertRowid);
  }
  return ruleOut(db.prepare('SELECT * FROM auto_rules WHERE id = ?').get(id));
}

export function deleteRule(botId, id) {
  if (!db.prepare('DELETE FROM auto_rules WHERE id = ? AND bot_id = ?').run(id, botId).changes) throw new HttpError(404, '规则不存在');
}

export function matchRule(rule, text) {
  const t = text.trim();
  const p = rule.pattern.trim();
  switch (rule.match_type) {
    case 'any':
      return true;
    case 'exact':
      return t.toLowerCase() === p.toLowerCase();
    case 'prefix':
      return t.toLowerCase().startsWith(p.toLowerCase());
    case 'regex':
      try {
        return new RegExp(p, 'i').test(t.slice(0, 2000));
      } catch {
        return false;
      }
    default:
      return p.split(/[|｜]/).some((k) => k.trim() && t.toLowerCase().includes(k.trim().toLowerCase()));
  }
}

// 回复模板：{name} 发送者昵称，{at} @发送者（群聊），{time} 当前时间
function renderTemplate(tpl, msg) {
  let usesAt = false;
  const out = tpl
    .replace(/\{name\}/g, msg.authorName || '你')
    .replace(/\{time\}/g, new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
    .replace(/\{at\}/g, () => {
      if (msg.convType !== 'group' || !msg.authorId) return '';
      usesAt = true;
      return `<qqbot-at-user id="${msg.authorId}" />`;
    });
  return { text: out, usesAt };
}

const cooldowns = new Map();

async function runRules(msg) {
  // 群里的其他机器人也可能触发规则，互相自动回复会形成死循环
  if (msg.payload.authorIsBot) return;
  const text = searchText(msg.content);
  const rules = db.prepare('SELECT * FROM auto_rules WHERE bot_id = ? AND enabled = 1 ORDER BY sort, id').all(msg.botId);
  for (const rule of rules) {
    if (rule.scope !== 'all' && rule.scope !== msg.convType) continue;
    if (rule.peer_id && rule.peer_id !== msg.peerId) continue;
    // 全量模式下群里每条消息都会推送，默认只响应 @机器人 的消息，避免刷屏
    if (msg.convType === 'group' && rule.require_at && !msg.payload.atBot) continue;
    if (!matchRule(rule, text)) continue;
    const key = `${rule.id}:${msg.convType}:${msg.peerId}`;
    const last = cooldowns.get(key) || 0;
    if (Date.now() - last < rule.cooldown_sec * 1000) return;
    cooldowns.set(key, Date.now());
    const { text: reply, usesAt } = renderTemplate(rule.reply_text, msg);
    db.prepare('UPDATE auto_rules SET hits = hits + 1 WHERE id = ?').run(rule.id);
    try {
      await sendMessage(msg.botId, msg.convType, msg.peerId, {
        text: reply,
        markdown: !!rule.reply_markdown || usesAt,
        stickerId: !reply.trim() && rule.sticker_id ? rule.sticker_id : undefined,
        replyMode: 'passive',
        replyToRowId: msg.id,
        origin: 'auto',
      });
      // 文字和表情都设置时，表情作为第二条被动回复
      if (reply.trim() && rule.sticker_id) {
        await sendMessage(msg.botId, msg.convType, msg.peerId, {
          stickerId: rule.sticker_id,
          replyMode: 'passive',
          replyToRowId: msg.id,
          origin: 'auto',
        });
      }
      botLog(msg.botId, 'info', `自动回复规则「${rule.name || rule.pattern}」已触发`);
    } catch (e) {
      botLog(msg.botId, 'warn', `自动回复规则「${rule.name || rule.pattern}」发送失败：${e.message}`);
    }
    return; // 只执行第一条命中的规则
  }
}

// ================= 转发给外部程序 =================
export function getForward(botId) {
  const b = db.prepare('SELECT forward_url, forward_secret_enc, forward_mode, forward_events FROM bots WHERE id = ?').get(botId);
  if (!b) throw new HttpError(404, '机器人不存在');
  return { url: b.forward_url, hasSecret: !!b.forward_secret_enc, mode: b.forward_mode, events: !!b.forward_events };
}

export function saveForward(botId, input) {
  getForward(botId);
  const url = String(input.url ?? '').trim();
  if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw new HttpError(400, '转发地址必须是 http(s) 网址');
  const mode = ['at', 'all'].includes(input.mode) ? input.mode : 'at';
  db.prepare('UPDATE bots SET forward_url = ?, forward_mode = ?, forward_events = ? WHERE id = ?').run(url, mode, input.events ? 1 : 0, botId);
  if (input.secret !== undefined && input.secret !== '') {
    db.prepare('UPDATE bots SET forward_secret_enc = ? WHERE id = ?').run(encryptSecret(String(input.secret).slice(0, 200)), botId);
  }
  if (input.clearSecret) db.prepare("UPDATE bots SET forward_secret_enc = '' WHERE id = ?").run(botId);
  return getForward(botId);
}

// 发送 POST 请求；外部程序可在响应中返回 {"reply": "文字"} 或 {"reply": {"text", "markdown", "stickerId"}}
async function postForward(botId, payload) {
  const b = db.prepare('SELECT id, app_id, name, forward_url, forward_secret_enc FROM bots WHERE id = ?').get(botId);
  if (!b?.forward_url) return null;
  const body = JSON.stringify({ ...payload, bot: { id: b.id, appId: b.app_id, name: b.name } });
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'qq-bot-panel', 'X-Panel-Timestamp': ts };
  if (b.forward_secret_enc) {
    const sig = crypto.createHmac('sha256', decryptSecret(b.forward_secret_enc)).update(`${ts}.${body}`).digest('hex');
    headers['X-Panel-Signature'] = `sha256=${sig}`;
  }
  const res = await fetch(b.forward_url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 100)}` : ''}`);
  if (!text.trim()) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const reply = data?.reply;
  if (!reply) return null;
  if (typeof reply === 'string') return { text: reply };
  return { text: String(reply.text || ''), markdown: !!reply.markdown, stickerId: Number(reply.stickerId) || undefined };
}

function msgPayload(msg) {
  const conv = getConversation(msg.botId, msg.convType, msg.peerId);
  return {
    type: 'message',
    conversation: { type: msg.convType, peerId: msg.peerId, name: conv?.name || '' },
    message: {
      id: msg.id,
      msgId: msg.msgId,
      authorId: msg.authorId,
      authorName: msg.authorName,
      authorRole: msg.authorRole,
      atBot: !!msg.payload.atBot,
      content: msg.content,
      text: searchText(msg.content),
      attachments: (msg.payload.attachments || []).map((a) => ({ contentType: a.content_type, url: a.url, filename: a.filename, mediaId: a.mediaId })),
      ts: msg.ts,
    },
  };
}

async function forwardMessage(msg) {
  const b = db.prepare('SELECT forward_url, forward_mode FROM bots WHERE id = ?').get(msg.botId);
  if (!b?.forward_url) return;
  // 其他机器人的消息仍会转发给外部程序，但不会把外部程序的回复发回群里，避免两个机器人互相回复
  const fromBot = !!msg.payload.authorIsBot;
  if (b.forward_mode === 'at' && msg.convType === 'group' && !msg.payload.atBot) return;
  try {
    const reply = await postForward(msg.botId, msgPayload(msg));
    if (!fromBot && reply && (reply.text.trim() || reply.stickerId)) {
      await sendMessage(msg.botId, msg.convType, msg.peerId, {
        text: reply.text,
        markdown: reply.markdown,
        stickerId: !reply.text.trim() ? reply.stickerId : undefined,
        replyMode: 'passive',
        replyToRowId: msg.id,
        origin: 'forward',
      });
    }
  } catch (e) {
    botLog(msg.botId, 'warn', `转发消息到外部程序失败：${e.message}`);
  }
}

async function forwardEvent(botId, ev) {
  const b = db.prepare('SELECT forward_url, forward_events FROM bots WHERE id = ?').get(botId);
  if (!b?.forward_url || !b.forward_events) return;
  try {
    await postForward(botId, { type: 'event', event: { id: ev.id, type: ev.type, convType: ev.convType, peerId: ev.peerId, data: ev.data, ts: ev.ts } });
  } catch (e) {
    botLog(botId, 'warn', `转发事件 ${ev.type} 失败：${e.message}`);
  }
}

export async function testForward(botId) {
  const reply = await postForward(botId, {
    type: 'test',
    conversation: { type: 'group', peerId: 'TEST', name: '测试会话' },
    message: { id: 0, authorId: 'TEST', authorName: '面板测试', atBot: true, content: 'ping', text: 'ping', attachments: [], ts: Date.now() },
  });
  return { ok: true, reply };
}

// ================= 启动 =================
let timer = null;
export function startAutomation() {
  messageHooks.push((msg) => {
    if (msg.direction !== 'in') return;
    // 自动回复和转发都在后台执行，不阻塞事件处理
    runRules(msg).catch((e) => console.error('auto rule error', e));
    forwardMessage(msg).catch((e) => console.error('forward error', e));
    // 私聊和 @机器人 的消息推送到手机/桌面通知
    if ((msg.convType === 'c2c' || msg.payload.atBot) && countSubscriptions()) {
      const conv = getConversation(msg.botId, msg.convType, msg.peerId);
      const body = searchText(msg.content) || (msg.payload.attachments?.length ? '[图片/文件]' : '');
      const who = msg.convType === 'group' ? `${msg.authorName || '成员'}：` : '';
      pushAll({
        title: conv?.name || '新消息',
        body: `${who}${body}`.slice(0, 120),
        tag: `${msg.convType}:${msg.peerId}`,
        url: `/#${msg.convType}/${msg.peerId}`,
      }).catch((e) => console.error('push error', e));
    }
  });
  eventHooks.push((botId, ev) => forwardEvent(botId, ev).catch(() => {}));
  // 启动时补算下一次运行时间（服务器停机期间可能错过）
  tickSchedules().catch((e) => console.error('schedule error', e));
  // SCHEDULE_TICK_MS 仅用于测试时缩短检查间隔
  const tick = Number(process.env.SCHEDULE_TICK_MS) || 15_000;
  timer = setInterval(() => tickSchedules().catch((e) => console.error('schedule error', e)), tick);
  timer.unref();
}
