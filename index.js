// index.js — Express + Next (./web) + WS routes (path-scoped)
// - Twilio <-> Deepgram on /audio-stream  (path-scoped; unchanged)
// - Browser demo on /web-demo/ws          (path-scoped)
// - WS ping on /ws-ping                   (path-scoped)

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
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const lv = { error: 0, warn: 1, info: 2, debug: 3 };
const log = (level, msg, extra) => {
  if ((lv[level] ?? 2) <= (lv[LOG_LEVEL] ?? 2)) {
    console.log(
      `[${new Date().toISOString()}] ${level} ${msg} ${extra ? JSON.stringify(extra) : ''}`
    );
  }
};

const sanitizeASCII = (str) =>
  String(str || '')
    .replace(/[\u0000-\u001f\u007f-\uFFFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const compact = (s, max = 380) => {
  const t = (s || '').slice(0, max);
  return t.length >= 40
    ? t
    : 'You are the intake specialist. Determine existing client vs accident. If existing: ask full name, best phone, and attorney; then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all; then say you will transfer. Be warm, concise, and stop speaking if the caller talks.';
};

// ---------------- Browser demo handler ----------------
// Accepts a browser WS and bridges it to Deepgram Agent.
// Expects 16k PCM16 20ms frames from the browser; sends back 16k PCM16.
function handleBrowserDemoWS(browserWS, req) {
  let closed = false;

  // --- Parse voiceId from query (accept voiceId or voiceID) ---
  let voiceId = 1;
  try {
    const u = new URL(req.url, 'http://localhost');
    const v = parseInt(u.searchParams.get('voiceId') || u.searchParams.get('voiceID') || '1', 10);
    if ([1, 2, 3].includes(v)) voiceId = v;
  } catch {}

  const ttsVoice =
    process.env[`VOICE_${voiceId}_TTS`] ||
    process.env.DG_TTS_VOICE ||
    'aura-2-odysseus-en';

  // --- Connect to Deepgram Agent ---
  const dgUrl = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
  const dgKey = process.env.DEEPGRAM_API_KEY;
  if (!dgKey) {
    try {
      browserWS.send(JSON.stringify({ type: 'status', text: 'Missing DEEPGRAM_API_KEY' }));
    } catch {}
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

  const useEnv = String(process.env.DISABLE_ENV_INSTRUCTIONS || 'false').toLowerCase() !== 'true';
  const rawEnvPrompt = useEnv ? (process.env.AGENT_INSTRUCTIONS || '') : '';
  const rawPrompt = sanitizeASCII(rawEnvPrompt || DEFAULT_PROMPT);
  const prompt = compact(rawPrompt, 380);

  const greeting = sanitizeASCII(
    process.env.AGENT_GREETING ||
      `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`
  );

  let settingsSent = false;
  let settingsApplied = false;

  try {
    browserWS.send(JSON.stringify({ type: 'status', text: 'demo-ws-connected' }));
  } catch {}

  // Keepalive to DG
  const keepalive = setInterval(() => {
    if (agentWS.readyState === WebSocket.OPEN) {
      try { agentWS.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
    }
  }, 25000);

  // Metering (optional logs)
  let meterMicBytes = 0, meterTtsBytes = 0;
  const meter = setInterval(() => {
    if (meterMicBytes || meterTtsBytes) {
      log('debug', 'web_demo_meter', { mic_bps: meterMicBytes, tts_bps: meterTtsBytes });
      meterMicBytes = 0; meterTtsBytes = 0;
    }
  }, 1000);

  function sendSettings() {
    if (settingsSent) return;
    const settings = {
      type: 'Settings',
      audio: {
        input:  { encoding: 'linear16', sample_rate: 16000 },
        output: { encoding: 'linear16', sample_rate: 16000 },
      },
      agent: {
        language: 'en',
        greeting,
        listen: { provider: { type: 'deepgram', model: sttModel, smart_format: true } },
        think:  { provider: { type: 'open_ai', model: llmModel, temperature }, prompt },
        speak:  { provider: { type: 'deepgram', model: ttsVoice } },
      },
    };
    try {
      agentWS.send(JSON.stringify(settings));
      settingsSent = true;
      try {
        browserWS.send(JSON.stringify({
          type: 'settings',
          sttModel, ttsVoice, llmModel, temperature, greeting, prompt_len: prompt.length
        }));
      } catch {}
    } catch (e) {
      try {
        browserWS.send(JSON.stringify({ type: 'status', text: 'Failed to send Settings to Deepgram.' }));
      } catch {}
    }
  }

  agentWS.on('open', () => {
    log('info', 'demo_dg_open', { url: dgUrl, voiceId, ttsVoice });
    try { browserWS.send(JSON.stringify({ type: 'status', text: 'Connected to Deepgram.' })); } catch {}
    sendSettings();
  });

  // Buffer mic frames until SettingsApplied
  const preFrames = [];
  const MAX_PRE_FRAMES = 200; // ~4s @ 20ms frames

  agentWS.on('message', (data) => {
    const isBuf = Buffer.isBuffer(data);

    // JSON control / transcripts
    if (!isBuf || (isBuf && data.length && data[0] === 0x7b)) {
      let evt = null; try { evt = JSON.parse(isBuf ? data.toString('utf8') : data); } catch {}
      if (!evt) return;

      const role = String((evt.role || evt.speaker || evt.actor || '')).toLowerCase();
      const text = String(evt.content ?? evt.text ?? evt.transcript ?? evt.message ?? '').trim();
      const isFinal = evt.final === true || evt.is_final === true || evt.status === 'final' || evt.type === 'UserResponse';

      switch (evt.type) {
        case 'Welcome':
          sendSettings();
          break;
        case 'SettingsApplied':
          settingsApplied = true;
          if (preFrames.length) {
            try { for (const fr of preFrames) agentWS.send(fr); } catch {}
            preFrames.length = 0;
          }
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
        case 'AddPartialTranscript': {
          if (!text) break;
          const payload = {
            type: 'transcript',
            role: role.includes('agent') || role.includes('assistant') ? 'Agent' : 'User',
            text,
            partial: !isFinal
          };
          try { browserWS.send(JSON.stringify(payload)); } catch {}
          break;
        }
        case 'AgentWarning':
          try { browserWS.send(JSON.stringify({ type: 'status', text: `Agent warning: ${evt.message || 'unknown'}` })); } catch {}
          break;
        case 'AgentError':
        case 'Error':
          try { browserWS.send(JSON.stringify({ type: 'status', text: `Agent error: ${evt.description || evt.message || 'unknown'}` })); } catch {}
          break;
      }
      return;
    }

    // Binary = DG TTS PCM16 @16k → forward to browser
    meterTtsBytes += data.length;
    try { browserWS.send(data, { binary: true }); } catch {}
  });

  agentWS.on('close', () => {
    clearInterval(keepalive); clearInterval(meter);
    try { browserWS.send(JSON.stringify({ type: 'status', text: 'Deepgram connection closed.' })); } catch {}
    safeClose();
  });
  agentWS.on('error', (e) => {
    try { browserWS.send(JSON.stringify({ type: 'status', text: `Deepgram error: ${e?.message || e}` })); } catch {}
  });

  // ---- Browser mic → DG, 20 ms frames ----
  const FRAME_MS = 20, IN_RATE = 16000, BPS = 2;
  const BYTES_PER_FRAME = Math.round(IN_RATE * BPS * (FRAME_MS / 1000)); // 640
  let micBuf = Buffer.alloc(0);

  browserWS.on('message', (msg) => {
    if (typeof msg === 'string') {
      // (Optional) handle control messages here in the future
      return;
    }
    if (agentWS.readyState !== WebSocket.OPEN) return;
    const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
    meterMicBytes += buf.length;
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
    clearInterval(keepalive); clearInterval(meter);
    try { agentWS.close(1000); } catch {}
    try { browserWS.terminate?.(); } catch {}
  }
}

// ---------------- Ping WS (diagnostics) ----------------
function handlePingWS(ws) {
  let t = null;
  try { ws.send('pong'); } catch {}
  t = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send('pong'); } catch {}
    } else {
      clearInterval(t);
    }
  }, 5000);
  ws.on('message', () => {}); // ignore
  ws.on('close', () => { if (t) clearInterval(t); });
}

// =======================================================
(async () => {
  const app = express();
  app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());

  // Health
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  // Twilio webhook
  app.post('/twilio/voice', handleTwilioCall);

  // HTTP server shared by Next + all WS
  const server = http.createServer(app);

  // ---------- WS: Twilio <-> Deepgram (path-scoped) ----------
  setupAudioStream(server);
  log('info', 'audio_ws_mounted', { route: process.env.AUDIO_STREAM_ROUTE || '/audio-stream' });

  // ---------- WS: Browser demo (path-scoped; accepts ?voiceId=) ----------
  const DEMO_ROUTE = '/web-demo/ws';
  const demoWSS = new WebSocket.Server({ server, path: DEMO_ROUTE, perMessageDeflate: false });
  demoWSS.on('connection', (ws, req) => {
    log('info', 'demo_ws_connection', { path: req.url });
    handleBrowserDemoWS(ws, req);
  });
  demoWSS.on('headers', (_headers, req) => {
    log('info', 'demo_ws_handshake', {
      path: req.url,
      upgrade: req.headers.upgrade,
      version: req.headers['sec-websocket-version'],
      ua: req.headers['user-agent'],
    });
  });
  log('info', 'demo_ws_mounted', { route: DEMO_ROUTE, mode: 'path-scoped' });

  // Optional: plain HTTP GET to WS path returns 426 to clarify misuse
  app.get(DEMO_ROUTE, (_req, res) => res.status(426).send('Upgrade Required: connect via WebSocket.'));

  // ---------- WS: Ping (path-scoped) ----------
  const PING_ROUTE = '/ws-ping';
  const pingWSS = new WebSocket.Server({ server, path: PING_ROUTE, perMessageDeflate: false });
  pingWSS.on('connection', (ws, req) => {
    log('info', 'ping_ws_connection', { path: req.url });
    handlePingWS(ws);
  });
  pingWSS.on('headers', (_headers, req) => {
    log('info', 'ping_ws_handshake', {
      path: req.url,
      upgrade: req.headers.upgrade,
      version: req.headers['sec-websocket-version'],
      ua: req.headers['user-agent'],
    });
  });
  log('info', 'ping_ws_mounted', { route: PING_ROUTE, mode: 'path-scoped' });

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
    PUBLIC_WSS_HOST: process.env.PUBLIC_WSS_HOST || null,
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

  process.on('unhandledRejection', (r) => log('warn', 'unhandledRejection', { err: r?.message || r }));
  process.on('uncaughtException', (e) => log('error', 'uncaughtException', { err: e?.message || e }));
})();
