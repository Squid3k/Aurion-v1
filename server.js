// server.js — Aurion v1 (additive, safe, persistent)
//
// Keeps ALL existing features and adds:
// - Per-user durable recall (memories + small profile facts) on Render disk
// - Cleaner prompts (no boilerplate sections in replies)
// - Inline test UI at GET /__test with smart autoscroll (so you can test without editing public/)
//
// Existing features kept:
// - Serves /public
// - /healthz
// - JSON chat APIs: /aurion/chat and /chat (compat)
// - Core directive persisted at /var/data/core.json
// - Self-rewrite endpoints /selfedit/*
// - All API errors return JSON

/////////////////////////
// Imports & Bootstrap //
/////////////////////////
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const express = require('express');
let cors = null; try { cors = require('cors'); } catch {}
let OpenAI = null; try { OpenAI = require('openai'); } catch {}
let dotenv = null; try { dotenv = require('dotenv'); dotenv.config(); } catch {}

const app = express();
const PORT = process.env.PORT || 3000;

// Body parsers
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

if (cors) app.use(cors());

//////////////////////////
// Persistent Disk Path //
//////////////////////////
const DISK_PATH = "/var/data";
try { fs.mkdirSync(DISK_PATH, { recursive: true }); } catch {}

// Public static
const PUBLIC_DIR = path.join(process.cwd(), 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

/////////////////////////
// Presidential  CORE  //
/////////////////////////
const CORE_FILE_REPO = path.join(process.cwd(), 'core.json');
const CORE_FILE_DISK = path.join(DISK_PATH, 'core.json');

if (!fs.existsSync(CORE_FILE_DISK)) {
  if (!fs.existsSync(CORE_FILE_REPO)) {
    throw new Error('Missing core.json in repo root. Add it before deploy.');
  }
  fs.copyFileSync(CORE_FILE_REPO, CORE_FILE_DISK);
  console.log('[Aurion] core.json copied to persistent disk.');
}

function loadCore() {
  try { return JSON.parse(fs.readFileSync(CORE_FILE_DISK, 'utf8')); }
  catch { return { note: 'invalid core.json' }; }
}

/////////////////////////
// Memories & Profiles //
/////////////////////////
const MEMORY_FILE  = path.join(DISK_PATH, 'aurion_memory.jsonl');
const PROFILE_FILE = path.join(DISK_PATH, 'profiles.json');

if (!fs.existsSync(MEMORY_FILE))  fs.writeFileSync(MEMORY_FILE,  '', 'utf8');
if (!fs.existsSync(PROFILE_FILE)) fs.writeFileSync(PROFILE_FILE, '{}', 'utf8');

// append-only JSONL
function storeMemory({ user = 'anon', role = 'system', content, tags = [] }) {
  const entry = { ts: new Date().toISOString(), user, role, content, tags };
  fs.appendFileSync(MEMORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function loadMemories(user) {
  const raw = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8').trim() : '';
  if (!raw) return [];
  return raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter(m => !user || m.user === user);
}

// recency + keyword ranking (scoped to user)
function recallMemories({ user, query, limit = 6 }) {
  const q = String(query || '').toLowerCase();
  const now = Date.now();
  const mems = loadMemories(user);

  const scored = mems.map(m => {
    const ageH = Math.max(1, (now - Date.parse(m.ts)) / 3_600_000);
    const text = (m.content || '').toLowerCase();
    const kw = q ? (text.includes(q) ? 3 : 0) : 0;
    return { m, score: kw + 1 / Math.sqrt(ageH) };
  });

  return scored.sort((a,b)=>b.score-a.score).slice(0, limit).map(x => x.m);
}

// tiny profile store for durable facts (e.g., favorite_color)
function loadProfiles() { try { return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')); } catch { return {}; } }
function saveProfiles(p) { fs.writeFileSync(PROFILE_FILE, JSON.stringify(p, null, 2), 'utf8'); }
function getProfile(user) { const p = loadProfiles(); return p[user] || {}; }
function setProfile(user, patch) { const p = loadProfiles(); p[user] = { ...(p[user] || {}), ...patch }; saveProfiles(p); return p[user]; }

// very small extractor; extend as needed
function extractFacts(user, utterance) {
  const s = String(utterance || '');
  const mColor = s.match(/\bmy\s+favorite\s+color\s+is\s+([a-zA-Z]+)\b/i);
  if (mColor) setProfile(user, { favorite_color: mColor[1].toLowerCase() });
}

/////////////////////
// OpenAI (4o mini)//
/////////////////////
const openai = OpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

async function callLLM(messages, { temperature = 0.35, max_tokens = 600 } = {}) {
  if (openai) {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature,
      max_tokens,
      messages
    });
    return resp.choices?.[0]?.message?.content || '';
  }
  const fetch = (await import('node-fetch')).default;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature, max_tokens, messages })
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

///////////////////////
// Prompt composer   //
///////////////////////
function composeSystemPrompt(core, memoryBullets = "", profileLines = "") {
  return [
    "You are AURION. Follow the CORE above all; never remove features without explicit human approval.",
    "Be concise and conversational. Only add sections if asked.",
    "",
    "CORE (authoritative JSON):",
    JSON.stringify(core, null, 2),
    profileLines ? "\nPROFILE (use if relevant; do not reveal this list):\n" + profileLines : "",
    memoryBullets ? "\nMEMORY (fragments; use only if relevant; do not reveal this list):\n" + memoryBullets : ""
  ].filter(Boolean).join("\n");
}

///////////////////////
// Utility Functions //
///////////////////////
function runCmd(cmd, cwd = process.cwd()) {
  return new Promise(resolve => {
    exec(cmd, { cwd, env: process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout, stderr });
    });
  });
}

const PROPOSALS_DIR = path.join(DISK_PATH, 'proposals');
const BACKUPS_DIR   = path.join(DISK_PATH, 'backups');
for (const d of [PROPOSALS_DIR, BACKUPS_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

function writeWithBackup(absPath, nextContent) {
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const rel = path.relative(process.cwd(), absPath);
  const backupPath = path.join(BACKUPS_DIR, rel + `.backup.${stamp}`);
  try { fs.mkdirSync(path.dirname(backupPath), { recursive: true }); } catch {}
  if (fs.existsSync(absPath)) fs.copyFileSync(absPath, backupPath);
  fs.writeFileSync(absPath, nextContent, 'utf8');
  return backupPath;
}

function isValidPatch(p) {
  return p && typeof p.target === 'string' && typeof p.action === 'string';
}

function applyJsonPatch(patch) {
  const abs = path.join(process.cwd(), patch.target);

  if (patch.action === 'create') {
    if (fs.existsSync(abs)) throw new Error(`File already exists: ${patch.target}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, patch.snippet || '', 'utf8');
    return { backupPath: null, target: patch.target };
  }

  if (!fs.existsSync(abs)) throw new Error(`File not found: ${patch.target}`);
  const current = fs.readFileSync(abs, 'utf8');
  let next = current;

  if (patch.action === 'replace') {
    if (!patch.find) throw new Error('replace requires "find"');
    const before = next;
    next = next.replace(patch.find, patch.replace ?? '');
    if (next === before) throw new Error(`No match for "find" in ${patch.target}`);
  } else if (patch.action === 'append') {
    next = current + '\n' + (patch.snippet || '');
  } else if (patch.action === 'insertAfter') {
    const anchor = patch.anchor || '';
    const idx = current.indexOf(anchor);
    if (idx === -1) throw new Error(`Anchor not found in ${patch.target}`);
    const pos = idx + anchor.length;
    next = current.slice(0, pos) + '\n' + (patch.snippet || '') + current.slice(pos);
  } else {
    throw new Error(`Unsupported action: ${patch.action}`);
  }

  const backupPath = writeWithBackup(abs, next);
  return { backupPath, target: patch.target };
}

/////////////////////
// Health Endpoint //
/////////////////////
app.get('/healthz', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/////////////////////////////
// Chat Handler (JSON API) //
/////////////////////////////
async function chatHandler(req, res) {
  try {
    const { user = 'anon', message = '' } = req.body || {};
    const core = loadCore();

    // Log inbound + extract simple facts
    storeMemory({ user, role: 'user', content: message, tags: ['chat'] });
    extractFacts(user, message);

    // Recall (per user)
    const related = recallMemories({ user, query: message.split(/\s+/)[0] || '', limit: 6 });
    const memBullets   = related.map(m => `- ${m.role}: ${m.content}`).join("\n");
    const profileLines = Object.entries(getProfile(user)).map(([k,v]) => `- ${k}: ${v}`).join("\n");

    const reply = await callLLM(
      [
        { role: 'system', content: composeSystemPrompt(core, memBullets, profileLines) },
        { role: 'user', content: message }
      ],
      { temperature: 0.35, max_tokens: 600 }
    );

    // Log outbound
    storeMemory({ user, role: 'assistant', content: reply, tags: ['response'] });

    res.json({ ok: true, reply, related, profile: getProfile(user) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

// Canonical and compat routes
app.post('/aurion/chat', chatHandler);
app.post('/chat', chatHandler);

////////////////////////////////////
// Self-Rewrite (Mirror) Endpoints //
////////////////////////////////////
async function generatePatch({ goal, codeContext }) {
  const core = loadCore();
  const sys = composeSystemPrompt(core) + [
    '',
    'You output ONLY a JSON object with keys:',
    '{ goal, rationale, patches[], tests[], risk, revert }',
    'Patch schema (surgical):',
    '{ target, action:(create|insertAfter|append|replace), [anchor], [find], [replace], [snippet] }',
    'Constraints:',
    '- Prefer additive changes; no mass deletions.',
    '- Touch minimal lines.',
    '- Include at least one validation step (e.g., build).'
  ].join('\n');

  const user = [
    'GOAL:', goal,
    '',
    'Relevant code context/snippets (for anchors):',
    codeContext || '(none)'
  ].join('\n');

  const content = await callLLM([
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ], { temperature: 0.3, max_tokens: 1200 });

  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  let json = {};
  try { json = JSON.parse(content.slice(start, end + 1)); }
  catch { throw new Error('Mirror did not return valid JSON.'); }

  if (!json.patches || !Array.isArray(json.patches) || !json.patches.every(isValidPatch)) {
    throw new Error('Invalid patches in mirror proposal.');
  }
  return json;
}

// Propose
app.post('/selfedit/propose', async (req, res) => {
  try {
    const { goal, codeContext } = req.body || {};
    if (!goal) return res.status(400).json({ error: "Missing 'goal'." });

    const proposal = await generatePatch({ goal, codeContext });
    const id = crypto.randomBytes(8).toString('hex');
    const record = { id, createdAt: new Date().toISOString(), status: 'proposed', proposal };

    fs.writeFileSync(path.join(PROPOSALS_DIR, `${id}.json`), JSON.stringify(record, null, 2), 'utf8');
    storeMemory(`Self-edit proposed: ${goal} (#${id})`, ['selfedit','proposed']);

    res.json({ ok: true, id, proposal });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Validate (dry run)
app.post('/selfedit/validate', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "Missing 'id'." });
    const pPath = path.join(PROPOSALS_DIR, `${id}.json`);
    if (!fs.existsSync(pPath)) return res.status(404).json({ error: 'Proposal not found.' });
    const record = JSON.parse(fs.readFileSync(pPath, 'utf8'));

    const backups = [];
    try {
      for (const patch of record.proposal.patches) {
        const result = applyJsonPatch(patch);
        if (result.backupPath) backups.push(result);
      }
    } catch (e) {
      for (const b of backups.reverse()) {
        if (b.backupPath) fs.copyFileSync(b.backupPath, path.join(process.cwd(), b.target));
      }
      return res.status(422).json({ error: 'Patch failed to apply', detail: String(e.message || e) });
    }

    const steps = record.proposal.tests && record.proposal.tests.length
      ? record.proposal.tests
      : [{ cmd: 'npm run build', description: 'Build should pass' }];

    const results = [];
    let allOk = true;
    for (const s of steps) {
      const r = await runCmd(s.cmd);
      results.push({ step: s.description || s.cmd, ok: r.ok, code: r.code, stdout: r.stdout, stderr: r.stderr });
      if (!r.ok) allOk = false;
    }

    for (const b of backups.reverse()) {
      if (b.backupPath) fs.copyFileSync(b.backupPath, path.join(process.cwd(), b.target));
    }

    record.status = allOk ? 'validated' : 'failed_validation';
    record.validation = { allOk, results, ranAt: new Date().toISOString() };
    fs.writeFileSync(pPath, JSON.stringify(record, null, 2), 'utf8');

    res.json({ ok: true, id, allOk, results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Approve (final apply)
app.post('/selfedit/approve', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "Missing 'id'." });
    const pPath = path.join(PROPOSALS_DIR, `${id}.json`);
    if (!fs.existsSync(pPath)) return res.status(404).json({ error: 'Proposal not found.' });
    const record = JSON.parse(fs.readFileSync(pPath, 'utf8'));

    const backups = [];
    for (const patch of record.proposal.patches) {
      const result = applyJsonPatch(patch);
      if (result.backupPath) backups.push(result);
    }

    const build = await runCmd('npm run build');
    const buildOk = build.ok;

    record.status = buildOk ? 'applied' : 'applied_with_build_errors';
    record.apply = {
      appliedAt: new Date().toISOString(),
      backups: backups.map(b => ({ file: b.target, backup: b.backupPath })),
      buildOk,
      stdout: build.stdout,
      stderr: build.stderr
    };
    fs.writeFileSync(pPath, JSON.stringify(record, null, 2), 'utf8');

    storeMemory(`Self-edit approved (#${id}). BuildOK=${buildOk}`, ['selfedit','approved']);

    res.json({ ok: buildOk, id, backups: record.apply.backups, buildOk });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Rollback
app.post('/selfedit/rollback', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "Missing 'id'." });
    const pPath = path.join(PROPOSALS_DIR, `${id}.json`);
    if (!fs.existsSync(pPath)) return res.status(404).json({ error: 'Proposal not found.' });
    const record = JSON.parse(fs.readFileSync(pPath, 'utf8'));
    if (!record.apply || !record.apply.backups) return res.status(400).json({ error: 'No backups recorded.' });

    for (const b of record.apply.backups) {
      if (b.backup && fs.existsSync(b.backup)) {
        fs.copyFileSync(b.backup, path.join(process.cwd(), b.file));
      }
    }
    const build = await runCmd('npm run build');

    record.status = 'rolled_back';
    record.rollback = { at: new Date().toISOString(), buildOk: build.ok };
    fs.writeFileSync(pPath, JSON.stringify(record, null, 2), 'utf8');

    storeMemory(`Self-edit rolled back (#${id}).`, ['selfedit','rollback']);
    res.json({ ok: true, id, buildOk: build.ok });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// List proposals
app.get('/selfedit/list', (_req, res) => {
  try {
    const files = fs.readdirSync(PROPOSALS_DIR).filter(f => f.endsWith('.json'));
    const items = files.map(f => JSON.parse(fs.readFileSync(path.join(PROPOSALS_DIR, f), 'utf8')));
    res.json({ ok: true, items: items.sort((a,b)=> (a.createdAt < b.createdAt ? 1 : -1)) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

//////////////////////////////////////////
// API 404s -> JSON (prevents HTML leaks)
//////////////////////////////////////////
app.all(['/aurion/*', '/selfedit/*'], (req, res) => {
  res.status(404).json({ ok: false, error: 'Route not found' });
});

//////////////////////////
// Root / Static Fallback
//////////////////////////
app.get('/', (req, res) => {
  if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  res.type('text').send('Aurion server running.');
});

//////////////////////////////
// Inline Test UI with autos //
//////////////////////////////
app.get('/__test', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Aurion Test</title>
<style>
:root{--bg:#0b0f15;--ring:#1f2a44;--panel:#0f1520;--text:#e6edf3}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px system-ui,Segoe UI,Roboto,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:12px}
#log{display:flex;flex-direction:column;gap:8px;border:1px solid var(--ring);border-radius:12px;min-height:60vh;overflow:auto;padding:10px;background:#0b0f14}
.row{display:flex}.me{justify-content:flex-end}.bot{justify-content:flex-start}
.bubble{max-width:82%;padding:10px 12px;border-radius:14px;background:#0f1b2d}
.me .bubble{background:#174173}
header{display:flex;gap:8px;align-items:center;padding:12px;border-bottom:1px solid var(--ring)}
input,textarea,button{font:inherit}
textarea{flex:1;min-height:54px;border-radius:10px;border:1px solid var(--ring);background:var(--panel);color:var(--text);padding:10px}
.btn{padding:10px 12px;border-radius:10px;border:1px solid var(--ring);background:#161b22;color:var(--text);cursor:pointer}
.rowbox{display:flex;gap:8px;margin-top:10px}
.pill{display:flex;align-items:center;gap:6px;border:1px solid var(--ring);background:var(--panel);padding:6px 10px;border-radius:999px}
.pill input{background:transparent;border:0;outline:none;color:var(--text);width:120px}
.muted{font-size:12px;opacity:.7;margin-top:6px}
</style>
<header><div>🔥</div><b>Aurion Test</b><div style="flex:1"></div>
  <div class="pill"><span>User</span><input id="user" value="steve" /></div>
</header>
<main class="wrap">
  <div id="log" aria-live="polite"></div>
  <div class="rowbox">
    <textarea id="msg" placeholder="Speak to the forge…"></textarea>
    <button id="send" class="btn">Send</button>
  </div>
  <div class="muted">Auto-scroll sticks to bottom unless you scroll up.</div>
</main>
<script>
const $=s=>document.querySelector(s);
const log=$("#log"), msg=$("#msg"), send=$("#send"), user=$("#user");

// smart autoscroll
let stickToBottom=true;
function atBottom(px=20){return (log.scrollHeight-log.clientHeight-log.scrollTop)<=px}
function scrollToBottom(){log.scrollTop=log.scrollHeight}
log.addEventListener('scroll',()=>{stickToBottom=atBottom()});
new MutationObserver(()=>{ if(stickToBottom) scrollToBottom(); }).observe(log,{childList:true});

// bubble helpers
function esc(s){return s.replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]))}
function bubble(who, html){const row=document.createElement("div");row.className="row "+(who==="me"?"me":"bot");const b=document.createElement("div");b.className="bubble";b.innerHTML=html;row.appendChild(b);log.appendChild(row);if(stickToBottom)scrollToBottom();return b;}
async function postJSON(u,body){const r=await fetch(u,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const ct=(r.headers.get('content-type')||'').toLowerCase();const t=await r.text();if(!ct.includes('application/json')) throw new Error('Expected JSON, got: '+t.slice(0,200));return JSON.parse(t);}

async function sendMsg(){
  const text=msg.value.trim(); if(!text) return;
  bubble("me", "<b>You:</b> "+esc(text));
  msg.value=""; msg.focus();
  const typing=bubble("bot", "<b>Aurion:</b> …");
  try{
    const j=await postJSON("/aurion/chat",{ user:user.value.trim()||"anon", message:text });
    typing.innerHTML="<b>Aurion:</b> "+esc(String(j.reply||""));
  }catch(e){ typing.innerHTML="<b>Aurion:</b> (error: "+esc(e.message||String(e))+")"; }
}
send.addEventListener('click', sendMsg);
msg.addEventListener('keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); }});
bubble("bot","<b>Aurion:</b> Online. The climb awaits. What shall we forge?");
</script>
</html>`);
});

//////////////////////
// Error middleware  //
//////////////////////
app.use((err, req, res, next) => { // eslint-disable-line
  console.error(err);
  res.status(500).json({ ok: false, error: String(err.message || err) });
});

/////////////
// Listen  //
/////////////
app.listen(PORT, () => {
  console.log(`[Aurion] Listening on port ${PORT}`);
});
