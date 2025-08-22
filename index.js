// index.js
require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');

// --- require Next with a fallback to web/node_modules ---
let next;
try {
  // will work locally if you also have next at the root
  next = require('next');
} catch {
  // render.com case: next is installed only in /web
  next = require(path.join(__dirname, 'web', 'node_modules', 'next'));
}

// Twilio webhook -> TwiML <Connect><Stream>
const { handleTwilioCall } = require('./lib/twilioHandler');
// Twilio <-> Deepgram agent bridge (WS), path-scoped to /audio-stream
const { setupBidiBridge } = require('./lib/twilio-deepgram-agent-bridge');
// Browser demo WS (mic <-> Deepgram agent), path-scoped to /web-demo/ws
const { setupWebDemoLive } = require('./web-demo-live');

const PORT = parseInt(process.env.PORT || '10000', 10);
const AUDIO_STREAM_ROUTE = process.env.AUDIO_STREAM_ROUTE || '/audio-stream';
const DEMO_WS_ROUTE = '/web-demo/ws';

// Next.js app (serves ./web/.next in production)
const nextApp = next({ dev: false, dir: path.join(__dirname, 'web') });
const handle = nextApp.getRequestHandler();

async function main() {
  await nextApp.prepare();

  const app = express();

  // Middleware
  app.use(morgan(process.env.LOG_FORMAT || 'tiny'));
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());

  // Static worklets for the browser demo
  app.use(
    '/worklets',
    express.static(path.join(__dirname, 'public', 'worklets'), {
      immutable: true,
      maxAge: '1y',
    })
  );

  // Health
  app.get('/healthz', (_req, res) => res.status(200).send('OK'));

  // Twilio webhook -> returns TwiML to open media stream to our WS
  app.post('/twilio/voice', handleTwilioCall);

  // Everything else served by Next
  app.all('*', (req, res) => handle(req, res));

  // One HTTP server for everything
  const server = http.createServer(app);

  // WS: Twilio media bridge
  setupBidiBridge(server, { route: AUDIO_STREAM_ROUTE });

  // WS: Browser demo
  setupWebDemoLive(server, { route: DEMO_WS_ROUTE });
  console.log(
    `[${new Date().toISOString()}] info demo_ws_mounted ${JSON.stringify({
      route: DEMO_WS_ROUTE,
    })}`
  );

  // Optional upgrade logger
  server.on('upgrade', (req) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      console.log(
        `[${new Date().toISOString()}] debug http_upgrade ${JSON.stringify({
          path: u.pathname,
        })}`
      );
    } catch {}
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[${new Date().toISOString()}] info server_listen ${JSON.stringify({
        url: `http://0.0.0.0:${PORT}`,
      })}`
    );
  });

  process.on('unhandledRejection', (r) =>
    console.warn('[warn] unhandledRejection', r?.message || r)
  );
  process.on('uncaughtException', (e) =>
    console.error('[error] uncaughtException', e?.message || e)
  );
}

main().catch((e) => {
  console.error('[fatal] boot_failed', e?.stack || e?.message || e);
  process.exit(1);
});
