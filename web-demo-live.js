// web-demo-live.js
require('dotenv').config();
const WebSocket = require('ws');

function setupWebDemoLive(server, { route = '/web-demo/ws' } = {}) {
  const wss = new WebSocket.Server({ server, path: route, perMessageDeflate: false });

  wss.on('connection', (client) => {
    const dgUrl = process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
    const dg = new WebSocket(dgUrl, ['token', process.env.DEEPGRAM_API_KEY]);

    let settingsSent = false;

    dg.on('open', () => {
      // Browser sends PCM16 @16k → tell the agent to expect linear16/16k.
      const sttModel = (process.env.DG_STT_MODEL || 'nova-2').trim();
      const ttsVoice = (process.env.DG_TTS_VOICE || 'aura-2-thalia-en').trim();
      const llmModel = (process.env.LLM_MODEL || 'gpt-4o-mini').trim();

      const firm = process.env.FIRM_NAME || 'Benji Personal Injury';
      const agentName = process.env.AGENT_NAME || 'Alexis';
      const DEFAULT_PROMPT =
        `You are ${agentName} for ${firm}. First ask: existing client or accident? Ask exactly one question per turn and wait for the reply. Existing: get name, best phone, attorney; then say youll transfer. Accident: get name, phone, email, what happened, when, city/state; confirm, then say youll transfer. Stop if the caller talks.`;
      const greeting =
        process.env.AGENT_GREETING ||
        `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`;

      const settings = {
        type: 'Settings',
        audio: {
          input:  { encoding: 'linear16', sample_rate: 16000 }, // matches your mic worklet frames
          output: { encoding: 'linear16', sample_rate: 16000, container: 'none' } // browser player expects PCM16
        },
        agent: {
          language: 'en',
          greeting,
          listen: { provider: { type: 'deepgram', model: sttModel, smart_format: true } },
          think:  { provider: { type: 'open_ai', model: llmModel, temperature: 0.15 } },
          speak:  { provider: { type: 'deepgram', model: ttsVoice } }
        }
      };

      try {
        dg.send(JSON.stringify(settings));
        settingsSent = true;
      } catch (e) {
        console.error('[demo] send settings failed', e?.message || e);
      }
    });

    // Deepgram → Browser
    dg.on('message', (data) => {
      // If JSON, pass through useful events as JSON; if binary, forward audio frames.
      if (typeof data === 'string') {
        try {
          const evt = JSON.parse(data);
          const passTypes = new Set([
            'Welcome', 'SettingsApplied', 'Transcript', 'UserTranscript',
            'ConversationText', 'History', 'AgentWarning', 'AgentError', 'Error'
          ]);
          if (evt && (evt.type && passTypes.has(evt.type))) {
            client.send(JSON.stringify(evt));
            return;
          }
        } catch {
          // non-JSON string, ignore
        }
      }
      // Binary = PCM16 audio from agent → send to the browser
      if (Buffer.isBuffer(data)) {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      }
    });

    dg.on('error', (e) => console.warn('[demo] dg error', e?.message || e));
    dg.on('close', () => {
      if (client.readyState === WebSocket.OPEN) client.close(1011, 'agent closed');
    });

    // Browser → Deepgram (binary PCM16 frames @16k)
    client.on('message', (data) => {
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
        if (dg.readyState === WebSocket.OPEN && settingsSent) {
          try { dg.send(data); } catch (e) { console.warn('[demo] dg send audio failed', e?.message || e); }
        }
      } else {
        // ignore text from client
      }
    });

    client.on('close', () => { try { dg.close(1000); } catch {} });
    client.on('error', (e) => console.warn('[demo] browser ws err', e?.message || e));
  });
}

module.exports = { setupWebDemoLive };
