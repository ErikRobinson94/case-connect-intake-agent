// web-demo-live.js
// Browser WS demo: manual upgrade + Deepgram Agent bridge (16k linear16).

const WebSocket = require('ws');
const { URL } = require('url');

function ts() { return new Date().toISOString(); }
function log(level, msg, extra) {
  console.log(`[${ts()}] ${level} ${msg} ${extra ? JSON.stringify(extra) : ''}`);
}

function setupWebDemoLive(server, { route = '/web-demo/ws' } = {}) {
  // Create a WSS we control via server.on('upgrade')
  const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy(); return;
    }
    if (pathname !== route) return; // not ours

    // Accept unconditionally (we’ll re-enable Origin gating later)
    log('debug', 'demo_ws_upgrade', {
      path: req.url,
      origin: req.headers.origin || null,
      allowed: true
    });
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (clientWS, req) => {
    log('info', 'demo_ws_connection_open', {
      ip: req.socket.remoteAddress,
      ua: req.headers['user-agent'] || ''
    });

    const url = new URL(req.url, 'http://localhost');
    const voiceId = parseInt(url.searchParams.get('voiceId') || '2', 10);

    // Env → models/voices
    const sttModel = (process.env.DG_STT_MODEL || 'nova-2').trim();
    const voices = {
      1: process.env.VOICE_1_TTS || process.env.DG_TTS_VOICE || 'aura-2-odysseus-en',
      2: process.env.VOICE_2_TTS || process.env.DG_TTS_VOICE || 'aura-2-thalia-en',
      3: process.env.VOICE_3_TTS || process.env.DG_TTS_VOICE || 'aura-2-orion-en',
    };
    const ttsVoice = (voices[voiceId] || process.env.DG_TTS_VOICE || 'aura-2-thalia-en').trim();
    const llmModel = (process.env.LLM_MODEL || 'gpt-4o-mini').trim();

    const firm = process.env.FIRM_NAME || 'Benji Personal Injury';
    const agentName = process.env.AGENT_NAME || 'Alexis';
    const DEFAULT_PROMPT =
      `You are ${agentName} for ${firm}. First ask: existing client or accident? ` +
      `Ask exactly one question per turn and wait for the reply. Existing: get name, best phone, attorney; ` +
      `then say youll transfer. Accident: get name, phone, email, what happened, when, city/state; ` +
      `confirm, then say youll transfer. Stop if the caller talks.`;
    const promptRaw = (process.env.AGENT_INSTRUCTIONS || DEFAULT_PROMPT).replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ');
    const prompt = promptRaw.length > 380 ? promptRaw.slice(0, 380) : promptRaw;

    const greeting =
      (process.env.AGENT_GREETING ||
       `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`)
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ');

    const dgUrl = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
    const dgKey = process.env.DEEPGRAM_API_KEY;
    if (!dgKey) {
      log('error', 'dg_missing_key');
      clientWS.close(1011, 'Server configuration error'); // internal error
      return;
    }

    const agentWS = new WebSocket(dgUrl, ['token', dgKey]);

    agentWS.on('open', () => {
      log('info', 'dg_agent_open', { url: dgUrl, sttModel, ttsVoice, llmModel });
      const settings = {
        type: 'Settings',
        audio: {
          input:  { encoding: 'linear16', sample_rate: 16000 },
          output: { encoding: 'linear16', sample_rate: 16000, container: 'none' }
        },
        agent: {
          language: 'en',
          greeting,
          listen: { provider: { type: 'deepgram', model: sttModel, smart_format: true } },
          think:  { provider: { type: 'open_ai', model: llmModel, temperature: 0.15 }, prompt },
          speak:  { provider: { type: 'deepgram', model: ttsVoice } }
        }
      };
      try { agentWS.send(JSON.stringify(settings)); } catch (e) {
        log('error', 'dg_send_settings_err', { err: e.message });
      }
    });

    // Deepgram → Browser
    agentWS.on('message', (data) => {
      if (Buffer.isBuffer(data)) {
        // Binary linear16 @ 16k → send to browser (your UI plays it)
        try { clientWS.send(data); } catch (e) {
          log('warn', 'demo_send_binary_err', { err: e.message });
        }
        return;
      }
      // (Optional) Parse JSON events for transcripts / debugging
      try {
        const evt = JSON.parse(data.toString());
        if (evt?.type === 'SettingsApplied') log('info', 'dg_evt_settings_applied');
      } catch {}
    });

    // Browser → Deepgram (binary Int16 @ 16k)
    clientWS.on('message', (chunk) => {
      if (agentWS.readyState === WebSocket.OPEN && Buffer.isBuffer(chunk)) {
        try { agentWS.send(chunk); } catch (e) {
          log('warn', 'dg_send_audio_err', { err: e.message });
        }
      }
    });

    const keepalive = setInterval(() => {
      try {
        if (agentWS.readyState === WebSocket.OPEN) {
          agentWS.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      } catch {}
    }, 25000);

    const cleanup = () => {
      clearInterval(keepalive);
      try { agentWS.close(1000); } catch {}
      try { clientWS.close(1000); } catch {}
    };

    clientWS.on('close', cleanup);
    clientWS.on('error', (e) => log('warn', 'demo_ws_err', { err: e.message }));
    agentWS.on('close', (code, reason) =>
      log('info', 'dg_agent_close', { code, reason: reason?.toString?.() || '' })
    );
    agentWS.on('error', (e) => log('warn', 'dg_agent_err', { err: e.message }));
  });

  // Optional: HTTP GET to WS path returns 426 to reduce confusion in logs
  try {
    // not fatal if index.js doesn’t pass us express `app`
  } catch {}

  log('info', 'demo_ws_ready', { route });
}

module.exports = { setupWebDemoLive };
