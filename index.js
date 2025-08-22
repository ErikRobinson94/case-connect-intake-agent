// index.js — Express + Next + Path-scoped WebSockets + Diagnostics
// Keeps Twilio /audio-stream, adds /web-demo/ws, /ws-ping, /ws-echo, and /debug page.

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { createRequire } = require('module');
const WebSocket = require('ws');

const { handleTwilioCall } = require('./lib/twilioHandler');
const { setupAudioStream } = require('./lib/audio-stream'); // Twilio path-scoped WS

// ---------------- Logging ----------------
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const lv = { error:0, warn:1, info:2, debug:3 };
const log = (level, msg, extra) => {
  if ((lv[level] ?? 2) <= (lv[LOG_LEVEL] ?? 2)) {
    console.log(`[${new Date().toISOString()}] ${level} ${msg} ${extra ? JSON.stringify(extra) : ''}`);
  }
};

// ---------------- Helpers for demo WS ----------------
const sanitizeASCII = (str) =>
  String(str || '').replace(/[\u0000-\u001f\u007f-\uFFFF]/g, ' ').replace(/\s+/g, ' ').trim();

const compact = (s, max = 380) => {
  const t = (s || '').slice(0, max);
  return t.length >= 40 ? t :
    'You are the intake specialist. Determine existing client vs accident. If existing: ask full name, best phone, and attorney; then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all; then say you will transfer. Be warm, concise, and stop speaking if the caller talks.';
};

// ---------------- Browser demo WS handler ----------------
function handleBrowserDemoWS(browserWS, req) {
  let closed = false;

  // voiceId or voiceID
  let voiceId = 1;
  try {
    const u = new URL(req.url, 'http://localhost');
    const v = parseInt(u.searchParams.get('voiceId') || u.searchParams.get('voiceID') || '1', 10);
    if ([1,2,3].includes(v)) voiceId = v;
  } catch {}

  const dgUrl = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
  const dgKey = process.env.DEEPGRAM_API_KEY;
  if (!dgKey) {
    try { browserWS.send(JSON.stringify({ type:'status', text:'Missing DEEPGRAM_API_KEY' })); } catch {}
    browserWS.close(1011, 'Missing DEEPGRAM_API_KEY');
    return;
  }

  const sttModel = (process.env.DG_STT_MODEL || 'nova-2').trim();
  const llmModel = (process.env.LLM_MODEL || 'gpt-4o-mini').trim();
  const temperature = Number(process.env.LLM_TEMPERATURE || '0.15');
  const ttsVoice = process.env[`VOICE_${voiceId}_TTS`] || process.env.DG_TTS_VOICE || 'aura-2-odysseus-en';

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

  // Wire to Deepgram
  const agentWS = new WebSocket(dgUrl, ['token', dgKey]);

  let settingsSent = false;
  let settingsApplied = false;

  try { browserWS.send(JSON.stringify({ type:'status', text:'demo-ws-connected' })); } catch {}

  const keepalive = setInterval(() => {
    if (agentWS.readyState === WebSocket.OPEN) {
      try { agentWS.send(JSON.stringify({ type:'KeepAlive' })); } catch {}
    }
  }, 25000);

  let meterMicBytes = 0, meterTtsBytes = 0;
  const meter = setInterval(() => {
    if (meterMicBytes || meterTtsBytes) {
      log('debug','web_demo_meter',{ mic_bps: meterMicBytes, tts_bps: meterTtsBytes });
      meterMicBytes = 0; meterTtsBytes = 0;
    }
  }, 1000);

  function sendSettings() {
    if (settingsSent) return;
    const settings = {
      type:'Settings',
      audio: { input:{ encoding:'linear16', sample_rate:16000 }, output:{ encoding:'linear16', sample_rate:16000 } },
      agent: {
        language:'en',
        greeting,
        listen:{ provider:{ type:'deepgram', model:sttModel, smart_format:true } },
        think:{ provider:{ type:'open_ai', model:llmModel, temperature }, prompt },
        speak:{ provider:{ type:'deepgram', model:ttsVoice } },
      }
    };
    try {
      agentWS.send(JSON.stringify(settings));
      settingsSent = true;
      try { browserWS.send(JSON.stringify({ type:'settings', sttModel, ttsVoice, llmModel, temperature, greeting, prompt_len: prompt.length })); } catch {}
    } catch (e) {
      try { browserWS.send(JSON.stringify({ type:'status', text:'Failed to send Settings to Deepgram.' })); } catch {}
    }
  }

  agentWS.on('open', () => {
    log('info','demo_dg_open',{ url: dgUrl, voiceId, ttsVoice });
    try { browserWS.send(JSON.stringify({ type:'status', text:'Connected to Deepgram.' })); } catch {}
    sendSettings();
  });

  const preFrames = [];
  const MAX_PRE_FRAMES = 200;

  agentWS.on('message', (data) => {
    const isBuf = Buffer.isBuffer(data);
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
        case 'AddPartialTranscript': {
          if (!text) break;
          const payload = { type:'transcript', role: (role.includes('agent')||role.includes('assistant'))?'Agent':'User', text, partial: !isFinal };
          try { browserWS.send(JSON.stringify(payload)); } catch {}
          break;
        }
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

    // Binary → forward PCM16 to browser
    meterTtsBytes += data.length;
    try { browserWS.send(data, { binary:true }); } catch {}
  });

  agentWS.on('close', () => {
    clearInterval(keepalive); clearInterval(meter);
    try { browserWS.send(JSON.stringify({ type:'status', text:'Deepgram connection closed.' })); } catch {}
    safeClose();
  });
  agentWS.on('error', (e) => {
    try { browserWS.send(JSON.stringify({ type:'status', text:`Deepgram error: ${e?.message || e}` })); } catch {}
  });

  // Browser mic → DG (20ms frames)
  const FRAME_MS = 20, IN_RATE = 16000, BPS = 2;
  const BYTES_PER_FRAME = Math.round(IN_RATE * BPS * (FRAME_MS/1000)); // 640
  let micBuf = Buffer.alloc(0);

  browserWS.on('message', (msg) => {
    if (typeof msg === 'string') return;
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

// ---------------- Simple WS: ping & echo ----------------
function handlePingWS(ws) {
  let t = null;
  try { ws.send('pong'); } catch {}
  t = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send('pong'); } catch {} }
    else clearInterval(t);
  }, 5000);
  ws.on('message', () => {});
  ws.on('close', () => { if (t) clearInterval(t); });
}

function handleEchoWS(ws) {
  ws.on('message', (data, isBinary) => {
    try { ws.send(data, { binary: isBinary }); } catch {}
  });
  try { ws.send('echo-ready'); } catch {}
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
  log('info','audio_ws_mounted',{ route: process.env.AUDIO_STREAM_ROUTE || '/audio-stream' });

  // ---------- WS: Demo (path-scoped) ----------
  const DEMO_ROUTE = '/web-demo/ws';
  const demoWSS = new WebSocket.Server({ server, path: DEMO_ROUTE, perMessageDeflate: false });
  demoWSS.on('connection', (ws, req) => { log('info','demo_ws_connection',{ path:req.url }); handleBrowserDemoWS(ws, req); });
  demoWSS.on('headers', (_h, req) => { log('info','demo_ws_handshake',{ path:req.url, ua:req.headers['user-agent'] }); });
  log('info','demo_ws_mounted',{ route: DEMO_ROUTE, mode:'path-scoped' });

  // ---------- WS: Ping (path-scoped) ----------
  const PING_ROUTE = '/ws-ping';
  const pingWSS = new WebSocket.Server({ server, path: PING_ROUTE, perMessageDeflate: false });
  pingWSS.on('connection', (ws, req) => { log('info','ping_ws_connection',{ path:req.url }); handlePingWS(ws); });
  pingWSS.on('headers', (_h, req) => { log('info','ping_ws_handshake',{ path:req.url, ua:req.headers['user-agent'] }); });
  log('info','ping_ws_mounted',{ route: PING_ROUTE, mode:'path-scoped' });

  // ---------- WS: Echo (path-scoped) ----------
  const ECHO_ROUTE = '/ws-echo';
  const echoWSS = new WebSocket.Server({ server, path: ECHO_ROUTE, perMessageDeflate: false });
  echoWSS.on('connection', (ws, req) => { log('info','echo_ws_connection',{ path:req.url }); handleEchoWS(ws); });
  echoWSS.on('headers', (_h, req) => { log('info','echo_ws_handshake',{ path:req.url, ua:req.headers['user-agent'] }); });
  log('info','echo_ws_mounted',{ route: ECHO_ROUTE, mode:'path-scoped' });

  // ---------- Explicit static for worklets (defensive) ----------
  const webDir = path.join(__dirname, 'web');
  app.use('/worklets', express.static(path.join(webDir, 'public', 'worklets'), {
    etag: false, maxAge: 0, fallthrough: true
  }));

  // ---------- Minimal /debug page ----------
  app.get('/debug', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>WS Debug</title>
<style>
body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#0b0b0b;color:#eee;margin:20px}
h1{font-size:20px} .ok{color:#6ee7b7} .bad{color:#fca5a5} code{background:#111;padding:2px 4px;border-radius:4px}
.box{border:1px solid #222;padding:12px;border-radius:10px;margin:10px 0;background:#121212}
small{color:#aaa}
</style></head><body>
<h1>CaseConnect /debug</h1>
<div class="box">
  <div id="host"></div>
  <ol id="log"></ol>
</div>
<script>
(function(){
  const log = (label, ok, extra) => {
    const li = document.createElement('li');
    li.innerHTML = (ok ? '✅ <span class="ok">' : '❌ <span class="bad">') + label + '</span>' + (extra? ' — <small>'+extra+'</small>':'');
    document.querySelector('#log').appendChild(li);
  };
  const host = location.host; const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  document.querySelector('#host').textContent = 'Origin: ' + location.origin;

  // 1) HTTP check
  fetch('/healthz').then(r=>r.ok?log('HTTP /healthz','ok'):log('HTTP /healthz',false,'status '+r.status)).catch(e=>log('HTTP /healthz',false,String(e)));

  // 2) Worklet fetches
  fetch('/worklets/pcm-processor.js').then(r=>log('Fetch /worklets/pcm-processor.js',r.ok,'status '+r.status)).catch(e=>log('Fetch /worklets/pcm-processor.js',false,String(e)));
  fetch('/worklets/pcm-player.js').then(r=>log('Fetch /worklets/pcm-player.js',r.ok,'status '+r.status)).catch(e=>log('Fetch /worklets/pcm-player.js',false,String(e)));

  // 3) AudioWorklet support
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { log('AudioContext available', false, 'no AudioContext'); }
  else { log('AudioContext available', true); }

  // 4) Mic permissions (will prompt)
  navigator.mediaDevices?.getUserMedia({audio:true, video:false})
    .then(()=>log('getUserMedia(audio)',true))
    .catch(e=>log('getUserMedia(audio)',false,String(e && e.name || e)));

  // 5) WS /ws-echo
  try {
    const w1 = new WebSocket(proto+'://'+host+'/ws-echo');
    w1.onopen = ()=>log('WS /ws-echo open',true);
    w1.onmessage = (ev)=>{ if (ev.data==='echo-ready') log('WS /ws-echo message',true,'echo-ready'); };
    w1.onerror = ()=>log('WS /ws-echo error',false);
    w1.onclose = ()=>{};
  } catch(e) { log('WS /ws-echo open',false,String(e)); }

  // 6) WS /ws-ping
  try {
    const w2 = new WebSocket(proto+'://'+host+'/ws-ping');
    let got = false;
    w2.onopen = ()=>log('WS /ws-ping open',true);
    w2.onmessage = (ev)=>{ if (!got && String(ev.data).toLowerCase()==='pong'){ got=true; log('WS /ws-ping pong',true);} };
    w2.onerror = ()=>log('WS /ws-ping error',false);
  } catch(e) { log('WS /ws-ping open',false,String(e)); }

  // 7) WS /web-demo/ws (no Deepgram dependency to open)
  try {
    const w3 = new WebSocket(proto+'://'+host+'/web-demo/ws?voiceId=2');
    w3.onopen = ()=>log('WS /web-demo/ws open',true);
    w3.onmessage = (ev)=>{ try { const p = JSON.parse(ev.data); if (p && p.type==='status') log('WS /web-demo/ws status',true,p.text); } catch{} };
    w3.onerror = ()=>log('WS /web-demo/ws error',false);
  } catch(e) { log('WS /web-demo/ws open',false,String(e)); }

  // 8) Deepgram key present? (server logs already print this at boot)
  fetch('/healthz').then(()=>log('Deepgram key present (see server logs boot_env)', true));
})();
</script>
</body></html>`);
  });

  // ---------- Next.js from ./web ----------
  const requireFromWeb = createRequire(path.join(webDir, 'package.json'));
  const next = requireFromWeb('next');
  const nextApp = next({ dev: false, dir: webDir });
  const nextHandler = nextApp.getRequestHandler();
  await nextApp.prepare();

  // Next handler last
  app.all('*', (req, res) => nextHandler(req, res));

  // ---------- Boot log ----------
  const mask = (v) => (v ? v.slice(0, 4) + '…' + v.slice(-4) : '');
  log('info','boot_env',{
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
    log('info','server_listen',{ url: `http://0.0.0.0:${PORT}` });
  });

  process.on('unhandledRejection', (r) => log('warn','unhandledRejection',{ err: r?.message || r }));
  process.on('uncaughtException', (e) => log('error','uncaughtException',{ err: e?.message || e }));
})();


