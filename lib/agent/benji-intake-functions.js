// lib/agent/benji-intake-functions.js
// Client-side function handlers for Deepgram Agent function calling.
// Stores intake data in-memory per streamSid.

const sessions = new Map(); // key = streamSid, value = { data, createdAt }

function getSess(streamSid) {
  if (!sessions.has(streamSid)) {
    sessions.set(streamSid, {
      createdAt: Date.now(),
      data: {
        client_type: null,   // "existing" | "new"
        name: null,          // "Erik Daniel Robinson"
        incident: null,      // brief description
        date: null,          // "June 5th" / "last Friday"
        location: null,      // "San Diego, CA"
        phone: null,
        email: null
      }
    });
  }
  return sessions.get(streamSid);
}

// Simple heuristics for quick eligibility
const SUPPORTED_STATES = (process.env.BENJI_STATES || 'CA,AZ,NV,WA,OR,TX')
  .split(',').map(s => s.trim().toUpperCase());
const MAX_EVENT_AGE_DAYS = parseInt(process.env.INTAKE_MAX_EVENT_DAYS || '730', 10);
const SIGNAL = /(accident|collision|rear[- ]?ended|slip|fall|dog bite|injur|fracture|concussion|uber|lyft|truck|work)/i;

function approxEventDaysAgo(textDate = '') {
  const t = textDate.toLowerCase();
  const now = new Date();
  const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  if (t.includes('today')) return 0;
  if (t.includes('yesterday')) return 1;
  const m = t.match(/\b(last|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (m) {
    const idx = WEEKDAYS.indexOf(m[2]);
    const delta = (now.getDay() - idx + 7) % 7;
    return m[1] === 'this' ? delta : delta + 7;
  }
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t)) return 180;
  return 365;
}
function stateFromLocation(loc='') {
  const m = loc.match(/\b([A-Z]{2})\b/i);
  return m ? m[1].toUpperCase() : null;
}
function assessEligibility(data) {
  const reasons = [];
  const st = stateFromLocation(data.location || '');
  const days = approxEventDaysAgo(data.date || '');
  const hasSignal = SIGNAL.test(data.incident || '');
  if (!st || !SUPPORTED_STATES.includes(st)) reasons.push('Out-of-coverage location');
  if (!hasSignal) reasons.push('Incident description lacks injury/accident signal');
  if (days > MAX_EVENT_AGE_DAYS) reasons.push('Older than typical statute/priority window');
  const eligible = reasons.length === 0;
  let action = eligible ? 'transfer' : (reasons.length === 1 && reasons[0].includes('signal') ? 'collect_more' : 'schedule_callback');
  return { eligible, reasons, action };
}

// --------- Function definitions we advertise to the Agent ----------
const FUNCTION_DEFINITIONS = [
  {
    name: 'save_field',
    description: 'Store one intake field after the caller answers.',
    json_schema: {
      type: 'object',
      properties: {
        field: { type:'string', enum:['client_type','name','incident','date','location','phone','email'] },
        value: { type:'string' }
      },
      required: ['field','value'],
      additionalProperties: false
    }
  },
  {
    name: 'confirm_fields',
    description: 'Return a one-sentence summary of current fields.',
    json_schema: { type:'object', properties:{}, additionalProperties:false }
  },
  {
    name: 'eligibility_assess',
    description:'Assess likely eligibility based on stored fields.',
    json_schema: { type:'object', properties:{}, additionalProperties:false }
  },
  {
    name: 'persist_intake',
    description:'Persist intake (in-memory stub) and return an id.',
    json_schema: { type:'object', properties:{}, additionalProperties:false }
  }
];

// --------- Handler for FunctionCallRequest ----------
async function handleFunctionCallRequest({ streamSid, fn }) {
  const sess = getSess(streamSid);
  const data = sess.data;
  let args = {};
  try { args = fn?.arguments ? JSON.parse(fn.arguments) : {}; } catch {}
  switch (fn?.name) {
    case 'save_field': {
      const { field, value } = args || {};
      if (!field || typeof value !== 'string') return wrap(fn, { ok:false, error:'Invalid args' });
      let v = value.trim();
      if (field === 'client_type') {
        const l = v.toLowerCase();
        v = /\b(existing|current)\b/.test(l) ? 'existing' : 'new';
      } else if (field === 'name') {
        v = v.replace(/\s+/g,' ').split(' ')
             .map(w => w ? (w[0].toUpperCase()+w.slice(1)) : '')
             .join(' ').trim();
      } else if (field === 'phone') {
        const d = v.replace(/\D+/g,'');
        v = d.length === 10 ? `+1${d}` : (d.startsWith('1') && d.length===11 ? `+${d}` : v);
      }
      data[field] = v;
      return wrap(fn, { ok:true, saved:{ [field]:v }, data });
    }
    case 'confirm_fields': {
      const parts = [];
      if (data.name) parts.push(`${data.name}`);
      if (data.client_type) parts.push(`${data.client_type} client`);
      if (data.incident) parts.push(`incident "${data.incident}"`);
      if (data.date) parts.push(`on ${data.date}`);
      if (data.location) parts.push(`in ${data.location}`);
      if (data.phone) parts.push(`phone ${data.phone}`);
      if (data.email) parts.push(`email ${data.email}`);
      const summary = parts.length ? parts.join(', ') : 'No details captured yet.';
      return wrap(fn, { ok:true, summary, data });
    }
    case 'eligibility_assess': {
      const result = assessEligibility(data);
      return wrap(fn, { ok:true, result, data });
    }
    case 'persist_intake': {
      const id = `intake_${streamSid}_${Date.now()}`;
      return wrap(fn, { ok:true, id, data });
    }
    default:
      return wrap(fn, { ok:false, error:'Unknown function' });
  }
}
function wrap(fn, payload) {
  return { name: fn?.name || 'unknown', content: JSON.stringify(payload) };
}

module.exports = {
  FUNCTION_DEFINITIONS,
  handleFunctionCallRequest,
  _intakeMemory: sessions
};
