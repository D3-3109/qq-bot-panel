// 表情收藏面板与输入联想
import { h, $, api, toast, promptBox, confirmBox } from './lib.js';
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

export function renderSuggestions() {
  const bar = $('#suggest-bar');
  if (!bar) return;
  const input = $('#input');
  suggestList = state.current && !state.attachment ? matchStickers(input.value) : [];
  if (!suggestList.length) {
    bar.classList.add('hidden');
    suggestSel = -1;
    return;
  }
  if (suggestSel >= suggestList.length) suggestSel = -1;
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  bar.append(h('span', { class: 'label' }, '表情'));
  suggestList.forEach((s, i) => bar.append(stickerCell(s, { selected: i === suggestSel, onPick: pickSuggestion })));
}

function pickSuggestion(s) {
  $('#input').value = '';
  suggestSel = -1;
  renderSuggestions();
  actions.sendImage({ stickerId: s.id });
  $('#input').focus();
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
