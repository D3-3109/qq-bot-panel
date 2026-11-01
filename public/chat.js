import { h, $, avatar, fmtTime, api, toast } from './lib.js';
import { state, actions, currentBot, currentConv, nameOf } from './state.js';
import { textNode, attachmentNode, arkNode, quotedFromElements, outMediaNode, plainPreview } from './render.js';
import { cardNode, keyboardNode } from './rich-ui.js';

const ROLE_TEXT = { owner: '群主', admin: '管理员' };

// 图片大图预览，可收藏为表情
export function showLightbox(info) {
  const { src, msg, idx } = typeof info === 'string' ? { src: info } : info;
  let mediaId = info.mediaId || null;
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);

  const already = () => mediaId && state.stickers.some((s) => s.mediaId === mediaId);
  const favBtn = h('button', { class: 'btn small' }, already() ? '已收藏' : '☆ 收藏为表情');
  favBtn.disabled = already();
  favBtn.onclick = async (e) => {
    e.stopPropagation();
    favBtn.disabled = true;
    try {
      if (!mediaId && msg) {
        const m = await api('POST', `/api/bots/${state.botId}/messages/${msg.id}/attachments/${idx}/cache`);
        mediaId = m.id;
      }
      if (!mediaId) throw new Error('这张图片无法收藏');
      const s = await api('POST', '/api/stickers', { mediaId });
      favBtn.textContent = '已收藏';
      toast(s.existed ? '已在表情收藏中' : '已收藏为表情', 'ok');
    } catch (err) {
      favBtn.disabled = false;
      toast(err.message, 'error');
    }
  };
  const sendBtn = h('button', { class: 'btn small' }, '再发一次');
  sendBtn.onclick = async (e) => {
    e.stopPropagation();
    try {
      if (!mediaId && msg) mediaId = (await api('POST', `/api/bots/${state.botId}/messages/${msg.id}/attachments/${idx}/cache`)).id;
      if (!mediaId) throw new Error('这张图片无法转发');
      close();
      actions.sendImage({ mediaId });
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const openBtn = h('a', { class: 'btn small', href: src, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, '原图');
  const box = h('div', { class: 'lightbox', onclick: close },
    h('img', { src, referrerpolicy: 'no-referrer', onclick: (e) => e.stopPropagation() }),
    h('div', { class: 'lightbox-bar', onclick: (e) => e.stopPropagation() },
      state.current ? sendBtn : null, favBtn, openBtn, h('button', { class: 'btn small', onclick: close }, '关闭')));
  document.body.append(box);
}

export function renderChatHead() {
  const conv = currentConv();
  if (!conv) return;
  $('#chat-name').textContent = conv.name;
  const sub = [];
  sub.push(conv.type === 'group' ? '群聊' : '私聊');
  if (conv.type === 'group') {
    const n = state.members.filter((m) => m.inGroup).length;
    if (n) sub.push(`已知成员 ${n}`);
  }
  if (conv.status === 'removed') sub.push('机器人已被移出');
  if (conv.status === 'rejected') sub.push('已关闭主动消息');
  if (conv.type === 'group') sub.push(conv.fullSeen ? '接收全部消息' : '仅接收 @机器人 的消息');
  $('#chat-sub').textContent = sub.join(' · ');
  renderWindowBar();
}

export function renderWindowBar() {
  const bar = $('#window-bar');
  const conv = currentConv();
  if (!conv) return;
  const w = conv.replyWindow;
  const mode = $('#opt-mode').value;
  bar.className = 'window-bar';
  const q = conv.quota;
  const quotaText = q ? `主动消息配额：今日 ${q.day}/${q.perDay}，近 1 分钟 ${q.minute}/${q.perMinute}` : '';
  const quotaLow = q && (q.minute >= q.perMinute - 2 || q.day >= q.perDay * 0.9);
  if (mode === 'active') {
    bar.classList.add(quotaLow ? 'blocked' : 'active');
    bar.textContent = `将以主动消息发送 · ${quotaText}${quotaLow ? '（即将达到上限）' : ''}`;
    return;
  }
  if (w && w.expiresAt > Date.now()) {
    const left = Math.max(0, Math.round((w.expiresAt - Date.now()) / 1000));
    const mm = Math.floor(left / 60);
    const ss = String(left % 60).padStart(2, '0');
    bar.classList.add('passive');
    bar.textContent = `被动回复窗口可用：剩余 ${w.remaining} 次 · ${mm}:${ss} 后过期`;
  } else if (mode === 'passive') {
    bar.classList.add('blocked');
    bar.textContent = '当前没有可用的被动回复窗口：需要有人 @机器人 或私聊后才能回复';
  } else {
    bar.classList.add(quotaLow ? 'blocked' : 'active');
    bar.textContent = conv.status === 'rejected'
      ? '无被动回复窗口，且对方已关闭主动消息，发送可能失败'
      : `无被动回复窗口，将以主动消息发送 · ${quotaText}${quotaLow ? '（即将达到上限）' : ''}`;
  }
}

function msgNode(m, prev) {
  const frag = document.createDocumentFragment();
  if (!prev || m.ts - prev.ts > 5 * 60_000) frag.append(h('div', { class: 'time-divider' }, fmtTime(m.ts, false)));

  if (m.direction === 'system') {
    frag.append(h('div', { class: 'sys-msg', title: fmtTime(m.ts, true), dataset: { id: m.id } }, m.content));
    return frag;
  }
  const out = m.direction === 'out';
  const bot = currentBot();
  const name = out ? bot?.name || '我' : m.authorName || nameOf(m.authorId);
  const bubble = h('div', { class: 'bubble' });

  if (m.status === 'recalled') {
    bubble.append(h('i', {}, out ? '你撤回了一条消息' : '该消息已被撤回'));
  } else {
    const p = m.payload || {};
    const quoteText = out ? (p.quote ? `${p.quote.authorName || ''}：${plainPreview(p.quote.content, nameOf)}` : '')
      : (p.messageType === 103 ? quotedFromElements(p.msgElements, nameOf) : '');
    if (quoteText) bubble.append(h('div', { class: 'quote' }, quoteText));
    if (m.content && m.content.trim()) bubble.append(textNode(m.content.trim(), { markdown: out && p.markdown, nameOf }));
    (p.attachments || []).forEach((a, idx) => bubble.append(attachmentNode(a, (info) => showLightbox({ ...info, msg: m, idx }))));
    if (p.arkData) bubble.append(arkNode(p.arkData));
    if (out && p.media) bubble.append(outMediaNode(p.media, showLightbox));
    if (out && p.card) bubble.append(cardNode(p.card));
    if (out && p.keyboard) bubble.append(keyboardNode(p.keyboard));
    if (!bubble.childNodes.length) {
      bubble.append(p.atBot ? h('span', { class: 'mention' }, `@${bot?.name || '机器人'}`) : h('span', { class: 'muted' }, '[不支持的消息类型]'));
    }
    // 只有图片（表情包）时像 QQ 一样不套气泡
    const kids = [...bubble.children];
    if (kids.length && kids.every((k) => k.tagName === 'IMG' || k.classList.contains('card-msg'))) bubble.classList.add('media-only');
  }

  const meta = h('div', { class: 'msg-meta' });
  if (out) {
    if (m.status === 'sending') meta.append('发送中…');
    else if (m.status === 'failed') meta.append(h('span', { class: 'fail', title: m.error }, `发送失败：${m.error}`));
    else if (m.status === 'audit') meta.append(h('span', { style: 'color:#d25f00' }, '审核中'));
    else if (m.payload?.sendMode) meta.append(m.payload.sendMode === 'passive' ? '被动回复' : '主动消息');
    const ORIGIN = { schedule: '⏰ 定时', auto: '🤖 自动回复', forward: '🔗 外部程序' };
    if (ORIGIN[m.payload?.origin]) meta.append(h('span', { class: 'tag' }, ORIGIN[m.payload.origin]));
  } else if (m.payload?.atBot) {
    meta.append(h('span', { class: 'tag admin' }, '@机器人'));
  }

  const acts = h('div', { class: 'msg-actions' });
  if (m.status !== 'recalled') {
    acts.append(h('button', { onclick: () => actions.setReply(m) }, '回复'));
    acts.append(h('button', { onclick: () => copyText(m.content) }, '复制'));
    const imgIdx = (m.payload?.attachments || []).findIndex((a) => String(a.content_type || '').startsWith('image'));
    const outImage = out && m.payload?.media?.type === 'image' && m.payload.media.mediaId;
    if (imgIdx >= 0 || outImage) {
      acts.append(h('button', { class: 'fav', onclick: () => favImage(m, imgIdx, outImage ? m.payload.media.mediaId : null) }, '☆收藏'));
    }
    if (!out && m.authorId && state.current?.type === 'group') acts.append(h('button', { onclick: () => actions.insertMention(m.authorId) }, '@TA'));
    if (m.msgId && (out || state.current?.type === 'group') && m.status === 'ok' && Date.now() - m.ts < 2 * 60_000) {
      acts.append(h('button', { onclick: () => actions.recall(m) }, '撤回'));
    }
    if (out && m.status === 'failed') acts.append(h('button', { onclick: () => actions.resend(m) }, '重发'));
  }

  const author = h('div', { class: 'author' }, name,
    !out && ROLE_TEXT[m.authorRole] ? h('span', { class: `tag ${m.authorRole}` }, ROLE_TEXT[m.authorRole]) : null,
    h('span', { title: fmtTime(m.ts, true) }, fmtTime(m.ts)));

  frag.append(h('div', { class: `msg ${out ? 'out' : 'in'} ${m.status === 'recalled' ? 'recalled' : ''}`, dataset: { id: m.id } },
    out ? avatar(name, bot?.appId, { size: 'sm', img: bot?.avatar }) : avatar(name, m.authorId, { size: 'sm' }),
    h('div', { class: 'body' }, author, bubble, meta, acts)));
  return frag;
}

async function favImage(m, idx, mediaId) {
  try {
    let id = mediaId || m.payload.attachments?.[idx]?.mediaId;
    if (!id) id = (await api('POST', `/api/bots/${state.botId}/messages/${m.id}/attachments/${idx}/cache`)).id;
    const s = await api('POST', '/api/stickers', { mediaId: id });
    toast(s.existed ? '已在表情收藏中' : '已收藏为表情', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function copyText(t) {
  navigator.clipboard?.writeText(t || '').then(() => toast('已复制'), () => toast('复制失败', 'error'));
}

export function renderMessages({ keepScroll = false, toBottom = false } = {}) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  box.innerHTML = '';
  if (state.hasMore) box.append(h('button', { class: 'load-more', onclick: () => actions.loadMore() }, '查看更早的消息'));
  if (!state.messages.length) box.append(h('div', { class: 'time-divider' }, '暂无消息'));
  let prev = null;
  for (const m of state.messages) {
    box.append(msgNode(m, prev));
    prev = m;
  }
  if (state.atLatest === false) box.append(h('button', { class: 'load-more', onclick: () => actions.jumpToLatest() }, '回到最新消息 ↓'));
  if (keepScroll) box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  else if (toBottom || nearBottom) {
    const stick = () => (box.scrollTop = box.scrollHeight);
    stick();
    requestAnimationFrame(stick);
    stickUntil = Date.now() + 3000;
  }
}

// 图片/视频异步加载会改变高度：渲染后短时间内保持贴底
let stickUntil = 0;
document.addEventListener('load', (e) => {
  if (Date.now() > stickUntil) return;
  const box = $('#messages');
  if (box.contains(e.target)) box.scrollTop = box.scrollHeight;
}, true);
document.addEventListener('loadedmetadata', (e) => {
  if (Date.now() > stickUntil) return;
  const box = $('#messages');
  if (box.contains(e.target)) box.scrollTop = box.scrollHeight;
}, true);

export function upsertMessage(m) {
  const i = state.messages.findIndex((x) => x.id === m.id);
  if (i >= 0) state.messages[i] = m;
  else state.messages.push(m);
  renderMessages({ toBottom: m.direction === 'out' && i < 0 });
}

export function renderReplyBar() {
  const bar = $('#reply-bar');
  const m = state.replyTo;
  if (!m) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  const who = m.direction === 'out' ? currentBot()?.name : m.authorName || nameOf(m.authorId);
  const hint = m.direction === 'in' ? '（优先使用该消息的被动回复窗口）' : '';
  bar.append(h('span', {}, `回复 ${who}：${plainPreview(m.content, nameOf) || '[媒体]'} ${hint}`),
    h('button', { onclick: () => actions.setReply(null), title: '取消' }, '✕'));
}

export function renderAttachment() {
  const box = $('#attach-preview');
  const a = state.attachment;
  if (!a) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = '';
  if (a.type === 'image' && (a.preview || a.url)) box.append(h('img', { src: a.preview || a.url, referrerpolicy: 'no-referrer' }));
  const label = { image: '图片', video: '视频', voice: '语音', file: '文件' }[a.type];
  box.append(h('span', {}, `${label}：${a.name || a.url}`), h('button', { onclick: () => actions.setAttachment(null) }, '✕'));
}

function attachmentBody(a) {
  if (!a) return undefined;
  if (a.mediaId) return { type: 'image', mediaId: a.mediaId };
  if (a.url) return { type: a.type, url: a.url, name: a.name };
  return { type: a.type, name: a.name, data: a.data };
}

// 直接发送一张图片（收藏的表情或媒体库图片），不影响输入框里正在编辑的文字
export async function sendImage({ stickerId, mediaId }) {
  const conv = currentConv();
  if (!conv) return;
  const body = { text: '', replyMode: $('#opt-mode').value };
  if (stickerId) body.stickerId = stickerId;
  else body.media = { type: 'image', mediaId };
  try {
    await api('POST', `/api/bots/${state.botId}/conversations/${conv.type}/${encodeURIComponent(conv.peerId)}/messages`, body);
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function sendCurrent() {
  const conv = currentConv();
  if (!conv) return;
  const input = $('#input');
  const text = input.value;
  if (!text.trim() && !state.attachment) return;
  const body = {
    text,
    markdown: $('#opt-markdown').checked,
    replyMode: $('#opt-mode').value,
    quoteId: state.replyTo?.id,
    keyboard: state.keyboard || undefined,
    media: attachmentBody(state.attachment),
  };
  input.value = '';
  actions.saveDraft();
  actions.setReply(null);
  actions.setAttachment(null);
  actions.setKeyboard(null);
  const btn = $('#btn-send');
  btn.disabled = true;
  try {
    await api('POST', `/api/bots/${state.botId}/conversations/${conv.type}/${encodeURIComponent(conv.peerId)}/messages`, body);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    input.focus();
  }
}
