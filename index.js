// index.js
require('dotenv').config();

const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');

const { handleTwilioCall } = require('./lib/twilioHandler');

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
app.get('/', (_req, res) => res.status(200).send('OK'));
app.post('/twilio/voice', handleTwilioCall);

/* ---------- Server 1: Express + Twilio <-> Deepgram WS bridge ---------- */
const server = http.createServer(app);

// Mount the bidirectional audio WebSocket route (defaults to /audio-stream)
if (typeof setupAudioStream === 'function') {
  setupAudioStream(server);
} else {
  console.error(
    '[error] setupAudioStream is not a function. Check lib/audio-stream.js export: module.exports = { setupAudioStream }'
  );
}

const PORT = parseInt(process.env.PORT || '5002', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[${new Date().toISOString()}] info server_listen {"url":"http://0.0.0.0:${PORT}"}`
  );
});

/* ---------- Server 2: Browser demo WS (/web-demo/ws) ---------- */
(function startDemo() {
  const DEMO_PORT = parseInt(process.env.DEMO_PORT || '5055', 10);

  // 1) Try to require user module
  let demoModule;
  try {
    demoModule = require('./web-demo-live');
  } catch (err) {
    console.warn(`[warn] require("./web-demo-live") failed: ${err?.message || err}`);
  }

  // 2) Resolve a callable export if present
  const startFromModule =
    (typeof demoModule === 'function' && demoModule) ||
    (demoModule && typeof demoModule.startDemoServer === 'function' && demoModule.startDemoServer) ||
    (demoModule && typeof demoModule.default === 'function' && demoModule.default) ||
    null;

  // Helpful trace so we can see exactly what was loaded
  console.log('[info] web-demo-live export trace', {
    typeofModule: typeof demoModule,
    keys: demoModule ? Object.keys(demoModule) : [],
    picked: startFromModule ? 'callable' : 'none'
  });

  if (typeof startFromModule === 'function') {
    try {
      startFromModule({ port: DEMO_PORT });
      return; // module started the server; it should log its own listen line
    } catch (err) {
      console.warn(`[warn] web-demo-live threw on start: ${err?.message || err}`);
    }
  }

  // 3) Fallback: start a minimal demo WS here so the UI always works
  const WebSocket = require('ws');
  const demoHttp = http.createServer();
  const wss = new WebSocket.Server({ server: demoHttp, path: '/web-demo/ws' });

  wss.on('connection', (ws) => {
    // let the UI know we are live
    try { ws.send(JSON.stringify({ type: 'status', msg: 'demo-ws-connected' })); } catch {}

    // simple echo keeps the UI happy; wire your DG pipeline here if you want
    ws.on('message', (data) => {
      try { ws.send(data); } catch {}
    });

    // keep-alive (optional)
    const iv = setInterval(() => { try { ws.ping(); } catch {} }, 15000);
    ws.on('close', () => clearInterval(iv));
    ws.on('error', () => {});
  });

  demoHttp.listen(DEMO_PORT, '0.0.0.0', () => {
    console.log(
      `[${new Date().toISOString()}] info demo_server_listen {"url":"ws://0.0.0.0:${DEMO_PORT}/web-demo/ws"}`
    );
  });
})();

/* ---------- harden process ---------- */
process.on('unhandledRejection', (r) =>
  console.warn('[warn] unhandledRejection', r?.message || r)
);
process.on('uncaughtException', (e) =>
  console.error('[error] uncaughtException', e?.message || e)
);
