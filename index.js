// index.js — Express + Next + explicit WS upgrade router with loud diagnostics.
// Keeps Twilio <-> Deepgram at /audio-stream (path-scoped).
// Adds manual-upgrade WS routes: /web-demo/ws, /ws-ping, /ws-echo.

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { createRequire } = require('module');
const WebSocket = require('ws');

const { handleTwilioCall } = require('./lib/twilioHandler');
const { setupAudioStream } = require('./lib/audio-stream'); // Twilio path WS

// ---------------- Small helpers ----------------
const LOG_LEVEL = (process.env.LOG_LEVEL || 'debug').toLowerCase();
const lv = { error: 0, warn: 1, info: 2, debug: 3 };
const log = (level, msg, extra) => {
  if ((lv[level] ?? 2) <= (lv[LOG_LEVEL] ?? 2)) {
    const safe = (o) => {
      try { return JSON.stringify(o); } catch { return String(o); }
    };
    console.log(`[${new Date().toISOString()}] ${level} ${msg} ${extra ? safe(extra) : ''}`);
  }
};

function headerSnapshot(req) {
  const h = req.headers || {};
  return {
    path: req.url,
    method: req.method,
    httpVersion: req.httpVersion,
    connection: h.connection || null,
    upgrade: h.upgrade || null,
    host: h.host || null,
    origin: h.origin || null,
    'sec-websocket-key': Boolean(h['sec-websocket-key']),
    'sec-websocket-version': h['sec-websocket-version'] || null,
    'sec-websocket-protocol': h['sec-websocket-protocol'] || null,
    'x-forwarded-for': h['x-forwarded-for'] || null,
    'x-forwarded-proto': h['x-forwarded-proto'] || null,
    'user-agent': h['user-agent'] || null,
  };
}

// ---------------- Browser demo handler ----------------
// (unchanged logic, trimmed for brevity — uses your Deepgram Agent bridge)
function handleBrowserDemoWS(browserWS, req) {
  let closed = false;

  // voiceId from query
  let voiceId = 1;
  try {
    const u = new URL(req.url, 'http://localhost');
    const v = parseInt(u.searchParams.get('voiceId') || '1', 10);
    if ([1, 2, 3].includes(v)) voiceId = v;
  } catch {}

  const ttsVoice =
    process.env[`VOICE_${voiceId}_TTS`] ||
    process.env.DG_TTS_VOICE ||
    'aura-2-odysseus-en';

  const dgUrl = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
  const dgKey = process.env.DEEPGRAM_API_KEY;
  if (!dgKey) {
    try { browserWS.send(JSON.stringify({ type: 'status', text: 'Missing DEEPGRAM_API_KEY' })); } catch {}
    browserWS.close(1011, 'Missing DEEPGRAM_API_KEY');
    return;
  }

  const agentWS = new WebSocket(dgUrl, ['token', dgKey]);
  const sttModel = (process.env.DG_STT_MODEL || 'nova-2').trim();
  const llmModel = (process.env.LLM_MODEL || 'gpt-4o-mini').trim();
  const temperature = Number(process.env.LLM_TEMPERATURE || '0.15');

  const firm = process.env.FIRM_NAME || 'Benji Personal Injury';
  const agentName = process.env.AGENT_NAME || 'Alexis';
  const DEFAULT_PROMPT =
    `You are ${agentName} for ${firm}. First ask: existing client or accident? Ask exactly one question per turn and wait for the reply. Existing: get name, best phone, attorney; then say youll transfer. Accident: get name, phone, email, what happened, when, city/state; confirm, then say youll transfer. Stop if the caller talks.`;

  const sanitize = (x) => String(x || '').replace(/[\u0000-\u001f\u007f-\uFFFF]/g,' ').replace(/\s+/g,' ').trim();
  const compact = (s,max=380)=>{ const t=(s||'').slice(0,max); return t.length>=40?t:DEFAULT_PROMPT; };

  const useEnv = String(process.env.DISABLE_ENV_INSTRUCTIONS || 'false').toLowerCase() !== 'true';
  const rawPrompt = sanitize(useEnv ? (process.env.AGENT_INSTRUCTIONS || '') : '') || DEFAULT_PROMPT;
  const prompt = compact(rawPrompt, 380);
  const greeting = sanitize(process.env.AGENT_GREETING || `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`);

  // quick client status
  try { browserWS.send(JSON.stringify({ type: 'status', text: 'demo-ws-connected' })); } catch {}

  // Keepalive
  const keepalive = setInterval(() => {
    if (agentWS.readyState === WebSocket.OPEN) {
      try { agentWS.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
    }
  }, 25000);

  let settingsSent = false;
  let settingsApplied = false;
  const preFrames = [];
  const MAX_PRE = 200;
  const BYTES_PER_FRAME = Math.round(16000 * 2 * (20 / 1000)); // 640

  function sendSettings() {
    if (settingsSent) return;
    const settings = {
      type: 'Settings',
      audio: { input: { encoding:'linear16', sample_rate:16000 }, output:{ encoding:'linear16', sample_rate:16000 } },
      agent: {
        language:'en',
        greeting,
        listen: { provider:{ type:'deepgram', model:sttModel, smart_format:true } },
        think:  { provider:{ type:'open_ai', model:llmModel, temperature }, prompt },
        speak:  { provider:{ type:'deepgram', model: ttsVoice } },
      },
    };
    try {
      agentWS.send(JSON.stringify(settings));
      settingsSent = true;
      try {
        browserWS.send(JSON.stringify({ type:'settings', sttModel, ttsVoice, llmModel, temperature, greeting, prompt_len: prompt.length }));
      } catch {}
    } catch (e) {
      try { browserWS.send(JSON.stringify({ type:'status', text:'Failed to send Settings to Deepgram.' })); } catch {}
    }
  }

  agentWS.on('open', () => { log('info','demo_dg_open',{ url: dgUrl, voiceId, ttsVoice }); sendSettings(); });
  agentWS.on('message', (data) => {
    const isBuf = Buffer.isBuffer(data);
    if (!isBuf || (isBuf && data[0] === 0x7b)) {
      let evt=null; try{ evt=JSON.parse(isBuf? data.toString('utf8'): data);}catch{}
      if (!evt) return;
      if (evt.type === 'Welcome') sendSettings();
      if (evt.type === 'SettingsApplied') {
        settingsApplied = true;
        if (preFrames.length) { try { for (const fr of preFrames) agentWS.send(fr); } catch {} preFrames.length=0; }
      }
      const role = String((evt.role || evt.speaker || evt.actor || '')).toLowerCase();
      const text = String(evt.content ?? evt.text ?? evt.transcript ?? evt.message ?? '').trim();
      const isFinal = evt.final === true || evt.is_final === true || evt.status === 'final' || evt.type === 'UserResponse';
      if (text) {
        const payload = { type:'transcript', role: role.includes('agent') || role.includes('assistant') ? 'Agent' : 'User', text, partial: !isFinal };
        try { browserWS.send(JSON.stringify(payload)); } catch {}
      }
      if (evt.type === 'AgentWarning') try { browserWS.send(JSON.stringify({ type:'status', text:`Agent warning: ${evt.message || 'unknown'}` })); } catch {}
      if (evt.type === 'AgentError' || evt.type === 'Error') try { browserWS.send(JSON.stringify({ type:'status', text:`Agent error: ${evt.description || evt.message || 'unknown'}` })); } catch {}
      return;
    }
    // Binary: TTS PCM16 @16k
    try { browserWS.send(data, { binary: true }); } catch {}
  });
  agentWS.on('close', () => { clearInterval(keepalive); try { browserWS.send(JSON.stringify({ type:'status', text:'Deepgram connection closed.' })); } catch {}; safeClose(); });
  agentWS.on('error', (e) => { try { browserWS.send(JSON.stringify({ type:'status', text:`Deepgram error: ${e?.message || e}` })); } catch {} });

  let micBuf = Buffer.alloc(0);
  browserWS.on('message', (msg) => {
    if (typeof msg === 'string') return;
    if (agentWS.readyState !== WebSocket.OPEN) return;
    const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
    micBuf = Buffer.concat([micBuf, buf]);
    while (micBuf.length >= BYTES_PER_FRAME) {
      const frame = micBuf.subarray(0, BYTES_PER_FRAME);
      micBuf = micBuf.subarray(BYTES_PER_FRAME);
      if (!settingsSent || !settingsApplied) {
        preFrames.push(frame);
        if (preFrames.length > MAX_PRE) preFrames.shift();
      } else {
        try { agentWS.send(frame); } catch {}
      }
    }
  });

  browserWS.on('close', safeClose);
  browserWS.on('error', safeClose);

  function safeClose() {
    if (closed) return;
    closed = true;
    try { agentWS.close(1000); } catch {}
    try { browserWS.terminate?.(); } catch {}
  }
}

// ---------------- Simple diagnostics WS ----------------
function handlePingWS(ws) {
  try { ws.send('pong'); } catch {}
  const t = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send('pong'); } catch {}
    } else clearInterval(t);
  }, 2000);
}
function handleEchoWS(ws) {
  try { ws.send('echo:ready'); } catch {}
  ws.on('message', (d, isBinary) => {
    try { ws.send(d, { binary: isBinary }); } catch {}
  });
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
  server.headersTimeout = 120000;
  server.keepAliveTimeout = 120000;
  server.setTimeout(0);

  // ---------- WS: Twilio <-> Deepgram (path-scoped) ----------
  setupAudioStream(server);
  log('info', 'audio_ws_mounted', { route: process.env.AUDIO_STREAM_ROUTE || '/audio-stream' });

  // ---------- WS: Browser demo / Ping / Echo (manual upgrade) ----------
  const DEMO_ROUTE = '/web-demo/ws';
  const PING_ROUTE = '/ws-ping';
  const ECHO_ROUTE = '/ws-echo';

  const demoWSS = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
  const pingWSS = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
  const echoWSS = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

  demoWSS.on('connection', (ws, req) => handleBrowserDemoWS(ws, req));
  pingWSS.on('connection', (ws) => handlePingWS(ws));
  echoWSS.on('connection', (ws) => handleEchoWS(ws));

  log('info', 'demo_ws_mounted', { route: DEMO_ROUTE, mode: 'manual-upgrade' });
  log('info', 'ping_ws_mounted', { route: PING_ROUTE, mode: 'manual-upgrade' });
  log('info', 'echo_ws_mounted', { route: ECHO_ROUTE, mode: 'manual-upgrade' });

  // Helpful: plain GETs to WS routes → 426 with header dump
  function attach426(path) {
    app.get(path, (req, res) => {
      log('warn', 'ws_plain_get', { path, hdrs: headerSnapshot(req) });
      res
        .status(426)
        .set('X-WS-Info', 'Upgrade Required')
        .send(`Upgrade Required: connect via WebSocket to ${path}.`);
    });
  }
  attach426(DEMO_ROUTE);
  attach426(PING_ROUTE);
  attach426(ECHO_ROUTE);

  // ---------- Upgrade router ----------
  server.on('upgrade', (req, socket, head) => {
    const snap = headerSnapshot(req);
    log('debug', 'http_upgrade', snap);

    // Guard: ensure Upgrade header present
    const u = (req.headers.upgrade || '').toLowerCase();
    const conn = (req.headers.connection || '').toLowerCase();
    if (!u.includes('websocket') || !conn.includes('upgrade')) {
      log('warn', 'upgrade_missing_headers', snap);
      try {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nMissing Upgrade: websocket');
      } catch {}
      return socket.destroy();
    }

    const pathOnly = (req.url || '').split('?')[0];

    if (req.url && req.url.startsWith(DEMO_ROUTE)) {
      return demoWSS.handleUpgrade(req, socket, head, (ws) => demoWSS.emit('connection', ws, req));
    }
    if (pathOnly === PING_ROUTE) {
      return pingWSS.handleUpgrade(req, socket, head, (ws) => pingWSS.emit('connection', ws, req));
    }
    if (pathOnly === ECHO_ROUTE) {
      return echoWSS.handleUpgrade(req, socket, head, (ws) => echoWSS.emit('connection', ws, req));
    }

    // Not ours → close politely
    try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch {}
    socket.destroy();
  });

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
    LOG_LEVEL: process.env.LOG_LEVEL || 'debug',
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

  process.on('unhandledRejection', (r) => log('warn', 'unhandledRejection', { err: r?.message || r }));
  process.on('uncaughtException', (e) => log('error', 'uncaughtException', { err: e?.message || e }));
})();
