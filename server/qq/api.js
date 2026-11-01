// QQ 开放平台 OpenAPI 客户端：AccessToken 管理 + 带鉴权的请求封装
// 文档: https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html

export class QQApiError extends Error {
  constructor(message, { status, code, traceId, body } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.traceId = traceId;
    this.body = body;
  }
}

const TOKEN_ERRORS = {
  100001: '获取 Token 频率过快，请稍后重试',
  100007: 'AppID 无效，或机器人已被封禁/删除',
  100016: 'AppID 或 AppSecret 错误',
  10004: '该 AppID 不存在对应的机器人',
};

export class QQApi {
  constructor({ appId, secret, apiBase, log = () => {} }) {
    this.appId = appId;
    this.secret = secret;
    this.apiBase = (apiBase || 'https://api.bot.qq.com').replace(/\/+$/, '');
    this.tokenUrl = `${this.apiBase}/app/getAppAccessToken`;
    this.log = log;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenPromise = null;
    this.refreshTimer = null;
  }

  async getToken(force = false) {
    // 平台在过期前 60 秒内才会下发新 Token，所以提前 50 秒刷新
    if (!force && this.token && Date.now() < this.tokenExpiresAt - 50_000) return this.token;
    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchToken().finally(() => (this.tokenPromise = null));
    }
    return this.tokenPromise;
  }

  async fetchToken() {
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new QQApiError(`获取 AccessToken 失败：HTTP ${res.status}`, { status: res.status, body: text });
    }
    if (!data.access_token) {
      const code = Number(data.code);
      throw new QQApiError(TOKEN_ERRORS[code] || `获取 AccessToken 失败：${data.message || text}`, {
        status: res.status,
        code,
        body: data,
      });
    }
    const ttl = Math.max(60, Number(data.expires_in) || 7200);
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + ttl * 1000;
    this.scheduleRefresh();
    this.log('info', `AccessToken 已更新，有效期 ${ttl} 秒`);
    return this.token;
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    const delay = Math.max(5_000, this.tokenExpiresAt - Date.now() - 45_000);
    this.refreshTimer = setTimeout(() => {
      this.getToken(true).catch((e) => this.log('error', `定时刷新 Token 失败：${e.message}`));
    }, delay);
    this.refreshTimer.unref?.();
  }

  stop() {
    clearTimeout(this.refreshTimer);
  }

  async request(method, path, body, { retryAuth = true, timeout = 30_000 } = {}) {
    const token = await this.getToken();
    const res = await fetch(this.apiBase + path, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const traceId = res.headers.get('x-tps-trace-id') || '';
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    const errCode = data.err_code ?? data.code;
    const failed = res.status >= 400 || (errCode !== undefined && errCode !== 0 && !data.id);
    if (res.status === 401 && retryAuth) {
      await this.getToken(true);
      return this.request(method, path, body, { retryAuth: false, timeout });
    }
    if (failed) {
      const msg = data.message || data.msg || data.raw || `HTTP ${res.status}`;
      throw new QQApiError(`${msg}${errCode ? ` (错误码 ${errCode})` : ''}`, {
        status: res.status,
        code: errCode,
        traceId: traceId || data.trace_id,
        body: data,
      });
    }
    return data;
  }

  me() {
    return this.request('GET', '/users/@me');
  }

  gatewayUrl() {
    return this.request('GET', '/gateway/bot').catch(() => this.request('GET', '/gateway'));
  }

  static scenePath(type, peer) {
    const id = encodeURIComponent(peer);
    return type === 'group' ? `/v2/groups/${id}` : `/v2/users/${id}`;
  }

  sendMessage(type, peer, body) {
    return this.request('POST', `${QQApi.scenePath(type, peer)}/messages`, body);
  }

  uploadFile(type, peer, body) {
    return this.request('POST', `${QQApi.scenePath(type, peer)}/files`, body, { timeout: 120_000 });
  }

  recall(type, peer, messageId) {
    return this.request('DELETE', `${QQApi.scenePath(type, peer)}/messages/${encodeURIComponent(messageId)}`);
  }

  groupMembers(groupId, cursor = '') {
    return this.request('GET', `/v2/groups/${encodeURIComponent(groupId)}/members?cursor=${encodeURIComponent(cursor)}`);
  }

  // 回应按钮回调，否则用户客户端会一直转圈；code: 0 成功 1 失败 2 频繁 3 重复 4 无权限 5 仅管理员
  ackInteraction(interactionId, code = 0) {
    return this.request('PUT', `/interactions/${encodeURIComponent(interactionId)}`, { code });
  }

  approveJoin(groupId, memberId, body) {
    return this.request(
      'POST',
      `/v2/groups/${encodeURIComponent(groupId)}/approval_join_request/${encodeURIComponent(memberId)}`,
      body,
    );
  }
}
