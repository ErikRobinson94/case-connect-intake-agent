// lib/intake-controller.js
require('dotenv').config();
const { IntakeStateMachine } = require('./intake-state-machine');
const twilio = require('twilio');

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const lv = { error:0, warn:1, info:2, debug:3 };
const log = (level, msg, extra) => {
  if ((lv[level] ?? 2) <= (lv[LOG_LEVEL] ?? 2)) {
    console.log(`[${new Date().toISOString()}] ${level} ${msg} ${extra ? JSON.stringify(extra) : ''}`);
  }
};

/**
 * Wire one intake controller per call connection.
 * @param {*} api - from the bridge (has .injectAgentMessage(string), .whenQuiet(ms), emits 'shadow_intake_update','close')
 * @param {{firmName?:string, agentName?:string, transferNumber?:string|null}} opts
 */
function startIntakeController(api, { firmName, agentName, transferNumber } = {}) {
  const callSid = api.callSid;
  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  const authToken  = process.env.TWILIO_AUTH_TOKEN || '';
  const client = (accountSid && authToken) ? twilio(accountSid, authToken) : null;

  log('info','controller_start', { callSid, streamSid: api.streamSid });
  log('info','controller_ready', { callSid });

  // ---- Say pipeline with de-dupe
  let sayLock = Promise.resolve();
  let lastText = '';
  let lastAt = 0;

  const say = (text) => {
    const s = String(text || '').trim();
    if (!s) return sayLock;
    const now = Date.now();
    if (s === lastText && (now - lastAt) < 1200) return sayLock;
    lastText = s; lastAt = now;

    sayLock = sayLock.then(async () => {
      await api.whenQuiet(700);
      api.injectAgentMessage(s); // string only
      log('info','dg_inject_msg', { text: s });
      log('info','prompt', { callId: callSid, text: s });
    }).catch(()=>{});
    return sayLock;
  };

  // Pull knobs from env (optional)
  const maxRepromptsPerState = Number.isFinite(+process.env.MAX_REPROMPTS_PER_STATE)
    ? +process.env.MAX_REPROMPTS_PER_STATE
    : 1;
  const repromptMs = Number.isFinite(+process.env.REPROMPT_MS)
    ? +process.env.REPROMPT_MS
    : 6000;
  const hardNudgeMs = Number.isFinite(+process.env.HARD_NUDGE_MS)
    ? +process.env.HARD_NUDGE_MS
    : 0; // default OFF

  // ---- FSM
  const fsm = new IntakeStateMachine({
    firmName: firmName || process.env.FIRM_NAME || 'Your Firm',
    agentName: agentName || process.env.AGENT_NAME || 'Alexis',
    repromptMs,
    hardNudgeMs,
    maxRepromptsPerState,
  });

  fsm.on('say', (text) => { say(text); });
  fsm.on('reprompt', (text) => { say(text); });

  fsm.on('field_set', (info) => log('info','field_set', { callId: callSid, ...info }));
  fsm.on('state', (info) => log('debug','state', { callId: callSid, ...info }));

  fsm.on('done', async ({ fields, summary }) => {
    log('info','fsm_done', { callId: callSid, fields });
    await say(`Thanks. ${summary} I’ll connect you now.`);
    if (transferNumber && client && callSid) {
      try {
        const vr = new (require('twilio').twiml.VoiceResponse)();
        const dial = vr.dial({ callerId: fields.phone || undefined });
        dial.number({}, transferNumber);
        await client.calls(callSid).update({ twiml: vr.toString() });
        log('info','transfer_requested', { callId: callSid, to: transferNumber });
      } catch (e) {
        log('warn','transfer_failed', { callId: callSid, err: e?.message || String(e) });
        await say(`I couldn’t connect you just now, but I’ve noted your details for a quick call back.`);
      }
    }
  });

  // Bridge → FSM
  api.on('shadow_intake_update', ({ text }) => {
    const s = (text || '').trim();
    if (!s) return;
    log('info','fsm_user_text', { callSid, text: s, original: text });
    log('info','dispatch_to_controller', { text: s });
    try { fsm.handleUserText(s); } catch (e) {
      log('warn','dispatch_err', { err: e?.message || String(e) });
    }
  });

  api.on('close', () => {
    log('info','connection_closed', { callSid });
    try { fsm.teardown(); } catch {}
  });
}

module.exports = { startIntakeController };
