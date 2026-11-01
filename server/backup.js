// 备份下载（zip：数据库快照 + 加密密钥 + 可选图片）与聊天记录导出
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { db } from './db.js';
import { config } from './config.js';
import { listMessagesAll } from './store.js';

// 极简 zip 写入器：仅存储不压缩（图片本身已压缩，数据库用 deflate）
class ZipWriter {
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
  }
  write(buf) {
    this.offset += buf.length;
    return this.out.write(buf) ? null : new Promise((r) => this.out.once('drain', r));
  }
  async add(name, data, { compress = false, mtime = new Date() } = {}) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = compress ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const dosTime = ((mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate()) & 0xffff;
    const method = compress ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    this.entries.push({ nameBuf, crc, size: body.length, raw: data.length, method, dosTime, dosDate, offset: this.offset });
    await this.write(Buffer.concat([local, nameBuf]));
    await this.write(body);
  }
  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.dosTime, 12);
      c.writeUInt16LE(e.dosDate, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.raw, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([c, e.nameBuf]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    this.out.end();
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export async function streamBackup(res, { includeMedia = true } = {}) {
  // VACUUM INTO 生成一致的数据库快照，不影响正在运行的服务
  const tmp = path.join(os.tmpdir(), `qqpanel-backup-${process.pid}-${Date.now()}.db`);
  db.prepare('VACUUM INTO ?').run(tmp);
  try {
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="qq-bot-panel-backup-${stamp()}.zip"`,
      'Cache-Control': 'no-store',
    });
    const zip = new ZipWriter(res);
    await zip.add('panel.db', fs.readFileSync(tmp), { compress: true });
    const keyFile = path.join(config.dataDir, 'secret.key');
    if (!process.env.PANEL_SECRET_KEY && fs.existsSync(keyFile)) await zip.add('secret.key', fs.readFileSync(keyFile));
    // 推送订阅绑定在这对 VAPID 密钥上，丢失后所有设备都要重新开启推送
    const vapidFile = path.join(config.dataDir, 'vapid.json');
    if (fs.existsSync(vapidFile)) await zip.add('vapid.json', fs.readFileSync(vapidFile));
    if (includeMedia && fs.existsSync(config.mediaDir)) {
      for (const f of fs.readdirSync(config.mediaDir)) {
        const p = path.join(config.mediaDir, f);
        const st = fs.statSync(p);
        if (st.isFile()) await zip.add(`media/${f}`, fs.readFileSync(p), { mtime: st.mtime });
      }
    }
    await zip.add(
      'README.txt',
      Buffer.from(
        [
          'QQ Bot 面板备份',
          `生成时间：${new Date().toLocaleString()}`,
          '',
          '恢复方法：停止面板，把本压缩包的内容解压到数据目录（DATA_DIR，Docker 中为 /data 卷），再启动面板。',
          process.env.PANEL_SECRET_KEY
            ? '注意：面板使用 PANEL_SECRET_KEY 环境变量作为加密密钥，备份中不含密钥，恢复时请设置相同的值。'
            : '注意：secret.key 用于解密已保存的机器人 AppSecret，请妥善保管本备份。',
        ].join('\n'),
      ),
    );
    await zip.finish();
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

// ---------------- 聊天记录导出 ----------------
function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function plain(content) {
  return String(content || '')
    .replace(/<qqbot-at-user id="[^"]*"\s*\/>/g, '@成员')
    .replace(/<@all>|<qqbot-at-everyone\s*\/>/g, '@全体成员')
    .replace(/<@!?[^>]+>/g, '@成员')
    .replace(/<faceType=[^>]*>/g, '[表情]');
}

export function exportConversation(botId, type, peerId, format) {
  const msgs = listMessagesAll(botId, type, peerId);
  const conv = db.prepare('SELECT remark FROM conversations WHERE bot_id = ? AND type = ? AND peer_id = ?').get(botId, type, peerId);
  const title = conv?.remark || `${type === 'group' ? '群' : '用户'} ${peerId}`;
  const base = `chat-${(conv?.remark || peerId).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}-${stamp()}`;
  if (format === 'json') {
    return {
      filename: `${base}.json`,
      type: 'application/json; charset=utf-8',
      body: JSON.stringify({ conversation: { type, peerId, title }, exportedAt: new Date().toISOString(), messages: msgs }, null, 2),
    };
  }
  const lines = [`${title}（${type === 'group' ? '群聊' : '私聊'}，${peerId}）`, `导出时间：${fmt(Date.now())}，共 ${msgs.length} 条`, ''];
  for (const m of msgs) {
    if (m.direction === 'system') {
      lines.push(`${fmt(m.ts)}  [系统] ${m.content}`);
      continue;
    }
    const who = m.direction === 'out' ? `${m.authorName || '机器人'}（我）` : m.authorName || m.authorId;
    let body = plain(m.content).trim();
    const atts = (m.payload.attachments || []).map((a) => `[${String(a.content_type || '').startsWith('image') ? '图片' : '文件'}${a.filename ? ' ' + a.filename : ''}]`);
    if (m.payload.media) atts.push(`[${m.payload.media.type === 'image' ? '图片' : '文件'}]`);
    if (m.payload.card) atts.push(`[卡片] ${m.payload.card.title || ''}`);
    body = [body, ...atts].filter(Boolean).join(' ');
    if (m.status === 'recalled') body += '（已撤回）';
    if (m.status === 'failed') body += `（发送失败：${m.error}）`;
    lines.push(`${fmt(m.ts)}  ${who}`, `  ${body.replace(/\n/g, '\n  ')}`);
  }
  return { filename: `${base}.txt`, type: 'text/plain; charset=utf-8', body: '\ufeff' + lines.join('\n') };
}
