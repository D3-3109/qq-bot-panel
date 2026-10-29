import { $, h, api, toast, avatar, promptBox, openModal, readFileBase64, confirmBox } from './lib.js';
import { state, actions, convKey, currentConv } from './state.js';
import { renderRail, renderBotCard, renderSidebar } from './sidebar.js';
import { renderChatHead, renderMessages, upsertMessage, renderReplyBar, renderAttachment, renderWindowBar, sendCurrent } from './chat.js';
import { renderPanel } from './panel.js';
import { botDialog, settingsDialog } from './bots-ui.js';
import { sendImage } from './chat.js';
import { loadStickers, setStickers, toggleStickerPanel, uploadImageFile, renderSuggestions, handleSuggestKey } from './stickers-ui.js';

// ---------------- 启动 / 登录 ----------------
async function boot() {
  try {
    const me = await api('GET', '/api/me');
    state.username = me.username;
    startApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    $('#login-error').textContent = '';
    try {
      const me = await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') });
      state.username = me.username;
      $('#login').classList.add('hidden');
      startApp();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  };
  $('#login-form [name=password]').focus();
}

async function startApp() {
  $('#app').classList.remove('hidden');
  bindUi();
  connectStream();
  loadStickers();
  await reloadBots(Number(localStorage.getItem('botId')) || undefined);
}

// ---------------- 实时推送 ----------------
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('bot', (e) => {
    const b = JSON.parse(e.data);
    const i = state.bots.findIndex((x) => x.id === b.id);
    if (i >= 0) state.bots[i] = b;
    else state.bots.push(b);
    renderRail();
  });
  es.addEventListener('conversation', (e) => {
    const c = JSON.parse(e.data);
    if (c.botId !== state.botId) return;
    const isOpen = state.current && convKey(state.current.type, state.current.peerId) === convKey(c.type, c.peerId);
    if (isOpen && c.unread && document.visibilityState === 'visible') {
      c.unread = 0;
      markRead(c);
    }
    state.convs.set(convKey(c.type, c.peerId), c);
    if (state.tab === 'chats') renderSidebar();
    renderBotCard();
    if (isOpen) renderChatHead();
  });
  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.botId !== state.botId) return;
    if (state.current && m.convType === state.current.type && m.peerId === state.current.peerId) {
      upsertMessage(m);
      if (m.direction === 'in' && m.convType === 'group') refreshMembersSoon();
    } else if (m.direction === 'in' && document.visibilityState !== 'visible' && (m.convType === 'c2c' || m.payload?.atBot)) {
      // 全量模式下群消息很多，只对私聊和 @机器人 弹通知
      notify(m);
    }
  });
  es.addEventListener('stickers', (e) => setStickers(JSON.parse(e.data)));
  es.addEventListener('event', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.botId !== state.botId) return;
    const i = state.events.findIndex((x) => x.id === ev.id);
    if (i >= 0) state.events[i] = ev;
    else state.events.unshift(ev);
    if (ev.type === 'GROUP_JOIN_REQUEST' && !ev.handled) toast(`新的加群申请：${ev.data.username || ''}`);
    if (state.tab === 'events') renderSidebar();
    if (state.current?.type === 'group' && ev.peerId === state.current.peerId && ev.type.startsWith('GROUP_MEMBER')) refreshMembersSoon();
  });
  es.addEventListener('log', (e) => {
    const l = JSON.parse(e.data);
    if (l.botId !== state.botId) return;
    state.logs.push(l);
    if (state.logs.length > 300) state.logs.shift();
    if (state.tab === 'logs') renderSidebar();
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(() => api('GET', '/api/me').then(connectStream, () => location.reload()), 3000);
    }
  };
}

function notify(m) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const c = state.convs.get(convKey(m.convType, m.peerId));
  new Notification(c?.name || '新消息', { body: `${m.authorName ? m.authorName + '：' : ''}${m.content || '[媒体]'}`.slice(0, 100), tag: convKey(m.convType, m.peerId) });
}

let memberTimer = null;
function refreshMembersSoon() {
  clearTimeout(memberTimer);
  memberTimer = setTimeout(loadMembers, 400);
}

// ---------------- 机器人 ----------------
async function reloadBots(preferId) {
  state.bots = await api('GET', '/api/bots');
  const ids = state.bots.map((b) => b.id);
  const id = ids.includes(preferId) ? preferId : ids.includes(state.botId) ? state.botId : ids[0];
  renderRail();
  if (id) await selectBot(id, true);
  else {
    state.botId = null;
    state.convs.clear();
    closeConv();
    renderSidebar();
    botDialog(null);
  }
}

async function selectBot(id, force = false) {
  if (state.botId === id && !force) return;
  const changed = state.botId !== id;
  state.botId = id;
  localStorage.setItem('botId', id);
  if (changed) closeConv();
  renderRail();
  const [convs, events, logs] = await Promise.all([
    api('GET', `/api/bots/${id}/conversations`),
    api('GET', `/api/bots/${id}/events`),
    api('GET', `/api/bots/${id}/logs`),
  ]);
  state.convs = new Map(convs.map((c) => [convKey(c.type, c.peerId), c]));
  state.events = events;
  state.logs = logs;
  renderBotCard();
  renderSidebar();
}

// ---------------- 会话 ----------------
async function openConv(type, peerId) {
  state.tab = 'chats';
  state.current = { type, peerId };
  state.replyTo = null;
  state.attachment = null;
  state.members = [];
  location.hash = `${type}/${peerId}`;
  $('#chat-empty').classList.add('hidden');
  $('#chat-inner').classList.remove('hidden');
  $('#app').classList.add('in-chat');
  $('#btn-at').classList.toggle('hidden', type !== 'group');
  renderSidebar();
  renderReplyBar();
  renderAttachment();
  let conv = currentConv();
  if (!conv) {
    conv = await api('POST', `/api/bots/${state.botId}/conversations`, { type, peerId });
    state.convs.set(convKey(type, peerId), conv);
  }
  renderChatHead();
  const [msgs] = await Promise.all([
    api('GET', `/api/bots/${state.botId}/conversations/${type}/${encodeURIComponent(peerId)}/messages?limit=50`),
    type === 'group' ? loadMembers() : Promise.resolve(),
  ]);
  if (!state.current || state.current.peerId !== peerId) return;
  state.messages = msgs;
  state.hasMore = msgs.length >= 50;
  renderMessages({ toBottom: true });
  renderPanel();
  if (conv.unread) markRead(conv);
  $('#input').focus();
}

async function loadMembers() {
  const c = state.current;
  if (!c || c.type !== 'group') return;
  const list = await api('GET', `/api/bots/${state.botId}/groups/${encodeURIComponent(c.peerId)}/members`);
  if (state.current?.peerId !== c.peerId) return;
  state.members = list;
  renderPanel();
  renderChatHead();
}

function markRead(conv) {
  api('PATCH', `/api/bots/${state.botId}/conversations/${conv.type}/${encodeURIComponent(conv.peerId)}`, { read: true }).catch(() => {});
}

function closeConv() {
  state.current = null;
  state.messages = [];
  state.members = [];
  $('#chat-empty').classList.remove('hidden');
  $('#chat-inner').classList.add('hidden');
  $('#app').classList.remove('in-chat');
  $('#panel').classList.add('hidden');
  history.replaceState(null, '', location.pathname);
}

async function loadMore() {
  const c = state.current;
  const first = state.messages[0];
  if (!c || !first) return;
  const older = await api('GET', `/api/bots/${state.botId}/conversations/${c.type}/${encodeURIComponent(c.peerId)}/messages?limit=50&before=${first.id}`);
  state.messages = [...older, ...state.messages];
  state.hasMore = older.length >= 50;
  renderMessages({ keepScroll: true });
}

function addConvDialog() {
  if (!state.botId) return toast('请先添加机器人', 'error');
  openModal((m, close) => {
    const type = h('select', {}, h('option', { value: 'group' }, '群聊（group_openid）'), h('option', { value: 'c2c' }, '私聊（user_openid）'));
    const peer = h('input', { placeholder: 'OpenID' });
    const remark = h('input', { placeholder: '备注名（可选）' });
    const err = h('p', { class: 'form-error' });
    m.append(
      h('h2', {}, '手动添加会话'),
      h('p', { class: 'muted small', style: 'line-height:1.6;margin-top:-6px' },
        'QQ 开放平台不提供“机器人所在群列表”接口，会话通常在收到消息或进群事件时自动创建。若已知群/用户的 OpenID（与当前机器人 AppID 绑定），可在这里手动添加并发送主动消息。'),
      h('div', { class: 'field' }, h('label', {}, '类型'), type),
      h('div', { class: 'field' }, h('label', {}, 'OpenID'), peer),
      h('div', { class: 'field' }, h('label', {}, '备注'), remark),
      err,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, '取消'),
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            const c = await api('POST', `/api/bots/${state.botId}/conversations`, { type: type.value, peerId: peer.value.trim(), remark: remark.value.trim() });
            state.convs.set(convKey(c.type, c.peerId), c);
            close();
            openConv(c.type, c.peerId);
          } catch (e) {
            err.textContent = e.message;
          }
        } }, '添加')),
    );
  });
}

async function hideConv(conv) {
  if (!(await confirmBox('移除会话', '会话将从列表中隐藏（聊天记录保留），收到新消息时会重新出现。', '移除'))) return;
  await api('PATCH', `/api/bots/${state.botId}/conversations/${conv.type}/${encodeURIComponent(conv.peerId)}`, { hidden: true });
  closeConv();
}

// ---------------- 输入框 ----------------
function setReply(m) {
  state.replyTo = m;
  renderReplyBar();
  if (m) $('#input').focus();
}

function setAttachment(a) {
  state.attachment = a;
  renderAttachment();
  renderSuggestions();
}

function insertAtCursor(text) {
  const input = $('#input');
  const s = input.selectionStart ?? input.value.length;
  const e = input.selectionEnd ?? s;
  input.value = input.value.slice(0, s) + text + input.value.slice(e);
  input.selectionStart = input.selectionEnd = s + text.length;
  input.focus();
}

function insertMention(memberId) {
  if (state.current?.type !== 'group') return;
  // QQ 群聊中 @成员 仅支持 Markdown 消息
  $('#opt-markdown').checked = true;
  insertAtCursor(`<qqbot-at-user id="${memberId}" /> `);
  updateHint();
}

function updateHint() {
  const v = $('#input').value;
  const hint = $('#composer-hint');
  if (/<qqbot-at-user\s/.test(v)) hint.textContent = '含 @成员，将以 Markdown 消息发送';
  else if (/<qqbot-at-everyone\s*\/>/.test(v)) hint.textContent = '@全体成员需要机器人是群管理员，每群每天 1 次';
  else hint.textContent = '';
}

let mentionState = null;
function handleMentionPopup() {
  const input = $('#input');
  const pop = $('#mention-pop');
  if (state.current?.type !== 'group') return pop.classList.add('hidden');
  const before = input.value.slice(0, input.selectionStart);
  const m = /@([^\s@<>]*)$/.exec(before);
  if (!m) {
    mentionState = null;
    return pop.classList.add('hidden');
  }
  const q = m[1].toLowerCase();
  const list = [
    { memberId: '__all__', name: '全体成员' },
    ...state.members.filter((x) => x.inGroup && !x.bot),
  ].filter((x) => !q || x.name.toLowerCase().includes(q) || x.memberId.toLowerCase().startsWith(q)).slice(0, 8);
  if (!list.length) return pop.classList.add('hidden');
  mentionState = { start: before.length - m[0].length, list, sel: 0 };
  drawMentionPop();
  const r = input.getBoundingClientRect();
  pop.style.left = `${r.left}px`;
  pop.style.top = `${Math.max(8, r.top - Math.min(260, list.length * 40 + 8) - 6)}px`;
  pop.classList.remove('hidden');
}

function drawMentionPop() {
  const pop = $('#mention-pop');
  pop.innerHTML = '';
  mentionState.list.forEach((x, i) => {
    pop.append(h('div', { class: `member ${i === mentionState.sel ? 'sel' : ''}`, onmousedown: (e) => {
      e.preventDefault();
      pickMention(x);
    } }, avatar(x.name, x.memberId, { size: 'xs' }), h('span', { class: 'mname' }, x.name)));
  });
}

function pickMention(x) {
  const input = $('#input');
  const end = input.selectionStart;
  input.value = input.value.slice(0, mentionState.start) + input.value.slice(end);
  input.selectionStart = input.selectionEnd = mentionState.start;
  if (x.memberId === '__all__') insertAtCursor('<qqbot-at-everyone /> ');
  else insertMention(x.memberId);
  mentionState = null;
  $('#mention-pop').classList.add('hidden');
  updateHint();
}

async function pickFile(file, forceType) {
  if (!file) return;
  // 图片先存入媒体库：发送后可以预览，也能收藏为表情
  if ((forceType === 'image' || !forceType) && /^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
    try {
      const m = await uploadImageFile(file);
      setAttachment({ type: 'image', name: m.name || file.name, size: m.size, mediaId: m.id, preview: m.url });
      $('#input').focus();
    } catch (e) {
      toast(e.message, 'error');
    }
    return;
  }
  if (file.size > 5 * 1024 * 1024) return toast('直接上传的文件不能超过 5MB；更大的文件请使用“网址”方式发送', 'error');
  let type = forceType;
  if (!type) {
    if (/^image\/(png|jpeg|gif)$/.test(file.type)) type = 'image';
    else if (file.type === 'video/mp4') type = 'video';
    else if (/\.(silk|slk|amr|mp3|wav)$/i.test(file.name)) type = 'voice';
    else type = 'file';
  }
  const data = await readFileBase64(file);
  setAttachment({ type, name: file.name, size: file.size, data, preview: type === 'image' ? `data:${file.type};base64,${data}` : '' });
  $('#input').focus();
}

async function urlMediaDialog() {
  openModal((m, close) => {
    const type = h('select', {}, h('option', { value: 'image' }, '图片 (png/jpg)'), h('option', { value: 'video' }, '视频 (mp4)'), h('option', { value: 'voice' }, '语音 (silk)'), h('option', { value: 'file' }, '文件'));
    const url = h('input', { placeholder: 'https://...' });
    m.append(
      h('h2', {}, '通过网址发送媒体'),
      h('p', { class: 'muted small', style: 'margin-top:-6px' }, 'QQ 服务器会从该网址下载文件，需能被公网访问。'),
      h('div', { class: 'field' }, h('label', {}, '类型'), type),
      h('div', { class: 'field' }, h('label', {}, '网址'), url),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, '取消'),
        h('button', { class: 'btn primary', onclick: () => {
          if (!/^https?:\/\//.test(url.value.trim())) return toast('请输入 http(s) 网址', 'error');
          setAttachment({ type: type.value, url: url.value.trim(), name: url.value.trim().split('/').pop() });
          close();
        } }, '确定')),
    );
  });
}

async function recall(m) {
  if (!(await confirmBox('撤回消息', m.direction === 'out' ? '确定撤回这条消息吗？' : '撤回群成员消息需要机器人是群管理员。确定撤回吗？', '撤回', true))) return;
  try {
    await api('POST', `/api/bots/${state.botId}/messages/${m.id}/recall`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function resend(m) {
  $('#input').value = m.content;
  $('#opt-markdown').checked = !!m.payload?.markdown;
  $('#input').focus();
  toast('已放回输入框，可修改后重新发送');
}

async function convMenu(c) {
  const v = await promptBox('设置会话备注', { value: c.remark, hint: `${c.type === 'group' ? 'group_openid' : 'user_openid'}: ${c.peerId}` });
  if (v === null) return;
  await api('PATCH', `/api/bots/${state.botId}/conversations/${c.type}/${encodeURIComponent(c.peerId)}`, { remark: v.trim() });
}

function togglePanel(open) {
  state.panelOpen = open ?? !state.panelOpen;
  localStorage.setItem('panelOpen', state.panelOpen ? '1' : '0');
  renderPanel();
}

// ---------------- 事件绑定 ----------------
let bound = false;
function bindUi() {
  if (bound) return;
  bound = true;
  $('#btn-add-bot').onclick = () => botDialog(null);
  $('#btn-settings').onclick = settingsDialog;
  $('#btn-add-conv').onclick = addConvDialog;
  $('#btn-back').onclick = closeConv;
  $('#btn-toggle-panel').onclick = () => togglePanel();
  $('#conv-search').oninput = (e) => {
    state.search = e.target.value;
    state.tab = 'chats';
    renderSidebar();
  };
  document.querySelectorAll('#sidebar-tabs button').forEach((b) => (b.onclick = () => {
    state.tab = b.dataset.tab;
    renderSidebar();
  }));
  $('#btn-send').onclick = sendCurrent;
  $('#btn-sticker').onclick = (e) => toggleStickerPanel(e.currentTarget);
  $('#btn-image').onclick = () => $('#file-image').click();
  $('#btn-file').onclick = () => $('#file-any').click();
  $('#btn-url-media').onclick = urlMediaDialog;
  $('#btn-at').onclick = () => {
    insertAtCursor('@');
    handleMentionPopup();
  };
  $('#file-image').onchange = (e) => {
    pickFile(e.target.files[0], 'image');
    e.target.value = '';
  };
  $('#file-any').onchange = (e) => {
    pickFile(e.target.files[0]);
    e.target.value = '';
  };
  $('#opt-mode').onchange = renderWindowBar;
  const input = $('#input');
  input.addEventListener('input', () => {
    handleMentionPopup();
    updateHint();
    renderSuggestions();
  });
  input.addEventListener('blur', () => setTimeout(() => $('#mention-pop').classList.add('hidden'), 150));
  input.addEventListener('keydown', (e) => {
    const popOpen = mentionState && !$('#mention-pop').classList.contains('hidden');
    if (popOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const n = mentionState.list.length;
      mentionState.sel = (mentionState.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      drawMentionPop();
      return;
    }
    if (popOpen && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      pickMention(mentionState.list[mentionState.sel]);
      return;
    }
    if (popOpen && e.key === 'Escape') {
      $('#mention-pop').classList.add('hidden');
      return;
    }
    if (!popOpen && handleSuggestKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendCurrent();
    }
  });
  input.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])][0];
    if (file && file.type.startsWith('image/')) {
      e.preventDefault();
      pickFile(file, 'image');
    }
  });
  const chat = $('#chat');
  chat.addEventListener('dragover', (e) => e.preventDefault());
  chat.addEventListener('drop', (e) => {
    e.preventDefault();
    if (state.current) pickFile(e.dataTransfer.files[0]);
  });
  setInterval(() => state.current && renderWindowBar(), 1000);
  document.addEventListener('visibilitychange', () => {
    const c = currentConv();
    if (document.visibilityState === 'visible' && c?.unread) markRead(c);
  });
  document.addEventListener('click', () => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }, { once: true });
}

Object.assign(actions, {
  selectBot,
  reloadBots,
  editBot: (b) => botDialog(b),
  openConv,
  convMenu,
  hideConv,
  loadMore,
  setReply,
  setAttachment,
  sendImage,
  insertMention,
  recall,
  resend,
  togglePanel,
  refreshChat: () => {
    renderMessages();
    renderPanel();
    renderChatHead();
  },
});

boot();
