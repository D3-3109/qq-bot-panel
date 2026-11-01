// 表情收藏面板与输入联想
import { h, $, api, toast, promptBox, confirmBox, openModal } from './lib.js';
import { state, actions } from './state.js';

export async function loadStickers() {
  try {
    state.stickers = await api('GET', '/api/stickers');
  } catch {
    state.stickers = [];
  }
  refreshStickerViews();
}

export function setStickers(list) {
  state.stickers = list;
  refreshStickerViews();
}

function refreshStickerViews() {
  if (popEl) drawGrid();
  renderSuggestions();
}

// 上传本地图片到媒体库，返回媒体记录
export async function uploadImageFile(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('只支持 PNG / JPEG / GIF / WebP 图片');
  if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10MB');
  const res = await fetch('/api/media', {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name || 'image') },
    body: file,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `上传失败 (${res.status})`);
  return data;
}

function stickerCell(s, { onPick, withMenu = false, selected = false } = {}) {
  const cell = h('button', { class: `sticker-cell ${selected ? 'sel' : ''}`, title: s.keywords ? `关键词：${s.keywords}` : '点击发送', onclick: () => onPick(s) },
    h('img', { src: s.url, alt: s.keywords || '表情', loading: 'lazy' }),
    s.keywords ? h('span', { class: 'kw' }, s.keywords.split(' ')[0]) : null);
  if (withMenu) {
    const more = h('span', { class: 'more', role: 'button', title: '编辑', onclick: (e) => {
      e.stopPropagation();
      stickerMenu(s);
    } }, '⋯');
    cell.append(more);
    cell.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      stickerMenu(s);
    });
  }
  return cell;
}

async function stickerMenu(s) {
  const kw = await promptBox('编辑表情', {
    label: '关键词',
    value: s.keywords,
    placeholder: '例如：哈哈 笑死 开心',
    hint: '用空格或逗号分隔。输入框里出现这些词时会推荐此表情。留空不推荐。',
  });
  if (kw === null) return;
  try {
    await api('PATCH', `/api/stickers/${s.id}`, { keywords: kw });
    toast('已保存', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function deleteSticker(s) {
  if (!(await confirmBox('删除表情', '确定从收藏中删除这个表情吗？', '删除', true))) return;
  try {
    await api('DELETE', `/api/stickers/${s.id}`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 表情面板 ----------
let popEl = null;
let popQuery = '';
let deleteMode = false;

export function toggleStickerPanel(anchor) {
  if (popEl) return closeStickerPanel();
  closeQuickPanel();
  popQuery = '';
  deleteMode = false;
  const search = h('input', { placeholder: '搜索关键词', oninput: (e) => {
    popQuery = e.target.value.trim().toLowerCase();
    drawGrid();
  } });
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true });
  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    let ok = 0;
    for (const f of files) {
      try {
        const m = await uploadImageFile(f);
        await api('POST', '/api/stickers', { mediaId: m.id });
        ok++;
      } catch (e) {
        toast(`${f.name}：${e.message}`, 'error');
      }
    }
    if (ok) toast(`已添加 ${ok} 个表情`, 'ok');
  };
  const delBtn = h('button', { class: 'btn small', title: '管理' }, '管理');
  delBtn.onclick = () => {
    deleteMode = !deleteMode;
    delBtn.textContent = deleteMode ? '完成' : '管理';
    drawGrid();
  };
  popEl = h('div', { class: 'sticker-pop' },
    h('div', { class: 'sp-head' }, search,
      h('button', { class: 'btn small primary', onclick: () => fileInput.click() }, '＋ 添加'), delBtn, fileInput),
    h('div', { class: 'sp-grid' }));
  document.body.append(popEl);
  const r = anchor.getBoundingClientRect();
  popEl.style.left = `${Math.max(12, Math.min(r.left, innerWidth - popEl.offsetWidth - 12))}px`;
  popEl.style.bottom = `${innerHeight - r.top + 8}px`;
  drawGrid();
  search.focus();
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
  document.addEventListener('keydown', escClose);
}

function outside(e) {
  if (popEl && !popEl.contains(e.target) && !e.target.closest('#btn-sticker')) closeStickerPanel();
}
function escClose(e) {
  if (e.key === 'Escape') closeStickerPanel();
}

export function closeStickerPanel() {
  popEl?.remove();
  popEl = null;
  document.removeEventListener('mousedown', outside);
  document.removeEventListener('keydown', escClose);
}

function drawGrid() {
  const grid = popEl.querySelector('.sp-grid');
  grid.innerHTML = '';
  const list = state.stickers.filter((s) => !popQuery || s.keywords.toLowerCase().includes(popQuery));
  if (!list.length) {
    grid.append(h('div', { class: 'sp-empty', html: popQuery ? '没有匹配的表情'
      : '还没有收藏表情<br>点击 ＋ 添加本地图片，<br>或在聊天中点开图片选择“收藏为表情”' }));
    return;
  }
  for (const s of list) {
    const cell = stickerCell(s, {
      withMenu: !deleteMode,
      onPick: (x) => {
        if (deleteMode) return deleteSticker(x);
        closeStickerPanel();
        actions.sendImage({ stickerId: x.id });
      },
    });
    if (deleteMode) cell.append(h('span', { class: 'more', style: 'display:block;color:#f53f3f' }, '✕'));
    grid.append(cell);
  }
}

// ---------- 输入联想：输入内容命中关键词时推荐表情 ----------
let suggestSel = -1;
let suggestList = [];

function matchStickers(text) {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 20 || t.includes('<')) return [];
  return state.stickers
    .map((s) => {
      const kws = s.keywords.toLowerCase().split(' ').filter(Boolean);
      let score = 0;
      for (const k of kws) {
        if (k === t) score = Math.max(score, 3);
        else if (k.startsWith(t) || t.endsWith(k)) score = Math.max(score, 2);
        else if (k.includes(t) || t.includes(k)) score = Math.max(score, 1);
      }
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.s.useCount - a.s.useCount)
    .slice(0, 12)
    .map((x) => x.s);
}

// 常用语：输入 “/” 列出全部，“/关键词” 或命中关键词时推荐
function matchQuick(text) {
  const raw = text.trim();
  const slash = raw.startsWith('/');
  const t = (slash ? raw.slice(1) : raw).toLowerCase();
  if ((!t && !slash) || t.length > 20 || t.includes('<')) return [];
  return (state.quickReplies || [])
    .map((q) => {
      if (slash && !t) return { q, score: 1 };
      const kws = q.keywords.toLowerCase().split(' ').filter(Boolean);
      let score = 0;
      for (const k of kws) {
        if (k === t) score = Math.max(score, 3);
        else if (k.startsWith(t)) score = Math.max(score, 2);
      }
      if (slash && q.text.toLowerCase().includes(t)) score = Math.max(score, 1);
      return { q, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.q.useCount - a.q.useCount)
    .slice(0, 8)
    .map((x) => x.q);
}

export function renderSuggestions() {
  const bar = $('#suggest-bar');
  if (!bar) return;
  const input = $('#input');
  const on = state.current && !state.attachment;
  const quick = on ? matchQuick(input.value) : [];
  const stickers = on && !input.value.trim().startsWith('/') ? matchStickers(input.value) : [];
  suggestList = [...quick.map((item) => ({ kind: 'quick', item })), ...stickers.map((item) => ({ kind: 'sticker', item }))];
  if (!suggestList.length) {
    bar.classList.add('hidden');
    suggestSel = -1;
    return;
  }
  if (suggestSel >= suggestList.length) suggestSel = -1;
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  suggestList.forEach((x, i) => {
    if (i === 0 || suggestList[i - 1].kind !== x.kind) bar.append(h('span', { class: 'label' }, x.kind === 'quick' ? '常用语' : '表情'));
    if (x.kind === 'sticker') bar.append(stickerCell(x.item, { selected: i === suggestSel, onPick: () => pickSuggestion(x) }));
    else bar.append(h('button', { class: `quick-chip ${i === suggestSel ? 'sel' : ''}`, title: x.item.text, onclick: () => pickSuggestion(x) }, x.item.text.slice(0, 30)));
  });
}

function pickSuggestion(x) {
  const input = $('#input');
  suggestSel = -1;
  if (x.kind === 'quick') {
    // 常用语填入输入框，确认后再发送
    input.value = x.item.text;
    if (x.item.markdown) $('#opt-markdown').checked = true;
    api('POST', `/api/quick-replies/${x.item.id}/used`).catch(() => {});
    input.dispatchEvent(new Event('input'));
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
    return;
  }
  input.value = '';
  input.dispatchEvent(new Event('input'));
  actions.sendImage({ stickerId: x.item.id });
  input.focus();
}

// 方向键在候选中选择，Enter 发送选中的表情；返回 true 表示已处理按键
export function handleSuggestKey(e) {
  if (!suggestList.length) return false;
  if (e.key === 'ArrowUp' && suggestSel === -1 && !e.target.value.includes('\n')) {
    e.preventDefault();
    suggestSel = 0;
    renderSuggestions();
    return true;
  }
  if (suggestSel < 0) return false;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    const n = suggestList.length;
    suggestSel = (suggestSel + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
    renderSuggestions();
    return true;
  }
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    pickSuggestion(suggestList[suggestSel]);
    return true;
  }
  if (e.key === 'Escape' || e.key === 'ArrowDown') {
    e.preventDefault();
    suggestSel = -1;
    renderSuggestions();
    return true;
  }
  return false;
}

// ---------- 常用语面板 ----------
export async function loadQuick() {
  try {
    state.quickReplies = await api('GET', '/api/quick-replies');
  } catch {
    state.quickReplies = [];
  }
  renderSuggestions();
}

export function setQuick(list) {
  state.quickReplies = list;
  renderSuggestions();
  if (quickEl) drawQuick();
}

let quickEl = null;

export function toggleQuickPanel(anchor) {
  if (quickEl) return closeQuickPanel();
  closeStickerPanel();
  quickEl = h('div', { class: 'sticker-pop quick-pop' },
    h('div', { class: 'sp-head' },
      h('span', { class: 'muted small', style: 'flex:1' }, '点击填入输入框；输入 “/” 也能调出'),
      h('button', { class: 'btn small primary', onclick: () => editQuick(null) }, '＋ 新建')),
    h('div', { class: 'quick-list' }));
  document.body.append(quickEl);
  const r = anchor.getBoundingClientRect();
  quickEl.style.left = `${Math.max(12, Math.min(r.left, innerWidth - quickEl.offsetWidth - 12))}px`;
  quickEl.style.bottom = `${innerHeight - r.top + 8}px`;
  drawQuick();
  setTimeout(() => document.addEventListener('mousedown', outsideQuick), 0);
}

function outsideQuick(e) {
  if (quickEl && !quickEl.contains(e.target) && !e.target.closest('#btn-quick') && !e.target.closest('.modal-mask')) closeQuickPanel();
}

export function closeQuickPanel() {
  quickEl?.remove();
  quickEl = null;
  document.removeEventListener('mousedown', outsideQuick);
}

function drawQuick() {
  const list = quickEl.querySelector('.quick-list');
  list.innerHTML = '';
  if (!state.quickReplies?.length) {
    list.append(h('div', { class: 'sp-empty' }, '还没有常用语'));
    return;
  }
  for (const q of state.quickReplies) {
    list.append(h('div', { class: 'quick-item', onclick: () => {
      closeQuickPanel();
      pickSuggestion({ kind: 'quick', item: q });
    } },
    h('div', { class: 'qi-text' }, q.text),
    h('div', { class: 'qi-meta' },
      q.keywords ? h('span', { class: 'tag' }, `/${q.keywords.split(' ')[0]}`) : null,
      q.markdown ? h('span', { class: 'tag' }, 'Markdown') : null,
      h('span', { style: 'flex:1' }),
      h('button', { class: 'link-btn', onclick: (e) => {
        e.stopPropagation();
        editQuick(q);
      } }, '编辑'),
      h('button', { class: 'link-btn danger', onclick: async (e) => {
        e.stopPropagation();
        if (!(await confirmBox('删除常用语', '确定删除这条常用语吗？', '删除', true))) return;
        api('DELETE', `/api/quick-replies/${q.id}`).catch((err) => toast(err.message, 'error'));
      } }, '删除'))));
  }
}

function editQuick(q) {
  openModal((m, close) => {
    const text = h('textarea', { rows: 4, placeholder: '要发送的内容' });
    text.value = q?.text || $('#input').value || '';
    const kw = h('input', { value: q?.keywords || '', placeholder: '例如：欢迎 新人' });
    const md = h('input', { type: 'checkbox', checked: !!q?.markdown });
    const err = h('p', { class: 'form-error' });
    m.append(
      h('h2', {}, q ? '编辑常用语' : '新建常用语'),
      h('div', { class: 'field' }, h('label', {}, '内容'), text,
        h('div', { class: 'hint' }, '可以包含 <qqbot-at-everyone /> 等标签')),
      h('div', { class: 'field' }, h('label', {}, '关键词'), kw,
        h('div', { class: 'hint' }, '输入框里输入关键词或 “/关键词” 时会推荐这条')),
      h('div', { class: 'field' }, h('div', { class: 'checks' }, h('label', {}, md, h('span', {}, '以 Markdown 发送')))),
      err,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, '取消'),
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            const body = { text: text.value, keywords: kw.value, markdown: md.checked };
            if (q) await api('PATCH', `/api/quick-replies/${q.id}`, body);
            else await api('POST', '/api/quick-replies', body);
            close();
          } catch (e) {
            err.textContent = e.message;
          }
        } }, '保存')),
    );
  });
}
