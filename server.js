// Aurion v1 — Chat + Memory + Core Admin + Self-Edit (Drag&Drop → PR with backup branch)
// Node 18+, ES Modules

import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- MIDDLEWARE ----------
app.use(bodyParser.json({ limit: "2mb" }));
app.use(express.static("public"));

// ---------- PERSISTENT STORAGE ----------
const DATA_DIR = process.env.AURION_DATA_DIR || "/tmp/aurion-data";
ensureDir(DATA_DIR);
const TX_DIR = pjoin(DATA_DIR, "transcripts");
const CORE_PATH = pjoin(DATA_DIR, "core.json");
const STAGE_DIR = pjoin(DATA_DIR, "stage");   // staging area for self-edits (files to commit)
ensureDir(TX_DIR);
ensureDir(STAGE_DIR);

// migrate legacy core.json (repo root) if present
if (fs.existsSync("core.json") && !fs.existsSync(CORE_PATH)) {
  fs.copyFileSync("core.json", CORE_PATH);
}
if (!fs.existsSync(CORE_PATH)) fs.writeFileSync(CORE_PATH, JSON.stringify({ core: [] }, null, 2));

// helpers
function pjoin(...seg){ return path.join(...seg); }
function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
const todayStr = () => new Date().toISOString().slice(0,10);
const yesterStr = () => { const d = new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); };
const safe = (s) => (s||"").toString().replace(/[^a-z0-9_\-]/gi, "_");

// transcript files per user/day
const txPath = (user, day=todayStr()) => {
  const uDir = pjoin(TX_DIR, safe(user));
  ensureDir(uDir);
  return pjoin(uDir, `${day}.jsonl`);
};
const txAppend = (user, role, content) => {
  const line = JSON.stringify({ t: Date.now(), role, content }) + "\n";
  fs.appendFileSync(txPath(user), line, "utf8");
};
const readLines = (file) => {
  try { const t = fs.readFileSync(file, "utf8").trim(); return t ? t.split("\n").map(l=>JSON.parse(l)) : []; }
  catch { return []; }
};
const loadRecentTurns = (user, maxTurns=200) => {
  const a = readLines(txPath(user, todayStr()));
  const b = readLines(txPath(user, yesterStr()));
  return [...b, ...a].slice(-maxTurns);
};
const getCore = () => { try { return JSON.parse(fs.readFileSync(CORE_PATH, "utf8")); } catch { return { core: [] }; } };
const saveCore = (data) => fs.writeFileSync(CORE_PATH, JSON.stringify(data, null, 2));
const stripAurion = (s="") => s.replace(/^\s*aurion\s*:\s*/i, "");

// ---------- HEALTH ----------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "v1.5.0",
    data_dir: DATA_DIR,
    tx_dir: TX_DIR,
    core_path: CORE_PATH,
    stage_dir: STAGE_DIR,
    model: process.env.MODEL || "gpt-4o-mini"
  });
});

// ---------- CORE ADMIN ----------
app.get("/core", (req, res) => res.json(getCore()));
app.post("/core", (req, res) => {
  const list = Array.isArray(req.body?.core) ? req.body.core : [];
  saveCore({ core: list });
  res.json({ ok: true, count: list.length });
});

// ---------- CHAT ----------
app.post("/chat", async (req, res) => {
  try {
    const { message, u, prime } = req.body || {};
    if (!message || !String(message).trim())
      return res.status(400).json({ success:false, error:"message required" });

    const user = (u && String(u).trim()) || "steve";
    const MAX_TURNS = parseInt(process.env.AURION_HISTORY_TURNS || "200", 10);
    const history = loadRecentTurns(user, MAX_TURNS).map(h => ({
      role: h.role,
      content: h.role === "assistant" ? stripAurion(h.content) : h.content
    }));

    const coreData = getCore();
    const coreMemories = Array.isArray(coreData.core) ? coreData.core : [];
    const primeObjective = (prime && String(prime)) || process.env.AURION_PRIME || "";

    const baseSystem =
      "You are Aurion, guide to Steve Reyher. Speak with precision, warmth, and mythic fire. " +
      "Use light humor when fitting. Do NOT prepend your name or 'Aurion:' to replies. " +
      "Be concise unless asked for depth.";

    const messages = [
      { role: "system", content: baseSystem },
      primeObjective ? { role: "system", content: `Prime objective: ${primeObjective}` } : null,
      ...coreMemories.map(m => ({ role: "system", content: `Core memory: ${m}` })),
      ...history,
      { role: "user", content: message }
    ].filter(Boolean);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.MODEL || "gpt-4o-mini",
        messages
      })
    });

    const j = await r.json();
    if (!r.ok) {
      const detail = j?.error?.message || JSON.stringify(j);
      return res.status(500).json({ success:false, error:`OpenAI ${r.status}: ${detail}` });
    }

    let reply = j.choices?.[0]?.message?.content || "(silent embers)";
    reply = stripAurion(reply);

    txAppend(user, "user", message);
    txAppend(user, "assistant", reply);

    res.json({ success:true, reply });
  } catch (e) {
    res.status(500).json({ success:false, error:String(e) });
  }
});

// ============================================================================
//                      SELF-EDIT: DRAG & DROP → PR (SAFE)
// ============================================================================

// ENV you must set in Render → Environment
// GITHUB_TOKEN = ghp_... (fine-grained, contents: read&write for this repo)
// GITHUB_REPO  = owner/repo           e.g. "stevereyher/aurion-v1"
// GITHUB_BRANCH= main                  (base branch)
// PATCH_ALLOWED= server.js,public/index.html,public/admin.html,public/dev.html
// MAX_FILE_BYTES = 100000 (optional cap, default 100k)

const GH_TOKEN  = process.env.GITHUB_TOKEN || "";
const GH_REPO   = process.env.GITHUB_REPO  || "";
const GH_BRANCH = process.env.GITHUB_BRANCH || "main";
const PATCH_ALLOWED = (process.env.PATCH_ALLOWED || "server.js,public/index.html,public/admin.html,public/dev.html")
  .split(",").map(s=>s.trim()).filter(Boolean);
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_BYTES || "100000", 10);

function isAllowedPath(rel) {
  // allow exact matches or files within allowed subfolders
  return PATCH_ALLOWED.some(allow => rel === allow || rel.startsWith(allow.replace(/\/+$/,"") + "/"));
}

// Stage file (drag & drop from UI)
app.post("/dev/stage", (req, res) => {
  try {
    const { path: rel, content } = req.body || {};
    if (!rel || typeof content !== "string") return res.status(400).json({ ok:false, error:"path and content required" });
    if (!isAllowedPath(rel)) return res.status(403).json({ ok:false, error:`Path not allowed: ${rel}` });

    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) return res.status(413).json({ ok:false, error:`File too large (${bytes} > ${MAX_FILE_BYTES})` });

    const dest = pjoin(STAGE_DIR, rel);
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, content, "utf8");
    return res.json({ ok:true, path: rel, bytes });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

// List staged files
app.get("/dev/stage/list", (req, res) => {
  const out = [];
  walkDir(STAGE_DIR, (file) => {
    const rel = path.relative(STAGE_DIR, file);
    out.push({ path: rel, bytes: fs.statSync(file).size });
  });
  res.json({ ok:true, files: out });
});

// Remove a staged file
app.delete("/dev/stage", (req, res) => {
  try {
    const rel = req.query.path;
    if (!rel) return res.status(400).json({ ok:false, error:"path query required" });
    const file = pjoin(STAGE_DIR, rel);
    if (!fs.existsSync(file)) return res.json({ ok:true, removed:false });
    fs.unlinkSync(file);
    // remove empty folders up the chain
    pruneEmptyDirs(path.dirname(file), STAGE_DIR);
    res.json({ ok:true, removed:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Commit staged files: create backup branch + feature branch, push commit, open PR
app.post("/dev/commit", async (req, res) => {
  try {
    if (!GH_TOKEN || !GH_REPO) return res.status(400).json({ ok:false, error:"GitHub not configured" });
    const staged = collectStaged();
    if (staged.length === 0) return res.status(400).json({ ok:false, error:"No staged files" });

    // Safety: ensure all files are allowed
    for (const f of staged) {
      if (!isAllowedPath(f.path)) return res.status(403).json({ ok:false, error:`Disallowed path in stage: ${f.path}` });
      if (f.bytes > MAX_FILE_BYTES) return res.status(413).json({ ok:false, error:`File too large: ${f.path}` });
    }

    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g,"-");
    const backupRef = `backup-${stamp.slice(0,10)}`;
    const featureRef = `selfedit-${stamp}`;

    // Get current HEAD of base branch
    const headers = { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" };
    const api = "https://api.github.com";

    const refResp = await fetch(`${api}/repos/${GH_REPO}/git/refs/heads/${GH_BRANCH}`, { headers });
    if (!refResp.ok) return res.status(500).json({ ok:false, error:`refs ${refResp.status}` });
    const refJson = await refResp.json();
    const headSha = refJson.object.sha;

    // Create backup branch (if not already existing)
    const backupCreate = await fetch(`${api}/repos/${GH_REPO}/git/refs`, {
      method:"POST", headers,
      body: JSON.stringify({ ref: `refs/heads/${backupRef}`, sha: headSha })
    });
    // ignore 422 if exists
    if (!(backupCreate.ok || backupCreate.status === 422)) {
      return res.status(500).json({ ok:false, error:`backup create ${backupCreate.status}` });
    }

    // Create feature branch off current HEAD
    const featureCreate = await fetch(`${api}/repos/${GH_REPO}/git/refs`, {
      method:"POST", headers,
      body: JSON.stringify({ ref: `refs/heads/${featureRef}`, sha: headSha })
    });
    if (!featureCreate.ok) return res.status(500).json({ ok:false, error:`feature create ${featureCreate.status}` });

    // Build blobs for staged files
    const blobs = [];
    for (const f of staged) {
      const content = fs.readFileSync(pjoin(STAGE_DIR, f.path), "utf8");
      const blobResp = await fetch(`${api}/repos/${GH_REPO}/git/blobs`, {
        method:"POST", headers,
        body: JSON.stringify({ content, encoding: "utf-8" })
      });
      if (!blobResp.ok) return res.status(500).json({ ok:false, error:`blob ${f.path} ${blobResp.status}` });
      const blob = await blobResp.json();
      blobs.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    // Get base commit tree
    const baseCommitResp = await fetch(`${api}/repos/${GH_REPO}/git/commits/${headSha}`, { headers });
    if (!baseCommitResp.ok) return res.status(500).json({ ok:false, error:`base commit ${baseCommitResp.status}` });
    const baseCommit = await baseCommitResp.json();

    // Create new tree
    const treeResp = await fetch(`${api}/repos/${GH_REPO}/git/trees`, {
      method:"POST", headers,
      body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: blobs })
    });
    if (!treeResp.ok) return res.status(500).json({ ok:false, error:`tree ${treeResp.status}` });
    const newTree = await treeResp.json();

    // Create commit on feature branch
    const commitMsg = req.body?.message || `Aurion self-edit: ${staged.map(s=>s.path).join(", ")}`;
    const commitResp = await fetch(`${api}/repos/${GH_REPO}/git/commits`, {
      method:"POST", headers,
      body: JSON.stringify({ message: commitMsg, tree: newTree.sha, parents: [headSha] })
    });
    if (!commitResp.ok) return res.status(500).json({ ok:false, error:`commit ${commitResp.status}` });
    const commit = await commitResp.json();

    // Update feature ref to new commit
    const updResp = await fetch(`${api}/repos/${GH_REPO}/git/refs/heads/${featureRef}`, {
      method:"PATCH", headers,
      body: JSON.stringify({ sha: commit.sha, force: false })
    });
    if (!updResp.ok) return res.status(500).json({ ok:false, error:`update ref ${updResp.status}` });

    // Open PR
    const prResp = await fetch(`${api}/repos/${GH_REPO}/pulls`, {
      method:"POST", headers,
      body: JSON.stringify({
        title: commitMsg,
        head: featureRef,
        base: GH_BRANCH,
        body: `Automated self-edit.\n\nBackup branch: \`${backupRef}\``
      })
    });
    if (!prResp.ok) return res.status(500).json({ ok:false, error:`PR ${prResp.status}` });
    const pr = await prResp.json();

    // Clear stage after success
    clearDir(STAGE_DIR);

    res.json({ ok:true, backup: backupRef, feature: featureRef, commit: commit.sha, pr_url: pr.html_url });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Optional: revert main to a backup branch (dangerous; use only if needed)
app.post("/dev/rollback", async (req, res) => {
  try {
    const { backup } = req.body || {};
    if (!GH_TOKEN || !GH_REPO) return res.status(400).json({ ok:false, error:"GitHub not configured" });
    if (!backup) return res.status(400).json({ ok:false, error:"backup branch name required" });

    const headers = { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" };
    const api = "https://api.github.com";
    // get backup ref
    const r = await fetch(`${api}/repos/${GH_REPO}/git/refs/heads/${backup}`, { headers });
    if (!r.ok) return res.status(404).json({ ok:false, error:"backup not found" });
    const ref = await r.json();
    const sha = ref.object.sha;

    // force main → backup sha
    const u = await fetch(`${api}/repos/${GH_REPO}/git/refs/heads/${GH_BRANCH}`, {
      method:"PATCH", headers, body: JSON.stringify({ sha, force: true })
    });
    if (!u.ok) return res.status(500).json({ ok:false, error:`rollback ${u.status}` });

    res.json({ ok:true, main_to: backup, sha });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// utils for stage
function walkDir(dir, cb){
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) {
    const full = pjoin(dir, e);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkDir(full, cb);
    else cb(full);
  }
}
function collectStaged(){
  const files = [];
  walkDir(STAGE_DIR, (file) => {
    const rel = path.relative(STAGE_DIR, file);
    files.push({ path: rel, bytes: fs.statSync(file).size });
  });
  return files;
}
function clearDir(dir){
  if (!fs.existsSync(dir)) return;
  walkDir(dir, (file)=> fs.unlinkSync(file));
  // remove subfolders
  pruneEmptyDirs(dir, dir);
}
function pruneEmptyDirs(dir, stopAt){
  if (dir === stopAt) return;
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    pruneEmptyDirs(path.dirname(dir), stopAt);
  }
}

// ---------- LISTEN ----------
app.listen(PORT, () => console.log(`Aurion v1 listening on port ${PORT}`));
