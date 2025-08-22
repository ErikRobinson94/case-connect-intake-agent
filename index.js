// index.js
// Single Render service: Next (from ./web) + WS bridges (Twilio+Demo) + optional WS ping.

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { createRequire } = require('module');
const { WebSocketServer } = require('ws');

const { handleTwilioCall } = require('./lib/twilioHandler');

// Optional: audio stream bridge (Twilio <-> Deepgram Agent)
let setupAudioStream;
try {
  ({ setupAudioStream } = require('./lib/audio-stream'));
} catch (e) {
  console.error('[error] Failed to load lib/audio-stream.js:', e?.message || e);
}

// Optional: WS ping probe (sanity check for infra)
let setupPing;
try {
  ({ setupPing } = require('./ws-ping'));
} catch (e) {
  console.warn('[warn] ws-ping not found; create ws-ping.js if you want a probe route.');
}

// Optional: browser demo WS handlers
let attachWebDemoHandlers = null;
let setupWebDemoLive = null;
try {
  const demo = require('./web-demo-live');
  if (demo) {
    if (typeof demo.attachWebDemoHandlers === 'function') attachWebDemoHandlers = demo.attachWebDemoHandlers;
    if (typeof demo.setupWebDemoLive === 'function') setupWebDemoLive = demo.setupWebDemoLive;
  }
} catch (e) {
  console.warn('[warn] require("./web-demo-live") failed:', e?.message || e);
}

(async () => {
  const app = express();

  // ---------- Basic middleware ----------
  app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
  app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends urlencoded
  app.use(bodyParser.json());

  // Health endpoint for Render
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  // Twilio Voice webhook → returns TwiML that opens the /audio-stream WebSocket
  app.post('/twilio/voice', handleTwilioCall);

  // HTTP server (shared with WS servers and Next)
  const server = http.createServer(app);

  // ----- Visibility log for any WS upgrades -----
  server.on('upgrade', (req, _socket, _head) => {
    console.log(
      `[${new Date().toISOString()}] debug http_upgrade ` +
      JSON.stringify({ path: req.url })
    );
  });

  // ----- Mount WS: Twilio <-> Deepgram (exact path; no clashes) -----
  if (typeof setupAudioStream === 'function') {
    setupAudioStream(server); // uses process.env.AUDIO_STREAM_ROUTE (default /audio-stream)
    console.log(
      `[${new Date().toISOString()}] info audio_ws_mounted ` +
      JSON.stringify({ route: process.env.AUDIO_STREAM_ROUTE || '/audio-stream' })
    );
  } else {
    console.error(
      '[error] setupAudioStream is not a function. Check lib/audio-stream.js export: module.exports = { setupAudioStream }'
    );
  }

  // ----- Mount WS: Ping probe (helps isolate infra vs app issues) -----
  if (typeof setupPing === 'function') {
    setupPing(server, '/ws-ping');
  }

  // ----- Browser demo WS: manual upgrade routing to avoid path clashes -----
  const DEMO_ROUTE = '/web-demo/ws';

  // Prefer the newer helper that attaches handlers to an existing WSS.
  // Fallback to legacy setup if not present.
  let demoWSS = null;
  if (attachWebDemoHandlers) {
    demoWSS = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    attachWebDemoHandlers(demoWSS);

    server.on('upgrade', (req, socket, head) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        if (u.pathname === DEMO_ROUTE) {
          return demoWSS.handleUpgrade(req, socket, head, (ws) => {
            demoWSS.emit('connection', ws, req);
          });
        }
      } catch {}
      // Do nothing for other paths; their own WS servers will handle them.
    });

    console.log(
      `[${new Date().toISOString()}] info demo_ws_mounted ` +
      JSON.stringify({ route: DEMO_ROUTE, mode: 'manual-upgrade' })
    );
  } else if (setupWebDemoLive) {
    // Legacy path-scoped mount (kept as a fallback)
    setupWebDemoLive(server, { route: DEMO_ROUTE });
    console.log(
      `[${new Date().toISOString()}] info demo_ws_mounted ` +
      JSON.stringify({ route: DEMO_ROUTE, mode: 'path-scoped' })
    );
  } else {
    console.warn('[warn] web-demo-live export not callable; browser demo WS not mounted.');
  }

  // ----- Next.js: load from ./web (no root "next" needed) -----
  const webDir = path.join(__dirname, 'web');
  const requireFromWeb = createRequire(path.join(webDir, 'package.json'));
  const next = requireFromWeb('next');

  const nextApp = next({ dev: false, dir: webDir });
  const nextHandler = nextApp.getRequestHandler();

  await nextApp.prepare();

  // Let Next handle everything else (no hard-coded "/" route here)
  app.all('*', (req, res) => nextHandler(req, res));

  // ---------- Boot visibility: summarize important env (mask secrets) ----------
  const mask = (v) => (v ? v.slice(0, 4) + '…' + v.slice(-4) : '');
  console.log(
    `[${new Date().toISOString()}] info boot_env ` +
      JSON.stringify({
        PORT: process.env.PORT || 10000,
        AUDIO_STREAM_ROUTE: process.env.AUDIO_STREAM_ROUTE || '/audio-stream',
        PUBLIC_WSS_HOST: process.env.PUBLIC_WSS_HOST || null,
        DG_AGENT_URL: process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse',
        DG_STT_MODEL: process.env.DG_STT_MODEL || 'nova-2',
        DG_TTS_VOICE: process.env.DG_TTS_VOICE || 'aura-2-thalia-en',
        LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
        LOG_LEVEL: process.env.LOG_LEVEL || 'info',
        DEEPGRAM_API_KEY_present: !!process.env.DEEPGRAM_API_KEY,
        OPENAI_API_KEY_present: !!process.env.OPENAI_API_KEY,
        keys_preview: {
          DEEPGRAM: mask(process.env.DEEPGRAM_API_KEY || ''),
          OPENAI: mask(process.env.OPENAI_API_KEY || ''),
        },
      })
  );

  const PORT = parseInt(process.env.PORT, 10) || 10000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[${new Date().toISOString()}] info server_listen ` +
      JSON.stringify({ url: `http://0.0.0.0:${PORT}` })
    );
  });

  // Harden process
  process.on('unhandledRejection', (r) =>
    console.warn('[warn] unhandledRejection', r?.message || r)
  );
  process.on('uncaughtException', (e) =>
    console.error('[error] uncaughtException', e?.message || e)
  );
})();
