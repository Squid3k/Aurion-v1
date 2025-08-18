// /memory/state.js
const { readJSON, writeJSON } = require("./store");

const STATE_FILE = "state.json";
const DEFAULT = { conversations: {} };

function load() { return readJSON(STATE_FILE, DEFAULT); }
function save(s) { writeJSON(STATE_FILE, s); }

function getConv(state, cid) {
  if (!state.conversations[cid]) {
    state.conversations[cid] = {
      // active state:
      pending_action: null,
      last_user_confirmation: null,
      current_task: null,
      persona_flags: { aurion_mode: true },

      // short-term window (last 12 turns):
      window: [] // [{role, content, ts}]
    };
  }
  return state.conversations[cid];
}

function pushWindow(conv, role, content) {
  conv.window.push({ role, content, ts: Date.now() });
  if (conv.window.length > 12) conv.window.shift();
}

module.exports = {
  load, save, getConv, pushWindow
};
