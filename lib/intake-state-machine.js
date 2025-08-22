// lib/intake-state-machine.js
const { EventEmitter } = require('events');

function titleCase(s='') {
  return s.trim().replace(/\s+/g,' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function extractClientType(t='') {
  const s = t.toLowerCase();
  if (/\b(existing|current)\b/.test(s)) return 'existing';
  if (/\b(new)\b/.test(s)) return 'new';
  if (/\b(accident|injur|crash|collision|hit|fell|slip|trip|truck|car|bus|uber|lyft)\b/.test(s)) return 'new';
  return null;
}

function extractFullName(t='') {
  const m = t.match(/\b([A-Z][a-z]+)\s+([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\b/);
  if (m) return titleCase(`${m[1]} ${m[2]}`);
  const n = t.match(/\b(?:my name is|this is|i am|i'm)\s+([a-z][a-z\s\.'-]{2,})$/i);
  if (n) {
    const cand = titleCase(n[1]);
    if (cand.split(' ').length >= 2) return cand;
  }
  return null;
}

function extractPhone(t='') {
  const m = t.match(/(\+?1[\s\-\.]?)?(\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4})/);
  if (!m) return null;
  const digits = m[0].replace(/[^\d]/g,'');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function extractEmail(t='') {
  const m = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}

function extractDate(t='') {
  const m =
    t.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/) ||
    t.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?/i) ||
    t.match(/\b(?:today|yesterday|last\s+(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?)\b/i);
  return m ? m[0] : null;
}

function looksIncidenty(t='') {
  return /\b(accident|injur|crash|collision|rear[- ]?ended|hit|dog|bite|slip|trip|work|car|uber|lyft|truck|bicycle|pedestrian|bus|motorcycle)\b/i.test(t);
}
function extractIncident(t='') {
  const s = t.trim();
  if (!s) return null;
  if (looksIncidenty(s) || s.split(/\s+/).length >= 5) return s.replace(/\.+$/,'');
  return null;
}

function extractLocation(t='') {
  const m = t.match(/\b(?:in|at)\s+([A-Za-z][A-Za-z\.\-']+(?:\s+[A-Za-z\.\-']+)*)(?:,\s*([A-Za-z]{2,}))?\b/);
  if (m) {
    const phrase = m[1].trim();
    // Guard against false positives like "in an accident"
    if (/^(an?|the)\s+(accident|injury|crash)$/i.test(phrase)) return null;
    const city = titleCase(phrase);
    const st   = m[2] ? m[2].toUpperCase() : '';
    return st ? `${city}, ${st}` : city;
  }
  return null;
}

class IntakeStateMachine extends EventEmitter {
  /**
   * @param {{
   *  firmName?: string,
   *  agentName?: string,
   *  repromptMs?: number,
   *  hardNudgeMs?: number,
   *  maxRepromptsPerState?: number
   * }} opts
   */
  constructor(opts = {}) {
    super();
    this.fields = {
      client_type: null,
      full_name:   null,
      phone:       null,
      email:       null,
      incident:    null,
      date:        null,
      location:    null,
    };

    this.firmName   = opts.firmName || 'Your Firm';
    this.agentName  = opts.agentName || 'Agent';
    this.repromptMs = Number.isFinite(opts.repromptMs) ? opts.repromptMs : 6000;
    this.hardNudgeMs= Number.isFinite(opts.hardNudgeMs)? opts.hardNudgeMs: 0; // default OFF
    this.maxRepromptsPerState = Number.isFinite(opts.maxRepromptsPerState) ? opts.maxRepromptsPerState : 1;

    this.state = 'AWAIT_CLIENT_TYPE';
    this._timers = new Set();
    this._cancelGeneration = 0;
    this._lastPromptText = '';
    this._lastPromptAt = 0;
    this._repromptCount = 0;

    // Only reprompt; greeting is played by the bridge.
    this._scheduleRepromptsFor(this.state);
  }

  teardown() {
    this._clearTimers();
    this.removeAllListeners();
  }

  _clearTimers() {
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    this._cancelGeneration++;
    this._repromptCount = 0;
  }

  _emitSay(text) {
    const s = String(text || '').trim();
    if (!s) return;
    const now = Date.now();
    if (s === this._lastPromptText && (now - this._lastPromptAt) < 1500) return;
    this._lastPromptText = s;
    this._lastPromptAt = now;
    this.emit('say', s);
  }

  _schedule(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
  }

  _scheduleRepromptsFor(state) {
    const gen = this._cancelGeneration + 1;

    const doSoft = () => {
      if (gen !== this._cancelGeneration + 1) return;
      if (this._repromptCount >= this.maxRepromptsPerState) return;
      this._repromptCount++;
      this.emit('reprompt', this._repromptTextFor(state));
    };

    const doHard = () => {
      if (!this.hardNudgeMs) return;
      if (gen !== this._cancelGeneration + 1) return;
      if (this._repromptCount >= this.maxRepromptsPerState) return;
      this._repromptCount++;
      this.emit('reprompt', this._hardNudgeTextFor(state));
    };

    if (this.repromptMs) this._schedule(doSoft, this.repromptMs);
    if (this.hardNudgeMs) this._schedule(doHard, this.hardNudgeMs);
  }

  _repromptTextFor(state) {
    switch (state) {
      case 'AWAIT_CLIENT_TYPE': return 'Please say “new” if you were in an accident, or “existing” if you’re already a client.';
      case 'AWAIT_NAME':        return 'Please say your first and last name clearly.';
      case 'AWAIT_PHONE':       return 'Please say ten digits for your phone number.';
      case 'AWAIT_EMAIL':       return 'Please say your email address, like name at gmail dot com.';
      case 'AWAIT_INCIDENT':    return 'Briefly, what happened? One sentence is fine.';
      case 'AWAIT_DATE':        return 'Please say the date, like June 5th 2025, or 06/05/2025.';
      case 'AWAIT_LOCATION':    return 'Where did it happen? City and place if you know it.';
      case 'CONFIRM':           return 'Please say yes if that’s correct, or say what needs to be fixed.';
      default: return '';
    }
  }
  _hardNudgeTextFor(state) {
    switch (state) {
      case 'AWAIT_CLIENT_TYPE': return 'Were you in an accident, or are you an existing client?';
      case 'AWAIT_NAME':        return 'What is your full name?';
      case 'AWAIT_PHONE':       return 'What is the best callback number? Say the digits clearly.';
      case 'AWAIT_EMAIL':       return 'What is your email address?';
      case 'AWAIT_INCIDENT':    return 'Can you tell me briefly what happened?';
      case 'AWAIT_DATE':        return 'What was the date? Month day and year is fine.';
      case 'AWAIT_LOCATION':    return 'Where did it happen? City and place if you know it.';
      case 'CONFIRM':           return 'Is everything correct?';
      default: return '';
    }
  }

  _promptFor(state) {
    switch (state) {
      case 'AWAIT_CLIENT_TYPE': return; // greeting already asked the question
      case 'AWAIT_NAME':        return this._emitSay('Thanks. What is your full name?');
      case 'AWAIT_PHONE':       return this._emitSay('What is the best callback number? Say the digits clearly.');
      case 'AWAIT_EMAIL':       return this._emitSay('What is your email address?');
      case 'AWAIT_INCIDENT':    return this._emitSay('Briefly, what happened? One sentence is fine.');
      case 'AWAIT_DATE':        return this._emitSay('What was the date? Month day and year is fine.');
      case 'AWAIT_LOCATION':    return this._emitSay('Where did it happen? City and place if you know it.');
      case 'CONFIRM': {
        const s = this._summary();
        return this._emitSay(`Let me read that back. ${s} Is everything correct?`);
      }
    }
  }

  _setField(name, value) {
    if (value && this.fields[name] !== value) {
      this.fields[name] = value;
      this.emit('field_set', { field: name, value });
    }
  }

  _setState(next) {
    if (this.state === next) return;
    this._clearTimers();
    this.state = next;
    this.emit('state', { state: this.state });
    this._promptFor(this.state);
    this._scheduleRepromptsFor(this.state);
  }

  _summary() {
    const f = this.fields;
    const safe = (x) => x ? String(x).replace(/\.*$/,'') : 'unspecified';
    return `Client type ${safe(f.client_type)}. Name ${safe(f.full_name)}. Phone ${safe(f.phone)}. Email ${safe(f.email)}. Incident: ${safe(f.incident)}. Date ${safe(f.date)}. Location ${safe(f.location)}.`;
  }

  handleUserText(text='') {
    const t = String(text || '').trim();
    if (!t) return;

    switch (this.state) {
      case 'AWAIT_CLIENT_TYPE': {
        const ct = extractClientType(t);
        if (ct) {
          this._setField('client_type', ct);
          // Do NOT opportunistically set location here (avoid "in an accident")
          // Incident can be captured later; keep it minimal on this turn.
          this._setState('AWAIT_NAME');
        }
        break;
      }
      case 'AWAIT_NAME': {
        const name = extractFullName(t);
        if (name) { this._setField('full_name', name); this._setState('AWAIT_PHONE'); }
        break;
      }
      case 'AWAIT_PHONE': {
        const ph = extractPhone(t);
        if (ph) { this._setField('phone', ph); this._setState('AWAIT_EMAIL'); }
        break;
      }
      case 'AWAIT_EMAIL': {
        const em = extractEmail(t);
        if (em) { this._setField('email', em); this._setState('AWAIT_INCIDENT'); }
        break;
      }
      case 'AWAIT_INCIDENT': {
        const inc = extractIncident(t);
        if (inc) { this._setField('incident', inc); this._setState('AWAIT_DATE'); }
        break;
      }
      case 'AWAIT_DATE': {
        const d = extractDate(t);
        if (d) { this._setField('date', d.replace(/\.$/,'')); this._setState('AWAIT_LOCATION'); }
        break;
      }
      case 'AWAIT_LOCATION': {
        const loc = extractLocation(t) || null;
        if (loc) { this._setField('location', String(loc).replace(/\.$/,'')); this._setState('CONFIRM'); }
        break;
      }
      case 'CONFIRM': {
        if (/\b(yes|yeah|correct|that'?s right|looks good)\b/i.test(t)) {
          this.emit('done', { fields: { ...this.fields }, summary: this._summary() });
          this._setState('DONE');
        } else if (/\b(no|not|fix|change|wrong|incorrect)\b/i.test(t)) {
          this._setState('AWAIT_INCIDENT');
        }
        break;
      }
    }
  }
}

module.exports = { IntakeStateMachine };
