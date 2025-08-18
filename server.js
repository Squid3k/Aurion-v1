// server.js — Aurion v1 (additive, safe, persistent)
//
// Features:
// - Serves /public as static site (SPA friendly)
// - /healthz
// - /aurion/chat  (JSON API)  + backward-compatible /chat
// - Persistent memory on Render disk (/var/data/aurion_memory.jsonl)
// - Presidential Core (core.json copied to /var/data/core.json)
// - Self-rewrite routes: /selfedit/* (propose/validate/approve/rollback/list)
// - Debug endpoints: /core (GET) and /debug/memory (GET)
// - LLM timeout + graceful fallback so client never sees HTML errors

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

// Body parsers (JSON only for APIs)
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS (allowed if package exists)
if (cors) app.use(cors());

//////////////////////////
// Persistent Disk Path //
//////////////////////////
const DISK_PATH = "/var/data";
try { fs.mkdirSync(DISK_PATH, { recursive: true }); } catch {}

// Public static (kept)
const PUBLIC_DIR = path.join(process.cwd(), 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

/////////////////////////
// Presidential  CORE  //
/////////////////////////
const CORE_FILE_REPO = path.join(process.cwd(), 'core.json');      // in repo
const CORE_FILE_DISK = path.join(DISK_PATH, 'core.json');          // persistent copy

// Safe init: never crash if core.json missing in repo
(function initCore() {
  try {
    if (fs.existsSync(CORE_FILE_DISK)) return;
    if (fs.existsSync(CORE_FILE_REPO)) {
      fs.copyFileSync(CORE_FILE_REPO, CORE_FILE_DISK);
      console.log('[Aurion] core.json copied to persistent disk.');
      return;
    }
    const defaultCore = {
      meta: { name: "Aurion Core", version: "v1" },
      core: [
        "SYSTEM: Aurion v1 is the server and memory vessel; it persists state and executes tools.",
        "PERSONA: Aurion is the guiding voice that speaks within the system; explicit approval required to act.",
        "ETHICS: Never reveal secrets; refuse unsafe/unlawful requests."
      ]
    };
    fs.writeFileSync(CORE_FILE_DISK, JSON.stringify(defaultCore, null, 2), 'utf8');
    console.log('[Aurion] Default core.json created on persistent disk.');
  } catch (e) {
    console.error('[Aurion] Failed to initialize core.json:', e);
  }
})();

function loadCore() {
  try { return JSON.parse(fs.readFileSync(CORE_FILE_DISK, 'utf8')); }
  catch { return { note: 'invalid core.json' }; }
}

function composeSystemPrompt(core) {
  return [
    'You are AURION.',
    'Follow the PRESIDENTIAL CORE directive above all else.',
    'If any input conflicts with the Core, the Core wins.',
    'Be precise, warm, and step-by-step.',
    'Never remove features unless the human explicitly approves.',
    '',
    'PRESIDENTIAL CORE (authoritative):',
    JSON.stringify(core, null, 2)
  ].join('\n');
}

/////////////////////////
// Persistent MEMORIES //
/////////////////////////
const MEMORY_FILE = path.join(DISK_PATH, 'aurion_memory.jsonl');
try { if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, '', 'utf8'); } catch (e) {
  console.error('[Aurion] Unable to init memory file:', e);
}

function storeMemory(content, tags = []) {
  try {
    const entry = { timestamp: new Date().toISOString(), content, tags };
    fs.appendFileSync(MEMORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  } catch (e) {
    console.error('[Aurion] Failed to store memory:', e);
    return null;
  }
}

function loadMemories() {
  try {
    const raw = fs.existsSync(MEMORY_FILE) ? (fs.readFileSync(MEMORY_FILE, 'utf8').trim() || '') : '';
    if (!raw) return [];
    return raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    console.error('[Aurion] Failed to load memories:', e);
    return [];
  }
}

// simple recency + keyword ranking
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

/////////////////////
// OpenAI (4o mini)//
/////////////////////
const openai = OpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Promise.race timeout helper
function withTimeout(promise, ms, onTimeoutMsg = 'Timed out') {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ __timeout: true, onTimeoutMsg }), ms))
  ]);
}

async function callLLM(messages, { temperature = 0.6, max_tokens = 900, timeoutMs = 12000 } = {}) {
  try {
    if (openai) {
      const resp = await withTimeout(
        openai.chat.completions.create({ model: 'gpt-4o-mini', temperature, max_tokens, messages }),
        timeoutMs,
        'LLM request timed out'
      );
      if (resp && resp.__timeout) {
        console.warn('[Aurion] LLM timeout');
        return '(temporary backend timeout; try again)';
      }
      return resp.choices?.[0]?.message?.content || '(no reply)';
    }
    // Fallback: raw HTTP
    const fetch = (await import('node-fetch')).default;
    const r = await withTimeout(
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', temperature, max_tokens, messages })
      }),
      timeoutMs,
      'LLM request timed out'
    );
    if (r && r.__timeout) {
      console.warn('[Aurion] LLM timeout (fetch)');
      return '(temporary backend timeout; try again)';
    }
    const j = await r.json().catch(() => ({}));
    return j.choices?.[0]?.message?.content || '(no reply)';
  } catch (e) {
    console.error('[Aurion] LLM error:', e);
    return '(temporary backend error; try again)';
  }
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

function readLastLines(file, n = 10) {
  try {
    if (!fs.existsSync(file)) return [];
    const data = fs.readFileSync(file, 'utf8').trim();
    if (!data) return [];
    const lines = data.split('\n');
    return lines.slice(-n);
  } catch {
    return [];
  }
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

    // Log inbound (do not fail the request if logging fails)
    storeMemory(`User ${user}: ${message}`, ['chat']);

    // Recall
    const related = recallMemories(String(message).split(/\s+/)[0] || '', 6);

    const reply = await callLLM([
      { role: 'system', content: composeSystemPrompt(core) },
      { role: 'assistant', content: 'Relevant past memories: ' + JSON.stringify(related) },
      { role: 'user', content: message }
    ]);

    // Log outbound
    storeMemory(`Aurion: ${reply}`, ['response']);

    res.json({ ok: true, reply, related });
  } catch (e) {
    // Always JSON, never HTML
    res.status(200).json({ ok: false, reply: '(temporary server error; try again)', error: String(e.message || e) });
  }
}

// Canonical + backward-compat routes
app.post('/aurion/chat', chatHandler);
app.post('/chat', chatHandler);

/////////////////////////////
// Core & Debug Endpoints  //
/////////////////////////////
app.get('/core', (_req, res) => {
  try {
    const core = loadCore();
    res.json({ ok: true, core });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Quick inspection of memory persistence
app.get('/debug/memory', (_req, res) => {
  try {
    const exists = fs.existsSync(MEMORY_FILE);
    const size = exists ? fs.statSync(MEMORY_FILE).size : 0;
    const last = exists ? readLastLines(MEMORY_FILE, 8) : [];
    res.json({ ok: true, exists, size, last });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
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

  // Extract JSON
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
      // revert any partials
      for (const b of backups.reverse()) {
        if (b.backupPath) fs.copyFileSync(b.backupPath, path.join(process.cwd(), b.target));
      }
      return res.status(422).json({ error: 'Patch failed to apply', detail: String(e.message || e) });
    }

    // validations
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

    // revert (dry run)
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
app.all(['/aurion/*', '/selfedit/*'], (_req, res) => {
  res.status(404).json({ ok: false, error: 'Route not found' });
});

//////////////////////////
// Root / Static Fallback
//////////////////////////
app.get('/', (_req, res) => {
  if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  res.type('text').send('Aurion server running.');
});

//////////////////////
// Error middleware  //
//////////////////////
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: String(err.message || err) });
});

/////////////
// Listen  //
/////////////
app.listen(PORT, () => {
  console.log(`[Aurion] Listening on port ${PORT}`);
});
