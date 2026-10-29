// QQ 平台 HTTP 回调（Webhook）
// 文档: https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
import { ed25519Sign, ed25519Verify } from './crypto.js';
import { findByAppId, markWebhookActivity } from './bots.js';
import { readBody, sendJson } from './http.js';

export async function handleWebhook(req, res, appIdFromPath) {
  const appId = appIdFromPath || req.headers['x-bot-appid'];
  const rt = appId ? findByAppId(appId) : null;
  if (!rt) return sendJson(res, 404, { error: 'unknown bot' });

  const raw = await readBody(req, 2 * 1024 * 1024);
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'bad json' });
  }

  if (payload.op === 13) {
    const { plain_token: plainToken, event_ts: eventTs } = payload.d || {};
    if (!plainToken || !eventTs) return sendJson(res, 400, { error: 'bad validation payload' });
    const signature = ed25519Sign(rt.keys.privateKey, String(eventTs) + String(plainToken));
    return sendJson(res, 200, { plain_token: plainToken, signature });
  }

  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];
  if (!ts || !ed25519Verify(rt.keys.publicKey, Buffer.concat([Buffer.from(String(ts)), raw]), String(sig || ''))) {
    return sendJson(res, 401, { error: 'invalid signature' });
  }

  sendJson(res, 200, { op: 12, d: 0 });
  markWebhookActivity(rt);
  if (payload.op === 0 && payload.t) {
    try {
      await rt.onEvent(payload.t, payload.d, payload.id);
    } catch (e) {
      console.error('webhook event error', e);
    }
  }
}
