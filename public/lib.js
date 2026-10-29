export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function toast(text, type = '') {
  const el = h('div', { class: `toast ${type}` }, text);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 5000 : 2500);
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#6366f1', '#f97316', '#0ea5e9'];
export function avatar(name, seed, { size = '', square = false, img = '' } = {}) {
  let n = 0;
  for (const c of String(seed || name || '')) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const el = h('div', { class: `avatar ${size} ${square ? 'sq' : ''}`, style: `background:${COLORS[n % COLORS.length]}` });
  if (img) {
    const i = h('img', { src: img, alt: '', referrerpolicy: 'no-referrer' });
    i.onerror = () => {
      i.remove();
      el.textContent = initial(name);
    };
    el.append(i);
  } else el.textContent = initial(name);
  return el;
}
function initial(name) {
  const s = String(name || '?').trim();
  return (Array.from(s)[0] || '?').toUpperCase();
}

export function fmtTime(ts, full = false) {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (full) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}:${pad(d.getSeconds())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function openModal(build) {
  const mask = document.getElementById('modal-mask');
  const modal = document.getElementById('modal');
  modal.innerHTML = '';
  const close = () => {
    mask.classList.add('hidden');
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  mask.onclick = (e) => e.target === mask && close();
  build(modal, close);
  mask.classList.remove('hidden');
  modal.querySelector('input, textarea, select')?.focus();
  return close;
}

export function confirmBox(title, text, okText = '确定', danger = false) {
  return new Promise((resolve) => {
    openModal((m, close) => {
      const done = (v) => {
        close();
        resolve(v);
      };
      m.append(
        h('h2', {}, title),
        h('p', { style: 'line-height:1.6;color:#4e5969' }, text),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => done(false) }, '取消'),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => done(true) }, okText)),
      );
    });
  });
}

export function promptBox(title, { label = '', value = '', placeholder = '', hint = '' } = {}) {
  return new Promise((resolve) => {
    openModal((m, close) => {
      const input = h('input', { value, placeholder });
      const done = (v) => {
        close();
        resolve(v);
      };
      input.onkeydown = (e) => e.key === 'Enter' && done(input.value);
      m.append(
        h('h2', {}, title),
        h('div', { class: 'field' }, label && h('label', {}, label), input, hint && h('div', { class: 'hint' }, hint)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => done(null) }, '取消'),
          h('button', { class: 'btn primary', onclick: () => done(input.value) }, '确定')),
      );
    });
  });
}

export function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// 极简 Markdown 渲染（输入先转义，避免 XSS）
export function renderMarkdown(src) {
  let s = esc(src);
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_, alt, url) => `<img src="${url}" alt="${alt.replace(/#\d+px/g, '').trim()}" referrerpolicy="no-referrer">`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>');
  s = s.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/^[-*] (.*)$/gm, '<li>$1</li>');
  s = s.replace(/^\*\*\*$|^---$/gm, '<hr>');
  return s;
}
