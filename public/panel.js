// 右侧详情面板：会话信息、群成员
import { h, $, avatar, api, toast, fmtTime, promptBox } from './lib.js';
import { state, actions, currentConv } from './state.js';

const ROLE_ORDER = { owner: 0, admin: 1, member: 2, '': 3 };
const ROLE_TEXT = { owner: '群主', admin: '管理员' };

function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast('已复制'));
}

export function renderPanel() {
  const panel = $('#panel');
  const conv = currentConv();
  panel.classList.toggle('hidden', !conv || !state.panelOpen);
  if (!conv || !state.panelOpen) return;
  panel.innerHTML = '';

  panel.append(h('div', { class: 'panel-head' },
    h('h3', {}, conv.type === 'group' ? '群聊信息' : '用户信息',
      h('button', { class: 'icon-btn', title: '关闭', onclick: () => actions.togglePanel(false) }, '✕')),
    h('div', { style: 'display:flex;gap:10px;align-items:center;margin:8px 0' },
      avatar(conv.name, conv.peerId, { square: conv.type === 'group' }),
      h('div', { style: 'min-width:0' },
        h('div', { style: 'font-weight:600' }, conv.name),
        h('button', { class: 'btn small', style: 'margin-top:4px', onclick: () => renameConv(conv) }, '设置备注'))),
    h('div', { class: 'kv' }, conv.type === 'group' ? 'group_openid: ' : 'user_openid: ',
      h('code', { title: '点击复制', onclick: () => copy(conv.peerId) }, conv.peerId)),
    h('div', { class: 'kv' }, '状态：', { active: '正常', removed: '机器人已被移出', rejected: '已关闭主动消息' }[conv.status] || conv.status),
    h('div', { class: 'kv', style: 'line-height:1.6;margin-top:8px' },
      'QQ 开放平台不提供群名称与历史消息接口，名称可通过“设置备注”自定义；成员列表根据收到的消息和事件自动积累。')));

  const body = h('div', { class: 'panel-body' });
  if (conv.type === 'group') {
    const members = [...state.members].sort((a, b) =>
      (b.inGroup - a.inGroup) || (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || b.lastSeen - a.lastSeen);
    body.append(h('div', { class: 'panel-section-title' },
      `群成员（${members.filter((m) => m.inGroup).length}）`,
      h('button', { class: 'btn small', title: '调用群成员列表接口（需平台开通权限）', onclick: syncMembers }, '同步')));
    if (!members.length) body.append(h('div', { class: 'empty-list' }, '还没有成员信息\n群成员发言后会出现在这里'));
    for (const m of members) {
      body.append(h('div', {
        class: `member ${m.inGroup ? '' : 'left'}`,
        title: `${m.memberId}${m.lastSeen ? '\n最近发言 ' + fmtTime(m.lastSeen, true) : ''}\n点击 @TA，右键设置备注`,
        onclick: () => actions.insertMention(m.memberId),
        oncontextmenu: (e) => {
          e.preventDefault();
          renameMember(m);
        },
      },
      avatar(m.name, m.memberId, { size: 'xs' }),
      h('span', { class: 'mname' }, m.name),
      m.bot ? h('span', { class: 'tag bot' }, '机器人') : null,
      ROLE_TEXT[m.role] ? h('span', { class: `tag ${m.role}` }, ROLE_TEXT[m.role]) : null,
      m.inGroup ? null : h('span', { class: 'tag' }, '不在群')));
    }
  }
  panel.append(body);

  panel.append(h('div', { class: 'panel-actions' },
    h('button', { class: 'btn', onclick: () => actions.hideConv(conv) }, '从列表中移除会话')));
}

async function renameConv(conv) {
  const v = await promptBox('设置会话备注', { value: conv.remark, placeholder: conv.type === 'group' ? '例如：技术交流群' : '例如：张三', hint: '留空恢复默认名称' });
  if (v === null) return;
  try {
    await api('PATCH', `/api/bots/${state.botId}/conversations/${conv.type}/${encodeURIComponent(conv.peerId)}`, { remark: v.trim() });
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function renameMember(m) {
  const conv = currentConv();
  const v = await promptBox('设置成员备注', { value: m.remark, placeholder: m.username || '备注名', hint: `member_openid: ${m.memberId}` });
  if (v === null) return;
  try {
    state.members = await api('PATCH', `/api/bots/${state.botId}/groups/${encodeURIComponent(conv.peerId)}/members/${encodeURIComponent(m.memberId)}`, { remark: v.trim() });
    actions.refreshChat();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function syncMembers() {
  const conv = currentConv();
  try {
    const r = await api('POST', `/api/bots/${state.botId}/groups/${encodeURIComponent(conv.peerId)}/members/sync`);
    state.members = r.members;
    toast(`已同步 ${r.count} 名成员`, 'ok');
    actions.refreshChat();
  } catch (e) {
    toast(e.message, 'error');
  }
}
