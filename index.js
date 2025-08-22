// index.js — Express + Next + multiple WS routes + deep diagnostics
require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { createRequire } = require('module');
const WebSocket = require('ws');

const { handleTwilioCall } = require('./lib/twilioHandler');
const { setupAudioStream } = require('./lib/audio-stream');

// ---------------- logging helpers ----------------
const LOG_LEVEL = (process.env.LOG_LEVEL || 'debug').toLowerCase();
const lv = { error:0, warn:1, info:2, debug:3 };
const log = (level, msg, extra) => {
  if ((lv[level] ?? 2) <= (lv[LOG_LEVEL] ?? 2)) {
    const safe = extra ? JSON.stringify(extra, (_, v) => (typeof v === 'string' && v.length > 400 ? v.slice(0,400)+'…' : v)) : '';
    console.log(`[${new Date().toISOString()}] ${level} ${msg} ${safe}`);
  }
};

// ---------------- tiny utils ----------------
const mask = (v) => (v ? v.slice(0, 4) + '…' + v.slice(-4) : '');
const headerPick = (h={}) => ({
  host: h.host,
  connection: h.connection,
  upgrade: h.upgrade,
  'sec-websocket-version': h['sec-websocket-version'],
  'sec-websocket-key': h['sec-websocket-key'],
  'sec-websocket-protocol': h['sec-websocket-protocol'],
  'x-forwarded-proto': h['x-forwarded-proto'],
  'x-forwarded-for': h['x-forwarded-for'],
  'user-agent': h['user-agent'],
});

// ---------------- simple WS handlers ----------------
function handleEchoWS(ws, req) {
  log('info', 'echo_open', { path: req.url, headers: headerPick(req.headers) });
  try { ws.send('hello from /ws-echo'); } catch {}
  ws.on('message', (msg) => {
    try { ws.send(msg); } catch {}
  });
  ws.on('close', (code, reason) => log('info', 'echo_close', { code, reason: reason?.toString?.() || '' }));
  ws.on('error', (e) => log('warn', 'echo_error', { err: e?.message || String(e) }));
}

function handlePingWS(ws, req) {
  log('info', 'ping_open', { path: req.url, headers: headerPick(req.headers) });
  let t = null;
  try { ws.send('pong'); } catch {}
  t = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send('pong'); } catch {} }
    else { clearInterval(t); }
  }, 5000);
  ws.on('close', () => { if (t) clearInterval(t); });
  ws.on('error', (e) => log('warn', 'ping_error', { err: e?.message || String(e) }));
}

// ---------------- browser demo WS (your original bridge) ----------------
function handleBrowserDemoWS(ws, req) {
  // keep your existing logic here; shortened for focus
  try { ws.send(JSON.stringify({ type: 'status', text: 'demo-ws-connected' })); } catch {}
  log('info','demo_ws_open',{ path: req.url, headers: headerPick(req.headers) });

  // If Deepgram key is missing, fail early (helps debug)
  if (!process.env.DEEPGRAM_API_KEY) {
    try { ws.send(JSON.stringify({ type:'status', text:'Missing DEEPGRAM_API_KEY' })); } catch {}
    return ws.close(1011, 'Missing DEEPGRAM_API_KEY');
  }

  // (… keep your full handleBrowserDemoWS from before …)
  ws.on('close', (c,r)=>log('info','demo_ws_close',{code:c,reason:r?.toString?.()||''}));
  ws.on('error', (e)=>log('warn','demo_ws_error',{err:e?.message||String(e)}));
}

// =======================================================
(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());

  // Health
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  // Twilio webhook
  app.post('/twilio/voice', handleTwilioCall);

  // HTTP server shared by Next + all WS
  const server = http.createServer(app);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // ---------- WS: Twilio audio (path-scoped) ----------
  setupAudioStream(server);
  log('info', 'audio_ws_mounted', { route: process.env.AUDIO_STREAM_ROUTE || '/audio-stream', mode:'path-scoped' });

  // ---------- WS: Echo (path-scoped) ----------
  const ECHO_ROUTE = '/ws-echo';
  const echoWSS = new WebSocket.Server({ server, path: ECHO_ROUTE, perMessageDeflate: false });
  echoWSS.on('connection', (ws, req) => handleEchoWS(ws, req));
  log('info', 'echo_ws_mounted', { route: ECHO_ROUTE, mode: 'path-scoped' });

  // ---------- WS: Ping (manual-upgrade) ----------
  const PING_ROUTE = '/ws-ping';
  const pingWSS = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
  pingWSS.on('connection', (ws, req) => handlePingWS(ws, req));
  app.get(PING_ROUTE, (_req, res) => res.status(426).send('Upgrade Required: connect via WebSocket.'));
  log('info', 'ping_ws_mounted', { route: PING_ROUTE, mode: 'manual-upgrade' });

  // ---------- WS: Browser demo (manual-upgrade; accepts ?voiceId=) ----------
  const DEMO_ROUTE = '/web-demo/ws';
  const demoWSS = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
  demoWSS.on('connection', (ws, req) => handleBrowserDemoWS(ws, req));
  app.get(DEMO_ROUTE, (_req, res) => res.status(426).send('Upgrade Required: connect via WebSocket.'));
  log('info', 'demo_ws_mounted', { route: DEMO_ROUTE, mode: 'manual-upgrade' });

  // ---------- Upgrade router (loud) ----------
  server.on('upgrade', (req, socket, head) => {
    log('info', 'http_upgrade', { path: req.url, headers: headerPick(req.headers) });
    const pathOnly = (req.url || '').split('?')[0];

    if (req.url && req.url.startsWith(DEMO_ROUTE)) {
      return demoWSS.handleUpgrade(req, socket, head, (ws) => demoWSS.emit('connection', ws, req));
    }
    if (pathOnly === PING_ROUTE) {
      return pingWSS.handleUpgrade(req, socket, head, (ws) => pingWSS.emit('connection', ws, req));
    }
    // Let path-scoped /ws-echo hook handle its own upgrade (ws library attached to server already)
    // If none of the above match, just destroy
    socket.destroy();
  });

  // ---------- Diagnostics ----------
  app.get('/diag', (req, res) => {
    res.json({
      now: new Date().toISOString(),
      node: process.versions.node,
      ip: req.ip,
      headers: headerPick(req.headers),
      env: {
        PORT: process.env.PORT || '10000',
        AUDIO_STREAM_ROUTE: process.env.AUDIO_STREAM_ROUTE || '/audio-stream',
        DG_AGENT_URL: process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse',
        DG_STT_MODEL: process.env.DG_STT_MODEL || 'nova-2',
        DG_TTS_VOICE: process.env.DG_TTS_VOICE || 'aura-2-odysseus-en',
        LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
        LOG_LEVEL: LOG_LEVEL,
        DEEPGRAM_API_KEY_present: !!process.env.DEEPGRAM_API_KEY,
        OPENAI_API_KEY_present: !!process.env.OPENAI_API_KEY,
      },
      ws_routes: {
        echo_path_scoped: ECHO_ROUTE,
        ping_manual_upgrade: PING_ROUTE,
        demo_manual_upgrade: DEMO_ROUTE,
      }
    });
  });

  // Try a local (in-container) WS connection to prove WS server works internally.
  app.get('/ws-selfcheck', async (_req, res) => {
    const PORT = parseInt(process.env.PORT, 10) || 10000;
    const url = `ws://127.0.0.1:${PORT}${ECHO_ROUTE}`;
    const result = { target: url, ok: false, err: null, firstMessage: null };

    try {
      await new Promise((resolve, reject) => {
        const c = new WebSocket(url);
        const timer = setTimeout(() => { try { c.terminate(); } catch {} reject(new Error('timeout')); }, 5000);
        c.on('open', () => log('info','selfcheck_open',{ url }));
        c.on('message', (d) => { result.firstMessage = d.toString(); });
        c.on('error', (e) => reject(e));
        c.on('close', () => { clearTimeout(timer); resolve(); });
        // send & close quickly
        c.on('open', () => { try { c.send('selfcheck'); c.close(1000); } catch {} });
      });
      result.ok = true;
    } catch (e) {
      result.err = e?.message || String(e);
    }
    res.json(result);
  });

  // ---------- Next.js from ./web ----------
  const webDir = path.join(__dirname, 'web');
  const requireFromWeb = createRequire(path.join(webDir, 'package.json'));
  const next = requireFromWeb('next');

  const nextApp = next({ dev: false, dir: webDir });
  const nextHandler = nextApp.getRequestHandler();
  await nextApp.prepare();

  app.all('*', (req, res) => nextHandler(req, res));

  // ---------- Boot ----------
  const PORT = parseInt(process.env.PORT, 10) || 10000;
  log('info', 'boot_env', {
    PORT,
    AUDIO_STREAM_ROUTE: process.env.AUDIO_STREAM_ROUTE || '/audio-stream',
    DG_AGENT_URL: process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse',
    DG_STT_MODEL: process.env.DG_STT_MODEL || 'nova-2',
    DG_TTS_VOICE: process.env.DG_TTS_VOICE || 'aura-2-odysseus-en',
    LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
    LOG_LEVEL: LOG_LEVEL,
    DEEPGRAM_API_KEY_present: !!process.env.DEEPGRAM_API_KEY,
    OPENAI_API_KEY_present: !!process.env.OPENAI_API_KEY,
    keys_preview: {
      DEEPGRAM: mask(process.env.DEEPGRAM_API_KEY || ''),
      OPENAI: mask(process.env.OPENAI_API_KEY || ''),
    },
  });

  server.listen(PORT, '0.0.0.0', () => {
    log('info', 'server_listen', { url: `http://0.0.0.0:${PORT}` });
  });

  process.on('unhandledRejection', (r) => log('warn', 'unhandledRejection', { err: r?.message || r }));
  process.on('uncaughtException', (e) => log('error', 'uncaughtException', { err: e?.message || e }));
})();
