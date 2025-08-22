// lib/twilioHandler.js
require('dotenv').config();
const { twiml: { VoiceResponse } } = require('twilio');

function wsUrl() {
  const route = process.env.AUDIO_STREAM_ROUTE || '/audio-stream';
  // Prefer ngrok host you set in .env; fall back to HOSTNAME or localhost
  const host  = process.env.AUDIO_STREAM_DOMAIN
             || process.env.HOSTNAME
             || 'localhost';
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

  connect.stream({
    url: wsUrl(),
    // (no params required; media + events handled by your WS handler)
  });

  res.type('text/xml').send(resp.toString());
}

module.exports = { handleTwilioCall };
