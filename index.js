// index.js (drop-in)
// Single Render service: Next (from ./web) + WS bridges.

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { createRequire } = require('module');

const { handleTwilioCall } = require('./lib/twilioHandler');
let setupAudioStream;
try {
  ({ setupAudioStream } = require('./lib/audio-stream'));
} catch (e) {
  console.error('[error] Failed to load lib/audio-stream.js:', e?.message || e);
}

(async () => {
  const app = express();

  // Basic middleware
  app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
  app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends urlencoded
  app.use(bodyParser.json());

  // Health endpoint for Render
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  // Twilio Voice webhook → TwiML that opens the /audio-stream WebSocket
  app.post('/twilio/voice', handleTwilioCall);

  // HTTP server (shared with both WS servers and Next)
  const server = http.createServer(app);

  // ----- Mount WS: Twilio <-> Deepgram (exact path; no clashes) -----
  if (typeof setupAudioStream === 'function') {
    setupAudioStream(server); // uses process.env.AUDIO_STREAM_ROUTE (default /audio-stream)
  } else {
    console.error(
      '[error] setupAudioStream is not a function. Check lib/audio-stream.js export: module.exports = { setupAudioStream }'
    );
  }

  // ----- Mount WS: Browser demo (exact path; no clashes) -----
  try {
    const demo = require('./web-demo-live');
    const fn =
      (demo && typeof demo.setupWebDemoLive === 'function' && demo.setupWebDemoLive) ||
      (typeof demo === 'function' && demo) ||
      (demo && typeof demo.default === 'function' && demo.default) ||
      null;

    if (fn) {
      fn(server, { route: '/web-demo/ws' }); // path-scoped
      console.log(`[${new Date().toISOString()}] info demo_ws_mounted {"route":"/web-demo/ws"}`);
    } else {
      console.warn('[warn] web-demo-live export not callable; browser demo WS not mounted.');
    }
  } catch (err) {
    console.warn(`[warn] require("./web-demo-live") failed: ${err?.message || err}`);
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

  const PORT = parseInt(process.env.PORT, 10) || 10000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[${new Date().toISOString()}] info server_listen {"url":"http://0.0.0.0:${PORT}"}`
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
