// QQ 机器人 WebSocket 网关客户端
// 文档: https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };

// 不应自动重连的关闭码：参数错误、intent 无权限、机器人下线/封禁
const FATAL_CLOSE = {
  4001: '无效的 opcode',
  4002: '无效的 payload',
  4010: '无效的 shard',
  4011: '连接需要处理的 guild 过多',
  4012: '无效的 version',
  4013: '无效的 intent',
  4014: 'intent 无权限（请在“账号设置”中取消未开通的事件订阅）',
  4914: '机器人已下线（仅限沙箱环境）',
  4915: '机器人已被封禁',
};
const CAN_RESUME = new Set([4008, 4009]);

export class Gateway {
  constructor({ api, intents, onEvent, onStatus, log }) {
    this.api = api;
    this.intents = intents;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.log = log;
    this.ws = null;
    this.sessionId = null;
    this.seq = null;
    this.heartbeatTimer = null;
    this.awaitingAck = false;
    this.reconnectTimer = null;
    this.attempt = 0;
    this.stopped = true;
    this.user = null;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.clearHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {}
      this.ws = null;
    }
    this.onStatus('offline');
  }

  async connect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.onStatus('connecting');
    let url;
    try {
      const data = await this.api.gatewayUrl();
      url = data.url;
      if (!url) throw new Error('网关地址为空');
    } catch (e) {
      this.log('error', `获取网关地址失败：${e.message}`);
      const fatal = [100007, 100016, 10004].includes(e.code);
      this.onStatus('error', e.message);
      if (!fatal) this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.onMessage(ws, ev));
    ws.addEventListener('close', (ev) => this.onClose(ws, ev));
    ws.addEventListener('error', () => {});
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  async onMessage(ws, ev) {
    if (ws !== this.ws) return;
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    } catch {
      return;
    }
    if (typeof msg.s === 'number') this.seq = msg.s;

    switch (msg.op) {
      case OP.HELLO: {
        this.startHeartbeat(msg.d?.heartbeat_interval || 45_000);
        let token;
        try {
          token = await this.api.getToken();
        } catch (e) {
          this.log('error', `获取 AccessToken 失败：${e.message}`);
          this.onStatus('error', e.message);
          ws.close(4000);
          return;
        }
        if (this.sessionId && this.seq !== null) {
          this.send({ op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq } });
        } else {
          this.send({
            op: OP.IDENTIFY,
            d: {
              token: `QQBot ${token}`,
              intents: this.intents,
              shard: [0, 1],
              properties: { $os: process.platform, $browser: 'qq-bot-panel', $device: 'qq-bot-panel' },
            },
          });
        }
        break;
      }
      case OP.HEARTBEAT_ACK:
        this.awaitingAck = false;
        break;
      case OP.HEARTBEAT:
        this.send({ op: OP.HEARTBEAT, d: this.seq });
        break;
      case OP.RECONNECT:
        this.log('warn', '服务端要求重连');
        ws.close(4900);
        break;
      case OP.INVALID_SESSION:
        this.log('warn', '会话无效，将重新鉴权');
        this.sessionId = null;
        this.seq = null;
        ws.close(4900);
        break;
      case OP.DISPATCH:
        if (msg.t === 'READY') {
          this.sessionId = msg.d.session_id;
          this.user = msg.d.user;
          this.attempt = 0;
          this.log('info', `已上线：${msg.d.user?.username || ''}`);
          await this.onEvent('READY', msg.d, msg.id);
          this.onStatus('online');
        } else if (msg.t === 'RESUMED') {
          this.attempt = 0;
          this.log('info', '会话已恢复');
          this.onStatus('online');
        } else {
          try {
            await this.onEvent(msg.t, msg.d, msg.id);
          } catch (e) {
            this.log('error', `处理事件 ${msg.t} 失败：${e.message}`);
          }
        }
        break;
    }
  }

  onClose(ws, ev) {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearHeartbeat();
    if (this.stopped) return;
    const code = ev.code;
    // 订阅了未开通的事件：退回到基础的群聊与私聊事件后重连
    // 订阅了未开通的事件：平台不告诉是哪一项，按顺序逐个去掉可选订阅后重连
    const OPTIONAL = [[1 << 26, '互动事件'], [1 << 24, '群成员事件']];
    const drop = OPTIONAL.find(([b]) => this.intents & b);
    if ((code === 4013 || code === 4014) && drop) {
      this.intents &= ~drop[0];
      this.log('warn', `事件订阅未开通 (${code})，已取消订阅「${drop[1]}」后重连`);
      this.onIntentsDowngraded?.(this.intents);
      this.sessionId = null;
      this.seq = null;
      this.scheduleReconnect();
      return;
    }
    if (FATAL_CLOSE[code]) {
      this.log('error', `连接被关闭 ${code}：${FATAL_CLOSE[code]}`);
      this.onStatus('error', `${FATAL_CLOSE[code]} (${code})`);
      this.sessionId = null;
      return;
    }
    if (!CAN_RESUME.has(code) && code !== 4900 && code !== 1006 && code !== 1000) {
      this.sessionId = null;
      this.seq = null;
    }
    this.log('warn', `连接断开 (${code}${ev.reason ? ' ' + ev.reason : ''})，准备重连`);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt, 6)) + Math.floor(Math.random() * 1000);
    this.attempt += 1;
    this.onStatus('reconnecting', `${Math.round(delay / 1000)} 秒后重连`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  startHeartbeat(interval) {
    this.clearHeartbeat();
    this.awaitingAck = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.awaitingAck) {
        this.log('warn', '心跳超时，重新连接');
        this.ws?.close(4900);
        return;
      }
      this.awaitingAck = true;
      this.send({ op: OP.HEARTBEAT, d: this.seq });
    }, interval);
  }

  clearHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
