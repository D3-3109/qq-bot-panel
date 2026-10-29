// 发送消息：自动选择被动回复（msg_id / event_id）或主动消息，支持引用、Markdown、富媒体
import { db } from './db.js';
import * as store from './store.js';
import { runtime } from './bots.js';
import { broadcast } from './hub.js';
import { HttpError } from './http.js';
import { previewOf } from './events.js';
import { getMedia, readMedia, saveImage, cachedFileInfo, storeFileInfo, dropFileInfo } from './media.js';
import * as stickers from './stickers.js';

const AUDIT_CODES = new Set([304023, 304024]);
// msg_id / event_id 过期或次数用尽
const PASSIVE_EXPIRED_CODES = new Set([40034024, 40034025, 40034026, 40034128]);
const FILE_TYPES = { image: 1, video: 2, voice: 3, file: 4 };

// 统一媒体来源：表情收藏 / 媒体库 / 网址 / 直接上传的数据（图片会先存入媒体库以便预览）
function resolveMedia(input) {
  if (input.stickerId) {
    const s = stickers.getSticker(Number(input.stickerId));
    if (!s) throw new HttpError(404, '表情不存在');
    return { type: 'image', mediaId: s.mediaId, stickerId: s.id, name: s.name, width: s.width, height: s.height };
  }
  const m = input.media;
  if (!m) return null;
  if (!FILE_TYPES[m.type]) throw new HttpError(400, '不支持的媒体类型');
  if (m.mediaId) {
    const row = getMedia(m.mediaId);
    if (!row) throw new HttpError(404, '图片不存在');
    return { type: 'image', mediaId: row.id, name: row.name, width: row.width, height: row.height };
  }
  if (m.url) {
    if (!/^https?:\/\//i.test(String(m.url))) throw new HttpError(400, '网址格式不正确');
    return { type: m.type, url: String(m.url).slice(0, 2000), name: String(m.name || '').slice(0, 200) };
  }
  if (m.data) {
    const buf = Buffer.from(String(m.data), 'base64');
    if (m.type === 'image') {
      const row = saveImage(buf, { name: m.name || 'image' });
      return { type: 'image', mediaId: row.id, name: row.name, width: row.width, height: row.height };
    }
    if (buf.length > 5 * 1024 * 1024) throw new HttpError(413, '直接上传的文件不能超过 5MB');
    return { type: m.type, data: String(m.data), name: String(m.name || 'file').slice(0, 200) };
  }
  throw new HttpError(400, '缺少媒体数据');
}

async function uploadMedia(rt, botId, convType, peerId, media) {
  const fileType = FILE_TYPES[media.type];
  if (media.mediaId) {
    const cached = cachedFileInfo(botId, convType, peerId, media.mediaId);
    if (cached) return cached;
    const { row, buf } = readMedia(media.mediaId);
    if (buf.length > 5 * 1024 * 1024) throw new HttpError(413, '图片超过 5MB，无法直接上传');
    const up = await rt.api.uploadFile(convType, peerId, {
      file_type: fileType,
      srv_send_msg: false,
      file_data: buf.toString('base64'),
      file_name: row.name || `image.${row.mime.split('/')[1]}`,
    });
    if (!up.file_info) throw new HttpError(502, '上传失败：未返回 file_info');
    storeFileInfo(botId, convType, peerId, media.mediaId, up.file_info, up.ttl);
    return up.file_info;
  }
  const upload = { file_type: fileType, srv_send_msg: false };
  if (media.url) upload.url = media.url;
  else {
    upload.file_data = media.data;
    upload.file_name = media.name;
  }
  const up = await rt.api.uploadFile(convType, peerId, upload);
  if (!up.file_info) throw new HttpError(502, '上传失败：未返回 file_info');
  return up.file_info;
}

function botName(botId) {
  return db.prepare('SELECT name FROM bots WHERE id = ?').get(botId)?.name || '机器人';
}

export async function sendMessage(botId, convType, peerId, input) {
  if (!['group', 'c2c'].includes(convType)) throw new HttpError(400, '会话类型无效');
  const rt = runtime(botId);
  const text = String(input.text || '').slice(0, 5000);
  const media = resolveMedia(input);
  const replyMode = ['auto', 'passive', 'active'].includes(input.replyMode) ? input.replyMode : 'auto';
  const quoteRow = input.quoteId ? store.getMessage(Number(input.quoteId)) : null;
  if (quoteRow && (quoteRow.botId !== botId || quoteRow.peerId !== peerId)) throw new HttpError(400, '引用的消息不属于该会话');
  if (!text.trim() && !media) throw new HttpError(400, '消息内容为空');

  const useMarkdown = !!input.markdown || /<qqbot-at-user\s/.test(text);

  const local = store.insertMessage({
    botId,
    convType,
    peerId,
    direction: 'out',
    authorId: 'bot',
    authorName: botName(botId),
    kind: 'message',
    content: text,
    payload: {
      markdown: useMarkdown,
      media: media
        ? {
            type: media.type,
            name: media.name || '',
            url: media.url || '',
            mediaId: media.mediaId || null,
            stickerId: media.stickerId || null,
            width: media.width || 0,
            height: media.height || 0,
          }
        : null,
      quote: quoteRow ? { id: quoteRow.id, authorName: quoteRow.authorName, content: quoteRow.content.slice(0, 100) } : null,
    },
    quoteIdx: quoteRow?.refIdx || '',
    status: 'sending',
    ts: Date.now(),
  });
  broadcast('message', local);

  try {
    const body = {};
    if (media) {
      body.msg_type = 7;
      body.media = { file_info: await uploadMedia(rt, botId, convType, peerId, media) };
      if (text.trim()) body.content = text;
    } else if (useMarkdown) {
      body.msg_type = 2;
      body.markdown = { content: text };
    } else {
      body.msg_type = 0;
      body.content = text;
    }
    if (quoteRow?.refIdx) body.message_reference = { message_id: quoteRow.refIdx };

    let source = null;
    if (replyMode !== 'active') {
      source = store.findReplySource(botId, convType, peerId, {
        msgRowId: quoteRow?.direction === 'in' ? quoteRow.id : undefined,
      });
      if (!source && replyMode === 'passive') throw new HttpError(409, '没有可用的被动回复窗口');
    }

    let res;
    let usedMode = 'active';
    if (source) {
      const seq = store.consumeReply(source);
      const passiveBody = { ...body, msg_seq: seq };
      if (source.kind === 'msg') passiveBody.msg_id = source.row.msg_id;
      else passiveBody.event_id = source.row.event_id;
      try {
        res = await rt.api.sendMessage(convType, peerId, passiveBody);
        usedMode = 'passive';
        store.markReplyUsed(source);
      } catch (e) {
        if (AUDIT_CODES.has(e.code)) {
          store.markReplyUsed(source);
          return finish(local.id, { status: 'audit', error: '消息已提交，等待人工审核' }, botId, convType, peerId);
        }
        if (PASSIVE_EXPIRED_CODES.has(e.code)) store.exhaustReply(source);
        if (replyMode === 'passive') throw e;
        // 被动窗口可能已失效，改用主动消息重试一次
        res = null;
        source.error = e;
      }
    }
    if (!res) {
      try {
        res = await rt.api.sendMessage(convType, peerId, body);
      } catch (e) {
        if (AUDIT_CODES.has(e.code)) {
          return finish(local.id, { status: 'audit', error: '消息已提交，等待人工审核' }, botId, convType, peerId);
        }
        if (source?.error) e.message = `被动回复失败：${source.error.message}；主动发送失败：${e.message}`;
        throw e;
      }
    }

    if (media?.stickerId) stickers.markUsed(media.stickerId);
    return finish(
      local.id,
      {
        msg_id: res.id || null,
        ref_idx: res.ext_info?.ref_idx || '',
        status: 'ok',
        error: '',
        payload: { ...local.payload, sendMode: usedMode, timestamp: res.timestamp || '' },
      },
      botId,
      convType,
      peerId,
    );
  } catch (e) {
    // file_info 可能已失效，下次重新上传
    if (media?.mediaId) dropFileInfo(botId, convType, peerId, media.mediaId);
    if (e.code === 40034002) e.message += '：图片格式不支持，或尺寸过小（极小的图片会被平台拒绝）';
    const detail = e.traceId ? `${e.message} [trace: ${e.traceId}]` : e.message;
    finish(local.id, { status: 'failed', error: detail }, botId, convType, peerId);
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, detail);
  }
}

function finish(rowId, patch, botId, convType, peerId) {
  const msg = store.updateMessage(rowId, patch);
  broadcast('message', msg);
  if (msg.status !== 'failed') {
    const conv = store.upsertConversation(botId, convType, peerId, {
      last_ts: msg.ts,
      last_preview: `我: ${previewOf(msg.content, msg.payload.media ? [{ content_type: msg.payload.media.type === 'image' ? 'image' : msg.payload.media.type }] : [], 0)}`,
      hidden: 0,
    });
    broadcast('conversation', conv);
  }
  return msg;
}

export async function recallMessage(botId, rowId) {
  const msg = store.getMessage(rowId);
  if (!msg || msg.botId !== botId) throw new HttpError(404, '消息不存在');
  if (!msg.msgId) throw new HttpError(400, '该消息没有平台消息 ID，无法撤回');
  if (msg.status === 'recalled') return msg;
  const rt = runtime(botId);
  try {
    await rt.api.recall(msg.convType, msg.peerId, msg.msgId);
  } catch (e) {
    throw new HttpError(502, `撤回失败：${e.message}`);
  }
  const updated = store.updateMessage(rowId, { status: 'recalled' });
  broadcast('message', updated);
  return updated;
}
