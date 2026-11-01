import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { hashPassword, verifyPassword, randomToken, encryptSecret, decryptSecret } from './crypto.js';
import { verifyTotp, newSecret, otpauthUri, newRecoveryCodes, hashRecovery } from './totp.js';
import { HttpError, parseCookies } from './http.js';

const COOKIE = 'qqpanel_session';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function ensureAdmin() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (row.n > 0) {
    if (config.adminPassword) {
      db.prepare("UPDATE users SET password_hash = ? WHERE username = 'admin'").run(
        hashPassword(config.adminPassword),
      );
    }
    return;
  }
  const password = config.adminPassword || randomToken(9);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
    'admin',
    hashPassword(password),
  );
  if (!config.adminPassword) {
    console.log('==================================================');
    console.log(' 已创建管理员账号  用户名: admin');
    console.log(` 初始密码: ${password}`);
    console.log(' 请登录后在“设置”中修改密码。');
    console.log('==================================================');
  }
}

const attempts = new Map();

function checkRate(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, reset: now + 15 * 60 * 1000 };
  if (now > a.reset) {
    a.n = 0;
    a.reset = now + 15 * 60 * 1000;
  }
  if (a.n >= 10) throw new HttpError(429, '登录尝试过多，请 15 分钟后再试');
  return a;
}

export function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  return config.trustProxy && req.headers['x-forwarded-proto'] === 'https';
}

// 校验两步验证码或恢复码；成功时记录已用的时间步/作废恢复码，防止重放
function checkSecondFactor(user, code) {
  const c = String(code || '').trim();
  const step = verifyTotp(decryptSecret(user.totp_secret_enc), c, { lastStep: user.totp_last_step });
  if (step !== null) {
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
    return true;
  }
  const hashes = JSON.parse(user.recovery_hashes || '[]');
  const i = hashes.indexOf(hashRecovery(c));
  if (c.length >= 10 && i >= 0) {
    hashes.splice(i, 1);
    db.prepare('UPDATE users SET recovery_hashes = ? WHERE id = ?').run(JSON.stringify(hashes), user.id);
    return true;
  }
  return false;
}

export function login(req, res, username, password, code) {
  const ip = clientIp(req);
  const a = checkRate(ip);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || 'admin'));
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    a.n += 1;
    attempts.set(ip, a);
    throw new HttpError(401, '用户名或密码错误');
  }
  if (user.totp_secret_enc) {
    if (!code) throw new HttpError(401, '请输入两步验证码', { need2fa: true });
    if (!checkSecondFactor(user, code)) {
      a.n += 1;
      attempts.set(ip, a);
      throw new HttpError(401, '验证码错误', { need2fa: true });
    }
  }
  attempts.delete(ip);
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha(token),
    user.id,
    Date.now() + config.sessionTtlMs,
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  return { username: user.username };
}

export function logout(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      'SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
    )
    .get(sha(token), Date.now());
  return row || null;
}

export function changePassword(user, oldPassword, newPassword) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!verifyPassword(String(oldPassword || ''), row.password_hash)) {
    throw new HttpError(400, '原密码错误');
  }
  if (String(newPassword || '').length < 8) throw new HttpError(400, '新密码至少 8 位');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
}

// ---------------- 两步验证 ----------------
const pendingSecrets = new Map(); // userId -> { secret, expires }

export function twoFactorStatus(user) {
  const row = db.prepare('SELECT totp_secret_enc, recovery_hashes FROM users WHERE id = ?').get(user.id);
  return { enabled: !!row.totp_secret_enc, recoveryLeft: JSON.parse(row.recovery_hashes || '[]').length };
}

export function startTwoFactor(user) {
  if (twoFactorStatus(user).enabled) throw new HttpError(409, '两步验证已开启');
  const secret = newSecret();
  pendingSecrets.set(user.id, { secret, expires: Date.now() + 10 * 60_000 });
  return { secret, uri: otpauthUri(secret, user.username) };
}

export function enableTwoFactor(user, code) {
  const p = pendingSecrets.get(user.id);
  if (!p || p.expires < Date.now()) throw new HttpError(400, '设置已过期，请重新开始');
  const step = verifyTotp(p.secret, code);
  if (step === null) throw new HttpError(400, '验证码错误，请确认手机时间准确');
  const codes = newRecoveryCodes();
  db.prepare('UPDATE users SET totp_secret_enc = ?, totp_last_step = ?, recovery_hashes = ? WHERE id = ?').run(
    encryptSecret(p.secret),
    step,
    JSON.stringify(codes.map(hashRecovery)),
    user.id,
  );
  pendingSecrets.delete(user.id);
  return { recoveryCodes: codes };
}

export function disableTwoFactor(user, password, code) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!verifyPassword(String(password || ''), row.password_hash)) throw new HttpError(400, '密码错误');
  if (row.totp_secret_enc && !checkSecondFactor(row, code)) throw new HttpError(400, '验证码错误');
  db.prepare("UPDATE users SET totp_secret_enc = '', totp_last_step = -1, recovery_hashes = '[]' WHERE id = ?").run(user.id);
}

// 丢失手机时的应急：以 DISABLE_2FA=1 启动一次即可关闭
export function applyDisable2faEnv() {
  if (process.env.DISABLE_2FA !== '1') return;
  const r = db.prepare("UPDATE users SET totp_secret_enc = '', totp_last_step = -1, recovery_hashes = '[]' WHERE totp_secret_enc != ''").run();
  console.log(`DISABLE_2FA=1：已关闭 ${r.changes} 个账号的两步验证，请去掉该环境变量后重启`);
}
