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
