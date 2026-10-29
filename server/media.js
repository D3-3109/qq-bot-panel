// 本地媒体库：保存上传的图片、缓存收到的 QQ 图片，供预览与表情收藏使用
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { HttpError } from './http.js';

fs.mkdirSync(config.mediaDir, { recursive: true });

const MAX_BYTES = 10 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/webp') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}

function rowOut(r) {
  if (!r) return null;
  return {
    id: r.id,
    mime: r.mime,
    size: r.size,
    width: r.width,
    height: r.height,
    name: r.name,
    source: r.source,
    url: `/api/media/${r.id}`,
  };
}

export function saveImage(buf, { name = '', source = 'upload', sourceUrl = '' } = {}) {
  if (!buf.length) throw new HttpError(400, '文件为空');
  if (buf.length > MAX_BYTES) throw new HttpError(413, '图片不能超过 10MB');
  const mime = sniffImage(buf);
  if (!mime) throw new HttpError(415, '只支持 PNG / JPEG / GIF / WebP 图片');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const existing = db.prepare('SELECT * FROM media WHERE sha256 = ?').get(sha);
  if (existing) {
    if (existing.source === 'remote' && source === 'upload') {
      db.prepare("UPDATE media SET source = 'upload' WHERE id = ?").run(existing.id);
    }
    return rowOut(db.prepare('SELECT * FROM media WHERE id = ?').get(existing.id));
  }
  const file = `${sha}.${EXT[mime]}`;
  fs.writeFileSync(path.join(config.mediaDir, file), buf);
  const dims = imageSize(buf, mime) || {};
  const r = db
    .prepare(
      'INSERT INTO media (sha256, mime, size, width, height, name, file, source, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(sha, mime, buf.length, dims.width || 0, dims.height || 0, String(name).slice(0, 200), file, source, sourceUrl.slice(0, 2000), Date.now());
  return rowOut(db.prepare('SELECT * FROM media WHERE id = ?').get(r.lastInsertRowid));
}

export function getMedia(id) {
  return rowOut(db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id)));
}

export function mediaFile(id) {
  const r = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id));
  if (!r) throw new HttpError(404, '媒体不存在');
  const file = path.join(config.mediaDir, r.file);
  if (!fs.existsSync(file)) throw new HttpError(404, '媒体文件已丢失');
  return { row: r, file };
}

export function readMedia(id) {
  const { row, file } = mediaFile(id);
  return { row, buf: fs.readFileSync(file) };
}

function hostAllowed(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  return config.mediaHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

export function normalizeRemoteUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  return `https://${u}`;
}

// 只下载来自 QQ 图床域名的图片，并逐跳校验重定向目标，避免被利用访问内网
export async function fetchRemoteImage(rawUrl, name = '') {
  let url = normalizeRemoteUrl(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    if (!hostAllowed(url)) throw new HttpError(400, '不允许的图片来源');
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).href;
      continue;
    }
    if (!res.ok) throw new HttpError(502, `下载图片失败：HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new HttpError(413, '图片过大');
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      if (size > MAX_BYTES) throw new HttpError(413, '图片过大');
      chunks.push(c);
    }
    return saveImage(Buffer.concat(chunks), { name, source: 'remote', sourceUrl: normalizeRemoteUrl(rawUrl) });
  }
  throw new HttpError(502, '重定向次数过多');
}

// file_info 缓存：同一张图在同一会话里重复发送时不必重新上传
export function cachedFileInfo(botId, convType, peerId, mediaId) {
  const r = db
    .prepare('SELECT file_info, expires_at FROM media_uploads WHERE bot_id = ? AND conv_type = ? AND peer_id = ? AND media_id = ?')
    .get(botId, convType, peerId, mediaId);
  if (!r || r.expires_at < Date.now()) return null;
  return r.file_info;
}

export function storeFileInfo(botId, convType, peerId, mediaId, fileInfo, ttlSec) {
  const ttl = Number(ttlSec) || 0;
  const expires = ttl > 0 ? Date.now() + Math.max(0, ttl - 120) * 1000 : Date.now() + 30 * 24 * 3600 * 1000;
  db.prepare(
    `INSERT INTO media_uploads (bot_id, conv_type, peer_id, media_id, file_info, expires_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (bot_id, conv_type, peer_id, media_id) DO UPDATE SET file_info = excluded.file_info, expires_at = excluded.expires_at`,
  ).run(botId, convType, peerId, mediaId, fileInfo, expires);
}

export function dropFileInfo(botId, convType, peerId, mediaId) {
  db.prepare('DELETE FROM media_uploads WHERE bot_id = ? AND conv_type = ? AND peer_id = ? AND media_id = ?').run(
    botId,
    convType,
    peerId,
    mediaId,
  );
}

// 清理过期的远程缓存（被收藏为表情的图片不会删除）
export function cleanupMedia() {
  const cutoff = Date.now() - config.mediaRetentionDays * 24 * 3600 * 1000;
  const rows = db
    .prepare(
      "SELECT id, file FROM media WHERE source = 'remote' AND created_at < ? AND id NOT IN (SELECT media_id FROM stickers)",
    )
    .all(cutoff);
  for (const r of rows) {
    try {
      fs.unlinkSync(path.join(config.mediaDir, r.file));
    } catch {}
    db.prepare('DELETE FROM media WHERE id = ?').run(r.id);
  }
  db.prepare('DELETE FROM media_uploads WHERE expires_at < ?').run(Date.now());
  return rows.length;
}

export function startMediaCleanup() {
  const run = () => {
    try {
      const n = cleanupMedia();
      if (n) console.log(`已清理 ${n} 个过期的图片缓存`);
    } catch (e) {
      console.error('清理图片缓存失败', e);
    }
  };
  run();
  setInterval(run, 6 * 3600 * 1000).unref();
}
