require('dotenv').config();
const WebSocket = require('ws');
const crypto = require('crypto');
const { finalizeIntake } = require('./finalize-intake');

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const lv = { error:0, warn:1, info:2, debug:3 };
const log = (level, msg, extra) => {
  if ((lv[level] ?? 2) <= (lv[LOG_LEVEL] ?? 2)) {
    console.log(`[${new Date().toISOString()}] ${level} ${msg} ${extra ? JSON.stringify(extra) : ''}`);
  }
};

// ======= Tunables (latency + logging) =======
const TWILIO_FRAME_BYTES = 160; // 20ms @ 8k μ-law
const BUFFER_FRAMES      = parseInt(process.env.BUFFER_FRAMES || '4', 10);   // ~80ms per burst
const PREBUF_MAX_CHUNKS  = parseInt(process.env.PREBUF_MAX_CHUNKS || '6', 10); // ~0.5–0.6s preroll
const SEND_BYTES         = TWILIO_FRAME_BYTES * BUFFER_FRAMES;

// Audio flow / barge
const BARGE_ENABLE       = String(process.env.BARGE_ENABLE ?? 'true').toLowerCase() !== 'false';
const BARGE_MUTE_MS      = parseInt(process.env.BARGE_MUTE_MS || '400', 10);
const CLEAR_THROTTLE_MS  = parseInt(process.env.CLEAR_THROTTLE_MS || '600', 10);
const PLAYBACK_MASK_MS   = parseInt(process.env.PLAYBACK_MASK_MS || '150', 10);

// Audio meter (instead of spamming every binary chunk)
const AUDIO_METER_MS     = parseInt(process.env.AGENT_AUDIO_METER_MS || '2000', 10); // 0 = off
let audioMeterTimer = null;

// ======= Shadow Intake controls =======
// SHADOW_LOG_MODE: 'off' | 'fields' | 'summary' | 'verbose'
const SHADOW_LOG_MODE    = (process.env.SHADOW_LOG_MODE || 'summary').toLowerCase();
const SHADOW_ENABLED     = SHADOW_LOG_MODE !== 'off';

// ---------- Helpers ----------
function maybeParseJSON(data) {
  try {
    if (typeof data === 'string') return JSON.parse(data);
    if (Buffer.isBuffer(data)) {
      const s = data.toString('utf8');
      if (s.length && s.trim().startsWith('{')) return JSON.parse(s);
    }
  } catch {}
  return null;
}
function sanitizeASCII(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u0000-\u001F\u007F-\uFFFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function compact(s, max = 380) {
  if (!s) return '';
  const t = s.length <= max ? s : s.slice(0, max);
  if (t.length >= 40) return t;
  return 'You are the intake specialist. Determine existing client vs accident. If existing: ask full name, best phone, and attorney; then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all; then say you will transfer. Be warm, concise, and stop speaking if the caller talks.';
}

// ======= Shadow Intake state & extractors =======
function makeIntakeState() {
  return {
    client_type: null,   // "existing" | "new"
    full_name:   null,
    phone:       null,
    email:       null,
    incident:    null,
    date:        null,
    location:    null,
    transcripts: [],
    completeLogged: false,
    _recentUtterances: [] // de-dupe ring for user lines
  };
}
const toTitle = s => (s||'').replace(/\b([a-z])/gi, m => m.toUpperCase());
const extractPhone = t => {
  const s = (t||'').replace(/[^\d\+]/g, '');
  const m = s.match(/(?:\+1)?(\d{10})$/);
  return m ? m[0].replace(/(\d{1,2})(\d{3})(\d{3})(\d{4})/, (x,c,a,b,d)=> (x.length===10?`${a}-${b}-${d}`:`+${c} ${a}-${b}-${d}`)) : null;
};
const extractEmail = t => {
  const m = (t||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
};
const extractClientType = t => {
  const s = (t||'').toLowerCase();
  if (/\b(existing|current|already.*client)\b/.test(s)) return 'existing';
  if (/\b(new|potential|not.*client|accident|injury|case)\b/.test(s)) return 'new';
  return null;
};
const extractFullName = t => {
  if (!t) return null;
  let m = t.match(/\b(?:my name is|this is|i am|i'm)\s+([a-z][a-z\s\.'-]{2,})$/i);
  if (m) {
    const cand = m[1].replace(/\s+/g, ' ').trim();
    if (cand.split(/\s+/).length >= 2) return toTitle(cand);
  }
  m = t.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/);
  return m ? m[1] : null;
};
const extractDate = t => {
  if (!t) return null;
  const m =
    t.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?/i) ||
    t.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/) ||
    t.match(/\b(?:yesterday|today|last\s+(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?)\b/i);
  return m ? m[0] : null;
};
const extractLocation = t => {
  if (!t) return null;
  let m = t.match(/\b(?:in|at)\s+([A-Za-z][A-Za-z\.\-']+(?:\s+[A-Za-z\.\-']+)*)(?:,\s*([A-Za-z]{2,}))?\b/);
  if (!m) return null;
  const phrase = m[1].trim();
  if (/^(an?|the)\s+(accident|injury|crash)\b/i.test(phrase)) return null;
  const city = toTitle(phrase);
  const st   = m[2] ? m[2].toUpperCase() : '';
  return st ? `${city}, ${st}` : city;
};
const looksIncidenty = t => /\b(accident|injury|fell|fall|collision|crash|rear[- ]?ended|hit|dog bite|bite|slip|trip|work|car|uber|lyft|truck|bicycle|pedestrian|bus|motorcycle)\b/i.test(t||'');
function isComplete(intake) {
  return !!(intake.client_type && intake.full_name && (intake.phone || intake.email) && intake.incident && intake.date && intake.location);
}
function intakeSnapshot(intake) {
  const { client_type, full_name, phone, email, incident, date, location } = intake;
  return { client_type, full_name, phone, email, incident, date, location, complete: isComplete(intake) };
}
function updateIntakeFromUserText(intake, text) {
  if (!SHADOW_ENABLED) return;
  const incoming = (text || '').trim();
  if (!incoming) return;

  const recent = intake._recentUtterances || (intake._recentUtterances = []);
  if (recent.includes(incoming)) return;
  recent.push(incoming);
  if (recent.length > 25) recent.shift();

  if (SHADOW_LOG_MODE === 'verbose') {
    log('debug', 'intake_shadow_seen', { text: incoming });
  }
  intake.transcripts.push(incoming);

  let changed = false;
  const maybe = (label, val) => {
    if (val && !intake[label]) { intake[label] = val; changed = true; if (SHADOW_LOG_MODE !== 'summary') log('info', 'intake_field', { field: label, value: intake[label] }); }
  };
  maybe('client_type', extractClientType(incoming));
  maybe('full_name',   extractFullName(incoming));
  maybe('phone',       extractPhone(incoming));
  maybe('email',       extractEmail(incoming));
  maybe('date',        extractDate(incoming));
  maybe('location',    extractLocation(incoming));
  if (!intake.incident) {
    const words = incoming.split(/\s+/);
    if (looksIncidenty(incoming) || words.length >= 6) {
      intake.incident = incoming; changed = true;
      if (SHADOW_LOG_MODE !== 'summary') log('info', 'intake_field', { field: 'incident', value: intake.incident });
    }
  }
  if (changed) log('info', 'intake_snapshot', intakeSnapshot(intake));
}

// ---------- Main bridge ----------
function setupBidiBridge(server, { route = '/twilio-bidi' } = {}) {
  // ⭐ IMPORTANT: limit this WS server to the specific route to avoid
  // clashing with other WS paths (e.g., /web-demo/ws).
  const wss = new WebSocket.Server({ server, path: route, perMessageDeflate: false });

  wss.on('connection', (twilioWS /*, req */) => {
    log('info', 'ws_connection', { url: route });

    let streamSid = null;
    let closed = false;

    let inBuffer = Buffer.alloc(0);

    // Audio meter counters
    let audioBytes = 0;
    let audioChunks = 0;
    if (AUDIO_METER_MS > 0) {
      audioMeterTimer = setInterval(() => {
        if (audioBytes || audioChunks) {
          log('info', 'dg_agent_audio_meter', { bytes_per_interval: audioBytes, chunks: audioChunks, interval_ms: AUDIO_METER_MS });
          audioBytes = 0; audioChunks = 0;
        }
      }, AUDIO_METER_MS);
    }

    // Per-call shadow intake state
    const intake = makeIntakeState();
    intake.callStartedAt = new Date().toISOString();

    // Connect to Deepgram Voice Agent
    const dgUrl = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
    const agentWS = new WebSocket(dgUrl, ['token', process.env.DEEPGRAM_API_KEY]);

    agentWS.on('unexpectedResponse', (_req, res) => {
      log('error', 'dg_unexpected_response', { statusCode: res.statusCode, headers: res.headers });
    });

    // Session state
    let settingsSent = false;
    let settingsApplied = false;
    let preRollChunks = [];

    let lastAgentAudioAt = 0;
    let playbackMaskUntil = 0;

    let bargeMuteUntil = 0;
    let lastClearAt = 0;

    // Prompt & greeting
    const firm = process.env.FIRM_NAME || 'Benji Personal Injury';
    const agentName = process.env.AGENT_NAME || 'Alexis';
    const DEFAULT_PROMPT =
      `You are ${agentName} for ${firm}. First ask: existing client or accident? Ask exactly one question per turn and wait for the reply. Existing: get name, best phone, attorney; then say youll transfer. Accident: get name, phone, email, what happened, when, city/state; confirm, then say youll transfer. Stop if the caller talks.`;

    const useEnv = String(process.env.DISABLE_ENV_INSTRUCTIONS || 'false').toLowerCase() !== 'true';
    const rawEnvPrompt = useEnv ? (process.env.AGENT_INSTRUCTIONS || '') : '';
    const rawPrompt = sanitizeASCII(rawEnvPrompt || DEFAULT_PROMPT);
    const prompt = compact(rawPrompt, 380);

    const greeting = sanitizeASCII(
      process.env.AGENT_GREETING ||
      `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`
    );

    const sttModel = (process.env.DG_STT_MODEL || 'nova-2').trim();
    const ttsVoice = (process.env.DG_TTS_VOICE || 'aura-2-thalia-en').trim();
    let llmModel = (process.env.LLM_MODEL || 'gpt-4o-mini').trim(); // 'gpt-4o-mini' for speed; 'gpt-4o' for quality

    agentWS.on('open', () => {
      log('info', 'dg_agent_open', { url: dgUrl });
      log('info', 'dg_settings_preview', {
        prompt_len: (rawEnvPrompt || DEFAULT_PROMPT).length,
        sanitized_len: rawPrompt.length,
        effective_len: prompt.length,
        sttModel, ttsVoice, llmModel
      });

      const settings = {
        type: 'Settings',
        audio: {
          input:  { encoding: 'mulaw', sample_rate: 8000 },
          output: { encoding: 'mulaw', sample_rate: 8000, container: 'none' }
        },
        agent: {
          language: 'en',
          greeting,
          listen: { provider: { type: 'deepgram', model: sttModel, smart_format: true } },
          think:  {
            provider: { type: 'open_ai', model: llmModel, temperature: 0.15 },
            prompt
          },
          speak:  { provider: { type: 'deepgram', model: ttsVoice } }
        }
      };

      try { agentWS.send(JSON.stringify(settings)); settingsSent = true; }
      catch (e) { log('error', 'dg_send_settings_err', { err: e.message }); }
    });

    const keepalive = setInterval(() => {
      if (agentWS.readyState === WebSocket.OPEN) {
        try { agentWS.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }
    }, 25000);

    // Agent -> Twilio
    agentWS.on('message', (data) => {
      const evt = maybeParseJSON(data);
      if (evt) {
        switch (evt.type) {
          case 'Welcome':
            log('info', 'dg_evt_welcome');
            break;

          case 'SettingsApplied':
            settingsApplied = true;
            log('info', 'dg_evt_settings_applied');
            if (preRollChunks.length) {
              try {
                for (const c of preRollChunks) if (agentWS.readyState === WebSocket.OPEN) agentWS.send(c);
              } catch (e) { log('warn', 'dg_preroll_flush_err', { err: e.message }); }
              preRollChunks = [];
            }
            break;

          case 'ConversationText':
          case 'History':
          case 'UserTranscript':
          case 'UserResponse':
          case 'Transcript': {
            const role = (evt.role || evt.speaker || '').toLowerCase();
            const text =
              (evt.content && String(evt.content)) ||
              (evt.text && String(evt.text)) ||
              (evt.transcript && String(evt.transcript)) ||
              '';
            const trimmed = text.trim();
            if (role === 'user' && trimmed) updateIntakeFromUserText(intake, trimmed);
            break;
          }

          case 'UserStartedSpeaking':
            if (BARGE_ENABLE) {
              requestClear('agent_hint');
              bargeMuteUntil = Date.now() + BARGE_MUTE_MS;
            }
            break;

          case 'AgentWarning':
            log('warn', 'dg_evt_warning', evt);
            break;

          case 'AgentError':
          case 'Error':
            log('error', 'dg_evt_error', evt);
            break;

          default:
            log('debug', 'dg_evt_other', evt);
        }
        return;
      }

      // Binary = agent TTS μ-law to Twilio
      lastAgentAudioAt = Date.now();
      playbackMaskUntil = lastAgentAudioAt + PLAYBACK_MASK_MS;

      if (AUDIO_METER_MS > 0) { audioBytes += data.length; audioChunks += 1; }

      if (Date.now() < bargeMuteUntil) return;
      if (!streamSid) return;

      const payload = data.toString('base64');
      try {
        twilioWS.send(JSON.stringify({ event:'media', streamSid, media:{ payload } }));
        twilioWS.send(JSON.stringify({ event:'mark',  streamSid, mark:{ name: crypto.randomUUID() } }));
      } catch (e) {
        log('warn', 'twilio_send_media_err', { err: e.message });
      }
    });

    agentWS.on('close', (code, reason) => {
      clearInterval(keepalive);
      if (audioMeterTimer) { clearInterval(audioMeterTimer); audioMeterTimer = null; }

      if (SHADOW_ENABLED) {
        log('info', 'intake_final', intakeSnapshot(intake));
      }

      (async () => {
        try {
          const result = await finalizeIntake(intake, {
            callStartedAt: intake.callStartedAt || null,
            callEndedAt: new Date().toISOString()
          });
          log('info', 'intake_structured', result);
        } catch (e) {
          log('error', 'intake_finalize_err', { err: e?.message || String(e) });
        }
      })();

      log('info', 'dg_agent_close', { code, reason: reason?.toString?.() || '' });
      safeClose();
    });

    agentWS.on('error', (e) => log('warn', 'dg_agent_err', { err: e?.message || String(e) }));

    // Twilio -> Agent
    twilioWS.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.event) {
        case 'connected':
          break;

        case 'start':
          streamSid = msg.start?.streamSid;
          log('info', 'twilio_start', { streamSid, tracks: msg.start?.tracks });
          break;

        case 'media': {
          if (msg.media?.track && msg.media.track !== 'inbound') break;
          const b = Buffer.from(msg.media.payload, 'base64');

          inBuffer = Buffer.concat([inBuffer, b]);
          while (inBuffer.length >= SEND_BYTES) {
            const chunk = inBuffer.subarray(0, SEND_BYTES);
            inBuffer = inBuffer.subarray(SEND_BYTES);

            if (agentWS.readyState === WebSocket.OPEN) {
              if (settingsSent && settingsApplied) {
                try { agentWS.send(chunk); } catch (e) { log('warn', 'dg_send_audio_err', { err: e.message }); }
              } else if (settingsSent) {
                preRollChunks.push(chunk);
                if (preRollChunks.length > PREBUF_MAX_CHUNKS) preRollChunks.shift();
              }
            }
          }
          break;
        }

        case 'stop':
          safeClose();
          break;
      }
    });

    twilioWS.on('close', safeClose);
    twilioWS.on('error', (e) => log('warn', 'twilio_ws_err', { err: e?.message || String(e) }));

    function canClearNow() {
      const now = Date.now();
      if (now - lastClearAt < CLEAR_THROTTLE_MS) return false;
      lastClearAt = now;
      return true;
    }
    function requestClear(reason) {
      if (!streamSid || !canClearNow()) return;
      try { twilioWS.send(JSON.stringify({ event: 'clear', streamSid })); } catch {}
      log('info', 'twilio_clear', { reason });
    }
    function safeClose() {
      if (closed) return;
      closed = true;
      try { agentWS.close(1000); } catch {}
      try { twilioWS.close(); } catch {}
    }
  });
}

module.exports = { setupBidiBridge };