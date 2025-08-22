// index.js — Render-friendly: Express + Next + path-scoped WebSockets (no manual upgrade)

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { createRequire } = require('module');
const WebSocket = require('ws');

const { handleTwilioCall } = require('./lib/twilioHandler');
const { setupAudioStream } = require('./lib/audio-stream');           // Twilio WS (already path-scoped)
const { attachWebDemoHandlers } = require('./web-demo-live');         // Browser demo core

// ---------- logging helpers ----------
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const lv = { error:0, warn:1, info:2, debug:3 };
const log = (level, msg, extra) => {
  if ((lv[level] ?? 2) <= (lv[LOG_LEVEL] ?? 2)) {
    console.log(`[${new Date().toISOString()}] ${level} ${msg} ${extra ? JSON.stringify(extra) : ''}`);
  }
};

// ---------- constants ----------
const PORT = parseInt(process.env.PORT || '10000', 10);
const AUDIO_ROUTE = process.env.AUDIO_STREAM_ROUTE || '/audio-stream';
const DEMO_ROUTE  = '/web-demo/ws';
const PING_ROUTE  = '/ws-ping';
const ECHO_ROUTE  = '/ws-echo';

// =======================================================
(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());

  // Health & diag
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));
  app.get('/diag', (req, res) => {
    res.json({
      now: new Date().toISOString(),
      node: process.version,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      headers: {
        host: req.headers.host,
        'x-forwarded-proto': req.headers['x-forwarded-proto'],
        'user-agent': req.headers['user-agent'],
      },
      env: {
        PORT: String(PORT),
        AUDIO_STREAM_ROUTE: AUDIO_ROUTE,
        DG_AGENT_URL: process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse',
        DG_STT_MODEL: process.env.DG_STT_MODEL || 'nova-2',
        DG_TTS_VOICE: process.env.DG_TTS_VOICE || 'aura-2-odysseus-en',
        LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
        LOG_LEVEL: LOG_LEVEL,
        DEEPGRAM_API_KEY_present: !!process.env.DEEPGRAM_API_KEY,
        OPENAI_API_KEY_present: !!process.env.OPENAI_API_KEY,
      },
      ws_routes: {
        audio_path_scoped: AUDIO_ROUTE,
        demo_path_scoped: DEMO_ROUTE,
        ping_path_scoped: PING_ROUTE,
        echo_path_scoped: ECHO_ROUTE,
      }
    });
  });

  // Twilio webhook (HTTP)
  app.post('/twilio/voice', handleTwilioCall);

  // Shared HTTP server
  const server = http.createServer(app);

  // =======================================================
  // 1) Twilio <-> Deepgram (path-scoped; handled inside setupAudioStream)
  // =======================================================
  setupAudioStream(server);
  log('info', 'audio_ws_mounted', { route: AUDIO_ROUTE, mode: 'path-scoped' });

  // =======================================================
  // 2) Browser demo WS (path-scoped)
  // =======================================================
  const demoWSS = new WebSocket.Server({ server, path: DEMO_ROUTE, perMessageDeflate: false });
  attachWebDemoHandlers(demoWSS);
  demoWSS.on('headers', (headers, req) => {
    log('debug', 'demo_ws_handshake', {
      path: req.url,
      upgrade: req.headers.upgrade,
      version: req.headers['sec-websocket-version'],
      ua: req.headers['user-agent'],
    });
  });
  demoWSS.on('error', (e) => log('warn', 'demo_ws_server_error', { err: e?.message || String(e) }));
  log('info', 'demo_ws_mounted', { route: DEMO_ROUTE, mode: 'path-scoped' });

  // Optional: clarify plain GET misuse
  app.get(DEMO_ROUTE, (req, res) => {
    if ((req.headers.upgrade || '').toLowerCase() === 'websocket') return res.end(); // should not happen
    res.status(426).send('Upgrade Required: connect via WebSocket.');
  });

  // =======================================================
  // 3) Ping WS (path-scoped)
  // =======================================================
  const pingWSS = new WebSocket.Server({ server, path: PING_ROUTE, perMessageDeflate: false });
  pingWSS.on('connection', (ws, req) => {
    log('info', 'ping_ws_open', { ip: req.socket.remoteAddress });
    const t = setInterval(() => { try { ws.send('pong'); } catch {} }, 5000);
    ws.on('close', () => { clearInterval(t); log('info', 'ping_ws_close'); });
    ws.on('error', (e) => log('warn', 'ping_ws_err', { err: e?.message || String(e) }));
    try { ws.send('pong'); } catch {}
  });
  pingWSS.on('headers', (h, req) => log('debug', 'ping_ws_handshake', { path: req.url, ua: req.headers['user-agent'] }));
  log('info', 'ping_ws_mounted', { route: PING_ROUTE, mode: 'path-scoped' });
  app.get(PING_ROUTE, (req, res) => {
    if ((req.headers.upgrade || '').toLowerCase() === 'websocket') return res.end();
    res.status(426).send('Upgrade Required: connect via WebSocket.');
  });

  // =======================================================
  // 4) Echo WS (path-scoped) — for diagnostics
  // =======================================================
  const echoWSS = new WebSocket.Server({ server, path: ECHO_ROUTE, perMessageDeflate: false });
  echoWSS.on('connection', (ws, req) => {
    log('info', 'echo_ws_open', { ip: req.socket.remoteAddress });
    try { ws.send(JSON.stringify({ type: 'hello', path: req.url })); } catch {}
    ws.on('message', (d, isBin) => { try { ws.send(d, { binary: isBin }); } catch {} });
    ws.on('close', (c, r) => log('info', 'echo_ws_close', { code: c, reason: r?.toString?.() || '' }));
    ws.on('error', (e) => log('warn', 'echo_ws_err', { err: e?.message || String(e) }));
  });
  echoWSS.on('headers', (h, req) => log('debug', 'echo_ws_handshake', { path: req.url, ua: req.headers['user-agent'] }));
  log('info', 'echo_ws_mounted', { route: ECHO_ROUTE, mode: 'path-scoped' });
  app.get(ECHO_ROUTE, (req, res) => {
    if ((req.headers.upgrade || '').toLowerCase() === 'websocket') return res.end();
    res.status(426).send('Upgrade Required: connect via WebSocket.');
  });

  // =======================================================
  // IMPORTANT: Do NOT register any manual `server.on('upgrade')` routers.
  // Path-scoped WSS handlers above will accept upgrades directly.
  // =======================================================

  // ---------- Next.js (from ./web) ----------
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
    PORT,
    AUDIO_STREAM_ROUTE: AUDIO_ROUTE,
    DG_AGENT_URL: process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse',
    DG_STT_MODEL: process.env.DG_STT_MODEL || 'nova-2',
    DG_TTS_VOICE: process.env.DG_TTS_VOICE || 'aura-2-odysseus-en',
    LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
    LOG_LEVEL,
    DEEPGRAM_API_KEY_present: !!process.env.DEEPGRAM_API_KEY,
    OPENAI_API_KEY_present: !!process.env.OPENAI_API_KEY,
    keys_preview: {
      DEEPGRAM: mask(process.env.DEEPGRAM_API_KEY || ''),
      OPENAI: mask(process.env.OPENAI_API_KEY || ''),
    },
  });

  server.listen(PORT, '0.0.0.0', () => log('info', 'server_listen', { url: `http://0.0.0.0:${PORT}` }));
  process.on('unhandledRejection', (r) => log('warn', 'unhandledRejection', { err: r?.message || r }));
  process.on('uncaughtException', (e) => log('error', 'uncaughtException', { err: e?.message || e }));
})();
