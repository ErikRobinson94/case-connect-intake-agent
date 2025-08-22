// lib/audio-stream.js
const { setupBidiBridge } = require('./twilio-deepgram-agent-bridge');

function setupAudioStream(server) {
  const route = process.env.AUDIO_STREAM_ROUTE || '/audio-stream';
  setupBidiBridge(server, { route });
}

module.exports = { setupAudioStream };
