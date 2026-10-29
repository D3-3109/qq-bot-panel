export const state = {
  bots: [],
  botId: null,
  convs: new Map(),
  current: null, // { type, peerId }
  messages: [],
  hasMore: false,
  members: [],
  events: [],
  logs: [],
  tab: 'chats',
  search: '',
  replyTo: null,
  attachment: null,
  panelOpen: localStorage.getItem('panelOpen') !== '0',
  stickers: [],
};

// 模块间回调，由 app.js 注册，避免循环依赖
export const actions = {};

export const convKey = (type, peerId) => `${type}:${peerId}`;

export function nameOf(id, fallback = '') {
  if (!id) return fallback || '未知';
  const bot = currentBot();
  if (bot && (id === bot.botUserId || id === bot.appId)) return bot.name;
  const m = state.members.find((x) => x.memberId === id);
  return m?.remark || m?.username || fallback || `成员 ${id.slice(0, 6)}`;
}

export const STATUS_TEXT = {
  online: '在线',
  webhook: 'Webhook 模式',
  connecting: '连接中…',
  reconnecting: '重连中…',
  error: '异常',
  offline: '离线',
};

export const EVENT_TEXT = {
  GROUP_AT_MESSAGE_CREATE: '群聊 @机器人 消息',
  GROUP_MESSAGE_CREATE: '群聊消息（全量）',
  C2C_MESSAGE_CREATE: '私聊消息',
  GROUP_ADD_ROBOT: '机器人被拉入群聊',
  GROUP_DEL_ROBOT: '机器人被移出群聊',
  GROUP_MSG_RECEIVE: '群开启主动消息',
  GROUP_MSG_REJECT: '群关闭主动消息',
  GROUP_MEMBER_ADD: '群成员加入',
  GROUP_MEMBER_REMOVE: '群成员退出',
  GROUP_JOIN_REQUEST: '加群申请',
  FRIEND_ADD: '用户添加好友',
  FRIEND_DEL: '用户删除好友',
  C2C_MSG_RECEIVE: '用户开启主动消息',
  C2C_MSG_REJECT: '用户关闭主动消息',
  INTERACTION_CREATE: '按钮互动',
};

export function currentBot() {
  return state.bots.find((b) => b.id === state.botId) || null;
}

export function currentConv() {
  if (!state.current) return null;
  return state.convs.get(convKey(state.current.type, state.current.peerId)) || null;
}

export function memberMap() {
  const m = new Map();
  for (const x of state.members) m.set(x.memberId, x);
  return m;
}
