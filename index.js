// index.js — Render: Express + Next (./web) + WS (path-scoped only)
// Hardened: wipe stray 'upgrade' listeners, path-scoped WS, catch-all upgrade logger,
// loud diagnostics (/diag) and in-process selfcheck.

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { createRequire } = require('module');
const WebSocket = require('ws');

const { handleTwilioCall } = require('./lib/twilioHandler');
const { setupAudioStream } = require('./lib/audio-stream'); // Twilio bridge

// ---------- logging helpers ----------
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const lv = { error:0, warn:1, info:2, debug:3 };
const log = (level, msg, extra) => {
  if ((lv[level] ?? 2) <= (lv[LOG_LEVEL] ?? 2)) {
    console.log(`[${new Date().toISOString()}] ${level} ${msg} ${extra ? JSON.stringify(extra) : ''}`);
  }
};

// ---------- browser demo WS handler (unchanged logic) ----------
function handleBrowserDemoWS(browserWS, req) {
  let closed = false;

  // query: ?voiceId=
  let voiceId = 1;
  try {
    const u = new URL(req.url, 'http://localhost');
    const v = parseInt(u.searchParams.get('voiceId') || '1', 10);
    if ([1,2,3].includes(v)) voiceId = v;
  } catch {}

  const ttsVoice =
    process.env[`VOICE_${voiceId}_TTS`] ||
    process.env.DG_TTS_VOICE ||
    'aura-2-odysseus-en';

  const dgUrl = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
  const dgKey = process.env.DEEPGRAM_API_KEY;
  if (!dgKey) {
    try { browserWS.send(JSON.stringify({ type:'status', text:'Missing DEEPGRAM_API_KEY' })); } catch {}
    browserWS.close(1011, 'Missing DEEPGRAM_API_KEY');
    return;
  }

  const agentWS = new WebSocket(dgUrl, ['token', dgKey]);

  const sttModel = (process.env.DG_STT_MODEL || 'nova-2').trim();
  const llmModel = (process.env.LLM_MODEL || 'gpt-4o-mini').trim();
  const temperature = Number(process.env.LLM_TEMPERATURE || '0.15');

  const firm = process.env.FIRM_NAME || 'Benji Personal Injury';
  const agentName = process.env.AGENT_NAME || 'Alexis';
  const prompt =
    `You are ${agentName} for ${firm}. First ask: existing client or accident? Ask exactly one question per turn and wait for the reply. Existing: get name, best phone, attorney; then say youll transfer. Accident: get name, phone, email, what happened, when, city/state; confirm, then say youll transfer. Stop if the caller talks.`;

  const greeting =
    process.env.AGENT_GREETING ||
    `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`;

  let settingsSent = false;
  let settingsApplied = false;

  const keepalive = setInterval(() => {
    if (agentWS.readyState === WebSocket.OPEN) {
      try { agentWS.send(JSON.stringify({ type:'KeepAlive' })); } catch {}
    }
  }, 25000);

  const preFrames = [];
  const MAX_PRE_FRAMES = 200;

  try { browserWS.send(JSON.stringify({ type:'status', text:'demo-ws-connected' })); } catch {}

  function sendSettings() {
    if (settingsSent) return;
    const settings = {
      type:'Settings',
      audio: {
        input:  { encoding:'linear16', sample_rate:16000 },
        output: { encoding:'linear16', sample_rate:16000 },
      },
      agent: {
        language:'en',
        greeting,
        listen: { provider:{ type:'deepgram', model: sttModel, smart_format:true } },
        think:  { provider:{ type:'open_ai', model: llmModel, temperature }, prompt },
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

  agentWS.on('open', () => {
    log('info','demo_dg_open',{ url: dgUrl, ttsVoice, voiceId });
    try { browserWS.send(JSON.stringify({ type:'status', text:'Connected to Deepgram.' })); } catch {}
    sendSettings();
  });

  agentWS.on('message', (data) => {
    const isBuf = Buffer.isBuffer(data);
    if (!isBuf || (isBuf && data.length && data[0] === 0x7b)) {
      let evt = null; try { evt = JSON.parse(isBuf ? data.toString('utf8') : data); } catch {}
      if (!evt) return;

      const role = String((evt.role || evt.speaker || evt.actor || '')).toLowerCase();
      const text = String(evt.content ?? evt.text ?? evt.transcript ?? evt.message ?? '').trim();
      const isFinal = evt.final === true || evt.is_final === true || evt.status === 'final' || evt.type === 'UserResponse';

      switch (evt.type) {
        case 'Welcome': sendSettings(); break;
        case 'SettingsApplied':
          settingsApplied = true;
          if (preFrames.length) { try { for (const fr of preFrames) agentWS.send(fr); } catch {} preFrames.length = 0; }
          break;
        case 'ConversationText':
        case 'History':
        case 'UserTranscript':
        case 'UserResponse':
        case 'Transcript':
        case 'AddUserMessage':
        case 'AddAssistantMessage':
        case 'AgentTranscript':
        case 'AgentResponse':
        case 'PartialTranscript':
        case 'AddPartialTranscript':
          if (text) {
            try {
              browserWS.send(JSON.stringify({
                type:'transcript',
                role: role.includes('agent') || role.includes('assistant') ? 'Agent' : 'User',
                text,
                partial: !isFinal
              }));
            } catch {}
          }
          break;
        case 'AgentWarning':
          try { browserWS.send(JSON.stringify({ type:'status', text:`Agent warning: ${evt.message || 'unknown'}` })); } catch {}
          break;
        case 'AgentError':
        case 'Error':
          try { browserWS.send(JSON.stringify({ type:'status', text:`Agent error: ${evt.description || evt.message || 'unknown'}` })); } catch {}
          break;
      }
      return;
    }

    // Binary TTS → browser
    try { browserWS.send(data, { binary:true }); } catch {}
  });

  agentWS.on('close', () => { try { browserWS.send(JSON.stringify({ type:'status', text:'Deepgram connection closed.' })); } catch {}; safeClose(); });
  agentWS.on('error', (e) => { try { browserWS.send(JSON.stringify({ type:'status', text:`Deepgram error: ${e?.message || e}` })); } catch {}; });

  // mic → agent (20ms frames @16k PCM16)
  const FRAME_MS = 20, IN_RATE = 16000, BPS = 2;
  const BYTES_PER_FRAME = Math.round(IN_RATE * BPS * (FRAME_MS / 1000)); // 640
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
        if (preFrames.length > MAX_PRE_FRAMES) preFrames.shift();
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
    clearInterval(keepalive);
    try { agentWS.close(1000); } catch {}
    try { browserWS.terminate?.(); } catch {}
  }
}

// ---------- tiny WS diagnostics ----------
function handlePingWS(ws) {
  const t = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send('pong'); } catch {} } else { clearInterval(t); }
  }, 3000);
  ws.on('close', () => clearInterval(t));
}
function handleEchoWS(ws) {
  ws.on('message', (data) => { try { ws.send(data, { binary: Buffer.isBuffer(data) }); } catch {} });
}

// =========================================================
(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
  app.use(bodyParser.urlencoded({ extended:false }));
  app.use(bodyParser.json());

  // health + diag
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));
  app.get('/diag', (req, res) => {
    res.json({
      now: new Date().toISOString(),
      node: process.version,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      headers: {
        host: req.headers.host,
        'x-forwarded-proto': req.headers['x-forwarded-proto'],
        'user-agent': req.headers['user-agent']
      },
      env: {
        PORT: process.env.PORT || '10000',
        AUDIO_STREAM_ROUTE: process.env.AUDIO_STREAM_ROUTE || '/audio-stream',
        DG_AGENT_URL: process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse',
        DG_STT_MODEL: process.env.DG_STT_MODEL || 'nova-2',
        DG_TTS_VOICE: process.env.DG_TTS_VOICE || 'aura-2-odysseus-en',
        LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
        LOG_LEVEL: process.env.LOG_LEVEL || 'info',
        DEEPGRAM_API_KEY_present: !!process.env.DEEPGRAM_API_KEY,
        OPENAI_API_KEY_present: !!process.env.OPENAI_API_KEY
      }
    });
  });

  // Twilio webhook
  app.post('/twilio/voice', handleTwilioCall);

  const server = http.createServer(app);

  // 🔧 Nuke any stray upgrade listeners BEFORE mounting ws servers
  const before = server.listeners('upgrade').length;
  server.removeAllListeners('upgrade');
  log('info','upgrade_listeners_cleared',{ before });

  // ---- WS: Twilio <-> Deepgram (path-scoped)
  setupAudioStream(server);
  log('info','audio_ws_mounted',{ route: process.env.AUDIO_STREAM_ROUTE || '/audio-stream', mode:'path-scoped' });

  // ---- WS: Browser demo (path-scoped)
  const DEMO_ROUTE = '/web-demo/ws';
  const demoWSS = new WebSocket.Server({ server, path: DEMO_ROUTE, perMessageDeflate:false });
  demoWSS.on('connection', (ws, req) => {
    log('info','demo_ws_connection',{ url: req.url, ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress });
    handleBrowserDemoWS(ws, req);
  });
  demoWSS.on('headers', (_h, req) => log('debug','demo_ws_handshake',{ path: req.url, ua: req.headers['user-agent'] }));
  demoWSS.on('error', (e) => log('warn','demo_ws_error',{ err: e?.message || String(e) }));
  log('info','demo_ws_mounted',{ route: DEMO_ROUTE, mode:'path-scoped' });

  // ---- WS: Ping (path-scoped)
  const PING_ROUTE = '/ws-ping';
  const pingWSS = new WebSocket.Server({ server, path: PING_ROUTE, perMessageDeflate:false });
  pingWSS.on('connection', (ws, req) => { log('info','ping_ws_connection',{ ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress }); handlePingWS(ws); });
  pingWSS.on('headers', (_h, req) => log('debug','ping_ws_handshake',{ path: req.url }));
  log('info','ping_ws_mounted',{ route: PING_ROUTE, mode:'path-scoped' });

  // ---- WS: Echo (path-scoped)
  const ECHO_ROUTE = '/ws-echo';
  const echoWSS = new WebSocket.Server({ server, path: ECHO_ROUTE, perMessageDeflate:false });
  echoWSS.on('connection', (ws, req) => { log('info','echo_ws_connection',{ ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress }); handleEchoWS(ws); });
  echoWSS.on('headers', (_h, req) => log('debug','echo_ws_handshake',{ path: req.url }));
  log('info','echo_ws_mounted',{ route: ECHO_ROUTE, mode:'path-scoped' });

  // 🔒 Final catch-all upgrade logger (registered LAST).
  // If you see this fire, a request bypassed all path-scoped WS handlers.
  setImmediate(() => {
    server.on('upgrade', (req, socket) => {
      log('error','upgrade_fallthrough',{
        url: req.url,
        upgrade: req.headers.upgrade,
        conn: req.headers.connection,
        version: req.headers['sec-websocket-version'],
        key: !!req.headers['sec-websocket-key'],
        ua: req.headers['user-agent']
      });
      try { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {}
      try { socket.destroy(); } catch {}
    });
    log('info','upgrade_listeners_final',{ count: server.listeners('upgrade').length });
  });

  // ---- Next.js (mounted AFTER WS)
  const webDir = path.join(__dirname, 'web');
  const requireFromWeb = createRequire(path.join(webDir, 'package.json'));
  const next = requireFromWeb('next');
  const nextApp = next({ dev:false, dir: webDir });
  const nextHandler = nextApp.getRequestHandler();
  await nextApp.prepare();
  app.all('*', (req, res) => nextHandler(req, res));

  // ---- boot log + selfcheck
  const PORT = parseInt(process.env.PORT, 10) || 10000;
  server.listen(PORT, '0.0.0.0', () => {
    log('info','server_listen',{ url: `http://0.0.0.0:${PORT}` });
    // in-process echo check (101 expected)
    const target = `ws://127.0.0.1:${PORT}${ECHO_ROUTE}`;
    try {
      const t = new WebSocket(target);
      let reported = false;
      t.on('open', () => { log('info','selfcheck_open',{ target }); t.close(); });
      t.on('unexpectedResponse', (_req, res) => { if (!reported) { log('error','selfcheck_unexpected',{ code: res.statusCode }); reported = true; } });
      t.on('error', (e) => { if (!reported) { log('error','selfcheck_error',{ err: e?.message || String(e), target }); reported = true; } });
    } catch (e) {
      log('error','selfcheck_throw',{ err: e?.message || String(e) });
    }
  });

  process.on('unhandledRejection', (r) => log('warn','unhandledRejection',{ err: r?.message || r }));
  process.on('uncaughtException', (e) => log('error','uncaughtException',{ err: e?.message || e }));
})();
