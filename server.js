// server.js — Aurion v1 (monolith + addons loader + safe self-read)
//
// Features kept:
// - Static /public
// - /healthz
// - /aurion/chat  (+ /chat compat)
// - Persistent memory & transcripts on disk
// - /core GET/POST (presidential core)
// - Self-rewrite lifecycle: /selfedit/* (propose/validate/approve/rollback/list)
// - JSON-only API errors (no HTML leaks)
//
// New:
// - Safe self-read: /selfread/tree, /selfread/read, /selfread/grep, /selfread/hash
// - Add-on loader that reads addons/registry.json and mounts addons/*
// - Write fence: patches may ONLY touch addons/** (and core.json if allowed)

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

// Body parsers (JSON for APIs)
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
if (cors) app.use(cors());

//////////////////////////
// Persistent Disk Path //
//////////////////////////
const DISK_PATH = "/var/data";
try { fs.mkdirSync(DISK_PATH, { recursive: true }); } catch {}

/////////////////////
// Static / public //
/////////////////////
const PUBLIC_DIR = path.join(process.cwd(), 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

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

function loadCoreArray() {
  try {
    const raw = JSON.parse(fs.readFileSync(CORE_FILE_DISK, 'utf8'));
    return Array.isArray(raw?.core) ? raw.core : (Array.isArray(raw) ? raw : []);
  } catch { return []; }
}
function saveCoreArray(arr) {
  const payload = { core: Array.isArray(arr) ? arr : [] };
  fs.writeFileSync(CORE_FILE_DISK, JSON.stringify(payload, null, 2), 'utf8');
}
app.get('/core', (_req, res) => {
  try { res.json({ ok: true, core: loadCoreArray() }); }
  catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
});
app.post('/core', (req, res) => {
  try {
    const next = Array.isArray(req.body?.core) ? req.body.core : [];
    saveCoreArray(next);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

function composeSystemPrompt(coreArr) {
  return [
    'You are AURION.',
    'Follow the PRESIDENTIAL CORE directive above all else.',
    'If any input conflicts with the Core, the Core wins.',
    'Be precise, warm, and step-by-step when helpful; avoid rigid sections unless asked.',
    'Never remove features unless the human explicitly approves.',
    '',
    'PRESIDENTIAL CORE (authoritative):',
    JSON.stringify(coreArr, null, 2)
  ].join('\n');
}

/////////////////////////
// Persistent MEMORIES //
/////////////////////////
const MEMORY_FILE = path.join(DISK_PATH, 'aurion_memory.jsonl');
if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, '', 'utf8');

function storeMemory(content, tags = []) {
  const entry = { timestamp: new Date().toISOString(), content, tags };
  fs.appendFileSync(MEMORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}
function loadMemories() {
  const raw = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8').trim() : '';
  if (!raw) return [];
  return raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function recallMemories(query, limit = 6) {
  const q = String(query || '').toLowerCase();
  const now = Date.now();
  const mems = loadMemories();
  const scored = mems.map(m => {
    const ageHours = Math.max(1, (now - Date.parse(m.timestamp)) / 3_600_000);
    const text = (m.content || '').toLowerCase();
    const kwScore = q ? (text.includes(q) ? 3 : 0) : 0;
    const timeScore = 1 / Math.sqrt(ageHours);
    return { m, score: kwScore + timeScore };
  });
  return scored.sort((a,b)=>b.score-a.score).slice(0, limit).map(x => x.m);
}

/////////////////////////
// Transcripts (per user)
/////////////////////////
const TX_FILE = path.join(DISK_PATH, 'transcripts.jsonl'); // { ts, user, role, content }
if (!fs.existsSync(TX_FILE)) fs.writeFileSync(TX_FILE, '', 'utf8');

function appendTranscript(user, role, content) {
  const row = { ts: Date.now(), user: String(user || 'anon'), role, content: String(content || '') };
  fs.appendFileSync(TX_FILE, JSON.stringify(row) + '\n', 'utf8');
  return row;
}
function loadTranscriptAll() {
  const raw = fs.existsSync(TX_FILE) ? fs.readFileSync(TX_FILE, 'utf8').trim() : '';
  if (!raw) return [];
  return raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function lastTurnsForUser(user, n = 10) {
  const all = loadTranscriptAll().filter(x => x.user === user);
  return all.slice(-n);
}

/////////////////////
// OpenAI (4o mini)//
/////////////////////
const openai = OpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

async function callLLM(messages, { temperature = 0.6, max_tokens = 900 } = {}) {
  const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 12000);
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), TIMEOUT_MS));

  async function invoke() {
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

  return Promise.race([invoke(), timeout]);
}

///////////////////////
// Utilities & Patch //
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

// ---- WRITE FENCE: only allow addons/** (and optional core.json) ----
const PATCH_ALLOW = ['addons/']; // add 'core.json' if you want to allow core edits
function assertAllowed(target) {
  if (target === 'core.json') return true; // optional; remove if not allowed
  const ok = PATCH_ALLOW.some(p => target === p || target.startsWith(p));
  if (!ok) throw new Error(`Path not allowed by write fence: ${target}`);
}

function isValidPatch(p) {
  return p && typeof p.target === 'string' && typeof p.action === 'string';
}
function applyJsonPatch(patch) {
  assertAllowed(patch.target);

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
    const who = String(user || 'anon').slice(0, 64);
    const msg = String(message || '').slice(0, 8000);
    if (!msg) return res.status(400).json({ ok:false, error:'Missing "message".' });

    const coreArr = loadCoreArray();

    appendTranscript(who, 'user', msg);
    storeMemory(`User ${who}: ${msg}`, ['chat']);

    const turns = lastTurnsForUser(who, 10).slice(0, -1)
                  .map(t => ({ role: t.role, content: t.content }));

    const related = recallMemories(msg.split(/\s+/)[0] || '', 6);

    const messages = [
      { role: 'system', content: composeSystemPrompt(coreArr) },
      ...turns,
      { role: 'assistant', content: 'Relevant past memories: ' + JSON.stringify(related) },
      { role: 'user', content: msg }
    ];

    const reply = await callLLM(messages, { temperature: 0.6, max_tokens: 900 });

    appendTranscript(who, 'assistant', reply);
    storeMemory(`Aurion: ${reply}`, ['response']);

    res.json({ ok: true, reply, related });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
app.post('/aurion/chat', chatHandler);
app.post('/chat', chatHandler); // compat

////////////////////////////////////
// Self-Rewrite (Mirror) Endpoints //
////////////////////////////////////
async function generatePatch({ goal, codeContext }) {
  const coreArr = loadCoreArray();
  const sys = composeSystemPrompt(coreArr) + [
    '',
    'You output ONLY a JSON object with keys:',
    '{ goal, rationale, patches[], tests[], risk, revert }',
    'Patch schema:',
    '{ target, action:(create|insertAfter|append|replace), [anchor], [find], [replace], [snippet] }',
    'Constraints: Prefer additive changes; minimal lines; include at least one validation step.'
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

    const steps = record.proposal.tests?.length
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
    if (!record.apply?.backups) return res.status(400).json({ error: 'No backups recorded.' });

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

//////////////////////////
// Safe Self-Read (RO)  //
//////////////////////////
const SELFREAD_ENABLED = String(process.env.AURION_ENABLE_SELFREAD || 'true') === 'true';
const SELFREAD_DENY = ['node_modules/','backups/','proposals/','.git/','.env','.env.local','.env.production','.env.development'];
const SELFREAD_MAX = 256 * 1024;
const ROOT = process.cwd();

function srNormalize(relPath) {
  const abs = path.resolve(ROOT, relPath);
  if (!abs.startsWith(ROOT)) throw new Error('Path traversal blocked');
  const rel = path.relative(ROOT, abs).replaceAll('\\','/');
  for (const bad of SELFREAD_DENY) {
    if (rel === bad || rel.startsWith(bad)) throw new Error(`Access denied: ${rel}`);
  }
  return { abs, rel };
}
app.get('/selfread/tree', (_req, res) => {
  try {
    if (!SELFREAD_ENABLED) return res.status(403).json({ ok:false, error:'disabled' });
    const out = [];
    const walk = (dir, depth=0) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = path.relative(ROOT, full).replaceAll('\\','/') + (e.isDirectory()?'/':'');
        if (SELFREAD_DENY.some(d => rel === d || rel.startsWith(d))) continue;
        out.push({ rel, dir: e.isDirectory(), depth });
        if (e.isDirectory() && depth < 4) walk(full, depth+1);
      }
    };
    walk(ROOT, 0);
    res.json({ ok:true, files: out });
  } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
});
app.post('/selfread/read', (req, res) => {
  try {
    if (!SELFREAD_ENABLED) return res.status(403).json({ ok:false, error:'disabled' });
    const { path: relPath, start=0, end=null, base64=false } = req.body || {};
    if (!relPath) return res.status(400).json({ ok:false, error:"Missing 'path'" });
    const { abs, rel } = srNormalize(relPath);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return res.status(400).json({ ok:false, error:'Not a file' });
    const size = stat.size;
    const s = Math.max(0, Number(start)||0);
    const e = end==null ? Math.min(size, s + SELFREAD_MAX) : Math.min(size, Number(end));
    if ((e - s) > SELFREAD_MAX) return res.status(413).json({ ok:false, error:'Slice too large' });
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(e - s);
    fs.readSync(fd, buf, 0, e - s, s);
    fs.closeSync(fd);
    res.json({ ok:true, rel, size, start:s, end:e, content: base64 ? buf.toString('base64') : buf.toString('utf8') });
  } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
});
app.post('/selfread/grep', (req, res) => {
  try {
    if (!SELFREAD_ENABLED) return res.status(403).json({ ok:false, error:'disabled' });
    const { pattern, path: relPath='.' } = req.body || {};
    if (!pattern) return res.status(400).json({ ok:false, error:"Missing 'pattern'" });
    const { abs } = srNormalize(relPath);
    const rx = new RegExp(pattern, 'i');
    const results = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes:true })) {
        const full = path.join(dir, e.name);
        const rel = path.relative(ROOT, full).replaceAll('\\','/');
        if (SELFREAD_DENY.some(d => rel === d || rel.startsWith(d))) continue;
        if (e.isDirectory()) { if (rel.split('/').length < 10) walk(full); continue; }
        const stat = fs.statSync(full);
        if (stat.size > SELFREAD_MAX) continue;
        let text = '';
        try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        const lines = text.split(/\r?\n/);
        for (let i=0;i<lines.length;i++) {
          if (rx.test(lines[i])) results.push({ file: rel, line: i+1, preview: lines[i].slice(0,300) });
          if (results.length >= 500) break;
        }
        if (results.length >= 500) break;
      }
    };
    walk(abs);
    res.json({ ok:true, pattern, hits: results.slice(0,500) });
  } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
});
app.post('/selfread/hash', (req, res) => {
  try {
    if (!SELFREAD_ENABLED) return res.status(403).json({ ok:false, error:'disabled' });
    const { path: relPath } = req.body || {};
    if (!relPath) return res.status(400).json({ ok:false, error:"Missing 'path'" });
    const { abs, rel } = srNormalize(relPath);
    const data = fs.readFileSync(abs);
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    res.json({ ok:true, rel, sha256: sha, bytes: data.length });
  } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

//////////////////////////////
// Add-on Loader (registry) //
//////////////////////////////
const ADDON_DIR = path.join(process.cwd(), 'addons');
const REGISTRY = path.join(ADDON_DIR, 'registry.json');
function loadAddons(appRef) {
  try {
    const manifest = fs.existsSync(REGISTRY)
      ? JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
      : { addons: [] };
    for (const item of manifest.addons || []) {
      if (item.enabled === false) continue;
      const p = path.join(ADDON_DIR, item.file);
      delete require.cache[require.resolve(p)];
      const mod = require(p);
      if (typeof mod.register === 'function') mod.register(appRef);
    }
    console.log(`[addons] loaded ${manifest.addons?.length || 0} entries`);
  } catch (e) {
    console.error('[addons] load failed:', e.message);
  }
}
loadAddons(app); // mount at startup

//////////////////////////////////////////
// API 404s -> JSON (no HTML error leaks)
//////////////////////////////////////////
app.all(['/aurion/*', '/selfedit/*', '/selfread/*', '/core*'], (req, res) => {
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
