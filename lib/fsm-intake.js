require('dotenv').config();
const twilio = require('twilio');
const parsers = require('./parsers');

// Initialize Twilio REST client (for call transfer and hangups)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

/**
 * Attach a deterministic intake FSM to a Twilio-Deepgram bridge connection.
 * @param {{ bridge: EventEmitter, streamSid: string, callSid: string, logger: Function }} params
 */
function attachIntakeFlow({ bridge, streamSid, callSid, logger }) {
  // Field storage
  const fields = {
    client_type: null,
    full_name: null,
    phone: null,
    email: null,
    incident: null,
    date: null,
    location: null,
    injuries: null,
    treatment: null
  };
  // Define sequence of states for intake questions
  let state = 'AWAIT_CLIENT_TYPE';
  let attemptCount = 0;
  let noInputTimer = null;

  // Prompt texts for each question state
  const prompts = {
    AWAIT_NAME:      "May I have your full name?",
    AWAIT_PHONE:     "What's the best phone number to reach you?",
    AWAIT_EMAIL:     "Could you provide your email address?",
    AWAIT_INCIDENT:  "Could you briefly describe what happened?",
    AWAIT_DATE:      "When did the incident occur?",
    AWAIT_LOCATION:  "Where did it happen?",
    AWAIT_INJURIES:  "What injuries did you sustain?",
    AWAIT_TREATMENT: "Have you received any medical treatment?"
  };

  // Clear any pending no-input reprompt timer
  function clearNoInputTimer() {
    if (noInputTimer) {
      clearTimeout(noInputTimer);
      noInputTimer = null;
    }
  }

  // Handle case where user gives no response within timeout
  async function onNoInput() {
    clearNoInputTimer();
    attemptCount++;
    if (attemptCount <= 2) {
      // Reprompt politely (up to 2 times)
      const repromptText = (state === 'AWAIT_CLIENT_TYPE')
        ? "I'm sorry, were you in an accident, or are you an existing client?"
        : "I'm sorry, " + prompts[state];
      await bridge.whenQuiet();
      bridge.injectAgentMessage(repromptText);
      logger('reprompt', { prompt: repromptText });
      // Shorter timeout on reprompt
      noInputTimer = setTimeout(onNoInput, 5000);
    } else {
      // After two reprompts with no response, end the call politely
      const goodbyeMsg = "I'm sorry, I haven't heard from you. Please call us again later. Goodbye.";
      bridge.injectAgentMessage(goodbyeMsg);
      logger('prompt', { prompt: goodbyeMsg });
      // Hang up the call after the goodbye message
      bridge.whenQuiet(1000).then(() => {
        if (twilioClient && callSid) {
          twilioClient.calls(callSid).update({ status: 'completed' }).catch(() => {});
        }
      });
    }
  }

  // Start/restart the no-input timer for the current state
  function startNoInputTimer(durationMs = 6000) {
    clearNoInputTimer();
    noInputTimer = setTimeout(onNoInput, durationMs);
  }

  // Build a confirmation prompt summarizing all collected info
  function buildConfirmationPrompt() {
    const typeStr = fields.client_type === 'existing' ? 'an existing client' : 'a new client';
    const nameStr = fields.full_name || '';
    const phoneStr = fields.phone ? fields.phone.replace(/^\+1/, '') : '';  // strip country code for speech
    const emailStr = fields.email || '';
    const incidentStr = fields.incident || '';
    const dateStr = fields.date || '';
    const locationStr = fields.location || '';
    let injuriesStr = fields.injuries || '';
    let treatmentStr = fields.treatment || '';
    if (injuriesStr.toLowerCase() === 'none') injuriesStr = 'no injuries';
    if (treatmentStr.toLowerCase() === 'none') treatmentStr = 'no medical treatment';
    return `To confirm, you are ${typeStr} named ${nameStr}. Your phone number is ${phoneStr}, and your email is ${emailStr}. ` +
           `You said the incident was: ${incidentStr}. It happened on ${dateStr} at ${locationStr}. ` +
           `You sustained ${injuriesStr}, and have received ${treatmentStr}. Is that correct?`;
  }

  // Initiate call transfer to the configured number
  async function transferCall() {
    logger('handoff_start', { number: process.env.TRANSFER_NUMBER || '' });
    if (twilioClient && callSid) {
      // Prepare URL for transfer TwiML (if our public host is known)
      const baseHost = process.env.PUBLIC_WSS_HOST || process.env.AUDIO_STREAM_DOMAIN || process.env.HOSTNAME;
      const transferUrl = baseHost 
        ? `https://${String(baseHost).replace(/^https?:\/\//, '')}/transfer`
        : null;
      try {
        if (transferUrl) {
          const call = await twilioClient.calls(callSid).update({ method: 'POST', url: transferUrl });
          logger('handoff_result', { status: call.status || 'transferring', sid: call.sid || null });
        } else {
          // If no public host is set, just hang up as a fallback (no transfer)
          await twilioClient.calls(callSid).update({ status: 'completed' });
          logger('handoff_result', { status: 'completed' });
        }
      } catch (err) {
        logger('handoff_result', { error: err.message });
      }
    } else {
      // Twilio client not available, end the call
      logger('handoff_result', { error: 'No Twilio client to transfer call' });
      bridge.whenQuiet(500).then(() => {
        try { bridge.stopSpeaking(); } catch {}
        if (twilioClient && callSid) {
          twilioClient.calls(callSid).update({ status: 'completed' }).catch(() => {});
        }
      });
    }
    // Optionally call a summarizer/evaluator (OpenAI) if configured
    if (process.env.OPENAI_API_KEY) {
      try {
        const { Configuration, OpenAIApi } = require('openai');
        const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));
        const summaryPrompt = 
          `Summarize the following intake:\n` +
          `Client Type: ${fields.client_type}\nName: ${fields.full_name}\nPhone: ${fields.phone}\nEmail: ${fields.email}\n` +
          `Incident: ${fields.incident}\nDate: ${fields.date}\nLocation: ${fields.location}\nInjuries: ${fields.injuries}\nTreatment: ${fields.treatment}\n`;
        const response = await openai.createCompletion({
          model: process.env.OPENAI_MODEL || 'text-davinci-003',
          prompt: summaryPrompt,
          max_tokens: 150,
          temperature: 0.2
        });
        const summary = response.data.choices?.[0]?.text?.trim() || '';
        if (summary) {
          logger('handoff_result', { summary });
        }
      } catch (e) {
        logger('handoff_result', { summary_error: e.message });
      }
    }
  }

  // Log and handle the initial agent greeting prompt (the first question)
  const greeting = process.env.AGENT_GREETING ||
    'Thank you for calling. Were you in an accident, or are you an existing client?';
  logger('prompt', { prompt: greeting });
  // Start timer waiting for user's answer to the greeting
  startNoInputTimer(7000);

  // Listen for recognized user speech from the bridge (shadow_intake_update events)
  bridge.on('shadow_intake_update', async ({ text }) => {
    if (!text) return;
    logger('fsm_user_text', { text });
    clearNoInputTimer();  // user responded, clear any no-input timeout

    let accepted = false;
    switch (state) {
      case 'AWAIT_CLIENT_TYPE': {
        const type = parsers.detectClientType(text);
        if (type) {
          fields.client_type = type;
          accepted = true;
          logger('field_set', { field: 'client_type', value: type });
        }
        break;
      }
      case 'AWAIT_NAME': {
        const name = parsers.normalizeName(text);
        if (name) {
          fields.full_name = name;
          accepted = true;
          logger('field_set', { field: 'full_name', value: name });
        }
        break;
      }
      case 'AWAIT_PHONE': {
        const phone = parsers.normalizePhone(text);
        if (phone) {
          fields.phone = phone;
          accepted = true;
          logger('field_set', { field: 'phone', value: phone });
        }
        break;
      }
      case 'AWAIT_EMAIL': {
        const email = parsers.normalizeEmail(text);
        if (email) {
          fields.email = email;
          accepted = true;
          logger('field_set', { field: 'email', value: email });
        }
        break;
      }
      case 'AWAIT_INCIDENT': {
        const incident = text.trim();
        if (incident) {
          fields.incident = incident;
          accepted = true;
          logger('field_set', { field: 'incident', value: incident });
        }
        break;
      }
      case 'AWAIT_DATE': {
        const date = parsers.normalizeDate(text);
        if (date) {
          fields.date = date;
          accepted = true;
          logger('field_set', { field: 'date', value: date });
        }
        break;
      }
      case 'AWAIT_LOCATION': {
        const location = parsers.normalizeLocation(text);
        if (location) {
          fields.location = location;
          accepted = true;
          logger('field_set', { field: 'location', value: location });
        }
        break;
      }
      case 'AWAIT_INJURIES': {
        let injuries = text.trim();
        if (parsers.isNegative(text)) {
          injuries = 'None';
        }
        if (injuries) {
          fields.injuries = injuries;
          accepted = true;
          logger('field_set', { field: 'injuries', value: injuries });
        }
        break;
      }
      case 'AWAIT_TREATMENT': {
        let treatment = text.trim();
        if (parsers.isNegative(text)) {
          treatment = 'None';
        }
        if (treatment) {
          fields.treatment = treatment;
          accepted = true;
          logger('field_set', { field: 'treatment', value: treatment });
        }
        break;
      }
      case 'CONFIRM': {
        if (parsers.isAffirmative(text)) {
          // Caller confirmed details are correct
          await transferCall();
          state = 'DONE';
          return;
        } else if (parsers.isNegative(text)) {
          // Caller indicated something is wrong - enter correction state
          state = 'AWAIT_CORRECTION';
          attemptCount = 0;
          const prompt = "Alright, let's correct that. Please say the correct information that needs to be updated.";
          bridge.injectAgentMessage(prompt);
          logger('prompt', { prompt });
          startNoInputTimer(6000);
          return;
        } else {
          // Neither a clear "yes" nor "no" - reprompt for confirmation
          attemptCount++;
          if (attemptCount <= 2) {
            const reprompt = "Please say 'yes' if everything is correct, or 'no' if something is wrong.";
            bridge.injectAgentMessage(reprompt);
            logger('reprompt', { prompt: reprompt });
            startNoInputTimer(5000);
          } else {
            // After two unclear answers, assume everything is correct and proceed
            await transferCall();
            state = 'DONE';
          }
          return;
        }
      }
      case 'AWAIT_CORRECTION': {
        // Try to figure out which field the caller corrected
        let updatedField = null;
        if (parsers.normalizePhone(text)) {
          fields.phone = parsers.normalizePhone(text);
          updatedField = 'phone';
        } else if (parsers.normalizeEmail(text)) {
          fields.email = parsers.normalizeEmail(text);
          updatedField = 'email';
        } else if (parsers.normalizeDate(text)) {
          fields.date = parsers.normalizeDate(text);
          updatedField = 'date';
        } else if (parsers.normalizeLocation(text)) {
          fields.location = parsers.normalizeLocation(text);
          updatedField = 'location';
        } else if (parsers.normalizeName(text)) {
          fields.full_name = parsers.normalizeName(text);
          updatedField = 'full_name';
        } else {
          // If not a standard field format, check keywords to guess field
          if (/\b(injur|hurt|pain|fracture|broken|bruise|wound|back|neck|leg|arm|head)\b/i.test(text)) {
            fields.injuries = text.trim();
            updatedField = 'injuries';
          } else if (/\b(treat|surgery|therapy|medication|doctor|hospital)\b/i.test(text)) {
            fields.treatment = text.trim();
            updatedField = 'treatment';
          } else if (text.trim()) {
            fields.incident = text.trim();
            updatedField = 'incident';
          }
        }
        if (updatedField) {
          logger('field_set', { field: updatedField, value: fields[updatedField] });
          // After one correction, ask for confirmation again
          state = 'CONFIRM_AFTER_CORRECTION';
          attemptCount = 0;
          const prompt = "Thank you. I've updated that information. Is everything correct now?";
          bridge.injectAgentMessage(prompt);
          logger('prompt', { prompt });
          startNoInputTimer(5000);
        } else {
          // Could not parse the correction
          attemptCount++;
          if (attemptCount <= 1) {
            const reprompt = "I'm sorry, I didn't get that. Please say the information we should correct.";
            bridge.injectAgentMessage(reprompt);
            logger('reprompt', { prompt: reprompt });
            startNoInputTimer(5000);
          } else {
            // If still unclear, proceed to transfer with what we have
            await transferCall();
            state = 'DONE';
          }
        }
        return;
      }
      case 'CONFIRM_AFTER_CORRECTION': {
        if (parsers.isAffirmative(text)) {
          await transferCall();
          state = 'DONE';
        } else {
          // If caller still says it's incorrect, just proceed to transfer to a human
          const prompt = "Alright, I'll connect you to our team for further assistance.";
          bridge.injectAgentMessage(prompt);
          logger('prompt', { prompt });
          await transferCall();
          state = 'DONE';
        }
        return;
      }
    }

    // If we got a valid answer for the expected field:
    if (accepted) {
      // Advance to the next state
      switch (state) {
        case 'AWAIT_CLIENT_TYPE': state = 'AWAIT_NAME'; break;
        case 'AWAIT_NAME':        state = 'AWAIT_PHONE'; break;
        case 'AWAIT_PHONE':       state = 'AWAIT_EMAIL'; break;
        case 'AWAIT_EMAIL':       state = 'AWAIT_INCIDENT'; break;
        case 'AWAIT_INCIDENT':    state = 'AWAIT_DATE'; break;
        case 'AWAIT_DATE':        state = 'AWAIT_LOCATION'; break;
        case 'AWAIT_LOCATION':    state = 'AWAIT_INJURIES'; break;
        case 'AWAIT_INJURIES':    state = 'AWAIT_TREATMENT'; break;
        case 'AWAIT_TREATMENT':   state = 'CONFIRM'; break;
      }
      attemptCount = 0;
      if (state === 'CONFIRM') {
        // All fields collected, build confirmation summary
        const confirmMsg = buildConfirmationPrompt();
        await bridge.whenQuiet();
        bridge.injectAgentMessage(confirmMsg);
        logger('prompt', { prompt: confirmMsg });
        startNoInputTimer(6000);
      } else {
        // Ask the next question
        const promptText = prompts[state];
        await bridge.whenQuiet();
        bridge.injectAgentMessage(promptText);
        logger('prompt', { prompt: promptText });
        startNoInputTimer(6000);
      }
    } else {
      // The answer didn't match the expected field format
      if (state.startsWith('AWAIT_') && !state.includes('CORRECTION')) {
        attemptCount++;
        if (attemptCount <= 2) {
          // Politely reprompt the same question
          const repromptText = (state === 'AWAIT_CLIENT_TYPE')
            ? "I’m sorry, I didn’t catch that. Were you in an accident, or are you an existing client?"
            : "I’m sorry, " + prompts[state];
          await bridge.whenQuiet();
          bridge.injectAgentMessage(repromptText);
          logger('reprompt', { prompt: repromptText });
          startNoInputTimer(5000);
        } else {
          // Too many failed attempts on this question – end the call or transfer to avoid frustration
          const goodbye = "Thank you. We will have someone follow up with you shortly. Goodbye.";
          bridge.injectAgentMessage(goodbye);
          logger('prompt', { prompt: goodbye });
          await transferCall();
          state = 'DONE';
        }
      }
    }
  });

  // Cleanup on call end
  bridge.on('close', () => {
    clearNoInputTimer();
  });
}

module.exports = { attachIntakeFlow };
