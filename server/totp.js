// 基于时间的一次性密码（RFC 6238，SHA-1、6 位、30 秒），兼容常见验证器 App
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('无效的 Base32 字符');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

export const STEP = 30;

export function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP);
}

// 返回匹配的时间步（用于防重放），不匹配返回 null；允许前后各 1 个时间步的时钟误差
export function verifyTotp(secretB32, code, { now = Date.now(), lastStep = -1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue;
    const expected = hotp(key, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}

export function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function otpauthUri(secret, account, issuer = 'QQ Bot 面板') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

// 恢复码：10 位，形如 4k7m-2xq9p
export function newRecoveryCodes(n = 8) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(10);
    const s = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export function hashRecovery(code) {
  return crypto.createHash('sha256').update(String(code).toLowerCase().replace(/[\s-]/g, '')).digest('hex');
}
