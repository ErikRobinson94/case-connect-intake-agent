// index.js
require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const next = require('next');

// Twilio webhook -> TwiML <Connect><Stream>
const { handleTwilioCall } = require('./lib/twilioHandler');
// Twilio <-> Deepgram agent bridge (WS), path-scoped to /audio-stream
const { setupBidiBridge } = require('./lib/twilio-deepgram-agent-bridge');
// Browser demo WS (microphone <-> Deepgram agent), path-scoped to /web-demo/ws
const { setupWebDemoLive } = require('./web-demo-live');

const PORT = parseInt(process.env.PORT || '10000', 10);
const AUDIO_STREAM_ROUTE = process.env.AUDIO_STREAM_ROUTE || '/audio-stream';
const DEMO_WS_ROUTE = '/web-demo/ws';

// --- Next.js app (serves ./web/.next in production) ---
const nextApp = next({ dev: false, dir: path.join(__dirname, 'web') });
const handle = nextApp.getRequestHandler();

async function main() {
  await nextApp.prepare();

  const app = express();

  // Basic middleware
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

  // Twilio webhook -> returns TwiML to open the media stream to our WS
  app.post('/twilio/voice', handleTwilioCall);

  // Let Next.js handle everything else (pages, assets)
  app.all('*', (req, res) => handle(req, res));

  // One HTTP server for everything
  const server = http.createServer(app);

  // Mount WS: Twilio media bridge (path-scoped so it won't collide)
  setupBidiBridge(server, { route: AUDIO_STREAM_ROUTE });

  // Mount WS: Browser demo (same HTTP server, different path)
  setupWebDemoLive(server, { route: DEMO_WS_ROUTE });
  console.log(
    `[${new Date().toISOString()}] info demo_ws_mounted ${JSON.stringify({
      route: DEMO_WS_ROUTE,
    })}`
  );

  // Optional: tiny upgrade logger (helps if anything else swallows upgrades)
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

  // Safety
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
