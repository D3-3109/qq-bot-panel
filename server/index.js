import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { sendJson, HttpError } from './http.js';
import { ensureAdmin, currentUser } from './auth.js';
import { router } from './routes.js';
import { handleWebhook } from './webhook.js';
import { startAll, stopAll } from './bots.js';
import { startMediaCleanup } from './media.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob: https: http:; media-src 'self' blob: https: http:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (pathname === '/healthz') return sendJson(res, 200, { ok: true });

    // 平台回调：/webhook 或 /webhook/<appid>
    const wh = /^\/webhook(?:\/(\d+))?\/?$/.exec(pathname);
    if (wh && req.method === 'POST') return await handleWebhook(req, res, wh[1]);

    if (pathname.startsWith('/api/')) {
      const route = router.match(req.method, pathname);
      if (!route) throw new HttpError(404, '接口不存在');
      const user = currentUser(req);
      if (!route.opts.public && !user) throw new HttpError(401, '未登录');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // 简单的 CSRF 防护：要求同源请求
        const origin = req.headers.origin;
        const host = req.headers['x-forwarded-host'] && config.trustProxy ? req.headers['x-forwarded-host'] : req.headers.host;
        if (origin && new URL(origin).host !== host) throw new HttpError(403, '跨站请求被拒绝');
        // 非 JSON 请求无法由普通表单跨站提交；原始上传只接受图片类型
        const ct = String(req.headers['content-type'] || '');
        const hasBody = req.headers['content-length'] && req.headers['content-length'] !== '0';
        const ok = route.opts.raw ? /^image\/(png|jpeg|gif|webp)\b/.test(ct) : !hasBody || ct.includes('application/json');
        if (!ok) throw new HttpError(415, route.opts.raw ? '只支持上传图片' : '需要 JSON 请求');
      }
      const result = await route.handler(req, res, { params: route.params, query: url.searchParams, user });
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    res.writeHead(405);
    res.end();
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    sendJson(res, 500, { error: '服务器内部错误' });
  }
});

ensureAdmin();
server.listen(config.port, config.host, () => {
  console.log(`QQ Bot 面板已启动: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  startAll();
  startMediaCleanup();
});

function shutdown() {
  console.log('正在关闭...');
  stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
