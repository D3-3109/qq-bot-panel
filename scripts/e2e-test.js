// 端到端测试：启动模拟 QQ 服务端 + 面板，验证收发消息、被动回复、Webhook、事件等
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ed25519KeysFromSecret, ed25519Sign } from '../server/crypto.js';

const MOCK = 'http://127.0.0.1:9100';
const PANEL = 'http://127.0.0.1:3917';
const SECRET = 'mockSecretValue123';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpanel-e2e-'));
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(args, env) {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`  | ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`  ! ${d}`));
  procs.push(p);
  return p;
}

async function waitFor(fn, label, timeout = 8000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`等待超时：${label}${last ? ' ' + last.message : ''}`);
}

let cookie = '';
async function call(method, url, body) {
  const res = await fetch(PANEL + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie, Origin: PANEL },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const mockSent = async () => (await fetch(MOCK + '/_mock/sent')).json();
const dispatch = (t, d) => fetch(MOCK + '/_mock/dispatch', { method: 'POST', body: JSON.stringify({ t, d }) });

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

try {
  start(['scripts/mock-qq.js'], {});
  start(['server/index.js'], { DATA_DIR: dataDir, PORT: '3917', HOST: '127.0.0.1', MEDIA_HOSTS: '127.0.0.1', ADMIN_PASSWORD: 'adminpass123' });
  await waitFor(() => fetch(MOCK + '/_mock/sent').then((r) => r.ok), 'mock 启动');
  await waitFor(() => fetch(PANEL + '/').then((r) => r.ok), '面板启动');

  await step('未登录访问 API 返回 401', async () => {
    assert.equal((await call('GET', '/api/bots')).status, 401);
  });
  await step('错误密码登录失败，正确密码登录成功', async () => {
    assert.equal((await call('POST', '/api/login', { username: 'admin', password: 'x' })).status, 401);
    assert.equal((await call('POST', '/api/login', { username: 'admin', password: 'adminpass123' })).status, 200);
  });
  await step('跨站 POST 被拒绝', async () => {
    const r = await fetch(PANEL + '/api/bots', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://evil.com', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
  });
  await step('错误的 AppSecret 无法添加机器人', async () => {
    const r = await call('POST', '/api/bots', { appId: '102000001', secret: 'wrongsecret', apiBase: MOCK });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /AppID 或 AppSecret 错误/);
  });

  let bot;
  await step('添加机器人并通过 WebSocket 上线', async () => {
    const r = await call('POST', '/api/bots', { appId: '102000001', secret: SECRET, apiBase: MOCK, intents: (1 << 25) | (1 << 24) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    bot = r.data;
    assert.equal(bot.name, '测试机器人');
    await waitFor(async () => (await call('GET', `/api/bots/${bot.id}`)).data.status === 'online', '机器人上线');
    const list = (await call('GET', '/api/bots')).data;
    assert.ok(!JSON.stringify(list).includes(SECRET), '接口不应返回 secret');
  });

  const G = 'GROUP_OPENID_1';
  await step('机器人进群事件生成会话和系统消息', async () => {
    await dispatch('GROUP_ADD_ROBOT', { group_openid: G, op_member_openid: 'MEMBER_A', timestamp: Math.floor(Date.now() / 1000) });
    const conv = await waitFor(async () => (await call('GET', `/api/bots/${bot.id}/conversations`)).data.find((c) => c.peerId === G), '群会话');
    assert.equal(conv.type, 'group');
    assert.ok(conv.replyWindow && conv.replyWindow.kind === 'event', '进群事件应提供 event_id 被动回复窗口');
  });

  await step('收到群 @消息，记录成员、引用索引', async () => {
    await dispatch('GROUP_AT_MESSAGE_CREATE', {
      id: 'MSG_IN_1', content: ' 你好机器人 ', group_openid: G, timestamp: new Date().toISOString(),
      author: { id: 'MEMBER_A', member_openid: 'MEMBER_A', username: '小红', member_role: 'owner' },
      message_scene: { source: 'default', ext: ['msg_idx=REFIDX_IN_1'] },
      attachments: [{ content_type: 'image/png', url: 'multimedia.nt.qq.com.cn/x.png', filename: 'x.png' }],
    });
    const msgs = await waitFor(async () => {
      const d = (await call('GET', `/api/bots/${bot.id}/conversations/group/${G}/messages`)).data;
      return d.find((m) => m.msgId === 'MSG_IN_1') && d;
    }, '收到消息');
    const m = msgs.find((x) => x.msgId === 'MSG_IN_1');
    assert.equal(m.authorName, '小红');
    assert.equal(m.refIdx, 'REFIDX_IN_1');
    assert.equal(m.payload.atBot, true);
    const members = (await call('GET', `/api/bots/${bot.id}/groups/${G}/members`)).data;
    assert.equal(members[0].username, '小红');
    assert.equal(members[0].role, 'owner');
  });

  await step('重复推送的消息被去重', async () => {
    await dispatch('GROUP_MESSAGE_CREATE', { id: 'MSG_IN_1', content: ' 你好机器人 ', group_openid: G, author: { member_openid: 'MEMBER_A', username: '小红' } });
    await sleep(300);
    const d = (await call('GET', `/api/bots/${bot.id}/conversations/group/${G}/messages`)).data;
    assert.equal(d.filter((m) => m.msgId === 'MSG_IN_1').length, 1);
  });

  let inMsg;
  await step('被动回复使用 msg_id，msg_seq 递增', async () => {
    const msgs = (await call('GET', `/api/bots/${bot.id}/conversations/group/${G}/messages`)).data;
    inMsg = msgs.find((m) => m.msgId === 'MSG_IN_1');
    const r1 = await call('POST', `/api/bots/${bot.id}/conversations/group/${G}/messages`, { text: '你好！', quoteId: inMsg.id });
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    assert.equal(r1.data.status, 'ok');
    assert.equal(r1.data.payload.sendMode, 'passive');
    const r2 = await call('POST', `/api/bots/${bot.id}/conversations/group/${G}/messages`, { text: '第二条' });
    assert.equal(r2.data.payload.sendMode, 'passive');
    const sent = (await mockSent()).filter((s) => s.body);
    const [a, b] = sent.slice(-2);
    assert.equal(a.body.msg_id, 'MSG_IN_1');
    assert.equal(a.body.msg_seq, 1);
    assert.deepEqual(a.body.message_reference, { message_id: 'REFIDX_IN_1' });
    assert.equal(b.body.msg_seq, 2);
    assert.equal(a.body.msg_type, 0);
  });

  await step('主动消息不带 msg_id', async () => {
    const r = await call('POST', `/api/bots/${bot.id}/conversations/group/${G}/messages`, { text: '主动', replyMode: 'active' });
    assert.equal(r.data.payload.sendMode, 'active');
    const last = (await mockSent()).filter((s) => s.body).at(-1);
    assert.equal(last.body.msg_id, undefined);
    assert.equal(last.body.event_id, undefined);
  });

  await step('@成员 自动转为 Markdown 消息', async () => {
    const r = await call('POST', `/api/bots/${bot.id}/conversations/group/${G}/messages`, { text: '<qqbot-at-user id="MEMBER_A" /> 看这里' });
    assert.equal(r.data.status, 'ok');
    const last = (await mockSent()).filter((s) => s.body).at(-1);
    assert.equal(last.body.msg_type, 2);
    assert.equal(last.body.markdown.content, '<qqbot-at-user id="MEMBER_A" /> 看这里');
    assert.equal(last.body.content, undefined);
  });

  await step('发送图片：先上传 file_data 再发 msg_type=7', async () => {
    const r = await call('POST', `/api/bots/${bot.id}/conversations/group/${G}/messages`, {
      text: '', media: { type: 'image', name: 'a.png', data: 'R0lGODlhBQAHAIAAAP///wAAACH5BAEAAAAALAAAAAAFAAcAAAIGhI+py+0FADs=' },
    });
    assert.equal(r.data.status, 'ok', JSON.stringify(r.data));
    const sent = await mockSent();
    const up = sent.filter((s) => s.upload).at(-1);
    assert.equal(up.upload.file_type, 1);
    assert.equal(up.upload.srv_send_msg, false);
    assert.equal(up.upload.file_name, 'a.png');
    assert.ok(up.upload.file_data, '图片应以 file_data 上传');
    const last = sent.filter((s) => s.body).at(-1);
    assert.equal(last.body.msg_type, 7);
    assert.match(last.body.media.file_info, /^FILEINFO_/);
  });

  await step('发送失败时记录错误', async () => {
    const r = await call('POST', `/api/bots/${bot.id}/conversations/group/${G}/messages`, { text: 'FAIL', replyMode: 'active' });
    assert.equal(r.status, 502);
    const msgs = (await call('GET', `/api/bots/${bot.id}/conversations/group/${G}/messages`)).data;
    const f = msgs.filter((m) => m.content === 'FAIL').at(-1);
    assert.equal(f.status, 'failed');
    assert.match(f.error, /消息发送失败/);
  });

  await step('撤回机器人自己的消息', async () => {
    const msgs = (await call('GET', `/api/bots/${bot.id}/conversations/group/${G}/messages`)).data;
    const mine = msgs.filter((m) => m.direction === 'out' && m.status === 'ok').at(-1);
    const r = await call('POST', `/api/bots/${bot.id}/messages/${mine.id}/recall`);
    assert.equal(r.data.status, 'recalled');
    const last = (await mockSent()).filter((s) => s.recall).at(-1);
    assert.equal(last.recall, mine.msgId);
  });

  await step('私聊消息与被动回复', async () => {
    await dispatch('C2C_MESSAGE_CREATE', { id: 'C2C_1', content: '私聊你好', author: { id: 'USER_1', user_openid: 'USER_1' }, timestamp: new Date().toISOString() });
    await waitFor(async () => (await call('GET', `/api/bots/${bot.id}/conversations`)).data.find((c) => c.peerId === 'USER_1'), '私聊会话');
    const r = await call('POST', `/api/bots/${bot.id}/conversations/c2c/USER_1/messages`, { text: '收到' });
    assert.equal(r.data.payload.sendMode, 'passive');
    const last = (await mockSent()).filter((s) => s.body).at(-1);
    assert.equal(last.scene, 'users');
    assert.equal(last.body.msg_id, 'C2C_1');
  });

  await step('加群申请事件与审批', async () => {
    await dispatch('GROUP_JOIN_REQUEST', { group_openid: G, join_request_id: 'JR1', member_openid: 'NEW_1', username: '新人', verify_info: { method: 'verify_message', verify_message: '我想加入' } });
    const ev = await waitFor(async () => (await call('GET', `/api/bots/${bot.id}/events`)).data.find((e) => e.type === 'GROUP_JOIN_REQUEST'), '加群事件');
    const r = await call('POST', `/api/bots/${bot.id}/events/${ev.id}/join-request`, { op: 'approve' });
    assert.equal(r.data.handled, 'approve');
    const last = (await mockSent()).filter((s) => s.approve).at(-1);
    assert.deepEqual(last.approve, { op: 'approve', join_request_id: 'JR1' });
  });

  await step('群成员同步接口', async () => {
    const r = await call('POST', `/api/bots/${bot.id}/groups/${G}/members/sync`);
    assert.equal(r.data.count, 2);
  });

  const G2 = 'GROUP_FULL_2';
  const msgsOf = async (g) => (await call('GET', `/api/bots/${bot.id}/conversations/group/${g}/messages`)).data;
  const convOf = async (g) => (await call('GET', `/api/bots/${bot.id}/conversations`)).data.find((c) => c.peerId === g);

  await step('全量模式：收到未 @ 的群消息，图片自动缓存到本地', async () => {
    await dispatch('GROUP_MESSAGE_CREATE', {
      id: 'FULL_1', content: '大家看图', group_openid: G2,
      author: { member_openid: 'MEM_X', username: '路人甲' },
      attachments: [{ content_type: 'image/png', url: `${MOCK}/img/a.png`, filename: 'a.png' }],
    });
    const m = await waitFor(async () => (await msgsOf(G2)).find((x) => x.msgId === 'FULL_1' && x.payload.attachments[0].mediaId), '图片缓存');
    assert.equal(m.payload.atBot, false);
    const c = await convOf(G2);
    assert.equal(c.fullSeen, true);
    assert.equal(c.atUnread, false);
    const img = await fetch(`${PANEL}/api/media/${m.payload.attachments[0].mediaId}`, { headers: { Cookie: cookie } });
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await img.arrayBuffer()).byteLength > 50, true);
  });

  await step('@机器人 的消息标记 [有人@我]，被动回复优先使用 @ 消息', async () => {
    await dispatch('GROUP_AT_MESSAGE_CREATE', { id: 'AT_2', content: ' 在吗', group_openid: G2, author: { member_openid: 'MEM_X', username: '路人甲' } });
    await dispatch('GROUP_MESSAGE_CREATE', { id: 'FULL_3', content: '闲聊', group_openid: G2, author: { member_openid: 'MEM_Y', username: '路人乙' } });
    await waitFor(async () => (await msgsOf(G2)).some((x) => x.msgId === 'FULL_3'), '全量消息');
    assert.equal((await convOf(G2)).atUnread, true);
    const r = await call('POST', `/api/bots/${bot.id}/conversations/group/${G2}/messages`, { text: '在的' });
    assert.equal(r.data.payload.sendMode, 'passive');
    assert.equal((await mockSent()).filter((s) => s.body).at(-1).body.msg_id, 'AT_2');
    await call('PATCH', `/api/bots/${bot.id}/conversations/group/${G2}`, { read: true });
    assert.equal((await convOf(G2)).atUnread, false);
  });

  await step('被动回复过期后自动改用主动消息，并不再重试该 msg_id', async () => {
    await dispatch('GROUP_AT_MESSAGE_CREATE', { id: 'EXPIRED', content: ' 旧消息', group_openid: 'GROUP_EXP', author: { member_openid: 'M1' } });
    await waitFor(async () => (await msgsOf('GROUP_EXP')).length, '过期测试消息');
    const r = await call('POST', `/api/bots/${bot.id}/conversations/group/GROUP_EXP/messages`, { text: '回复' });
    assert.equal(r.data.payload.sendMode, 'active');
    assert.equal((await convOf('GROUP_EXP')).replyWindow, null, '过期的 msg_id 不应再作为被动窗口');
  });

  let mediaId;
  await step('上传图片到媒体库：只接受真实图片', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP4z8DwnwEIGJAZAEXyBPxZhbwFAAAAAElFTkSuQmCC', 'base64');
    const up = (body, type) => fetch(`${PANEL}/api/media`, { method: 'POST', headers: { Cookie: cookie, Origin: PANEL, 'Content-Type': type, 'X-File-Name': 'kun.png' }, body });
    let r = await up(png, 'image/png');
    assert.equal(r.status, 200);
    const m = await r.json();
    assert.deepEqual([m.width, m.height, m.mime], [2, 3, 'image/png']);
    mediaId = m.id;
    assert.equal((await up(png, 'image/png').then((x) => x.json())).id, mediaId, '相同图片去重');
    assert.equal((await up(Buffer.from('not an image at all'), 'image/png')).status, 415);
    assert.equal((await up(png, 'text/plain')).status, 415);
  });

  let sticker;
  await step('收藏表情、设置关键词、重复收藏不新增', async () => {
    const r = await call('POST', '/api/stickers', { mediaId });
    assert.equal(r.status, 200);
    sticker = r.data;
    assert.equal((await call('POST', '/api/stickers', { mediaId })).data.existed, true);
    const p = await call('PATCH', `/api/stickers/${sticker.id}`, { keywords: '哈哈，笑死  开心' });
    assert.equal(p.data.keywords, '哈哈 笑死 开心');
    assert.equal((await call('GET', '/api/stickers')).data.length, 1);
  });

  await step('发送收藏的表情：上传 file_data，同一会话第二次复用 file_info', async () => {
    const before = (await mockSent()).filter((s) => s.upload).length;
    const r1 = await call('POST', `/api/bots/${bot.id}/conversations/group/${G2}/messages`, { stickerId: sticker.id, replyMode: 'active' });
    assert.equal(r1.data.status, 'ok', JSON.stringify(r1.data));
    assert.equal(r1.data.payload.media.mediaId, mediaId);
    const sent = await mockSent();
    const up = sent.filter((s) => s.upload).at(-1);
    assert.equal(up.upload.file_type, 1);
    assert.match(up.upload.file_name, /\.png$/);
    assert.equal(sent.filter((s) => s.body).at(-1).body.msg_type, 7);
    await call('POST', `/api/bots/${bot.id}/conversations/group/${G2}/messages`, { stickerId: sticker.id, replyMode: 'active' });
    assert.equal((await mockSent()).filter((s) => s.upload).length, before + 1, '第二次发送不应重新上传');
    assert.equal((await call('GET', '/api/stickers')).data[0].useCount, 2);
  });

  await step('删除表情', async () => {
    assert.equal((await call('DELETE', `/api/stickers/${sticker.id}`)).status, 200);
    assert.equal((await call('GET', '/api/stickers')).data.length, 0);
  });

  await step('连接被踢 (4009) 后自动 Resume 恢复在线', async () => {
    await fetch(MOCK + '/_mock/kick');
    await waitFor(async () => (await call('GET', `/api/bots/${bot.id}`)).data.status !== 'online', '掉线', 3000).catch(() => {});
    await waitFor(async () => (await call('GET', `/api/bots/${bot.id}`)).data.status === 'online', '恢复在线', 10000);
    const logs = (await call('GET', `/api/bots/${bot.id}/logs`)).data;
    assert.ok(logs.some((l) => l.text.includes('会话已恢复')), '应通过 RESUME 恢复');
  });

  await step('订阅了未开通的事件 (4014) 时自动退回基础订阅并上线', async () => {
    await fetch(`${MOCK}/_mock/deny-intent?bits=${1 << 24}`);
    await call('POST', `/api/bots/${bot.id}/restart`);
    const b = await waitFor(async () => {
      const x = (await call('GET', `/api/bots/${bot.id}`)).data;
      return x.status === 'online' && x.intents === 1 << 25 && x;
    }, '降级后上线', 10000);
    assert.equal(b.intents, 1 << 25);
    await fetch(`${MOCK}/_mock/deny-intent?bits=0`);
  });

  await step('Webhook 回调地址验证 (op 13) 签名正确', async () => {
    const r = await fetch(`${PANEL}/webhook/102000001`, { method: 'POST', body: JSON.stringify({ op: 13, d: { plain_token: 'PT123', event_ts: '1725442341' } }) });
    const d = await r.json();
    const expected = ed25519Sign(ed25519KeysFromSecret(SECRET).privateKey, '1725442341PT123');
    assert.equal(d.plain_token, 'PT123');
    assert.equal(d.signature, expected);
  });

  await step('Webhook 事件：签名校验通过则入库，签名错误返回 401', async () => {
    const payload = JSON.stringify({ op: 0, id: 'WH_EV_1', t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'WH_MSG_1', content: 'webhook 消息', group_openid: 'WH_GROUP', author: { member_openid: 'M9', username: '回调用户' } } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = ed25519Sign(ed25519KeysFromSecret(SECRET).privateKey, ts + payload);
    const bad = await fetch(`${PANEL}/webhook`, { method: 'POST', headers: { 'X-Bot-Appid': '102000001', 'X-Signature-Ed25519': sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a'), 'X-Signature-Timestamp': ts }, body: payload });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${PANEL}/webhook`, { method: 'POST', headers: { 'X-Bot-Appid': '102000001', 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts }, body: payload });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { op: 12, d: 0 });
    await waitFor(async () => (await call('GET', `/api/bots/${bot.id}/conversations`)).data.find((c) => c.peerId === 'WH_GROUP'), 'webhook 会话');
  });

  await step('静态页面与安全响应头', async () => {
    const r = await fetch(PANEL + '/');
    assert.match(await r.text(), /QQ Bot 面板/);
    assert.ok(r.headers.get('content-security-policy'));
    const trav = await fetch(PANEL + '/..%2fpackage.json');
    assert.notEqual(trav.status, 200);
  });

  await step('重启面板后数据与登录状态保留，机器人自动上线', async () => {
    const panel = procs[1];
    panel.kill();
    await new Promise((r) => panel.on('exit', r));
    start(['server/index.js'], { DATA_DIR: dataDir, PORT: '3917', HOST: '127.0.0.1', MEDIA_HOSTS: '127.0.0.1' });
    await waitFor(() => fetch(PANEL + '/').then((r) => r.ok), '面板重启');
    await waitFor(async () => (await call('GET', `/api/bots/${bot.id}`)).data?.status === 'online', '重启后上线');
    const convs = (await call('GET', `/api/bots/${bot.id}/conversations`)).data;
    assert.ok(convs.length >= 3);
  });

  console.log(`\n全部通过：${passed} 项`);
} catch (e) {
  console.error('\n测试失败：', e);
  process.exitCode = 1;
} finally {
  for (const p of procs) p.kill();
  setTimeout(() => fs.rmSync(dataDir, { recursive: true, force: true }), 500);
}
