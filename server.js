// Top of server.js (keep all your existing code)
const { installAurionAddons } = require('./aurion_addons');

// ... your existing server setup ...
// Example:
const express = require('express');
const app = express();

// ✅ Install Aurion add-ons without removing any existing routes
installAurionAddons(app);

// (keep your existing routes/endpoints intact)

// Start server (keep your existing listen)
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ---- storage (works locally; on Render set a Disk or DATA_DIR) ----
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "aurion-data");
const TX_FILE   = path.join(DATA_DIR, "transcripts.jsonl");
const CORE_FILE = path.join(DATA_DIR, "core.json");
const BK_DIR    = path.join(DATA_DIR, "backups");
const PT_DIR    = path.join(DATA_DIR, "patches");

for (const p of [DATA_DIR, BK_DIR, PT_DIR]) fs.mkdirSync(p, { recursive: true });
if (!fs.existsSync(TX_FILE)) fs.writeFileSync(TX_FILE, "");
if (!fs.existsSync(CORE_FILE)) fs.writeFileSync(CORE_FILE, JSON.stringify({ core: [] }, null, 2));

// ---- app middleware ----
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- helpers ----
const readCore = () => JSON.parse(fs.readFileSync(CORE_FILE, "utf8"));
const saveCore = (coreArr) => fs.writeFileSync(CORE_FILE, JSON.stringify({ core: coreArr }, null, 2));

function appendTx(user, role, content) {
  fs.appendFileSync(TX_FILE, JSON.stringify({ user, role, content, time: Date.now() }) + "\n");
}

function historyFor(user, limit = 20) {
  const lines = fs.readFileSync(TX_FILE, "utf8").trim().split("\n").filter(Boolean);
  const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return parsed.filter(x => x.user === user).slice(-limit).map(x => ({ role: x.role, content: x.content }));
}

// ---- endpoints ----
app.get("/health", (_, res) => res.json({ ok: true }));

// chat
app.post("/chat", async (req, res) => {
  try {
    const { message, u = "default", prime = "", core = true } = req.body || {};
    if (!message) return res.status(400).json({ error: "missing message" });

    const msgs = [
      { role: "system", content: "You are Aurion, a friendly mythic guide. Be precise, warm, lightly humorous. Never repeat your name. If your reply does not already start with 'Aurion:', add 'Aurion: ' once." }
    ];

    if (prime) msgs.push({ role: "system", content: prime });

    if (core) {
      const c = readCore()?.core ?? [];
      if (c.length) msgs.push({ role: "system", content: `Core memories: ${c.join("; ")}` });
    }

    msgs.push(...historyFor(u));
    msgs.push({ role: "user", content: message });

    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: "OPENAI_API_KEY not set" });

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: msgs
      })
    });

    const j = await r.json();
    let reply = j?.choices?.[0]?.message?.content?.trim() || "(silent embers)";

    // enforce single prefix
    if (!/^Aurion:\s*/i.test(reply)) reply = `Aurion: ${reply}`;
    reply = reply.replace(/^Aurion:\s*Aurion:\s*/i, "Aurion: ");

    appendTx(u, "user", message);
    appendTx(u, "assistant", reply);

    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// core memory admin
app.get("/core", (_, res) => res.json(readCore()));
app.post("/core", (req, res) => {
  const { core } = req.body || {};
  if (!Array.isArray(core)) return res.status(400).json({ error: "core must be an array of strings" });
  saveCore(core);
  res.json({ ok: true });
});

// propose/apply patch (backup first)
app.post("/dev/propose", (req, res) => {
  const { patch } = req.body || {};
  if (!patch || typeof patch !== "string") return res.json({ ok: false, error: "no patch" });
  res.json({ ok: true });
});

app.post("/dev/apply", (req, res) => {
  try {
    const { patch, target = "server.js" } = req.body || {};
    if (!patch) return res.json({ ok: false, error: "no patch" });

    const targetPath = path.join(__dirname, target);
    if (!fs.existsSync(targetPath)) return res.json({ ok: false, error: `target not found: ${target}` });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(BK_DIR, `${stamp}_${path.basename(target)}`);
    fs.copyFileSync(targetPath, backup);

    const patchFile = path.join(PT_DIR, `${stamp}.patch.txt`);
    fs.writeFileSync(patchFile, patch);

    fs.writeFileSync(targetPath, patch); // replace file with new contents
    res.json({ ok: true, backup: path.basename(backup), patch: path.basename(patchFile) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`Aurion v1 listening on ${PORT}`));
