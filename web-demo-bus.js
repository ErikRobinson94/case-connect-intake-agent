// A shared EventEmitter both the server routes and your Deepgram bridge can use.
const { EventEmitter } = require("events");
module.exports = global.__webDemoBus || (global.__webDemoBus = new EventEmitter());
