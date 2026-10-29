// 消息内容渲染：@ 提及、表情、附件、Markdown、卡片
import { h, esc, renderMarkdown, fmtSize } from './lib.js';

const TOKEN_RE = /<@!?([A-Za-z0-9_\-=]+)>|<qqbot-at-user id="([^"]*)"\s*\/>|<qqbot-at-everyone\s*\/>|@everyone|<faceType=\d+,faceId="?(\d+)"?(?:,ext="([^"]*)")?[^>]*>/g;

function faceName(id, ext) {
  if (ext) {
    try {
      const json = JSON.parse(decodeURIComponent(escape(atob(ext))));
      if (json.text) return `[${json.text.replace(/^\//, '')}]`;
    } catch {}
  }
  return `[表情${id || ''}]`;
}

function tokenize(content, nameOf) {
  const out = [];
  let last = 0;
  for (const m of String(content || '').matchAll(TOKEN_RE)) {
    if (m.index > last) out.push({ text: content.slice(last, m.index) });
    if (m[1] || m[2] !== undefined) out.push({ mention: `@${nameOf(m[1] || m[2])}` });
    else if (m[0].startsWith('<faceType')) out.push({ face: faceName(m[3], m[4]) });
    else out.push({ mention: '@全体成员' });
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push({ text: content.slice(last) });
  return out;
}

export function textNode(content, { markdown = false, nameOf = (id) => id.slice(0, 6) } = {}) {
  const tokens = tokenize(content || '', nameOf);
  if (!markdown) {
    const frag = document.createDocumentFragment();
    for (const t of tokens) {
      if (t.text) frag.append(t.text);
      else if (t.mention) frag.append(h('span', { class: 'mention' }, t.mention));
      else if (t.face) frag.append(h('span', { class: 'face' }, t.face));
    }
    return frag;
  }
  const holders = [];
  const src = tokens
    .map((t) => {
      if (t.text) return t.text;
      holders.push(`<span class="mention">${esc(t.mention || t.face)}</span>`);
      return `\u0000${holders.length - 1}\u0000`;
    })
    .join('');
  const html = renderMarkdown(src).replace(/\u0000(\d+)\u0000/g, (_, i) => holders[Number(i)]);
  return h('div', { class: 'md', html });
}

export function plainPreview(content, nameOf) {
  return tokenize(content || '', nameOf || ((id) => id.slice(0, 6)))
    .map((t) => t.text ?? t.mention ?? t.face)
    .join('')
    .trim();
}

function fixUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  return `https://${u}`;
}

export function attachmentNode(a, onImage) {
  const ct = a.content_type || '';
  const url = fixUrl(a.url);
  if (ct.startsWith('image')) {
    const ratio = a.width && a.height ? `aspect-ratio:${a.width}/${a.height};width:${Math.min(260, a.width, (260 * a.width) / a.height)}px` : '';
    const img = h('img', { class: 'att', src: url, alt: a.filename || '图片', referrerpolicy: 'no-referrer', style: ratio || null });
    img.addEventListener('click', () => onImage?.(url));
    return img;
  }
  if (ct.startsWith('video')) {
    return h('video', { src: url, controls: true, preload: 'metadata', referrerpolicy: 'no-referrer' });
  }
  if (ct === 'voice') {
    const wav = fixUrl(a.voice_wav_url);
    return h('div', {},
      wav ? h('audio', { src: wav, controls: true, preload: 'none' }) : h('div', {}, '[语音]'),
      a.asr_refer_text ? h('div', { class: 'small', style: 'opacity:.75;margin-top:2px' }, `识别：${a.asr_refer_text}`) : null);
  }
  return h('a', { class: 'file-card', href: url, target: '_blank', rel: 'noopener noreferrer' },
    h('span', { class: 'ico' }, '📄'),
    h('span', {}, a.filename || '文件', a.size ? h('span', { class: 'muted small' }, ` ${fmtSize(a.size)}`) : null));
}

export function arkNode(ark) {
  if (!ark) return null;
  const f = ark.fields || {};
  return h('div', { class: 'ark' },
    h('div', { class: 'ark-title' }, f.title || ark.prompt || ark.ark_name || '卡片消息'),
    f.desc ? h('div', { class: 'small muted' }, f.desc) : null,
    f.jump_url ? h('a', { href: fixUrl(f.jump_url), target: '_blank', rel: 'noopener noreferrer', class: 'small' }, '打开链接') : null);
}

// 引用消息（message_type=103）中被引用的内容
export function quotedFromElements(elements, nameOf) {
  const q = (elements || []).find((e) => e.message_type === 103) || elements?.[0];
  if (!q) return '';
  const inner = q.msg_elements?.[0] || q;
  const who = inner.author?.username || '';
  const text = plainPreview(inner.content || '', nameOf) || (inner.attachments?.length ? '[附件]' : '');
  return `${who ? who + '：' : ''}${text}`;
}

export function outMediaNode(media, onImage) {
  if (!media) return null;
  const src = media.preview || media.url;
  if (media.type === 'image' && src) {
    const img = h('img', { class: 'att', src, alt: media.name || '图片', referrerpolicy: 'no-referrer' });
    img.addEventListener('click', () => onImage?.(src));
    return img;
  }
  if (media.type === 'video' && media.url) return h('video', { src: media.url, controls: true, preload: 'metadata' });
  const icon = { video: '🎬', voice: '🎤', file: '📄', image: '🖼' }[media.type] || '📄';
  return h('div', { class: 'file-card' }, h('span', { class: 'ico' }, icon), h('span', {}, media.name || media.url || '文件'));
}
