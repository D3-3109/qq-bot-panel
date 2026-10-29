import { db } from './db.js';
import { config } from './config.js';
import { encryptSecret, decryptSecret, ed25519KeysFromSecret } from './crypto.js';
import { QQApi } from './qq/api.js';
import { Gateway } from './qq/gateway.js';
import { handleDispatch } from './events.js';
import { broadcast } from './hub.js';
import { HttpError } from './http.js';
import * as store from './store.js';

export const INTENTS = {
  GROUP_AND_C2C_EVENT: 1 << 25,
  GROUP_MEMBER_EVENT: 1 << 24,
  INTERACTION: 1 << 26,
};
export const DEFAULT_INTENTS = INTENTS.GROUP_AND_C2C_EVENT;

const runtimes = new Map();
const logs = new Map();

function pushLog(botId, level, text) {
  const list = logs.get(botId) || [];
  const entry = { ts: Date.now(), level, text };
  list.push(entry);
  if (list.length > 300) list.shift();
  logs.set(botId, list);
  broadcast('log', { botId, ...entry });
  const tag = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN ' : 'INFO ';
  console.log(`[${new Date().toISOString()}] ${tag} bot#${botId} ${text}`);
}

export function getLogs(botId) {
  return logs.get(botId) || [];
}

function getRow(id) {
  const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '机器人不存在');
  return row;
}

export function listBots() {
  return db
    .prepare('SELECT * FROM bots ORDER BY id')
    .all()
    .map((r) => store.publicBot(r, runtimes.get(r.id)));
}

export function getBot(id) {
  const row = getRow(id);
  return store.publicBot(row, runtimes.get(row.id));
}

export function runtime(id) {
  const rt = runtimes.get(Number(id));
  if (!rt) throw new HttpError(409, '机器人未启用');
  return rt;
}

function setStatus(botId, status, detail = '') {
  const rt = runtimes.get(botId);
  if (!rt) return;
  rt.status = status;
  rt.statusDetail = detail;
  broadcast('bot', getBot(botId));
}

function startRuntime(row) {
  stopRuntime(row.id);
  const secret = decryptSecret(row.secret_enc);
  const log = (level, text) => pushLog(row.id, level, text);
  const api = new QQApi({ appId: row.app_id, secret, apiBase: row.api_base || config.defaultApiBase, log });
  const rt = {
    botId: row.id,
    appId: row.app_id,
    api,
    gateway: null,
    keys: ed25519KeysFromSecret(secret),
    status: 'offline',
    statusDetail: '',
  };
  runtimes.set(row.id, rt);

  const onEvent = async (type, d, eventId) => {
    if (type === 'READY') {
      if (d?.user) {
        db.prepare('UPDATE bots SET name = CASE WHEN ? != \'\' THEN ? ELSE name END, bot_user_id = ? WHERE id = ?').run(
          d.user.username || '',
          d.user.username || '',
          d.user.id || '',
          row.id,
        );
      }
      return;
    }
    handleDispatch({ id: row.id }, type, d, eventId);
  };
  rt.onEvent = onEvent;

  if (row.mode === 'webhook') {
    // Webhook 模式下仍需维护 AccessToken 以便发消息
    api.getToken().then(
      () => setStatus(row.id, 'webhook', '等待平台回调'),
      (e) => {
        log('error', e.message);
        setStatus(row.id, 'error', e.message);
      },
    );
  } else {
    rt.gateway = new Gateway({
      api,
      intents: row.intents,
      onEvent,
      onStatus: (s, detail) => setStatus(row.id, s, detail),
      log,
    });
    rt.gateway.onIntentsDowngraded = (bits) => {
      db.prepare('UPDATE bots SET intents = ? WHERE id = ?').run(bits, row.id);
      broadcast('bot', getBot(row.id));
    };
    rt.gateway.start();
  }
  return rt;
}

function stopRuntime(id) {
  const rt = runtimes.get(id);
  if (!rt) return;
  rt.gateway?.stop();
  rt.api.stop();
  runtimes.delete(id);
}

export function startAll() {
  for (const row of db.prepare('SELECT * FROM bots WHERE enabled = 1').all()) {
    try {
      startRuntime(row);
    } catch (e) {
      pushLog(row.id, 'error', `启动失败：${e.message}`);
    }
  }
}

export function stopAll() {
  for (const id of [...runtimes.keys()]) stopRuntime(id);
}

function validateInput({ appId, secret, mode, intents, apiBase }, partial = false) {
  const out = {};
  if (!partial || appId !== undefined) {
    if (!/^\d{4,20}$/.test(String(appId || ''))) throw new HttpError(400, 'AppID 应为数字');
    out.app_id = String(appId);
  }
  if (!partial || (secret !== undefined && secret !== '')) {
    if (!secret || String(secret).length < 8 || String(secret).length > 128)
      throw new HttpError(400, 'AppSecret 格式不正确');
    out.secret = String(secret).trim();
  }
  if (mode !== undefined) {
    if (!['websocket', 'webhook'].includes(mode)) throw new HttpError(400, '接入方式无效');
    out.mode = mode;
  }
  if (intents !== undefined) {
    const n = Number(intents);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '事件订阅无效');
    out.intents = n;
  }
  if (apiBase !== undefined) {
    const v = String(apiBase || '').trim();
    if (v && !/^https?:\/\/[^\s]+$/.test(v)) throw new HttpError(400, 'API 地址格式不正确');
    out.api_base = v.replace(/\/+$/, '');
  }
  return out;
}

export async function addBot(input) {
  const v = validateInput(input);
  if (db.prepare('SELECT id FROM bots WHERE app_id = ?').get(v.app_id)) {
    throw new HttpError(409, '该 AppID 已添加');
  }
  // 先验证凭证
  const api = new QQApi({ appId: v.app_id, secret: v.secret, apiBase: v.api_base || config.defaultApiBase });
  try {
    await api.getToken();
  } catch (e) {
    throw new HttpError(400, `凭证校验失败：${e.message}`);
  } finally {
    api.stop();
  }
  let name = String(input.name || '').trim().slice(0, 60);
  let avatar = '';
  try {
    const me = await api.me();
    name = name || me.username || '';
    avatar = me.avatar || '';
  } catch {}
  const r = db
    .prepare(
      'INSERT INTO bots (app_id, secret_enc, name, avatar, mode, intents, api_base, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
    )
    .run(
      v.app_id,
      encryptSecret(v.secret),
      name || `Bot ${v.app_id}`,
      avatar,
      v.mode || 'websocket',
      v.intents || DEFAULT_INTENTS,
      v.api_base || '',
      Date.now(),
    );
  const row = getRow(Number(r.lastInsertRowid));
  startRuntime(row);
  return getBot(row.id);
}

export async function updateBot(id, input) {
  const row = getRow(id);
  const v = validateInput(input, true);
  delete v.app_id;
  if (v.secret) {
    const api = new QQApi({ appId: row.app_id, secret: v.secret, apiBase: v.api_base ?? row.api_base });
    try {
      await api.getToken();
    } catch (e) {
      throw new HttpError(400, `凭证校验失败：${e.message}`);
    } finally {
      api.stop();
    }
    v.secret_enc = encryptSecret(v.secret);
    delete v.secret;
  }
  if (input.name !== undefined) v.name = String(input.name).trim().slice(0, 60) || row.name;
  if (input.enabled !== undefined) v.enabled = input.enabled ? 1 : 0;
  const keys = Object.keys(v);
  if (keys.length) {
    db.prepare(`UPDATE bots SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => v[k]),
      id,
    );
  }
  const updated = getRow(id);
  const needsRestart = ['secret_enc', 'mode', 'intents', 'api_base', 'enabled'].some((k) => k in v);
  if (needsRestart) {
    stopRuntime(id);
    if (updated.enabled) startRuntime(updated);
  }
  const bot = getBot(id);
  broadcast('bot', bot);
  return bot;
}

export function restartBot(id) {
  const row = getRow(id);
  if (!row.enabled) throw new HttpError(409, '机器人已停用');
  startRuntime(row);
  return getBot(id);
}

export function deleteBot(id) {
  getRow(id);
  stopRuntime(id);
  db.prepare('DELETE FROM bots WHERE id = ?').run(id);
  logs.delete(id);
}

export function findByAppId(appId) {
  const row = db.prepare('SELECT * FROM bots WHERE app_id = ?').get(String(appId));
  if (!row) return null;
  return runtimes.get(row.id) || null;
}

export function markWebhookActivity(rt) {
  if (rt.status !== 'online') setStatus(rt.botId, 'online', 'Webhook 回调正常');
  rt.lastWebhookAt = Date.now();
}
