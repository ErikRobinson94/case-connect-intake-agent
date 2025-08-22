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
app.set('trust proxy', 1); // Render/Proxies
app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
app.use(bodyParser.urlencoded({ extended: false })); // Twilio posts urlencoded
app.use(bodyParser.json());

/* ---------- routes ---------- */
app.get('/', (_req, res) => res.status(200).send('OK'));
app.post('/twilio/voice', handleTwilioCall);

/* ---------- Single HTTP server (Render binds one PORT) ---------- */
const server = http.createServer(app);

// Mount the bidirectional audio WebSocket route (defaults to /audio-stream)
if (typeof setupAudioStream === 'function') {
  setupAudioStream(server);
} else {
  console.error(
    '[error] setupAudioStream is not a function. Check lib/audio-stream.js export: module.exports = { setupAudioStream }'
  );
}

/* ---------- ALSO mount the browser demo WS on the SAME server ---------- */
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

const PORT = parseInt(process.env.PORT || '5002', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[${new Date().toISOString()}] info server_listen {"url":"http://0.0.0.0:${PORT}"}`
  );
});

/* ---------- harden process ---------- */
process.on('unhandledRejection', (r) =>
  console.warn('[warn] unhandledRejection', r?.message || r)
);
process.on('uncaughtException', (e) =>
  console.error('[error] uncaughtException', e?.message || e)
);
