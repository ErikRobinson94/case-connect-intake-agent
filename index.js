require('dotenv').config();

const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const next = require('next');

const { handleTwilioCall } = require('./lib/twilioHandler');

let setupAudioStream;
try {
  ({ setupAudioStream } = require('./lib/audio-stream'));
} catch (e) {
  console.error('[error] Failed to load lib/audio-stream.js:', e?.message || e);
}

const app = express();
app.set('trust proxy', 1);

/* ---------- middleware ---------- */
app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
app.use(bodyParser.urlencoded({ extended: false })); // Twilio posts urlencoded
app.use(bodyParser.json());

/* ---------- Twilio webhook ---------- */
app.post('/twilio/voice', handleTwilioCall);

/* ---------- Create one HTTP server ---------- */
const server = http.createServer(app);

/* ---------- WebSockets on the SAME server ---------- */
// 1) Twilio <-> Deepgram bidirectional audio stream (defaults to /audio-stream)
if (typeof setupAudioStream === 'function') {
  setupAudioStream(server);
} else {
  console.error(
    '[error] setupAudioStream is not a function. Check lib/audio-stream.js export: module.exports = { setupAudioStream }'
  );
}

// 2) Browser demo WS at /web-demo/ws
try {
  const { setupWebDemoLive } = require('./web-demo-live');
  if (typeof setupWebDemoLive === 'function') {
    const demoRoute = '/web-demo/ws';
    setupWebDemoLive(server, { route: demoRoute });
    console.log(
      `[${new Date().toISOString()}] info demo_ws_mounted {"route":"${demoRoute}"}`
    );
  } else {
    console.warn('[warn] web-demo-live did not export setupWebDemoLive(server, {route})');
  }
} catch (err) {
  console.warn(`[warn] require("./web-demo-live") failed: ${err?.message || err}`);
}

/* ---------- Next.js app served by the same process ---------- */
const nextApp = next({ dev: false, dir: './web' }); // uses /web/.next built at deploy time
const handle = nextApp.getRequestHandler();

(async () => {
  try {
    await nextApp.prepare();

    // Health endpoint (so root "/" can be handled by Next)
    app.get('/healthz', (_req, res) => res.status(200).send('OK'));

    // Let Next handle everything else (pages, assets, /worklets, etc.)
    app.all('*', (req, res) => handle(req, res));

    const PORT = parseInt(process.env.PORT || '5002', 10);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(
        `[${new Date().toISOString()}] info server_listen {"url":"http://0.0.0.0:${PORT}"}`
      );
    });
  } catch (err) {
    console.error('[error] next_prepare_failed', err?.message || err);
    process.exit(1);
  }
})();

/* ---------- harden process ---------- */
process.on('unhandledRejection', (r) =>
  console.warn('[warn] unhandledRejection', r?.message || r)
);
process.on('uncaughtException', (e) =>
  console.error('[error] uncaughtException', e?.message || e)
);
