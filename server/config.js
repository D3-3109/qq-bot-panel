import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
fs.mkdirSync(dataDir, { recursive: true });

function loadMasterKey() {
  if (process.env.PANEL_SECRET_KEY) {
    return crypto.createHash('sha256').update(process.env.PANEL_SECRET_KEY).digest();
  }
  const keyFile = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
}

export const config = {
  root,
  dataDir,
  publicDir: path.join(root, 'public'),
  dbFile: path.join(dataDir, 'panel.db'),
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  defaultApiBase: process.env.QQ_API_BASE || 'https://api.bot.qq.com',
  sessionTtlMs: 30 * 24 * 3600 * 1000,
  masterKey: loadMasterKey(),
};
