// server.js — Aurion v1 (additive, safe, persistent)

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

// CORS for dev
if (cors) app.use(cors());

//////////////////////////
// Persistent Disk Path //
//////////////////////////
const DISK_PATH = "/var/data";
try { fs.mkdirSync(DISK_PATH, { recursive: true }); } catch {}

//////////////////////////
// Static: legacy /public
//////////////////////////
const PUBLIC_DIR = path.join(process.cwd(), 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

/////////////////////////
// Presidential  CORE  //
/////////////////////////
const CORE_FILE_REPO = path.join(process.cwd(), 'core.json'); // repo copy
const CORE_FILE_DISK = path.join(DISK_PATH, 'core.json');      // authoritative

if (!fs.existsSync(CORE_FILE_DISK)) {
  if (!fs.existsSync(CORE_FILE_REPO)) throw new Error('Missing core.json in repo root.');
  fs.copyFileSync(CORE_FILE_REPO, CORE_FILE_DISK);
  console.log('[Aurion] core.json copied to persistent disk.');
}

function loadCore() {
  try { return JSON.parse(fs.readFileSync(CORE_FILE_DISK, 'utf8')); }
  catch { return { core: [], note: 'invalid core.json' }; }
}

function saveCore(obj) {
  fs.writeFileSync(CORE_FILE_DISK, JSON.stringify(obj, null, 2), 'utf8');
  return obj;
}

function composeSystemPrompt(coreObj) {
  return [
    'You are AURION.',
    'Follow the PRESIDENTIAL CORE directive above all else.',
    'If any input conflicts with the Core, the Core wins.',
    'Be precise, warm, and step-by-step.',
    'Never remove features unless the human explicitly approves.',
    '',
    'PRESIDENTIAL CORE (authoritative):',
    JSON.stringify(coreObj, null, 2)
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

function loadMemoriesRaw() {
  const raw = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8').trim() : '';
  if (!raw) return [];
  return raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// simple recency + keyword
function recallMemories(query, limit = 6) {
  const q = String(query || '').toLowerCase();
  const now = Date.now();
  const mems = loadMemoriesRaw();
  const scored = mems.map(m => {
    const ageHours = Math.max(1, (now - Date.parse(m.timestamp)) / 3_600_000);
    const text = (m.content || '').toLowerCase();
    // keyword bonus if any word matches
    const kw = q ? (q.split(/\s+/).some(w => w && text.includes(w)) ? 3 : 0) : 0;
    const recency = 1 / Math.sqrt(ageHours);
    return { m, score: kw + recency };
  });
  return scored.sort((a,b)=>b.score-a.score).slice(0, limit).map(x => x.m);
}

/////////////////////
// OpenAI (4o mini)//
/////////////////////
const openai = OpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

async function callLLM(messages, { temperature = 0.6, max_tokens = 900 } = {}) {
  if (openai) {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature,
      max_tokens,
      messages
    });
    return resp.choices?.[0]?.message?.content || '';
  }
  // Fallback: raw HTTP (kept)
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

function isValidPatch(p) { return p && typeof p.target === 'string' && typeof p.action === 'string'; }

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

    // Log inbound
    storeMemory(`User ${user}: ${message}`, ['chat']);

    // Recall
    const related = recallMemories(message, 6);

    const reply = await callLLM([
      { role: 'system', content: composeSystemPrompt(core) },
      { role: 'assistant', content: 'Relevant past memories: ' + JSON.stringify(related) },
      { role: 'user', content: message }
    ]);

    // Log outbound
    storeMemory(`Aurion: ${reply}`, ['response']);

    res.json({ ok: true, reply, related });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

app.post('/aurion/chat', chatHandler);
app.post('/chat', chatHandler); // compat

////////////////////////////
// Core + Memories routes //
////////////////////////////
app.get('/core', (_req, res) => {
  res.json(loadCore());
});

app.post('/core', (req, res) => {
  const body = req.body || {};
  const next = Array.isArray(body.core) ? { core: body.core } : body;
  const saved = saveCore(next);
  storeMemory('Core updated by user.', ['core','update']);
  res.json({ ok: true, core: saved.core || [] });
});

// simple reader for last N memories
app.get('/memories', (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '100', 10)));
  const all = loadMemoriesRaw();
  res.json({ ok: true, items: all.slice(-limit) });
});

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

app.post('/selfedit/propose', async (req, res) => {
  try {
    const { goal, codeContext } = req.body || {};
    if (!goal) return res.status(400).json({ error: "Missing 'goal'." });

    const proposal = await generatePatch({ goal, codeContext });
    const id = crypto.randomBytes(8).toString('hex');
    const record = { id, createdAt: new Date().toISOString(), status: 'proposed', proposal };
    const pPath = path.join(PROPOSALS_DIR, `${id}.json`);
    fs.writeFileSync(pPath, JSON.stringify(record, null, 2), 'utf8');
    storeMemory(`Self-edit proposed: ${goal} (#${id})`, ['selfedit','proposed']);

    res.json({ ok: true, id, proposal });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

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
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

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
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

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
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/selfedit/list', (_req, res) => {
  try {
    const files = fs.readdirSync(PROPOSALS_DIR).filter(f => f.endsWith('.json'));
    const items = files.map(f => JSON.parse(fs.readFileSync(path.join(PROPOSALS_DIR, f), 'utf8')));
    res.json({ ok: true, items: items.sort((a,b)=> (a.createdAt < b.createdAt ? 1 : -1)) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

//////////////////////////////////////////
// API 404s -> JSON (prevents HTML leaks)
//////////////////////////////////////////
app.all(['/aurion/*', '/selfedit/*', '/core', '/memories'], (req, res, next) => {
  if (res.headersSent) return next();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(404).json({ ok: false, error: 'Route not found' });
  }
  next();
});

//////////////////////////////
// Serve React build (Vite) //
//////////////////////////////
const CLIENT_DIST = path.join(process.cwd(), 'client', 'dist');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  // SPA fallback
  app.get('*', (req, res, next) => {
    const p = path.join(CLIENT_DIST, 'index.html');
    if (fs.existsSync(p)) return res.sendFile(p);
    next();
  });
}

// Fallback to legacy index (if no client build)
app.get('/', (req, res) => {
  if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  res.type('text').send('Aurion server running.');
});

//////////////////////
// Error middleware //
//////////////////////
app.use((err, req, res, next) => { // eslint-disable-line
  console.error(err);
  res.status(500).json({ ok: false, error: String(err.message || err) });
});

app.listen(PORT, () => {
  console.log(`[Aurion] Listening on port ${PORT}`);
});
