// web-demo-live.js
// Browser demo WS <-> Deepgram Agent bridge (16k PCM), with explicit origin allowlist and verbose logs.

const WebSocket = require('ws');
const { URL } = require('url');
const crypto = require('crypto');

const lv = { error:0, warn:1, info:2, debug:3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const log = (level, msg, extra) => {
  if ((lv[level] ?? 2) <= (lv[LOG_LEVEL] ?? 2)) {
    console.log(`[${new Date().toISOString()}] ${level} ${msg} ${extra ? JSON.stringify(extra) : ''}`);
  }
};

// Helpers
const sanitize = (s) => (s || '').replace(/[\u0000-\u001F\u007F-\uFFFF]/g, ' ').replace(/\s+/g, ' ').trim();
const compact = (s, max = 380) => (s && s.length > max ? s.slice(0, max) : s);

// Env
const DG_URL = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
const STT = (process.env.DG_STT_MODEL || 'nova-2').trim();
const DEFAULT_TTS = (process.env.DG_TTS_VOICE || 'aura-2-thalia-en').trim();
const LLM = (process.env.LLM_MODEL || 'gpt-4o-mini').trim();
const FIRM = process.env.FIRM_NAME || 'Benji Personal Injury';
const AGENT_NAME = process.env.AGENT_NAME || 'Alexis';
const GREETING = sanitize(process.env.AGENT_GREETING || `Thank you for calling ${FIRM}. Were you in an accident, or are you an existing client?`);
const RAW_PROMPT = sanitize(process.env.AGENT_INSTRUCTIONS || `You are ${AGENT_NAME} for ${FIRM}. First ask: existing client or accident? Ask one question per turn and wait. Existing: name, best phone, attorney; then say you'll transfer. Accident: name, phone, email, what happened, when, city/state; confirm then say you'll transfer. Stop when caller talks.`);
const PROMPT = compact(RAW_PROMPT, 380);

// Voice map by query param (?voiceId=1|2|3)
const VOICE_MAP = {
  '1': process.env.VOICE_1_TTS || DEFAULT_TTS,
  '2': process.env.VOICE_2_TTS || DEFAULT_TTS,
  '3': process.env.VOICE_3_TTS || DEFAULT_TTS,
};

// Allowlist origins
function isOriginAllowed(origin) {
  const list = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return true; // allow all if not set
  return list.includes(origin);
}

function setupWebDemoLive(server, { route = '/web-demo/ws' } = {}) {
  const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      const u = new URL(req.url, 'http://x');
      pathname = u.pathname;
    } catch { /* ignore */ }

    if (pathname !== route) return; // Not our WS path

    const origin = req.headers.origin || '';
    const allowed = isOriginAllowed(origin);

    log('debug', 'demo_ws_upgrade', { path: req.url, origin, allowed });
    if (!allowed) {
      try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
      try { socket.destroy(); } catch {}
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (client, req) => {
    // Parse query
    let q = {};
    try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch {}
    const voiceId = String(q.voiceId || '2');
    const ttsVoice = (VOICE_MAP[voiceId] || DEFAULT_TTS).trim();

    log('info', 'demo_ws_connected', { from_origin: req.headers.origin || '', ttsVoice });

    // Connect to Deepgram Agent (16k PCM for browser)
    const agentWS = new WebSocket(DG_URL, ['token', process.env.DEEPGRAM_API_KEY]);

    let settingsSent = false;
    let settingsApplied = false;
    const preRoll = [];

    const ka = setInterval(() => {
      if (agentWS.readyState === WebSocket.OPEN) {
        try { agentWS.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }
    }, 25000);

    agentWS.on('open', () => {
      log('info', 'demo_dg_open', { url: DG_URL, STT, ttsVoice, LLM, prompt_len: PROMPT.length });
      const settings = {
        type: 'Settings',
        audio: {
          input:  { encoding: 'linear16', sample_rate: 16000 },
          output: { encoding: 'linear16', sample_rate: 16000, container: 'none' }
        },
        agent: {
          language: 'en',
          greeting: GREETING,
          listen: { provider: { type: 'deepgram', model: STT, smart_format: true } },
          think:  { provider: { type: 'open_ai', model: LLM, temperature: 0.15 }, prompt: PROMPT },
          speak:  { provider: { type: 'deepgram', model: ttsVoice } }
        }
      };
      try { agentWS.send(JSON.stringify(settings)); settingsSent = true; }
      catch (e) { log('error', 'demo_dg_send_settings_err', { err: e.message }); }
    });

    agentWS.on('message', (data) => {
      // If JSON → turn into UI payload; If binary → forward to browser (TTS 16k PCM16)
      if (typeof data === 'string' || (Buffer.isBuffer(data) && data[0] === 0x7B /* '{' */)) {
        let evt = null;
        try { evt = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString('utf8')); } catch {}
        if (!evt) return;

        switch (evt.type) {
          case 'Welcome':
            log('debug', 'demo_evt_welcome'); break;

          case 'SettingsApplied':
            settingsApplied = true;
            log('info', 'demo_evt_settings_applied');
            // Tell UI what’s active
            try {
              client.send(JSON.stringify({
                type: 'settings',
                sttModel: STT, ttsVoice, llmModel: LLM, temperature: 0.15,
                greeting: GREETING, prompt_len: PROMPT.length
              }));
            } catch {}
            // flush any preroll audio
            if (preRoll.length) {
              try { for (const c of preRoll) agentWS.send(c); } catch {}
              preRoll.length = 0;
            }
            break;

          case 'Transcript':
          case 'ConversationText':
          case 'History':
          case 'UserTranscript':
          case 'UserResponse': {
            const role = (evt.role || evt.speaker || '').toLowerCase();
            const text =
              (evt.content && String(evt.content)) ||
              (evt.text && String(evt.text)) ||
              (evt.transcript && String(evt.transcript)) ||
              '';
            const partial = !!evt.partial;
            if (text.trim()) {
              try {
                client.send(JSON.stringify({
                  type: 'transcript',
                  role: role === 'user' ? 'User' : 'Agent',
                  text, partial
                }));
              } catch {}
            }
            break;
          }

          case 'AgentWarning':
            log('warn', 'demo_evt_warning', evt); break;
          case 'AgentError':
          case 'Error':
            log('error', 'demo_evt_error', evt); break;
          default:
            log('debug', 'demo_evt_other', evt);
        }
        return;
      }

      // Binary from Agent → forward to browser (Int16 PCM @16k)
      try { client.send(data); } catch (e) {
        log('warn', 'demo_client_send_audio_err', { err: e.message });
      }
    });

    agentWS.on('close', (code, reason) => {
      clearInterval(ka);
      log('info', 'demo_dg_close', { code, reason: reason?.toString?.() || '' });
      try { client.close(1000); } catch {}
    });

    agentWS.on('error', (e) => log('warn', 'demo_dg_err', { err: e?.message || String(e) }));

    // Browser → Agent audio (binary Int16 @16k)
    client.on('message', (data) => {
      // We only expect binary from the browser mic worklet
      if (agentWS.readyState !== WebSocket.OPEN) return;
      if (settingsSent && settingsApplied) {
        try { agentWS.send(data); } catch (e) { log('warn', 'demo_dg_send_audio_err', { err: e.message }); }
      } else if (settingsSent) {
        preRoll.push(data);
        if (preRoll.length > 24) preRoll.shift();
      }
    });

    client.on('close', () => {
      try { agentWS.close(1000); } catch {}
      log('info', 'demo_client_close');
    });

    client.on('error', (e) => log('warn', 'demo_client_err', { err: e?.message || String(e) }));
  });

  log('info', 'demo_ws_ready', { route });
}

module.exports = { setupWebDemoLive };
