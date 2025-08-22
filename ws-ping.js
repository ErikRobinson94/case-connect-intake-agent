// ws-ping.js
const { WebSocketServer } = require('ws');

function setupPing(server, route = '/ws-ping') {
  const wss = new WebSocketServer({ server, path: route, perMessageDeflate: false });
  console.log(`[${new Date().toISOString()}] info ping_ws_mounted {"route":"${route}"}`);

  wss.on('connection', (ws, req) => {
    console.log(`[${new Date().toISOString()}] info ping_conn {"url":"${req.url}","ip":"${req.socket?.remoteAddress}"}`);
    ws.send('hello');
    ws.on('message', (msg) => {
      console.log(`[${new Date().toISOString()}] info ping_rx {"len":${Buffer.byteLength(msg)}}`);
      ws.send(`echo:${msg}`);
    });
    ws.on('close', (code, reason) => {
      console.log(`[${new Date().toISOString()}] info ping_close {"code":${code},"reason":"${reason}"}`);
    });
    ws.on('error', (err) => console.error('[error] ping_ws', err?.message || err));
  });
}

module.exports = { setupPing };
