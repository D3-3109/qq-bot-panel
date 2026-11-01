// Web Push：VAPID（RFC 8292）+ aes128gcm 消息加密（RFC 8291），无第三方依赖
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { HttpError } from './http.js';

db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`);

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// ---------------- VAPID 密钥 ----------------
let vapid = null;

function loadVapid() {
  if (vapid) return vapid;
  const file = path.join(config.dataDir, 'vapid.json');
  let jwk;
  if (fs.existsSync(file)) jwk = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    jwk = privateKey.export({ format: 'jwk' });
    fs.writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicRaw = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  vapid = { privateKey, publicKey: b64u(publicRaw) };
  return vapid;
}

export function vapidPublicKey() {
  return loadVapid().publicKey;
}

function vapidAuth(endpoint) {
  const { privateKey, publicKey } = loadVapid();
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(
    JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: process.env.VAPID_SUBJECT || 'mailto:admin@example.com' }),
  );
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

// ---------------- 加密（RFC 8291） ----------------
function hkdf(salt, ikm, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}

// asPrivate / salt 仅用于测试向量；正常使用时随机生成
export function encryptPayload(plaintext, uaPublicB64, authB64, { asPrivate, salt } = {}) {
  const uaPublic = fromB64u(uaPublicB64);
  const authSecret = fromB64u(authB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('订阅公钥格式不正确');
  const ecdh = crypto.createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(fromB64u(asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const s = salt ? fromB64u(salt) : crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const cek = hkdf(s, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(s, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  s.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// ---------------- 订阅管理 ----------------
export function subscribe(sub, userAgent = '') {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!/^https:\/\/[^\s]+$/.test(endpoint) || endpoint.length > 2000) throw new HttpError(400, '推送地址无效');
  if (fromB64u(p256dh).length !== 65 || fromB64u(auth).length < 16) throw new HttpError(400, '推送密钥无效');
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
  ).run(endpoint, p256dh, auth, String(userAgent).slice(0, 200), Date.now());
  return { count: countSubscriptions() };
}

export function unsubscribe(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint || ''));
}

export function countSubscriptions() {
  return db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;
}

export function clearSubscriptions() {
  db.prepare('DELETE FROM push_subscriptions').run();
}

async function sendOne(sub, payload) {
  const body = encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuth(sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  // 订阅已失效（用户取消、浏览器重装等）
  if (res.status === 404 || res.status === 410) {
    unsubscribe(sub.endpoint);
    return false;
  }
  if (!res.ok) throw new Error(`推送服务返回 HTTP ${res.status}`);
  return true;
}

export async function pushAll(payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  const results = await Promise.allSettled(subs.map((s) => sendOne(s, payload)));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) console.warn(`Web Push：${failed.length}/${subs.length} 个订阅推送失败：${failed[0].reason?.message}`);
  return { total: subs.length, ok: results.filter((r) => r.status === 'fulfilled' && r.value).length };
}
