require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');

// Twilio webhook
const { handleTwilioCall } = require('./lib/twilioHandler');

// Twilio <-> Deepgram bridge (mounts its own WS on /audio-stream)
let setupAudioStream;
try {
  ({ setupAudioStream } = require('./lib/audio-stream'));
} catch (e) {
  console.error('[error] Failed to load lib/audio-stream.js:', e?.message || e);
}

// Next.js app (lives in ./web)
const next = require('next');
const dev = false;
const webDir = path.join(__dirname, 'web');
const nextApp = next({ dev, dir: webDir });
const handle = nextApp.getRequestHandler();

// Single Express app for everything (Next pages + API)
const app = express();
app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health
app.get('/', (_req, res) => res.status(200).send('OK'));
// Twilio webhook
app.post('/twilio/voice', handleTwilioCall);

// Let Next handle everything else (public assets, /app routes, etc.)
app.all('*', (req, res) => handle(req, res));

async function start() {
  await nextApp.prepare();

  // One HTTP server for both HTTP and WebSockets
  const server = http.createServer(app);

  // Mount Twilio media stream WS (/audio-stream) via your bridge
  if (typeof setupAudioStream === 'function') {
    setupAudioStream(server);
  } else {
    console.error(
      '[error] setupAudioStream is not a function. Check lib/audio-stream.js export: module.exports = { setupAudioStream }'
    );
  }

  // ---- Browser demo WS on /web-demo/ws (noServer, manual upgrade) ----
  const { createWebDemoWSS } = require('./web-demo-live');
  const demoWSS = createWebDemoWSS();
  const DEMO_ROUTE = process.env.RENDER_WS_PATH || '/web-demo/ws';

  console.log(
    `[${new Date().toISOString()}] info demo_ws_mounted ${JSON.stringify({ route: DEMO_ROUTE })}`
  );

  server.on('upgrade', (req, socket, head) => {
    // Only intercept the browser demo path; ignore everything else.
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch { /* ignore */ }

    if (pathname === DEMO_ROUTE) {
      demoWSS.handleUpgrade(req, socket, head, (ws) => {
        demoWSS.emit('connection', ws, req);
      });
      return;
    }

    // Do NOT touch other upgrade events; Twilio bridge handles /audio-stream itself.
  });

  // Port Render gives your service via env; default to 10000 for local-ish
  const PORT = parseInt(process.env.PORT || '10000', 10);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[${new Date().toISOString()}] info server_listen ${JSON.stringify({ url: `http://0.0.0.0:${PORT}` })}`
    );
  });

  // harden process
  process.on('unhandledRejection', (r) =>
    console.warn('[warn] unhandledRejection', r?.message || r)
  );
  process.on('uncaughtException', (e) =>
    console.error('[error] uncaughtException', e?.message || e)
  );
}

start().catch((e) => {
  console.error('[fatal] boot_failed', e?.message || e);
  process.exit(1);
});

