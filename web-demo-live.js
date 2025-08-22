// web-demo-live.js
// Browser demo WS <-> Deepgram Agent bridge (16k PCM), path-scoped WSS (no manual upgrade).

const WebSocket = require('ws');

const lv = { error:0, warn:1, info:2, debug:3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const log = (level, msg, extra) => {
  if ((lv[level] ?? 2) <= (lv[LOG_LEVEL] ?? 2)) {
    console.log(`[${new Date().toISOString()}] ${level} ${msg} ${extra ? JSON.stringify(extra) : ''}`);
  }
};

const sanitize = (s) => (s || '').replace(/[\u0000-\u001F\u007F-\uFFFF]/g, ' ').replace(/\s+/g, ' ').trim();
const compact = (s, max = 380) => (s && s.length > max ? s.slice(0, max) : s);

const DG_URL  = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
const STT     = (process.env.DG_STT_MODEL   || 'nova-2').trim();
const LLM     = (process.env.LLM_MODEL      || 'gpt-4o-mini').trim();
const DEFAULT_TTS = (process.env.DG_TTS_VOICE || 'aura-2-thalia-en').trim();

const FIRM       = process.env.FIRM_NAME  || 'Benji Personal Injury';
const AGENT_NAME = process.env.AGENT_NAME || 'Alexis';
const GREETING   = sanitize(process.env.AGENT_GREETING || `Thank you for calling ${FIRM}. Were you in an accident, or are you an existing client?`);
const RAW_PROMPT = sanitize(process.env.AGENT_INSTRUCTIONS || `You are ${AGENT_NAME} for ${FIRM}. First ask: existing client or accident? Ask one question per turn and wait. Existing: name, best phone, attorney; then say you'll transfer. Accident: name, phone, email, what happened, when, city/state; confirm then say you'll transfer. Stop when caller talks.`);
const PROMPT     = compact(RAW_PROMPT, 380);

const VOICE_MAP = {
  '1': process.env.VOICE_1_TTS || DEFAULT_TTS,
  '2': process.env.VOICE_2_TTS || DEFAULT_TTS,
  '3': process.env.VOICE_3_TTS || DEFAULT_TTS,
};

function isOriginAllowed(origin) {
  const list = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return true; // allow all if unset
  return list.includes(origin);
}

function setupWebDemoLive(server, { route = '/web-demo/ws' } = {}) {
  // IMPORTANT: path-scoped WSS, no manual server.on('upgrade')
  const wss = new WebSocket.Server({ server, path: route, perMessageDeflate: false });
  log('info', 'demo_ws_ready', { route });

  wss.on('connection', (client, req) => {
    const origin = req.headers.origin || '';
    if (!isOriginAllowed(origin)) {
      log('warn', 'demo_ws_bad_origin', { origin });
      try { client.close(1008, 'bad origin'); } catch {}
      return;
    }

    // Choose voice by query parameter (?voiceId=1|2|3)
    let voiceId = '2';
    try { voiceId = new URL(req.url, 'http://x').searchParams.get('voiceId') || '2'; } catch {}
    const ttsVoice = (VOICE_MAP[voiceId] || DEFAULT_TTS).trim();

    log('info', 'demo_ws_connected', { origin, ttsVoice });

    const agentWS = new WebSocket(DG_URL, ['token', process.env.DEEPGRAM_API_KEY]);
    let settingsSent = false;
    let settingsApplied = false;
    const preRoll = [];

    const keepalive = setInterval(() => {
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
      // JSON → forward transcripts/settings to UI
      // Binary → forward TTS PCM16 to UI
      let evt = null;
      if (typeof data === 'string') {
        try { evt = JSON.parse(data); } catch {}
      } else if (Buffer.isBuffer(data) && data.length && data[0] === 0x7B) { // '{'
        try { evt = JSON.parse(data.toString('utf8')); } catch {}
      }

      if (evt) {
        switch (evt.type) {
          case 'SettingsApplied':
            settingsApplied = true;
            log('info', 'demo_evt_settings_applied');
            try {
              client.send(JSON.stringify({
                type: 'settings',
                sttModel: STT, ttsVoice, llmModel: LLM, temperature: 0.15,
                greeting: GREETING, prompt_len: PROMPT.length
              }));
            } catch {}
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

          case 'AgentWarning': log('warn',  'demo_evt_warning', evt); break;
          case 'AgentError':
          case 'Error':        log('error', 'demo_evt_error',   evt); break;
          default:             log('debug', 'demo_evt_other',   evt);
        }
        return;
      }

      // Binary audio: Agent → Browser (PCM16 @ 16k)
      try { client.send(data); } catch (e) {
        log('warn', 'demo_client_send_audio_err', { err: e.message });
      }
    });

    client.on('message', (data) => {
      // Browser mic frames (PCM16 @16k) → Agent
      if (agentWS.readyState !== WebSocket.OPEN) return;
      if (settingsSent && settingsApplied) {
        try { agentWS.send(data); } catch (e) { log('warn', 'demo_dg_send_audio_err', { err: e.message }); }
      } else if (settingsSent) {
        preRoll.push(data);
        if (preRoll.length > 24) preRoll.shift();
      }
    });

    const cleanup = () => {
      clearInterval(keepalive);
      try { agentWS.close(1000); } catch {}
    };

    client.on('close', () => { log('info', 'demo_client_close'); cleanup(); });
    client.on('error', (e) => log('warn', 'demo_client_err', { err: e?.message || String(e) }));
    agentWS.on('close', (c, r) => { log('info', 'demo_dg_close', { code: c, reason: r?.toString?.() || '' }); try { client.close(1000); } catch {} cleanup(); });
    agentWS.on('error', (e) => log('warn', 'demo_dg_err', { err: e?.message || String(e) }));
  });
}

module.exports = { setupWebDemoLive };
