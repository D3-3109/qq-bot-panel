// 将 QQ 推送事件转换为面板中的消息 / 事件记录
import * as store from './store.js';
import { broadcast } from './hub.js';
import { config } from './config.js';
import { fetchRemoteImage } from './media.js';

function parseExt(scene) {
  const out = {};
  for (const item of scene?.ext || []) {
    const i = String(item).indexOf('=');
    if (i > 0) out[item.slice(0, i)] = item.slice(i + 1);
  }
  return out;
}

function toMs(ts) {
  if (!ts) return Date.now();
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  if (/^\d+$/.test(ts)) return Number(ts) * 1000;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? Date.now() : t;
}

function previewOf(content, attachments, messageType) {
  const text = String(content || '')
    .replace(/<@all>/g, '@全体成员')
    .replace(/<@!?([^>]+)>/g, '@成员')
    .replace(/<qqbot-at-user id="[^"]*"\s*\/>/g, '@成员')
    .replace(/<qqbot-at-everyone\s*\/>/g, '@全体成员')
    .replace(/<faceType=[^>]*>/g, '[表情]')
    .trim();
  if (text) return text.slice(0, 80);
  if (messageType === 3) return '[卡片消息]';
  const a = attachments?.[0];
  if (!a) return messageType === 103 ? '[引用消息]' : '';
  const ct = a.content_type || '';
  if (ct.startsWith('image')) return '[图片]';
  if (ct.startsWith('video')) return '[视频]';
  if (ct === 'voice') return '[语音]';
  return `[文件] ${a.filename || ''}`;
}

const SYSTEM_TEXT = {
  GROUP_ADD_ROBOT: (d, n) => `${n(d.op_member_openid)} 将机器人加入了群聊`,
  GROUP_DEL_ROBOT: (d, n) => `${n(d.op_member_openid)} 将机器人移出了群聊`,
  GROUP_MSG_RECEIVE: (d, n) => `${n(d.op_member_openid)} 开启了机器人主动消息`,
  GROUP_MSG_REJECT: (d, n) => `${n(d.op_member_openid)} 关闭了机器人主动消息`,
  GROUP_MEMBER_ADD: (d, n) => `${n(d.member_openid)} 加入了群聊`,
  GROUP_MEMBER_REMOVE: (d, n) => `${n(d.member_openid)} 退出了群聊`,
  GROUP_JOIN_REQUEST: (d) =>
    `${d.username || '用户'} 申请加入群聊${d.verify_info?.verify_message ? `：${d.verify_info.verify_message}` : ''}`,
  FRIEND_ADD: () => '用户添加了机器人为好友',
  FRIEND_DEL: () => '用户删除了机器人',
  C2C_MSG_RECEIVE: () => '用户开启了机器人主动消息',
  C2C_MSG_REJECT: () => '用户关闭了机器人主动消息',
};

const CONV_STATUS = {
  GROUP_ADD_ROBOT: 'active',
  GROUP_DEL_ROBOT: 'removed',
  GROUP_MSG_RECEIVE: 'active',
  GROUP_MSG_REJECT: 'rejected',
  FRIEND_ADD: 'active',
  FRIEND_DEL: 'removed',
  C2C_MSG_RECEIVE: 'active',
  C2C_MSG_REJECT: 'rejected',
};

export function handleDispatch(bot, type, d, eventId) {
  const botId = bot.id;
  d = d || {};
  if (type === 'GROUP_AT_MESSAGE_CREATE' || type === 'GROUP_MESSAGE_CREATE' || type === 'C2C_MESSAGE_CREATE') {
    return handleMessage(bot, type, d, eventId);
  }

  let convType = '';
  let peerId = '';
  if (d.group_openid) {
    convType = 'group';
    peerId = d.group_openid;
  } else if (type.startsWith('FRIEND_') || type.startsWith('C2C_')) {
    convType = 'c2c';
    peerId = d.openid || d.user_openid || '';
  } else if (type === 'INTERACTION_CREATE') {
    if (d.group_openid) {
      convType = 'group';
      peerId = d.group_openid;
    } else if (d.user_openid) {
      convType = 'c2c';
      peerId = d.user_openid;
    }
  }
  const ts = toMs(d.timestamp || d.apply_at);
  const ev = store.insertEvent({ botId, eventId, type, convType, peerId, data: d, ts: Date.now() });
  if (!ev) return; // 重复推送
  broadcast('event', ev);

  if (!peerId) return;

  if (convType === 'group') {
    if (type === 'GROUP_MEMBER_ADD') store.upsertMember(botId, peerId, { id: d.member_openid, lastSeen: ts });
    if (type === 'GROUP_MEMBER_REMOVE') store.upsertMember(botId, peerId, { id: d.member_openid, inGroup: false });
    if (type === 'GROUP_JOIN_REQUEST')
      store.upsertMember(botId, peerId, { id: d.member_openid, username: d.username, bot: d.bot, inGroup: false });
  }

  const textFn = SYSTEM_TEXT[type];
  const patch = { last_ts: Date.now() };
  if (CONV_STATUS[type]) patch.status = CONV_STATUS[type];
  if (textFn) {
    const nameOf = (id) => (id ? store.memberName(botId, peerId, id) : '某成员');
    const text = textFn(d, nameOf);
    patch.last_preview = `[系统] ${text}`;
    const msg = store.insertMessage({
      botId,
      convType,
      peerId,
      direction: 'system',
      kind: 'system',
      content: text,
      payload: { eventType: type, eventRowId: ev.id, data: d },
      ts: Date.now(),
    });
    if (msg) broadcast('message', msg);
  }
  const conv = store.upsertConversation(botId, convType, peerId, patch);
  broadcast('conversation', conv);
}

function handleMessage(bot, type, d, eventId) {
  const botId = bot.id;
  const isGroup = type !== 'C2C_MESSAGE_CREATE';
  const convType = isGroup ? 'group' : 'c2c';
  const author = d.author || {};
  const peerId = isGroup ? d.group_openid : author.user_openid || author.id;
  if (!peerId) return;
  const authorId = isGroup ? author.member_openid || author.id : author.user_openid || author.id;
  const ext = parseExt(d.message_scene);
  const ts = toMs(d.timestamp);
  const atBot = type === 'GROUP_AT_MESSAGE_CREATE';

  if (isGroup) {
    store.upsertMember(botId, peerId, {
      id: authorId,
      username: author.username,
      role: author.member_role,
      bot: author.bot,
      lastSeen: ts,
    });
    for (const m of d.mentions || []) {
      store.upsertMember(botId, peerId, {
        id: m.member_openid || m.id,
        username: m.username,
        role: m.member_role,
        bot: m.bot,
      });
    }
  }

  const msg = store.insertMessage({
    botId,
    convType,
    peerId,
    direction: 'in',
    msgId: d.id,
    authorId,
    authorName: author.username || (isGroup ? store.memberName(botId, peerId, authorId) : ''),
    authorRole: author.member_role || '',
    kind: 'message',
    content: d.content || '',
    payload: {
      eventType: type,
      eventId,
      atBot,
      messageType: d.message_type ?? 0,
      attachments: d.attachments || [],
      mentions: d.mentions || [],
      arkData: d.ark_data || null,
      msgElements: d.msg_elements || [],
      authorUnionOpenid: author.union_openid || '',
    },
    refIdx: ext.msg_idx || '',
    quoteIdx: ext.ref_msg_idx || '',
    // 被动回复窗口从平台收到消息时开始计算，用本地接收时间更稳妥
    ts: Date.now(),
  });

  const fullMode = type === 'GROUP_MESSAGE_CREATE';

  if (!msg) {
    // 同一条消息可能同时以 @ 事件与全量事件推送
    if (atBot) {
      const existing = store.findMessageByMsgId(botId, d.id);
      if (existing && !existing.payload.atBot) {
        const updated = store.updateMessage(existing.id, { payload: { ...existing.payload, atBot: true } });
        broadcast('message', updated);
        const conv = store.upsertConversation(botId, convType, peerId, { at_unread: 1 });
        broadcast('conversation', conv);
      }
    }
    return;
  }

  const patch = {
    last_ts: msg.ts,
    last_preview: `${isGroup ? `${msg.authorName}: ` : ''}${previewOf(d.content, d.attachments, d.message_type)}`,
    unreadInc: 1,
    hidden: 0,
    ...(store.getConversation(botId, convType, peerId)?.status === 'removed' ? {} : { status: 'active' }),
  };
  if (atBot) patch.at_unread = 1;
  if (fullMode) patch.full_seen = 1;
  const conv = store.upsertConversation(botId, convType, peerId, patch);
  broadcast('message', msg);
  broadcast('conversation', conv);
  cacheAttachments(msg);
}

// QQ 图片链接有时效，收到后下载到本地媒体库，用于预览和收藏表情
function cacheAttachments(msg) {
  if (!config.cacheRemoteMedia) return;
  const atts = msg.payload.attachments || [];
  const jobs = atts.map((a, i) => ({ a, i })).filter(({ a }) => String(a.content_type || '').startsWith('image') && a.url);
  if (!jobs.length) return;
  (async () => {
    let changed = false;
    for (const { a, i } of jobs) {
      try {
        const m = await fetchRemoteImage(a.url, a.filename || '');
        atts[i] = { ...a, mediaId: m.id };
        changed = true;
      } catch (e) {
        console.warn(`缓存图片失败（消息 ${msg.id}）：${e.message}`);
      }
    }
    if (!changed) return;
    const current = store.getMessage(msg.id);
    if (!current) return;
    broadcast('message', store.updateMessage(msg.id, { payload: { ...current.payload, attachments: atts } }));
  })();
}

export { previewOf, toMs };
