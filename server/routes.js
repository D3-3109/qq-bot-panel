import { db } from './db.js';
import { Router, HttpError, readJson, str } from './http.js';
import * as auth from './auth.js';
import * as bots from './bots.js';
import * as store from './store.js';
import { sendMessage, recallMessage } from './sender.js';
import { addClient, broadcast } from './hub.js';
import fs from 'node:fs';
import { readBody } from './http.js';
import * as media from './media.js';
import * as stickers from './stickers.js';
import { streamBackup, exportConversation } from './backup.js';
import * as automation from './automation.js';
import * as webpush from './webpush.js';

export const router = new Router();
const r = (method, path, handler, opts) => router.add(method, path, handler, opts);

const botId = (p) => {
  const id = Number(p.id);
  if (!Number.isInteger(id)) throw new HttpError(400, '机器人 ID 无效');
  bots.getBot(id);
  return id;
};
const convType = (t) => {
  if (!['group', 'c2c'].includes(t)) throw new HttpError(400, '会话类型无效');
  return t;
};
const peer = (p) => {
  const v = str(p, 128);
  if (!/^[A-Za-z0-9_\-=]+$/.test(v)) throw new HttpError(400, 'OpenID 格式不正确');
  return v;
};

// ---- 认证 ----
r('POST', '/api/login', async (req, res) => {
  const body = await readJson(req);
  return auth.login(req, res, body.username, body.password, body.code);
}, { public: true });

r('POST', '/api/logout', async (req, res) => {
  auth.logout(req, res);
  return { ok: true };
}, { public: true });

r('GET', '/api/me', async (req, res, { user }) => ({ username: user.username }));

r('POST', '/api/password', async (req, res, { user }) => {
  const body = await readJson(req);
  auth.changePassword(user, body.oldPassword, body.newPassword);
  auth.logout(req, res);
  return { ok: true };
});

r('GET', '/api/2fa', async (req, res, { user }) => auth.twoFactorStatus(user));
r('POST', '/api/2fa/setup', async (req, res, { user }) => auth.startTwoFactor(user));
r('POST', '/api/2fa/enable', async (req, res, { user }) => auth.enableTwoFactor(user, (await readJson(req)).code));
r('POST', '/api/2fa/disable', async (req, res, { user }) => {
  const body = await readJson(req);
  auth.disableTwoFactor(user, body.password, body.code);
  return { ok: true };
});

r('GET', '/api/stream', async (req, res) => {
  addClient(req, res);
  return undefined;
});

// ---- 机器人 ----
r('GET', '/api/bots', async () => bots.listBots());
r('POST', '/api/bots', async (req) => bots.addBot(await readJson(req)));
r('GET', '/api/bots/:id', async (req, res, { params }) => bots.getBot(botId(params)));
r('PATCH', '/api/bots/:id', async (req, res, { params }) => bots.updateBot(botId(params), await readJson(req)));
r('DELETE', '/api/bots/:id', async (req, res, { params }) => {
  bots.deleteBot(botId(params));
  return { ok: true };
});
r('POST', '/api/bots/:id/restart', async (req, res, { params }) => bots.restartBot(botId(params)));
r('GET', '/api/bots/:id/logs', async (req, res, { params }) => bots.getLogs(botId(params)));

// ---- 会话 ----
r('GET', '/api/bots/:id/conversations', async (req, res, { params }) => store.listConversations(botId(params)));

r('POST', '/api/bots/:id/conversations', async (req, res, { params }) => {
  const id = botId(params);
  const body = await readJson(req);
  const conv = store.upsertConversation(id, convType(body.type), peer(body.peerId), {
    remark: str(body.remark, 60),
    hidden: 0,
  });
  broadcast('conversation', conv);
  return conv;
});

r('PATCH', '/api/bots/:id/conversations/:type/:peer', async (req, res, { params }) => {
  const id = botId(params);
  const body = await readJson(req);
  const patch = {};
  if (body.remark !== undefined) patch.remark = str(body.remark, 60);
  if (body.hidden !== undefined) patch.hidden = body.hidden ? 1 : 0;
  if (body.read) {
    patch.unread = 0;
    patch.at_unread = 0;
  }
  const conv = store.upsertConversation(id, convType(params.type), peer(params.peer), patch);
  broadcast('conversation', conv);
  return conv;
});

r('GET', '/api/bots/:id/conversations/:type/:peer/messages', async (req, res, { params, query }) => {
  const id = botId(params);
  const before = Number(query.get('before')) || undefined;
  const limit = Math.min(200, Number(query.get('limit')) || 50);
  const around = Number(query.get('around')) || 0;
  if (around) return store.listMessagesAround(id, convType(params.type), peer(params.peer), around, limit);
  return store.listMessages(id, convType(params.type), peer(params.peer), { before, limit });
});

r('POST', '/api/bots/:id/conversations/:type/:peer/messages', async (req, res, { params }) => {
  const id = botId(params);
  const body = await readJson(req, 8 * 1024 * 1024);
  return sendMessage(id, convType(params.type), peer(params.peer), body);
}, { bodyLimit: 8 * 1024 * 1024 });

r('GET', '/api/bots/:id/conversations/:type/:peer/window', async (req, res, { params }) =>
  store.replyWindow(botId(params), convType(params.type), peer(params.peer)));

r('POST', '/api/bots/:id/messages/:mid/recall', async (req, res, { params }) =>
  recallMessage(botId(params), Number(params.mid)));

r('GET', '/api/bots/:id/search', async (req, res, { params, query }) => {
  const id = botId(params);
  const t = query.get('type');
  const p = query.get('peer');
  return store.searchMessages(id, query.get('q'), {
    convType: t ? convType(t) : undefined,
    peerId: p ? peer(p) : undefined,
    limit: Math.min(100, Number(query.get('limit')) || 50),
  });
});

// ---- 群成员 ----
r('GET', '/api/bots/:id/groups/:peer/members', async (req, res, { params }) =>
  store.listMembers(botId(params), peer(params.peer)));

r('POST', '/api/bots/:id/groups/:peer/members/sync', async (req, res, { params }) => {
  const id = botId(params);
  const gid = peer(params.peer);
  const rt = bots.runtime(id);
  let cursor = '';
  let count = 0;
  for (let page = 0; page < 100; page++) {
    let data;
    try {
      data = await rt.api.groupMembers(gid, cursor);
    } catch (e) {
      throw new HttpError(502, `拉取群成员失败：${e.message}${e.code === 11253 ? '（该接口目前仅对白名单机器人开放）' : ''}`);
    }
    for (const m of data.members || []) {
      store.upsertMember(id, gid, { id: m.member_openid, username: m.username, role: m.member_role, bot: m.bot });
      count++;
    }
    cursor = data.next_cursor || '';
    if (!cursor) break;
  }
  return { count, members: store.listMembers(id, gid) };
});

r('PATCH', '/api/bots/:id/groups/:peer/members/:mid', async (req, res, { params }) => {
  const id = botId(params);
  const body = await readJson(req);
  db.prepare('UPDATE members SET remark = ? WHERE bot_id = ? AND group_id = ? AND member_id = ?').run(
    str(body.remark, 60),
    id,
    peer(params.peer),
    peer(params.mid),
  );
  return store.listMembers(id, peer(params.peer));
});

// ---- 事件 ----
r('GET', '/api/bots/:id/events', async (req, res, { params, query }) =>
  store.listEvents(botId(params), {
    before: Number(query.get('before')) || undefined,
    type: query.get('type') || undefined,
    limit: Math.min(200, Number(query.get('limit')) || 100),
  }));

r('POST', '/api/bots/:id/events/:eid/join-request', async (req, res, { params }) => {
  const id = botId(params);
  const ev = store.eventRow(db.prepare('SELECT * FROM events WHERE id = ? AND bot_id = ?').get(Number(params.eid), id));
  if (!ev || ev.type !== 'GROUP_JOIN_REQUEST') throw new HttpError(404, '加群申请不存在');
  const body = await readJson(req);
  const op = body.op === 'approve' ? 'approve' : 'decline';
  const payload = { op, join_request_id: ev.data.join_request_id };
  if (op === 'decline') {
    if (body.reason) payload.reject_reason = str(body.reason, 200);
    if (body.blacklist) payload.add_to_member_blacklist = true;
  }
  try {
    await bots.runtime(id).api.approveJoin(ev.data.group_openid, ev.data.member_openid, payload);
  } catch (e) {
    throw new HttpError(502, `审批失败：${e.message}`);
  }
  db.prepare('UPDATE events SET handled = ? WHERE id = ?').run(op, ev.id);
  const updated = store.eventRow(db.prepare('SELECT * FROM events WHERE id = ?').get(ev.id));
  broadcast('event', updated);
  return updated;
});

// ---- 媒体库 ----
// 原始二进制上传（Content-Type 为图片类型），返回媒体记录
r('POST', '/api/media', async (req) => {
  const buf = await readBody(req, 10 * 1024 * 1024 + 1024);
  return media.saveImage(buf, { name: str(req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name']) : '', 200) });
}, { raw: true });

r('GET', '/api/media/:mid', async (req, res, { params }) => {
  const { row, file } = media.mediaFile(Number(params.mid));
  res.writeHead(200, {
    'Content-Type': row.mime,
    'Content-Length': row.size,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
  fs.createReadStream(file).pipe(res);
  return undefined;
});

// 把收到的 QQ 图片保存到媒体库（未自动缓存或缓存失败时）
r('POST', '/api/bots/:id/messages/:mid/attachments/:idx/cache', async (req, res, { params }) => {
  const id = botId(params);
  const msg = store.getMessage(Number(params.mid));
  if (!msg || msg.botId !== id) throw new HttpError(404, '消息不存在');
  const idx = Number(params.idx);
  const atts = msg.payload.attachments || [];
  const a = atts[idx];
  if (!a || !String(a.content_type || '').startsWith('image')) throw new HttpError(404, '图片不存在');
  if (a.mediaId && media.getMedia(a.mediaId)) return media.getMedia(a.mediaId);
  let m;
  try {
    m = await media.fetchRemoteImage(a.url, a.filename || '');
  } catch (e) {
    throw new HttpError(e.status || 502, `${e.message}（图片链接可能已过期）`);
  }
  atts[idx] = { ...a, mediaId: m.id };
  broadcast('message', store.updateMessage(msg.id, { payload: { ...msg.payload, attachments: atts } }));
  return m;
});

// ---- 表情收藏 ----
r('GET', '/api/stickers', async () => stickers.listStickers());

r('POST', '/api/stickers', async (req) => {
  const body = await readJson(req);
  const s = stickers.addSticker(Number(body.mediaId), str(body.keywords, 200));
  broadcast('stickers', stickers.listStickers());
  return s;
});

r('PATCH', '/api/stickers/:sid', async (req, res, { params }) => {
  const body = await readJson(req);
  const s = stickers.updateSticker(Number(params.sid), { keywords: body.keywords });
  broadcast('stickers', stickers.listStickers());
  return s;
});

r('DELETE', '/api/stickers/:sid', async (req, res, { params }) => {
  stickers.deleteSticker(Number(params.sid));
  broadcast('stickers', stickers.listStickers());
  return { ok: true };
});

// ---- 常用语 ----
r('GET', '/api/quick-replies', async () => stickers.listQuick());
r('POST', '/api/quick-replies', async (req) => {
  const q = stickers.saveQuick(await readJson(req));
  broadcast('quick', stickers.listQuick());
  return q;
});
r('PATCH', '/api/quick-replies/:qid', async (req, res, { params }) => {
  const q = stickers.saveQuick({ ...(await readJson(req)), id: Number(params.qid) });
  broadcast('quick', stickers.listQuick());
  return q;
});
r('DELETE', '/api/quick-replies/:qid', async (req, res, { params }) => {
  stickers.deleteQuick(Number(params.qid));
  broadcast('quick', stickers.listQuick());
  return { ok: true };
});
r('POST', '/api/quick-replies/:qid/used', async (req, res, { params }) => {
  stickers.markQuickUsed(Number(params.qid));
  return { ok: true };
});

// ---- 备份与导出 ----
r('GET', '/api/backup', async (req, res, { query }) => {
  await streamBackup(res, { includeMedia: query.get('media') !== '0' });
  return undefined;
});

r('GET', '/api/bots/:id/conversations/:type/:peer/export', async (req, res, { params, query }) => {
  const id = botId(params);
  const out = exportConversation(id, convType(params.type), peer(params.peer), query.get('format') === 'json' ? 'json' : 'txt');
  const body = Buffer.from(out.body, 'utf8');
  res.writeHead(200, {
    'Content-Type': out.type,
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
  return undefined;
});

// ---- 自动化：定时消息、自动回复、转发 ----
r('GET', '/api/bots/:id/schedules', async (req, res, { params }) => automation.listSchedules(botId(params)));
r('POST', '/api/bots/:id/schedules', async (req, res, { params }) => automation.saveSchedule(botId(params), await readJson(req)));
r('PATCH', '/api/bots/:id/schedules/:sid', async (req, res, { params }) =>
  automation.saveSchedule(botId(params), await readJson(req), Number(params.sid)));
r('DELETE', '/api/bots/:id/schedules/:sid', async (req, res, { params }) => {
  automation.deleteSchedule(botId(params), Number(params.sid));
  return { ok: true };
});

r('GET', '/api/bots/:id/rules', async (req, res, { params }) => automation.listRules(botId(params)));
r('POST', '/api/bots/:id/rules', async (req, res, { params }) => automation.saveRule(botId(params), await readJson(req)));
r('PATCH', '/api/bots/:id/rules/:rid', async (req, res, { params }) =>
  automation.saveRule(botId(params), await readJson(req), Number(params.rid)));
r('DELETE', '/api/bots/:id/rules/:rid', async (req, res, { params }) => {
  automation.deleteRule(botId(params), Number(params.rid));
  return { ok: true };
});

r('GET', '/api/bots/:id/forward', async (req, res, { params }) => automation.getForward(botId(params)));
r('PUT', '/api/bots/:id/forward', async (req, res, { params }) => automation.saveForward(botId(params), await readJson(req)));
r('POST', '/api/bots/:id/forward/test', async (req, res, { params }) => {
  try {
    return await automation.testForward(botId(params));
  } catch (e) {
    throw new HttpError(502, `测试失败：${e.message}`);
  }
});

// ---- Web Push ----
r('GET', '/api/push', async () => ({ publicKey: webpush.vapidPublicKey(), count: webpush.countSubscriptions() }));
r('POST', '/api/push/subscribe', async (req) => webpush.subscribe(await readJson(req), req.headers['user-agent']));
r('POST', '/api/push/unsubscribe', async (req) => {
  webpush.unsubscribe((await readJson(req)).endpoint);
  return { ok: true };
});
r('POST', '/api/push/test', async () => webpush.pushAll({ title: 'QQ Bot 面板', body: '这是一条测试通知', test: true }));
