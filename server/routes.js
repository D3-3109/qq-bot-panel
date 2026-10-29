import { db } from './db.js';
import { Router, HttpError, readJson, str } from './http.js';
import * as auth from './auth.js';
import * as bots from './bots.js';
import * as store from './store.js';
import { sendMessage, recallMessage } from './sender.js';
import { addClient, broadcast } from './hub.js';

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
  return auth.login(req, res, body.username, body.password);
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
  if (body.read) patch.unread = 0;
  const conv = store.upsertConversation(id, convType(params.type), peer(params.peer), patch);
  broadcast('conversation', conv);
  return conv;
});

r('GET', '/api/bots/:id/conversations/:type/:peer/messages', async (req, res, { params, query }) => {
  const id = botId(params);
  const before = Number(query.get('before')) || undefined;
  const limit = Math.min(200, Number(query.get('limit')) || 50);
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
