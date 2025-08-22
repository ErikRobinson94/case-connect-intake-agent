// index.js — One Render Web Service: Express + Next (./web) + path-scoped WS routes
require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { createRequire } = require('module');
const WebSocket = require('ws');

const { handleTwilioCall } = require('./lib/twilioHandler');
const { setupAudioStream } = require('./lib/audio-stream'); // Twilio WS (already path-scoped)
const { attachWebDemoHandlers } = require('./web-demo-live'); // browser demo handlers

// ---------------- Small helpers ----------------
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const lv = { error: 0, warn: 1, info: 2, debug: 3 };
const log = (level, msg, extra) => {
  if ((lv[level] ?? 2) <= (lv[LOG_LEVEL] ?? 2)) {
    console.log(
      `[${new Date().toISOString()}] ${level} ${msg} ${
        extra ? JSON.stringify(extra) : ''
      }`
    );
  }
};
const WS_DEBUG = String(process.env.WS_DEBUG || '').toLowerCase() === '1';

// =======================================================
(async () => {
  const app = express();
  app.set('trust proxy', true); // Render proxy
  app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());

  // Health
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  // Twilio webhook (HTTP)
  app.post('/twilio/voice', handleTwilioCall);

  // HTTP server (shared by Next + WS)
  const server = http.createServer(app);

  // ---------- WS: Twilio <-> Deepgram (path-scoped inside setupAudioStream) ----------
  setupAudioStream(server);
  log('info', 'audio_ws_mounted', {
    route: process.env.AUDIO_STREAM_ROUTE || '/audio-stream',
    mode: 'path-scoped',
  });

  // ---------- WS: simple ECHO (smoke test) ----------
  const ECHO_ROUTE = '/ws-echo';
  const echoWSS = new WebSocket.Server({
    server,
    path: ECHO_ROUTE,
    perMessageDeflate: false,
  });
  echoWSS.on('connection', (ws, req) => {
    log('info', 'echo_ws_open', {
      ip: req.socket?.remoteAddress,
      url: req.url,
      ua: req.headers['user-agent'],
    });
    ws.on('message', (buf, isBinary) => {
      try { ws.send(buf, { binary: isBinary === true }); } catch {}
    });
    ws.on('close', (code, reason) => {
      log('info', 'echo_ws_close', { code, reason: reason?.toString?.() || '' });
    });
    ws.on('error', (e) => log('warn', 'echo_ws_err', { err: e?.message || String(e) }));
  });
  if (WS_DEBUG) {
    echoWSS.on('headers', (headers, req) => {
      log('debug', 'echo_ws_handshake', {
        path: req.url,
        upgrade: req.headers.upgrade,
        version: req.headers['sec-websocket-version'],
        key: req.headers['sec-websocket-key'],
        origin: req.headers.origin,
      });
    });
  }
  // If someone *GETs* the WS path, return 426 so it’s obvious
  app.get(ECHO_ROUTE, (_req, res) => res.status(426).send('Upgrade Required: connect via WebSocket.'));

  // ---------- WS: Ping (diagnostics) ----------
  const PING_ROUTE = '/ws-ping';
  const pingWSS = new WebSocket.Server({
    server,
    path: PING_ROUTE,
    perMessageDeflate: false,
  });
  pingWSS.on('connection', (ws, req) => {
    log('info', 'ping_ws_open', { url: req.url });
    const t = setInterval(() => {
      try { ws.send('pong'); } catch {}
    }, 5000);
    ws.on('close', () => clearInterval(t));
  });
  if (WS_DEBUG) {
    pingWSS.on('headers', (headers, req) => {
      log('debug', 'ping_ws_handshake', {
        path: req.url,
        upgrade: req.headers.upgrade,
        version: req.headers['sec-websocket-version'],
        origin: req.headers.origin,
      });
    });
  }
  app.get(PING_ROUTE, (_req, res) => res.status(426).send('Upgrade Required: connect via WebSocket.'));

  // ---------- WS: Browser demo (path-scoped; accepts ?voiceId=) ----------
  const DEMO_ROUTE = '/web-demo/ws';
  const demoWSS = new WebSocket.Server({
    server,
    path: DEMO_ROUTE,
    perMessageDeflate: false,
  });
  attachWebDemoHandlers(demoWSS);
  if (WS_DEBUG) {
    demoWSS.on('headers', (headers, req) => {
      log('debug', 'demo_ws_handshake', {
        path: req.url,
        upgrade: req.headers.upgrade,
        version: req.headers['sec-websocket-version'],
        origin: req.headers.origin,
      });
    });
  }
  app.get(DEMO_ROUTE, (_req, res) => res.status(426).send('Upgrade Required: connect via WebSocket.'));
  log('info', 'demo_ws_mounted', { route: DEMO_ROUTE, mode: 'path-scoped' });
  log('info', 'ping_ws_mounted', { route: PING_ROUTE, mode: 'path-scoped' });
  log('info', 'echo_ws_mounted', { route: ECHO_ROUTE, mode: 'path-scoped' });

  // ********** IMPORTANT **********
  // NO manual server.on('upgrade') router here.
  // Mixing manual upgrades with path-scoped ws servers can race and kill upgrades
  // under Render’s proxy. All WS endpoints above are path-scoped.

  // ---------- Next.js from ./web ----------
  const webDir = path.join(__dirname, 'web');
  const requireFromWeb = createRequire(path.join(webDir, 'package.json'));
  const next = requireFromWeb('next');

  const nextApp = next({ dev: false, dir: webDir });
  const nextHandler = nextApp.getRequestHandler();
  await nextApp.prepare();

  app.all('*', (req, res) => nextHandler(req, res));

  // ---------- Boot log ----------
  const mask = (v) => (v ? v.slice(0, 4) + '…' + v.slice(-4) : '');
  log('info', 'boot_env', {
    PORT: process.env.PORT || 10000,
    AUDIO_STREAM_ROUTE: process.env.AUDIO_STREAM_ROUTE || '/audio-stream',
    DG_AGENT_URL: process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse',
    DG_STT_MODEL: process.env.DG_STT_MODEL || 'nova-2',
    DG_TTS_VOICE: process.env.DG_TTS_VOICE || 'aura-2-odysseus-en',
    LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    DEEPGRAM_API_KEY_present: !!process.env.DEEPGRAM_API_KEY,
    OPENAI_API_KEY_present: !!process.env.OPENAI_API_KEY,
    keys_preview: {
      DEEPGRAM: mask(process.env.DEEPGRAM_API_KEY || ''),
      OPENAI: mask(process.env.OPENAI_API_KEY || ''),
    },
  });

  const PORT = parseInt(process.env.PORT, 10) || 10000;
  server.listen(PORT, '0.0.0.0', () => {
    log('info', 'server_listen', { url: `http://0.0.0.0:${PORT}` });
  });

  process.on('unhandledRejection', (r) =>
    log('warn', 'unhandledRejection', { err: r?.message || r })
  );
  process.on('uncaughtException', (e) =>
    log('error', 'uncaughtException', { err: e?.message || e })
  );
})();
