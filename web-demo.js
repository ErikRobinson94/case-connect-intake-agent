// web-demo-live.js
require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');

function startDemoServer(opts = {}) {
  const port = Number(opts.port || process.env.DEMO_PORT || 5055);
  const server = http.createServer();

  // Browser connects here: ws://localhost:5055/web-demo/ws
  const wss = new WebSocket.Server({ server, path: '/web-demo/ws' });

  wss.on('connection', (ws) => {
    // let UI know we're live
    try { ws.send(JSON.stringify({ type: 'status', msg: 'demo-ws-connected' })); } catch {}

    // simple echo keeps UI happy; wire DG here later if needed
    ws.on('message', (data) => {
      try { ws.send(data); } catch {}
    });

    // lightweight keepalive (optional)
    const pingIv = setInterval(() => {
      try { ws.ping(); } catch {}
    }, 15000);
    ws.on('close', () => clearInterval(pingIv));
    ws.on('error', () => {});
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(
      `[${new Date().toISOString()}] info demo_server_listen {"url":"ws://0.0.0.0:${port}/web-demo/ws"}`
    );
  });
}

// Support all import styles
module.exports = startDemoServer;
module.exports.startDemoServer = startDemoServer;
module.exports.default = startDemoServer;

// Allow `node web-demo-live.js` directly (optional)
if (require.main === module) {
  startDemoServer();
}