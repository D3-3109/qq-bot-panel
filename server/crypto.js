import crypto from 'node:crypto';
import { config } from './config.js';

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.masterKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(stored) {
  const [iv, tag, enc] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// QQ webhook keys: the Bot Secret repeated to >= 32 bytes, first 32 bytes used as the Ed25519 seed.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function ed25519KeysFromSecret(secret) {
  let seed = secret;
  while (Buffer.byteLength(seed) < 32) seed = seed.repeat(2);
  const seedBuf = Buffer.from(seed).subarray(0, 32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seedBuf]),
    format: 'der',
    type: 'pkcs8',
  });
  return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
}

export function ed25519Sign(privateKey, message) {
  return crypto.sign(null, Buffer.from(message), privateKey).toString('hex');
}

export function ed25519Verify(publicKey, message, signatureHex) {
  if (!/^[0-9a-fA-F]{128}$/.test(signatureHex || '')) return false;
  const sig = Buffer.from(signatureHex, 'hex');
  if ((sig[63] & 224) !== 0) return false;
  return crypto.verify(null, Buffer.from(message), publicKey, sig);
}
