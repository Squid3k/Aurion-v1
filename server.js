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

app.use(bodyParser.json({ limit: "2mb" }));
app.use(express.static("public"));

// ====== STORAGE (persistent on Render Disk or project root) ======
const DATA_DIR = process.env.DATA_DIR || "./";
const TX_FILE   = path.join(DATA_DIR, "transcripts.jsonl");
const CORE_FILE = path.join(DATA_DIR, "core.json");

if (!fs.existsSync(TX_FILE))   fs.writeFileSync(TX_FILE, "");
if (!fs.existsSync(CORE_FILE)) fs.writeFileSync(CORE_FILE, JSON.stringify({ core: [] }, null, 2));

const txAppend = (user, role, content) => {
  fs.appendFileSync(TX_FILE, JSON.stringify({ user, role, content, time: Date.now() }) + "\n");
};
const getCore = () => JSON.parse(fs.readFileSync(CORE_FILE, "utf-8"));
const saveCore = (obj) => fs.writeFileSync(CORE_FILE, JSON.stringify(obj, null, 2));

// ====== CHAT ======
app.post("/chat", async (req, res) => {
  try {
    const { message, u = "anon", prime, useCore = true } = req.body || {};
    if (!message) return res.status(400).json({ success:false, error:"message required" });

    const history = fs
      .readFileSync(TX_FILE, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(l => JSON.parse(l))
      .slice(-15);

    const core = useCore ? getCore() : { core: [] };

    // Important: ONLY the server prefixes "Aurion:" (UI should not)
    const messages = [
      { role:"system", content:"You are Aurion, guide to Steve Reyher. Speak with precision, warmth, mythic fire, and light humor. Do NOT start your reply with your name unless explicitly requested; the system will prefix it." },
      prime ? { role:"system", content: prime } : null,
      (core.core?.length ? { role:"system", content: `Core memories: ${core.core.join("; ")}` } : null),
      ...history.map(h => ({ role:h.role, content:h.content })),
      { role:"user", content: message }
    ].filter(Boolean);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model:"gpt-4o-mini", messages })
    });

    const j = await r.json();
    if (!r.ok) throw new Error(`OpenAI error ${r.status}: ${JSON.stringify(j)}`);

    let reply = j.choices?.[0]?.message?.content?.trim() || "(silent embers)";
    reply = `Aurion: ${reply}`; // single prefix only

    txAppend(u, "user", message);
    txAppend(u, "assistant", reply);
    res.json({ success:true, reply });
  } catch (e) {
    res.status(500).json({ success:false, error:String(e) });
  }
});

// ====== CORE MEMORY ADMIN ======
app.get("/core", (_req, res) => res.json(getCore()));
app.post("/core", (req, res) => {
  const { core } = req.body || {};
  if (!Array.isArray(core)) return res.status(400).json({ ok:false, error:"core must be an array of strings" });
  saveCore({ core });
  res.json({ ok:true });
});

// ====== DEV: PROPOSE + APPLY (auto backup branch + PR) ======
// Env you must set on Render: GITHUB_TOKEN (repo scope), GH_OWNER, GH_REPO, GH_BASE (e.g. "main")
const GH = {
  token: process.env.GITHUB_TOKEN,
  owner: process.env.GH_OWNER,
  repo:  process.env.GH_REPO,
  base:  process.env.GH_BASE || "main"
};
const github = async (url, init={}) => {
  if (!GH.token || !GH.owner || !GH.repo) throw new Error("GitHub env not configured");
  const r = await fetch(`https://api.github.com${url}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${GH.token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(init.headers||{})
    }
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${JSON.stringify(j)}`);
  return j;
};
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// Create a short-lived “patch cache” so you can stage then apply
let LAST_PATCH = null;

// 1) Propose: validate & echo back
app.post("/dev/propose", (req, res) => {
  const { files, message = "Aurion dev patch" } = req.body || {};
  if (!Array.isArray(files) || files.length === 0)
    return res.status(400).json({ ok:false, error:"Provide files: [{path, content}]" });

  // minimal validation
  for (const f of files) {
    if (!f.path || typeof f.content !== "string")
      return res.status(400).json({ ok:false, error:"Each file needs path + content (string)" });
  }
  LAST_PATCH = { files, message, time: Date.now() };
  res.json({ ok:true, patch: LAST_PATCH });
});

// 2) Apply: create branch from base, upsert files, open PR
app.post("/dev/apply", async (_req, res) => {
  try {
    if (!LAST_PATCH) return res.status(400).json({ ok:false, error:"No patch staged" });

    // Get base SHA
    const baseRef = await github(`/repos/${GH.owner}/${GH.repo}/git/ref/heads/${GH.base}`);
    const baseSha = baseRef.object.sha;

    // Create backup branch name
    const branch = `aurion-auto-${new Date().toISOString().replace(/[:.]/g,"-")}`;

    // Create branch (ref)
    await github(`/repos/${GH.owner}/${GH.repo}/git/refs`, {
      method:"POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha })
    });

    // Upsert each file via Contents API
    for (const f of LAST_PATCH.files) {
      // Check if file exists to include its SHA (update vs create)
      let sha = undefined;
      try {
        const existing = await github(`/repos/${GH.owner}/${GH.repo}/contents/${encodeURIComponent(f.path)}?ref=${branch}`);
        sha = existing.sha;
      } catch { /* not found → create */ }

      await github(`/repos/${GH.owner}/${GH.repo}/contents/${encodeURIComponent(f.path)}`, {
        method:"PUT",
        body: JSON.stringify({
          message: `[aurion] ${LAST_PATCH.message}`,
          content: b64(f.content),
          branch,
          sha
        })
      });
    }

    // Open PR
    const pr = await github(`/repos/${GH.owner}/${GH.repo}/pulls`, {
      method:"POST",
      body: JSON.stringify({
        title: `[aurion] ${LAST_PATCH.message}`,
        head: branch,
        base: GH.base,
        body: "Auto-created by Aurion dev console. Please review and merge."
      })
    });

    const result = { ok:true, branch, pr: { number: pr.number, url: pr.html_url } };
    LAST_PATCH = null; // clear staged patch
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ====== HEALTH ======
app.get("/", (_req, res) => {
  res.json({ ok:true, name:"aurion-v1", version:"2.0", model:"gpt-4o-mini", count: fs.readFileSync(TX_FILE, "utf-8").trim().split("\n").filter(Boolean).length });
});

app.listen(PORT, () => console.log(`Aurion v1 listening on ${PORT}; data dir=${DATA_DIR}`));
