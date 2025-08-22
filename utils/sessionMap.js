
const sessionToCallSidMap = new Map();

module.exports = {
  store(session, callSid) {
    sessionToCallSidMap.set(session, callSid);
  },
  getCallSid(session) {
    return sessionToCallSidMap.get(session);
  },
  clear(session) {
    sessionToCallSidMap.delete(session);
  }
};
