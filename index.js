// index.js
require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');

// Twilio webhook + WS audio bridge
const { handleTwilioCall } = require('./lib/twilioHandler');
const { setupAudioStream } = require('./lib/audio-stream');

// Web demo WS (browser mic <-> Deepgram Agent)
const { setupWebDemoLive } = require('./web-demo-live');

// --- Resolve Next *from the /web app* without installing it at the repo root
const next = require(path.join(__dirname, 'web', 'node_modules', 'next'));

(async () => {
  const PORT = parseInt(process.env.PORT || '10000', 10);

  // ----------------- Next app (serves your /web UI) -----------------
  const nextApp = next({
    dir: path.join(__dirname, 'web'), // Next project lives in ./web
    dev: false,
  });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();

  // ----------------- Express app (REST + Twilio) -----------------
  const app = express();

  // middleware
  app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
  app.use(bodyParser.urlencoded({ extended: false })); // Twilio posts urlencoded
  app.use(bodyParser.json());

  // health
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  // Twilio webhook
  app.post('/twilio/voice', handleTwilioCall);

  // Serve the AudioWorklets for the browser demo
  app.use(
    '/worklets',
    express.static(path.join(__dirname, 'web', 'public', 'worklets'), {
      maxAge: '1h',
      immutable: true,
    })
  );

  // All remaining routes → Next (serves your UI from /web)
  app.all('*', (req, res) => handle(req, res));

  // ----------------- Single shared HTTP server -----------------
  const server = http.createServer(app);

  // Attach the WS bridges by path (no manual server.on('upgrade')!)
  // 1) Twilio <Connect><Stream> ↔ Deepgram
  setupAudioStream(server); // uses process.env.AUDIO_STREAM_ROUTE (defaults /audio-stream)

  // 2) Browser demo mic ↔ Deepgram Agent
  setupWebDemoLive(server, { route: '/web-demo/ws' });
  console.log(
    `[${new Date().toISOString()}] info demo_ws_mounted ${JSON.stringify({
      route: '/web-demo/ws',
    })}`
  );

  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[${new Date().toISOString()}] info server_listen ${JSON.stringify({
        url: `http://0.0.0.0:${PORT}`,
      })}`
    );
  });

  // harden process
  process.on('unhandledRejection', (r) =>
    console.warn('[warn] unhandledRejection', r?.message || r)
  );
  process.on('uncaughtException', (e) =>
    console.error('[error] uncaughtException', e?.message || e)
  );
})();
