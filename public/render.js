// 消息内容渲染：@ 提及、表情、附件、Markdown、卡片
import { h, esc, renderMarkdown, fmtSize } from './lib.js';

const TOKEN_RE = /<@!?([A-Za-z0-9_\-=]+)>|<qqbot-at-user id="([^"]*)"\s*\/>|<qqbot-at-everyone\s*\/>|@everyone|<@all>|<faceType=(\d+),faceId="?(\d+)"?(?:,ext="([^"]*)")?[^>]*>/g;

// 经典小黄脸的常见编号，事件里没有带名称时用来兜底
const FACE_NAMES = {
  0: '惊讶', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴', 8: '睡', 9: '大哭',
  10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙', 14: '微笑', 15: '难过', 16: '酷', 18: '抓狂', 19: '吐',
  20: '偷笑', 21: '可爱', 22: '白眼', 23: '傲慢', 24: '饥饿', 25: '困', 26: '惊恐', 27: '流汗', 28: '憨笑',
  29: '悠闲', 30: '奋斗', 31: '咒骂', 32: '疑问', 33: '嘘', 34: '晕', 36: '衰', 37: '骷髅', 38: '敲打',
  39: '再见', 41: '发抖', 42: '爱情', 43: '跳跳', 46: '猪头', 49: '拥抱', 53: '蛋糕', 60: '咖啡', 63: '玫瑰',
  66: '爱心', 67: '心碎', 74: '太阳', 75: '月亮', 76: '赞', 77: '踩', 78: '握手', 79: '胜利', 96: '冷汗',
  97: '擦汗', 98: '抠鼻', 99: '鼓掌', 101: '坏笑', 104: '哈欠', 105: '鄙视', 106: '委屈', 107: '快哭了',
  108: '阴险', 111: '可怜', 116: '示爱', 118: '抱拳', 120: '拳头', 122: '爱你', 123: 'NO', 124: 'OK',
  178: '斜眼笑', 179: 'doge', 180: '惊喜', 182: '笑哭', 212: '托腮', 264: '捂脸', 265: '辣眼睛', 266: '哦哟',
  267: '头秃', 268: '问号脸', 269: '暗中观察', 270: 'emm', 271: '吃瓜', 272: '呵呵哒', 273: '我酸了',
  277: '汪汪', 281: '无眼笑', 282: '敬礼', 284: '面无表情', 285: '摸鱼', 287: '哦', 289: '睁眼', 293: '摸锦鲤',
  294: '期待', 297: '拜谢', 299: '牛啊', 306: '牛气冲天', 307: '喵喵', 311: '打call', 318: '崇拜', 319: '比心',
  320: '庆祝', 322: '拒绝', 323: '嫌弃', 326: '生气',
};

// 返回 '' 表示不显示（例如商城大表情，图片会作为附件单独显示）
function faceName(type, id, ext) {
  if (ext) {
    try {
      const json = JSON.parse(decodeURIComponent(escape(atob(ext))));
      const t = String(json.text || '').replace(/^\//, '').trim();
      if (t && t !== '[?]') return `[${t}]`;
    } catch {}
  }
  if (type === '6') return '';
  if (type === '1' && FACE_NAMES[id]) return `[${FACE_NAMES[id]}]`;
  return '[表情]';
}

function tokenize(content, nameOf) {
  const out = [];
  let last = 0;
  for (const m of String(content || '').matchAll(TOKEN_RE)) {
    if (m.index > last) out.push({ text: content.slice(last, m.index) });
    if (m[1] || m[2] !== undefined) out.push({ mention: `@${nameOf(m[1] || m[2])}` });
    else if (m[0].startsWith('<faceType')) {
      const f = faceName(m[3], m[4], m[5]);
      if (f) out.push({ face: f });
    } else out.push({ mention: '@全体成员' });
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
    // 优先显示本地缓存，QQ 图片链接过期后仍可查看
    const src = a.mediaId ? `/api/media/${a.mediaId}` : url;
    const ratio = a.width && a.height ? `aspect-ratio:${a.width}/${a.height};width:${Math.min(260, a.width, (260 * a.width) / a.height)}px` : '';
    const img = h('img', { class: 'att', src, alt: a.filename || '图片', referrerpolicy: 'no-referrer', style: ratio || null });
    if (a.mediaId) img.onerror = () => { img.onerror = null; img.src = url; };
    img.addEventListener('click', () => onImage?.({ src, mediaId: a.mediaId || null, attachment: a }));
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
  const src = media.mediaId ? `/api/media/${media.mediaId}` : media.preview || media.url;
  if (media.type === 'image' && src) {
    const ratio = media.width && media.height
      ? `aspect-ratio:${media.width}/${media.height};width:${Math.min(media.stickerId ? 160 : 260, media.width, (260 * media.width) / media.height)}px`
      : '';
    const img = h('img', { class: `att ${media.stickerId ? 'sticker' : ''}`, src, alt: media.name || '图片', referrerpolicy: 'no-referrer', style: ratio || null });
    img.addEventListener('click', () => onImage?.({ src, mediaId: media.mediaId || null }));
    return img;
  }
  if (media.type === 'video' && media.url) return h('video', { src: media.url, controls: true, preload: 'metadata' });
  const icon = { video: '🎬', voice: '🎤', file: '📄', image: '🖼' }[media.type] || '📄';
  return h('div', { class: 'file-card' }, h('span', { class: 'ico' }, icon), h('span', {}, media.name || media.url || '文件'));
}
