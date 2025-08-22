// lib/agent/intake-agent.js

function createIntakeAgent() {
  const state = {
    // step: 'intro', // ❌ remove the intro stage to prevent double greeting
    step: 'client_type', // ✅ start here; opening() is spoken once by the server
    data: { clientType: null, name: null, incident: null, date: null, location: null }
  };

  function opening() {
    return "Hey, this is Alexis with Benji Personal Injury. Are you an existing client, or would you like to speak to an attorney about a potential case?";
  }

  function respond(text) {
    const raw = (text || '').trim();
    const lower = raw.toLowerCase();
    const yes = /\b(yes|yeah|yep|correct|that’s right|that's right|i am|sure)\b/.test(lower);
    const no  = /\b(no|nope|nah|not really|i'm not|new)\b/.test(lower);

    switch (state.step) {
      case 'client_type': {
        if (/\b(existing|current)\b/.test(lower) || (yes && !/\bnew\b/.test(lower))) {
          state.data.clientType = 'existing';
          state.step = 'name';
          return "Got it. What’s your full name?";
        }
        if (/\b(new|potential|attorney|lawyer|case|accident|injury)\b/.test(lower) || no) {
          state.data.clientType = 'new';
          state.step = 'name';
          return "Thanks. What’s your full name?";
        }
        return "Sorry—are you an existing client, or should I connect you with an attorney about a new case?";
      }

      case 'name': {
        // Accept 2+ words; keep 3 names if provided
        let m = raw.match(/\b(?:my name is|this is|i am|i'm)\s+([a-z][a-z\s\.'-]{2,})$/i);
        const candidate = (m ? m[1] : raw).replace(/\s+/g, ' ').trim();
        if (candidate.split(/\s+/).length >= 2) {
          state.data.name = toTitle(candidate);
          state.step = 'incident';
          return `Thanks, ${state.data.name}. Can you briefly describe what happened?`;
        }
        return "Thanks. Could I get your first and last name?";
      }

      case 'incident': {
        const words = raw.split(/\s+/).filter(Boolean);
        const hasSignal = /\b(accident|injury|fell|collision|hit|rear[- ]?ended|dog bite|slip|trip|work|car|uber|lyft|truck)\b/i.test(raw);
        if (words.length >= 4 || hasSignal) {
          state.data.incident = raw;
          state.step = 'date';
          return "When did this happen? A date like ‘June 5th’ or ‘last Friday’ works.";
        }
        return "A few words about what happened will help me route you. What happened?";
      }

      case 'date': {
        const d = extractDate(raw);
        if (!d) return "Could you share the date? ‘Last Friday’ or ‘June 5th’ is fine.";
        state.data.date = d;
        state.step = 'location';
        return "Where did it happen? City and state if you have it.";
      }

      case 'location': {
        if (!raw || raw.length < 3) return "What’s the city and state where it happened?";
        state.data.location = raw;
        state.step = 'confirm';
        return `Thanks. Let me confirm: ${state.data.name}, ${state.data.clientType || 'new'} client, incident "${state.data.incident}", on ${state.data.date}, in ${state.data.location}. Is that correct?`;
      }

      case 'confirm': {
        if (yes) { state.step = 'done'; return "Perfect. I’ll connect you to an attorney now."; }
        if (no)  { state.step = 'name'; return "No problem. Let’s fix it. What’s your full name?"; }
        return "Is that information correct?";
      }

      default:
        return "Thanks—how can I help you regarding a personal injury matter today?";
    }
  }

  return {
    opening,
    respond,
    isDone() { return state.step === 'done'; },
    getState() { return JSON.parse(JSON.stringify(state)); }
  };
}

function toTitle(s){ return s.replace(/\b([a-z])/gi, m => m.toUpperCase()); }

function extractDate(text) {
  if (!text) return null;
  const m =
    text.match(/\b(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?)\b/i) ||
    text.match(/\b(last|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i) ||
    text.match(/\b(yesterday|today)\b/i);
  return m ? m[0] : null;
}

module.exports = { createIntakeAgent };
