// lib/finalize-intake.js
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const OpenAI = require('openai');

// ---- OpenAI client (requires OPENAI_API_KEY in .env) ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Load & compile JSON Schema ----
const schemaPath = path.join(__dirname, '..', 'schemas', 'intake-schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({
  allErrors: true,
  removeAdditional: 'failing',
  strict: false
});
addFormats(ajv);
const validate = ajv.compile(schema);

// ---- Helpers ----
const S = (v) => (typeof v === 'string' ? v.trim() : v);

const BASE_CONF = {
  clientType: 0.7,
  fullName: 0.6,
  phone: 0.85,
  email: 0.85,
  incidentDescription: 0.55,
  incidentDate: 0.7,
  incidentLocation: 0.6
};

// Map your shadow intake (from the bridge) to canonical keys
function mapShadowToCanonical(shadow) {
  const out = {};
  if (shadow.client_type) out.clientType = shadow.client_type;
  if (shadow.full_name) out.fullName = shadow.full_name;
  if (shadow.phone) out.phone = normalizePhone(shadow.phone);
  if (shadow.email) out.email = shadow.email;
  if (shadow.incident) out.incidentDescription = shadow.incident;
  if (shadow.date) out.incidentDate = normalizeDate(shadow.date);
  if (shadow.location) out.incidentLocation = shadow.location;

  const confidence = {};
  for (const k of Object.keys(out)) {
    confidence[k] = BASE_CONF[k] ?? 0.5;
  }
  return { partial: out, confidence };
}

function normalizePhone(text) {
  if (!text) return null;
  const digits = (String(text).match(/\d/g) || []).join('');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return text; // leave as-is; LLM may normalize
}

function normalizeDate(input) {
  if (!input) return null;
  const t = String(input).trim();

  // yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  // mm/dd[/yy(yy)]
  const m = t.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (m) {
    let [, mm, dd, yy] = m;
    if (!yy) yy = String(new Date().getFullYear());
    else if (yy.length === 2) yy = String(2000 + parseInt(yy, 10));
    return `${yy.padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  return t; // natural language; let LLM resolve
}

function buildLLMPrompt(transcript, seed, schema) {
  return [
    {
      role: 'system',
      content:
        `You convert messy phone-call transcripts into STRICT JSON for a legal intake.\n` +
        `- Output ONLY a JSON object, no prose.\n` +
        `- If uncertain, set a field to null (do not guess).\n` +
        `- Include a "confidence" object with per-field scores in [0,1].\n` +
        `- Include "sourceUtterances" mapping field -> array of raw USER lines supporting it.\n` +
        `- Follow the provided JSON Schema; do not add extra top-level keys.`
    },
    {
      role: 'user',
      content:
`JSON Schema (reference):
${JSON.stringify(schema, null, 2)}

Seed data from realtime extractors (may be partial or noisy):
${JSON.stringify(seed, null, 2)}

Transcript (chronological; focus on USER lines for evidence):
${transcript.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Return ONLY a JSON object with keys:
{ "clientType","fullName","phone","email","incidentDescription","incidentDate","incidentLocation","meta","confidence","sourceUtterances" }`
    }
  ];
}

async function callOpenAIForIntake(transcripts, seed, schema) {
  const messages = buildLLMPrompt(transcripts, seed, schema);
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  const resp = await openai.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages
  });

  const txt = resp.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(txt); } catch { parsed = {}; }
  parsed.confidence = parsed.confidence || {};
  parsed.sourceUtterances = parsed.sourceUtterances || {};
  parsed.meta = parsed.meta || {};
  return parsed;
}

function mergeResults(shadow, llm) {
  const fields = [
    'clientType', 'fullName', 'phone', 'email',
    'incidentDescription', 'incidentDate', 'incidentLocation'
  ];

  const out = { meta: {}, confidence: {}, sourceUtterances: {} };

  for (const f of fields) {
    const sVal = S(shadow.partial[f]);
    const lVal = S(llm[f]);
    const sConf = shadow.confidence[f] ?? 0;
    const lConf = typeof llm.confidence?.[f] === 'number' ? llm.confidence[f] : 0;

    if (sVal && !lVal) {
      out[f] = sVal;
      out.confidence[f] = sConf;
      out.sourceUtterances[f] = llm.sourceUtterances?.[f] || [];
    } else if (!sVal && lVal) {
      out[f] = lVal;
      out.confidence[f] = lConf;
      out.sourceUtterances[f] = llm.sourceUtterances?.[f] || [];
    } else if (sVal && lVal) {
      // prefer higher confidence; slight bias to LLM if close (format normalization)
      if (lConf >= sConf - 0.05) {
        out[f] = lVal;
        out.confidence[f] = Math.max(lConf, sConf * 0.95);
      } else {
        out[f] = sVal;
        out.confidence[f] = Math.max(sConf, lConf * 0.95);
      }
      out.sourceUtterances[f] = llm.sourceUtterances?.[f] || [];
    } else {
      out[f] = null;
      out.confidence[f] = 0;
      out.sourceUtterances[f] = [];
    }
  }

  // meta prefers LLM, then finalized below by caller
  out.meta = { ...(llm.meta || {}), source: llm.meta?.source || 'post-call' };
  return out;
}

function validateOrReport(obj) {
  const ok = validate(obj);
  return { ok, errors: validate.errors || [] };
}

/**
 * finalizeIntake
 * @param {{
 *   transcripts: string[],
 *   client_type?: string, full_name?: string, phone?: string, email?: string,
 *   incident?: string, date?: string, location?: string
 * }} shadowState
 * @param {{ callStartedAt?: string, callEndedAt?: string }} meta
 * @returns {Promise<object>} validated CaseIntake JSON
 */
async function finalizeIntake(shadowState, meta = {}) {
  const transcripts = Array.isArray(shadowState.transcripts) ? shadowState.transcripts : [];
  const transcriptHash = crypto.createHash('sha1').update(transcripts.join('\n')).digest('hex');

  const shadowMapped = mapShadowToCanonical(shadowState);
  const seed = {
    ...shadowMapped.partial,
    meta: {
      transcriptHash,
      callStartedAt: meta.callStartedAt || null,
      callEndedAt: meta.callEndedAt || null,
      source: 'live-call'
    },
    confidence: shadowMapped.confidence,
    sourceUtterances: {}
  };

  // LLM normalization
  const llm = await callOpenAIForIntake(transcripts, seed, schema);

  // Merge shadow + LLM
  const merged = mergeResults({ partial: seed, confidence: seed.confidence }, llm);

  // Final meta stamp
  merged.meta = {
    transcriptHash,
    callStartedAt: meta.callStartedAt || null,
    callEndedAt: meta.callEndedAt || null,
    source: 'post-call'
  };

  // Validate
  const { ok, errors } = validateOrReport(merged);
  if (!ok) {
    console.warn('[finalizeIntake] schema errors:', errors);
  }
  return merged;
}

// Mid-call checkpoint (no LLM) — handy for dashboards
function checkpoint(shadowState) {
  const transcripts = Array.isArray(shadowState.transcripts) ? shadowState.transcripts : [];
  const transcriptHash = crypto.createHash('sha1').update(transcripts.join('\n')).digest('hex');
  const { partial, confidence } = mapShadowToCanonical(shadowState);
  return {
    ...partial,
    meta: { transcriptHash, source: 'live-call' },
    confidence,
    sourceUtterances: {}
  };
}

module.exports = { finalizeIntake, checkpoint };
