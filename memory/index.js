// /memory/index.js
const { load, save, getConv, pushWindow } = require("./state");
const { addToVectors, searchVectors } = require("./semantic");
const { bucketsForIntent } = require("./policy");
const { summarizeTurn } = require("./summarizer");

async function recordUser({ convId, text }) {
  const state = load();
  const conv = getConv(state, convId);
  pushWindow(conv, "user", text);
  save(state);
}

async function recordAssistant({ convId, text }) {
  const state = load();
  const conv = getConv(state, convId);
  pushWindow(conv, "assistant", text);
  save(state);
}

function setActiveState({ convId, patch }) {
  const state = load();
  const conv = getConv(state, convId);
  Object.assign(conv, patch); // patch top-level fields (pending_action, etc.)
  save(state);
  return conv;
}

function getActiveState({ convId }) {
  const state = load();
  const conv = getConv(state, convId);
  return {
    pending_action: conv.pending_action,
    last_user_confirmation: conv.last_user_confirmation,
    current_task: conv.current_task,
    persona_flags: conv.persona_flags,
  };
}

function getWindow({ convId }) {
  const state = load();
  return getConv(state, convId).window;
}

async function retrieveContext({ convId, userQuery, intent = "general", k = 5 }) {
  // Hard preference order: Active State → Window → Summaries (RAG)
  const active = getActiveState({ convId });
  const window = getWindow({ convId });

  // Build context packets; always available pieces first
  const packets = [];
  packets.push({ kind: "active_state", text: JSON.stringify(active) });
  packets.push({ kind: "window", text: window.map(m => `${m.role}: ${m.content}`).join("\n") });

  // Targeted RAG
  try {
    const buckets = bucketsForIntent(intent);
    const rag = await searchVectors({ query: userQuery, buckets, k });
    if (rag.length) {
      packets.push({
        kind: "retrieval",
        text: rag.map(r => `(${r.bucket} • ${r.score.toFixed(2)}) ${r.text}`).join("\n---\n")
      });
    }
  } catch (e) {
    // swallow RAG errors → stability first
  }

  return packets;
}

async function indexDecision({ bucket, text, meta }) {
  await addToVectors({ id: `${bucket}-${Date.now()}`, bucket, text, meta });
}

async function postTurn({ convId }) {
  const state = load();
  const conv = getConv(state, convId);
  const note = await summarizeTurn({ convId, window: conv.window, activeState: {
    pending_action: conv.pending_action,
    last_user_confirmation: conv.last_user_confirmation,
    current_task: conv.current_task,
    persona_flags: conv.persona_flags
  }});
  return note;
}

module.exports = {
  recordUser,
  recordAssistant,
  setActiveState,
  getActiveState,
  getWindow,
  retrieveContext,
  indexDecision,
  postTurn
};
