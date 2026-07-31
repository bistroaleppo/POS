/*
 * Bistro POS - Print Bridge Server
 * =================================
 * يسمح لنظام نقاط البيع بطباعة أوامر ESC/POS تلقائياً على طابعات الشبكة
 * (LAN/WiFi) عبر المنفذ 9100 بدون تدخل المستخدم.
 *
 * التشغيل:
 *   node print-server.js
 *   (اختياري) PORT=6333 PRINT_SERVER_TOKEN=secret node print-server.js
 *
 * ثم ضبط عنوان السيرفر من: الإعدادات -> إدارة الطابعات -> عنوان سيرفر الطباعة.
 * المثال: http://192.168.1.50:6333
 */
'use strict';

const http = require('http');
const net = require('net');

const PORT = Number(process.env.PORT) || 6333;
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.PRINT_SERVER_TOKEN || '';
const MAX_BODY = 5 * 1024 * 1024; // 5MB

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, server: 'bistro-print-server', version: 1 }));
    return;
  }

  if (req.method === 'POST' && req.url === '/print') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        req.destroy();
      }
    });
    req.on('end', () => {
      let job;
      try {
        job = JSON.parse(body);
      } catch (e) {
        respond(400, { ok: false, error: 'invalid json' });
        return;
      }
      if (TOKEN && job.token !== TOKEN) {
        respond(401, { ok: false, error: 'unauthorized' });
        return;
      }
      const ip = String(job.ip || '').trim();
      const port = Number(job.port) || 9100;
      const bytesBase64 = job.bytesBase64;
      if (!ip || !bytesBase64) {
        respond(400, { ok: false, error: 'ip and bytesBase64 are required' });
        return;
      }
      const bytes = Buffer.from(bytesBase64, 'base64');
      if (!bytes.length) {
        respond(400, { ok: false, error: 'empty payload' });
        return;
      }

      const timeoutMs = Number(job.timeout) || 8000;
      const sock = net.connect({ host: ip, port });
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          sock.destroy();
          respond(504, { ok: false, error: `timeout: printer ${ip}:${port} did not respond` });
        }
      }, timeoutMs);

      sock.on('connect', () => {
        sock.write(bytes, () => {
          clearTimeout(timer);
          done = true;
          sock.end();
          respond(200, { ok: true, sent: bytes.length, device: `${ip}:${port}` });
        });
      });
      sock.on('error', err => {
        clearTimeout(timer);
        if (!done) {
          done = true;
          respond(502, { ok: false, error: String(err.message || err), device: `${ip}:${port}` });
        }
      });

      function respond(code, payload) {
        if (res.writableEnded) return;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`Bistro print server is running on http://${HOST}:${PORT}`);
  console.log(`Waiting for ESC/POS jobs from the POS app...`);
  if (TOKEN) console.log('Auth token is enabled.');
});
