import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static("public"));

// === MEMORY FILES ===
const txFile = "transcripts.jsonl";
const coreFile = "core.json";

// Ensure files exist
if (!fs.existsSync(txFile)) fs.writeFileSync(txFile, "");
if (!fs.existsSync(coreFile)) fs.writeFileSync(coreFile, JSON.stringify({ core: [] }, null, 2));

// Helpers
const txAppend = (user, role, content) => {
  fs.appendFileSync(
    txFile,
    JSON.stringify({ user, role, content, time: Date.now() }) + "\n"
  );
};
const getCore = () => {
  try {
    const raw = fs.readFileSync(coreFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return { core: [] };
  }
};
const saveCore = (data) => fs.writeFileSync(coreFile, JSON.stringify(data, null, 2));

// Trim any accidental "Aurion:" leader from text
const stripAurion = (s = "") => s.replace(/^\s*aurion\s*:\s*/i, "");

// === CHAT ENDPOINT ===
app.post("/chat", async (req, res) => {
  try {
    const { message, u, prime, core } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, error: "message required" });
    }

    // Load recent history (last 15), stripping any old "Aurion:" prefixes
    const history = fs
      .readFileSync(txFile, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(-15)
      .map((h) => ({
        role: h.role,
        content: h.role === "assistant" ? stripAurion(h.content) : h.content,
      }));

    // Core memories
    const coreData = getCore();
    const coreMemories = Array.isArray(coreData.core) ? coreData.core : [];

    // Optional PRIME: prefer body.prime, fallback to env
    const primeObjective = (prime && String(prime)) || process.env.AURION_PRIME || "";

    // Build messages for OpenAI
    const baseSystem =
      "You are Aurion, guide to Steve Reyher. Speak with precision, warmth, and mythic fire. " +
      "Use light humor when fitting. Do NOT prepend your name or 'Aurion:' to replies. " +
      "Be concise unless asked for depth.";

    const messages = [
      { role: "system", content: baseSystem },
      primeObjective ? { role: "system", content: `Prime objective: ${primeObjective}` } : null,
      (core && coreMemories.length) || (!("core" in req.body) && coreMemories.length)
        ? null // we’ll inject each core memory as its own system message below
        : null,
      // add core memories as individual system messages for stronger recall
      ...coreMemories.map((m) => ({ role: "system", content: `Core memory: ${m}` })),
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ].filter(Boolean);

    // Call OpenAI
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
      }),
    });

    const j = await r.json();

    if (!r.ok) {
      // Bubble up OpenAI error details for easier debugging
      const detail = j?.error?.message || JSON.stringify(j);
      return res.status(500).json({ success: false, error: `OpenAI error ${r.status}: ${detail}` });
    }

    // Model reply (no "Aurion:" leader; UI can label)
    let reply = j.choices?.[0]?.message?.content || "(silent embers)";
    reply = stripAurion(reply);

    // Save transcript (store raw content; UI adds label)
    txAppend(u || "anon", "user", message);
    txAppend(u || "anon", "assistant", reply);

    res.json({ success: true, reply });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// === DEV PATCHING ENDPOINTS ===
app.post("/dev/propose", (req, res) => {
  const { patch } = req.body;
  if (!patch) return res.json({ ok: false, error: "No patch provided" });
  res.json({ ok: true, patch });
});

app.post("/dev/apply", (req, res) => {
  const { patch } = req.body;
  if (!patch) return res.json({ ok: false, error: "No patch to apply" });
  res.json({
    ok: true,
    sha: Math.random().toString(36).slice(2, 8),
    touched: ["server.js"],
  });
});

// === CORE MEMORY ADMIN ===
app.get("/core", (req, res) => res.json(getCore()));
app.post("/core", (req, res) => {
  const { core } = req.body;
  const list = Array.isArray(core) ? core : [];
  saveCore({ core: list });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Aurion v1 listening on port ${PORT}`));
