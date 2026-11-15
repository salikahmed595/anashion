'use strict';
// The whole app is this one Node.js process: it serves the shop pages, the admin
// panel and the uploaded photos, and keeps its data in a SQLite file. No packages
// to install: `node server.js` is enough.

process.removeAllListeners('warning');
process.on('warning', (w) => { if (!/SQLite is an experimental/.test(w.message)) console.warn(w.name, w.message); });

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { parseCookies, ShopError } = require('./lib/core');
const { UPLOAD_DIR } = require('./lib/db');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/x-icon',
};
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; script-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'";

// ---------------------------------------------------------------- routing

const routes = [];
function add(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp(`^${pattern.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
  routes.push({ method, rx, keys, handler });
}
const app = { get: (p, h) => add('GET', p, h), post: (p, h) => add('POST', p, h) };
const shop = require('./lib/shop');
shop.routes(app);
require('./lib/admin')(app);

// ---------------------------------------------------------------- helpers

function sendFile(req, res, root, rel, maxAge) {
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep)) return false;
  const type = TYPES[path.extname(file).toLowerCase()];
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!type || !stat.isFile()) return false;
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': `public, max-age=${maxAge}` });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk); else chunks.length = 0; // keep reading so the reply can be sent, but store nothing
    });
    req.on('end', () => (size > limit ? reject(Object.assign(new Error('Too large'), { status: 413 })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function makeContext(req, res, url) {
  const ctx = {
    req, res, url, query: url.searchParams, params: {}, form: new URLSearchParams(), json: null, raw: null,
    cookies: parseCookies(req.headers.cookie),
    ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
    secure: req.headers['x-forwarded-proto'] === 'https',
    send(status, type, body, headers = {}) {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    },
    html: (body, status = 200) => ctx.send(status, 'text/html; charset=utf-8', body, { 'Content-Security-Policy': CSP }),
    sendJson: (obj, status = 200) => ctx.send(status, 'application/json; charset=utf-8', JSON.stringify(obj)),
    redirect: (to, status = 303) => ctx.send(status, 'text/plain; charset=utf-8', 'Redirecting', { Location: to }),
    setCookie(name, value, maxAgeSeconds) {
      const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
      if (ctx.secure) parts.push('Secure');
      res.appendHeader('Set-Cookie', parts.join('; '));
    },
  };
  return ctx;
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  let ctx;
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { pathname = '/'; }
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (pathname.startsWith('/admin')) res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    if (method === 'GET' && pathname.startsWith('/assets/') && sendFile(req, res, PUBLIC_DIR, pathname.slice(8), 3600)) return;
    if (method === 'GET' && pathname.startsWith('/uploads/') && sendFile(req, res, UPLOAD_DIR, pathname.slice(9), 31536000)) return;

    ctx = makeContext(req, res, url);
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = route.rx.exec(pathname);
      if (!m) continue;
      route.keys.forEach((k, i) => { ctx.params[k] = m[i + 1]; });
      if (method === 'POST') {
        ctx.raw = await readBody(req, pathname === '/admin/upload' ? 8 * 1024 * 1024 : 512 * 1024);
        const type = String(req.headers['content-type'] || '');
        if (type.includes('application/json')) {
          try { ctx.json = JSON.parse(ctx.raw.toString('utf8')); } catch { ctx.json = null; }
        } else if (type.includes('application/x-www-form-urlencoded')) {
          ctx.form = new URLSearchParams(ctx.raw.toString('utf8'));
        }
      }
      await route.handler(ctx);
      return;
    }
    ctx.html(shop.notFound(), 404);
  } catch (err) {
    const status = err.status || (err instanceof ShopError ? 400 : 500);
    if (status === 500) console.error(err);
    if (res.headersSent) { res.end(); return; }
    const message = status === 413 ? 'That file is too large.' : err instanceof ShopError ? err.message : 'Something went wrong on our side. Please try again.';
    const wantsJson = String(req.headers.accept || '').includes('application/json') || String(req.headers['content-type'] || '').includes('json');
    res.writeHead(status, { 'Content-Type': wantsJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(wantsJson ? JSON.stringify({ error: message }) : message);
  }
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`Store running at http://localhost:${PORT}  (admin: http://localhost:${PORT}/admin)`);
});

module.exports = server;
