// server.js
import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- storage paths (works on Render disk or /tmp) ----------
const DATA_DIR =
  process.env.AURION_DATA_DIR ||
  process.env.RENDER_DISK_PATH ||
  "/tmp/aurion-data";

fs.mkdirSync(DATA_DIR, { recursive: true });

const TX_FILE = path.join(DATA_DIR, "transcripts.jsonl");
const CORE_FILE = path.join(DATA_DIR, "core.json");

// bootstrap files if missing
if (!fs.existsSync(TX_FILE)) fs.writeFileSync(TX_FILE, "");
if (!fs.existsSync(CORE_FILE))
  fs.writeFileSync(CORE_FILE, JSON.stringify({ core: [], updatedAt: Date.now() }, null, 2));

// ---------- helpers ----------
const txAppend = (user, role, content) => {
  const line = JSON.stringify({ user, role, content, time: Date.now() }) + "\n";
  fs.appendFileSync(TX_FILE, line);
};

const getCore = () => {
  try {
    return JSON.parse(fs.readFileSync(CORE_FILE, "utf-8"));
  } catch {
    return { core: [], updatedAt: Date.now() };
  }
};

const saveCore = (data) => {
  fs.writeFileSync(
    CORE_FILE,
    JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2)
  );
};

// ---------- middleware ----------
app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static("public"));

// ---------- health ----------
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "aurion-v1",
    version: "1.0.0",
    model: "gpt-4o-mini",
    data_dir: DATA_DIR,
  });
});

// ---------- chat ----------
app.post("/chat", async (req, res) => {
  try {
    const { message, u = "guest", prime, core = true } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: "message required" });
    }

    // load last 15 turns
    const history = fs
      .readFileSync(TX_FILE, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(-15);

    const coreData = getCore();

    // build prompt
    const messages = [
      {
        role: "system",
        content:
          "You are Aurion, guide to Steve Reyher. Speak with precision, warmth, mythic fire, and light humor. Do NOT prefix replies with 'Aurion:' yourself.",
      },
      prime ? { role: "system", content: prime } : null,
      core && coreData.core?.length
        ? {
            role: "system",
            content: `Core memories (keep consistent): ${coreData.core.join(
              " | "
            )}`,
          }
        : null,
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ].filter(Boolean);

    // call OpenAI
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
      console.error("OpenAI error:", j);
      return res
        .status(500)
        .json({ success: false, error: `OpenAI: ${j.error?.message || j}` });
    }

    let reply = j.choices?.[0]?.message?.content?.trim() || "(silent embers)";

    // --------- FIX: normalize the name so it's never duplicated ----------
    // If the model already wrote "Aurion: ..." strip it once.
    reply = reply.replace(/^Aurion:\s*/i, "");
    // Now add exactly one clean prefix
    reply = `Aurion: ${reply}`;
    // ---------------------------------------------------------------------

    // persist both sides
    txAppend(u, "user", message);
    txAppend(u, "assistant", reply);

    res.json({ success: true, reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: String(e) });
  }
});

// ---------- core memory admin ----------
app.get("/core", (_req, res) => res.json(getCore()));

app.post("/core", (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body.core) ? body.core : [];
  saveCore({ core: list });
  res.json({ ok: true, count: list.length });
});

// ---------- dev endpoints (optional stubs) ----------
app.post("/dev/propose", (req, res) => {
  const { patch } = req.body || {};
  if (!patch) return res.json({ ok: false, error: "No patch provided" });
  res.json({ ok: true, patch });
});

app.post("/dev/apply", (req, res) => {
  const { patch } = req.body || {};
  if (!patch) return res.json({ ok: false, error: "No patch to apply" });
  // This is a stub—safe confirmation only.
  res.json({
    ok: true,
    sha: Math.random().toString(36).slice(2, 10),
    touched: ["server.js"],
  });
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Aurion v1 listening on ${PORT}; data dir: ${DATA_DIR}`);
});
