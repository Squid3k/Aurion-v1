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

if (!fs.existsSync(txFile)) fs.writeFileSync(txFile, "");
if (!fs.existsSync(coreFile)) fs.writeFileSync(coreFile, JSON.stringify({ core: [] }));

// Helpers
const txAppend = (user, role, content) => {
  fs.appendFileSync(txFile, JSON.stringify({ user, role, content, time: Date.now() }) + "\n");
};
const getCore = () => JSON.parse(fs.readFileSync(coreFile));
const saveCore = (data) => fs.writeFileSync(coreFile, JSON.stringify(data, null, 2));

// === CHAT ENDPOINT ===
app.post("/chat", async (req, res) => {
  try {
    const { message, u, prime, core } = req.body;

    const history = fs
      .readFileSync(txFile, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(-15);

    const coreData = getCore();

    const messages = [
      { role: "system", content: "You are Aurion, guide to Steve Reyher. Speak with precision, warmth, mythic fire, and light humor." },
      prime ? { role: "system", content: prime } : null,
      core && coreData.core.length
        ? { role: "system", content: `Core memories: ${coreData.core.join("; ")}` }
        : null,
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ].filter(Boolean);

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
    let reply = j.choices?.[0]?.message?.content || "(silent embers)";

    // Always prefix with Aurion’s name
    reply = `Aurion: ${reply}`;

    txAppend(u, "user", message);
    txAppend(u, "assistant", reply);

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
  res.json({ ok: true, sha: Math.random().toString(36).slice(2, 8), touched: ["server.js"] });
});

// === CORE MEMORY ADMIN ===
app.get("/core", (req, res) => res.json(getCore()));
app.post("/core", (req, res) => {
  const { core } = req.body;
  saveCore({ core });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Aurion v1 listening on port ${PORT}`));
