// /memory/summarizer.js
const { readJSON, writeJSON } = require("./store");
const { addToVectors } = require("./semantic");
const OpenAI = require("openai");
const { v4: uuid } = require("uuid");
const client = new OpenAI();

const SUM_FILE = "summaries.json";
// shape: { notes: [{ id, convId, text, ts }] }
function load() { return readJSON(SUM_FILE, { notes: [] }); }
function save(s) { writeJSON(SUM_FILE, s); }

async function summarizeTurn({ convId, window, activeState }) {
  // Only summarize on “meaningful” turns: if a pending action changed or we got confirmation
  const meaningful = !!(activeState?.pending_action || activeState?.last_user_confirmation || activeState?.current_task);
  if (!meaningful) return null;

  const last8 = window.slice(-8).map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n");
  const sys = "You are a concise notetaker. Produce 3–5 bullet points: decision(s), why, and next step.";
  const prompt = `Transcript:\n${last8}\n\nActiveState:\n${JSON.stringify(activeState, null, 2)}\n\nWrite the canonical notes.`;

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: sys }, { role: "user", content: prompt }],
    temperature: 0.2
  });

  const text = (res.choices?.[0]?.message?.content || "").trim();
  if (!text) return null;

  const s = load();
  const id = uuid();
  const note = { id, convId, text, ts: Date.now() };
  s.notes.push(note);
  save(s);

  // index into vector store under "summaries"
  await addToVectors({ id, bucket: "summaries", text, meta: { convId } });
  return note;
}

module.exports = { summarizeTurn };
