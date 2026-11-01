// 表情收藏：基于媒体库的图片，带关键词，用于面板与输入联想
import { db } from './db.js';
import { HttpError } from './http.js';
import { getMedia } from './media.js';

function rowOut(r) {
  if (!r) return null;
  return {
    id: r.id,
    mediaId: r.media_id,
    keywords: r.keywords,
    useCount: r.use_count,
    lastUsed: r.last_used,
    createdAt: r.created_at,
    mime: r.mime,
    width: r.width,
    height: r.height,
    name: r.name,
    url: `/api/media/${r.media_id}`,
  };
}

const SELECT = `SELECT s.*, m.mime, m.width, m.height, m.name FROM stickers s JOIN media m ON m.id = s.media_id`;

function normKeywords(k) {
  return String(k || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20)
    .join(' ')
    .slice(0, 200);
}

export function listStickers() {
  return db.prepare(`${SELECT} ORDER BY s.last_used DESC, s.id DESC`).all().map(rowOut);
}

export function getSticker(id) {
  return rowOut(db.prepare(`${SELECT} WHERE s.id = ?`).get(id));
}

export function addSticker(mediaId, keywords = '') {
  const media = getMedia(mediaId);
  if (!media) throw new HttpError(404, '图片不存在');
  const existing = db.prepare('SELECT id FROM stickers WHERE media_id = ?').get(media.id);
  if (existing) {
    if (keywords) db.prepare('UPDATE stickers SET keywords = ? WHERE id = ?').run(normKeywords(keywords), existing.id);
    return { ...getSticker(existing.id), existed: true };
  }
  const r = db
    .prepare('INSERT INTO stickers (media_id, keywords, created_at) VALUES (?, ?, ?)')
    .run(media.id, normKeywords(keywords), Date.now());
  return getSticker(Number(r.lastInsertRowid));
}

export function updateSticker(id, { keywords }) {
  if (!getSticker(id)) throw new HttpError(404, '表情不存在');
  if (keywords !== undefined) db.prepare('UPDATE stickers SET keywords = ? WHERE id = ?').run(normKeywords(keywords), id);
  return getSticker(id);
}

export function deleteSticker(id) {
  if (!getSticker(id)) throw new HttpError(404, '表情不存在');
  db.prepare('DELETE FROM stickers WHERE id = ?').run(id);
}

export function markUsed(id) {
  db.prepare('UPDATE stickers SET use_count = use_count + 1, last_used = ? WHERE id = ?').run(Date.now(), id);
}

// ---------------- 常用语 ----------------
function quickOut(r) {
  return r && { id: r.id, text: r.text, keywords: r.keywords, markdown: !!r.markdown, useCount: r.use_count, lastUsed: r.last_used };
}

export function listQuick() {
  return db.prepare('SELECT * FROM quick_replies ORDER BY last_used DESC, id DESC').all().map(quickOut);
}

export function saveQuick({ id, text, keywords, markdown }) {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) throw new HttpError(400, '内容不能为空');
  const kw = normKeywords(keywords);
  if (id) {
    const r = db.prepare('UPDATE quick_replies SET text = ?, keywords = ?, markdown = ? WHERE id = ?').run(t, kw, markdown ? 1 : 0, id);
    if (!r.changes) throw new HttpError(404, '常用语不存在');
    return quickOut(db.prepare('SELECT * FROM quick_replies WHERE id = ?').get(id));
  }
  const r = db
    .prepare('INSERT INTO quick_replies (text, keywords, markdown, created_at) VALUES (?, ?, ?, ?)')
    .run(t, kw, markdown ? 1 : 0, Date.now());
  return quickOut(db.prepare('SELECT * FROM quick_replies WHERE id = ?').get(r.lastInsertRowid));
}

export function deleteQuick(id) {
  if (!db.prepare('DELETE FROM quick_replies WHERE id = ?').run(id).changes) throw new HttpError(404, '常用语不存在');
}

export function markQuickUsed(id) {
  db.prepare('UPDATE quick_replies SET use_count = use_count + 1, last_used = ? WHERE id = ?').run(Date.now(), id);
}
