import { h, $, avatar, fmtTime, api, toast, esc } from './lib.js';
import { state, actions, currentBot, convKey, STATUS_TEXT, EVENT_TEXT } from './state.js';

export function renderRail() {
  const box = $('#rail-bots');
  box.innerHTML = '';
  for (const b of state.bots) {
    const btn = h('button', {
      class: `rail-bot ${b.id === state.botId ? 'active' : ''}`,
      title: `${b.name}（${STATUS_TEXT[b.status] || b.status}）`,
      onclick: () => actions.selectBot(b.id),
    }, avatar(b.name, b.appId, { square: true, img: b.avatar }), h('span', { class: `dot ${b.status}` }));
    box.append(btn);
  }
  renderBotCard();
}

export function renderBotCard() {
  const card = $('#bot-card');
  card.innerHTML = '';
  const b = currentBot();
  if (!b) {
    card.append(h('div', { class: 'info' }, h('div', { class: 'name' }, '未添加机器人'), h('div', { class: 'status' }, '点击左侧 ＋ 添加账号')));
    return;
  }
  const unread = [...state.convs.values()].reduce((n, c) => n + (c.unread || 0), 0);
  card.append(
    avatar(b.name, b.appId, { img: b.avatar }),
    h('div', { class: 'info' },
      h('div', { class: 'name' }, b.name, unread ? h('span', { class: 'badge', style: 'margin-left:6px' }, unread > 99 ? '99+' : unread) : null),
      h('div', { class: 'status' }, h('span', { class: `dot ${b.status}`, style: 'border:none;width:8px;height:8px;margin-right:4px' }),
        `${STATUS_TEXT[b.status] || b.status}${b.statusDetail ? ' · ' + b.statusDetail : ''}`)),
    h('button', { class: 'icon-btn', title: '账号设置', onclick: () => actions.editBot(b) }, '⋯'),
  );
}

export function renderSidebar() {
  document.querySelectorAll('#sidebar-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'chats') renderConvs();
  else if (state.tab === 'events') renderEvents();
  else renderLogs();
}

function renderConvs() {
  const body = $('#sidebar-body');
  body.innerHTML = '';
  if (!currentBot()) return;
  const q = state.search.trim().toLowerCase();
  const list = [...state.convs.values()]
    .filter((c) => !c.hidden)
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.peerId.toLowerCase().includes(q) || (c.lastPreview || '').toLowerCase().includes(q))
    .sort((a, b) => b.lastTs - a.lastTs);
  if (!list.length) {
    body.append(h('div', { class: 'empty-list', html: q ? '没有匹配的会话' :
      '暂无会话<br>把机器人拉进群并 @ 它，或私聊机器人，<br>会话就会出现在这里。<br><br>也可以点击右上角 ＋ 手动添加群 OpenID。' }));
    return;
  }
  for (const c of list) {
    const active = state.current && convKey(state.current.type, state.current.peerId) === convKey(c.type, c.peerId);
    const statusTag = c.status === 'removed' ? h('span', { class: 'tag danger' }, '已移出')
      : c.status === 'rejected' ? h('span', { class: 'tag warn' }, '拒收主动') : null;
    body.append(h('div', {
      class: `conv ${active ? 'active' : ''}`,
      onclick: () => actions.openConv(c.type, c.peerId),
      oncontextmenu: (e) => {
        e.preventDefault();
        actions.convMenu(c);
      },
    },
    avatar(c.name, c.peerId, { square: c.type === 'group' }),
    h('div', { class: 'meta' },
      h('div', { class: 'row1' },
        h('span', { class: 'title' }, c.type === 'group' ? h('span', { class: 'tag', style: 'margin-right:4px' }, '群') : null, c.name, ' ', statusTag),
        h('span', { class: 'time' }, c.lastTs ? fmtTime(c.lastTs) : '')),
      h('div', { class: 'row2' },
        h('span', { class: 'preview' }, c.atUnread ? h('span', { class: 'at-tag' }, '[有人@我]') : null, c.lastPreview || ''),
        c.unread ? h('span', { class: 'badge' }, c.unread > 99 ? '99+' : c.unread) : null))));
  }
}

function describeEvent(ev) {
  const d = ev.data || {};
  const parts = [];
  if (d.group_openid) parts.push(`群 ${d.group_openid.slice(0, 8)}`);
  if (d.op_member_openid) parts.push(`操作人 ${d.op_member_openid.slice(0, 8)}`);
  if (d.member_openid) parts.push(`成员 ${d.username || d.member_openid.slice(0, 8)}`);
  if (d.openid) parts.push(`用户 ${d.openid.slice(0, 8)}`);
  if (d.verify_info?.verify_message) parts.push(`验证信息：${d.verify_info.verify_message}`);
  if (d.risk_tips) parts.push(`⚠ ${d.risk_tips}`);
  return parts.join(' · ');
}

function renderEvents() {
  const body = $('#sidebar-body');
  body.innerHTML = '';
  if (!state.events.length) {
    body.append(h('div', { class: 'empty-list' }, '暂无事件'));
    return;
  }
  for (const ev of state.events) {
    const item = h('div', { class: 'event-item' },
      h('div', { class: 'head' },
        h('span', {}, h('span', { class: 'type' }, ev.type), ' ', h('span', { class: 'muted small' }, EVENT_TEXT[ev.type] || '')),
        h('span', { class: 'muted small' }, fmtTime(ev.ts))),
      h('div', { class: 'desc' }, describeEvent(ev)));
    if (ev.type === 'GROUP_JOIN_REQUEST') {
      if (ev.handled) item.append(h('div', { class: 'actions' }, h('span', { class: 'tag' }, ev.handled === 'approve' ? '已同意' : '已拒绝')));
      else item.append(h('div', { class: 'actions' },
        h('button', { class: 'btn small primary', onclick: () => handleJoin(ev, 'approve') }, '同意'),
        h('button', { class: 'btn small danger', onclick: () => handleJoin(ev, 'decline') }, '拒绝')));
    }
    if (ev.peerId) {
      item.append(h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => actions.openConv(ev.convType, ev.peerId) }, '打开会话')));
    }
    const det = h('details', {}, h('summary', { class: 'muted small' }, '原始数据'), h('pre', {}, JSON.stringify(ev.data, null, 2)));
    item.append(det);
    body.append(item);
  }
}

async function handleJoin(ev, op) {
  try {
    await api('POST', `/api/bots/${state.botId}/events/${ev.id}/join-request`, { op });
    toast(op === 'approve' ? '已同意入群' : '已拒绝', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderLogs() {
  const body = $('#sidebar-body');
  body.innerHTML = '';
  if (!state.logs.length) {
    body.append(h('div', { class: 'empty-list' }, '暂无日志'));
    return;
  }
  for (const l of [...state.logs].reverse()) {
    body.append(h('div', { class: `log-item ${l.level}` }, `${fmtTime(l.ts, true)}  ${l.text}`));
  }
}

export { esc };
