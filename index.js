// index.js
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');

const { handleTwilioCall } = require('./lib/twilioHandler');
const { createWebDemoWSS } = require('./web-demo-live');

let setupAudioStream;
try {
  ({ setupAudioStream } = require('./lib/audio-stream'));
} catch (e) {
  console.error('[error] Failed to load lib/audio-stream.js:', e?.message || e);
}

const app = express();

/* ---------- middleware ---------- */
app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
app.use(bodyParser.urlencoded({ extended: false })); // Twilio posts urlencoded
app.use(bodyParser.json());

/* ---------- routes ---------- */
app.get('/healthz', (_req, res) => res.status(200).send('OK'));
app.get('/', (_req, res) => sendIndex(res));
app.post('/twilio/voice', handleTwilioCall);

/* ---------- static: serve prebuilt Next app from /web ---------- */
const WEB_DIR = path.join(__dirname, 'web');
const NEXT_OUT = path.join(WEB_DIR, '.next');
const PUBLIC_DIR = path.join(WEB_DIR, 'public');

// _next static assets
app.use('/_next', express.static(path.join(NEXT_OUT, 'static'), { maxAge: '1y', immutable: true }));

// public assets (images, worklets, etc.)
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, { maxAge: '7d' }));
}

function sendIndex(res) {
  const html = path.join(NEXT_OUT, 'server', 'app', 'index.html');
  const fallback = path.join(WEB_DIR, 'app', 'index.html'); // in case of alternative layouts
  const file = fs.existsSync(html) ? html : fallback;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  fs.createReadStream(file).pipe(res);
}

/* ---------- HTTP server ---------- */
const server = http.createServer(app);

/* ---------- WebSocket: Twilio <-> Deepgram bridge on /audio-stream ---------- */
if (typeof setupAudioStream === 'function') {
  setupAudioStream(server); // this module mounts its own WSS (path: /audio-stream)
} else {
  console.error(
    '[error] setupAudioStream is not a function. Check lib/audio-stream.js export: module.exports = { setupAudioStream }'
  );
}

/* ---------- WebSocket: Browser demo on /web-demo/ws (noServer+router) ---------- */
const WEB_DEMO_ROUTE = '/web-demo/ws';
const webDemoWSS = createWebDemoWSS();

// Single upgrade router → avoids “handleUpgrade more than once” and accepts query strings
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    // optional: observe forwarded host if you want to restrict by host
    // const xfHost = req.headers['x-forwarded-host'] || req.headers.host;

    if (pathname === WEB_DEMO_ROUTE) {
      webDemoWSS.handleUpgrade(req, socket, head, (ws) => {
        webDemoWSS.emit('connection', ws, req);
      });
    } else {
      // do nothing here; other listeners (e.g., /audio-stream inside setupAudioStream)
      // will match and handle their own upgrades.
    }
  } catch (e) {
    // If anything goes wrong, make sure to close the socket so it doesn’t hang.
    try { socket.destroy(); } catch {}
  }
});

console.log(`[${new Date().toISOString()}] info demo_ws_mounted ${JSON.stringify({ route: WEB_DEMO_ROUTE })}`);

/* ---------- listen ---------- */
const PORT = parseInt(process.env.PORT || '10000', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] info server_listen ${JSON.stringify({ url: `http://0.0.0.0:${PORT}` })}`);
});

/* ---------- harden process ---------- */
process.on('unhandledRejection', (r) =>
  console.warn('[warn] unhandledRejection', r?.message || r)
);
process.on('uncaughtException', (e) =>
  console.error('[error] uncaughtException', e?.message || e)
);
