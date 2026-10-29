// 本地模拟 QQ 开放平台（仅用于开发调试，不连接真实腾讯服务器）
// 用法: node scripts/mock-qq.js  然后在面板“高级”中把 OpenAPI 地址设为 http://127.0.0.1:9100
// 注入事件: POST http://127.0.0.1:9100/_mock/dispatch  {"t":"GROUP_AT_MESSAGE_CREATE","d":{...}}
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_PORT || 9100);
const APP_ID = process.env.MOCK_APPID || '102000001';
const SECRET = process.env.MOCK_SECRET || 'mockSecretValue123';

export const sent = [];
const sockets = new Set();
let seq = 0;
let token = crypto.randomBytes(8).toString('hex');

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(c).toString() || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

export function dispatch(t, d) {
  const payload = { op: 0, s: ++seq, t, d, id: `${t}:${crypto.randomUUID()}` };
  for (const ws of sockets) if (ws.ready) ws.send(JSON.stringify(payload));
  return payload;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/app/getAppAccessToken' && req.method === 'POST') {
    const b = await body(req);
    if (b.appId !== APP_ID || b.clientSecret !== SECRET) return json(res, 200, { code: 100016, message: 'invalid appid or secret' });
    return json(res, 200, { access_token: token, expires_in: '7200' });
  }
  if (p === '/_mock/dispatch' && req.method === 'POST') {
    const b = await body(req);
    return json(res, 200, dispatch(b.t, b.d));
  }
  if (p === '/_mock/sent') return json(res, 200, sent);
  if (p === '/_mock/kick') {
    for (const ws of sockets) ws.close(4009, 'expired');
    return json(res, 200, { ok: true });
  }

  if (req.headers.authorization !== `QQBot ${token}`) return json(res, 401, { message: 'unauthorized', code: 11241 });

  if (p === '/users/@me') return json(res, 200, { id: 'BOTUSER1', username: '测试机器人', avatar: '' });
  if (p === '/gateway/bot' || p === '/gateway') {
    return json(res, 200, { url: `ws://127.0.0.1:${PORT}/websocket`, shards: 1 });
  }
  let m;
  if ((m = /^\/v2\/(groups|users)\/([^/]+)\/messages$/.exec(p)) && req.method === 'POST') {
    const b = await body(req);
    sent.push({ scene: m[1], peer: m[2], body: b });
    if (b.msg_id === 'EXPIRED') return json(res, 200, { code: 40034024, err_code: 40034024, message: '被动回复已过期', trace_id: 't1' });
    if (b.content === 'FAIL') return json(res, 500, { err_code: 22009, message: '消息发送失败', trace_id: 't2' });
    const id = `ROBOT_OUT_${sent.length}`;
    return json(res, 200, { id, timestamp: new Date().toISOString(), ext_info: { ref_idx: `REFIDX_OUT_${sent.length}` } });
  }
  if ((m = /^\/v2\/(groups|users)\/([^/]+)\/files$/.exec(p)) && req.method === 'POST') {
    const b = await body(req);
    sent.push({ scene: m[1], peer: m[2], upload: { ...b, file_data: b.file_data ? `<${b.file_data.length} b64>` : undefined } });
    return json(res, 200, { file_uuid: 'uuid1', file_info: 'FILEINFO_' + sent.length, ttl: 3600 });
  }
  if ((m = /^\/v2\/(groups|users)\/([^/]+)\/messages\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
    sent.push({ scene: m[1], peer: m[2], recall: m[3] });
    return json(res, 200, {});
  }
  if ((m = /^\/v2\/groups\/([^/]+)\/members$/.exec(p))) {
    return json(res, 200, {
      members: [
        { member_openid: 'MEMBER_A', username: '小红', member_role: 'owner', bot: false },
        { member_openid: 'MEMBER_B', username: '小明', member_role: 'member', bot: false },
      ],
      next_cursor: '',
    });
  }
  if ((m = /^\/v2\/groups\/([^/]+)\/approval_join_request\/([^/]+)$/.exec(p))) {
    sent.push({ approve: await body(req), group: m[1], member: m[2] });
    return json(res, 200, {});
  }
  json(res, 404, { message: 'not found' });
});

const wss = new WebSocketServer({ server, path: '/websocket' });
wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.op === 1) ws.send(JSON.stringify({ op: 11 }));
    if (msg.op === 2) {
      if (msg.d.token !== `QQBot ${token}`) return ws.close(4004, 'auth fail');
      ws.ready = true;
      ws.send(JSON.stringify({ op: 0, s: ++seq, t: 'READY', d: { version: 1, session_id: 'sess-1', user: { id: 'BOTUSER1', username: '测试机器人', bot: true }, shard: [0, 1] } }));
    }
    if (msg.op === 6) {
      ws.ready = true;
      ws.send(JSON.stringify({ op: 0, s: ++seq, t: 'RESUMED', d: '' }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Mock QQ OpenAPI on http://127.0.0.1:${PORT}  appId=${APP_ID} secret=${SECRET}`));
