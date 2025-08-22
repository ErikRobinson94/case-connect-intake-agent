require('dotenv').config();
const { twiml: { VoiceResponse } } = require('twilio');

function cleanHost(h) {
  if (!h) return '';
  return String(h).replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').trim();
}

function wsUrl(req) {
  const route = process.env.AUDIO_STREAM_ROUTE || '/audio-stream';

  // Prefer explicit override from env (useful locally), else the request Host header (Render)
  const override = cleanHost(process.env.AUDIO_STREAM_DOMAIN || process.env.HOSTNAME);
  const hostFromReq =
    cleanHost(req.headers['x-forwarded-host'] || req.headers['host']) || 'localhost';

  const host = override || hostFromReq;

  // Twilio requires TLS for media streams → always use wss://
  return `wss://${host}${route}`;
}

/**
 * Twilio Voice webhook -> returns TwiML that opens a *bidirectional* media WS
 * to our Node server. Twilio will send inbound audio and accept outbound audio
 * on the same socket.
 */
function handleTwilioCall(req, res) {
  const resp = new VoiceResponse();
  const connect = resp.connect();

  connect.stream({ url: wsUrl(req) });

  res.type('text/xml').send(resp.toString());
}

module.exports = { handleTwilioCall };
