// server.js — Aurion v1 (additive, safe, persistent) + FACT RECALL
//
// Features kept from your build:
// - Serves /public
// - /healthz
// - /aurion/chat  (JSON API)  + /chat (compat)
// - Persistent memory on Render disk (/var/data/aurion_memory.jsonl)
// - Presidential Core (core.json copied to /var/data/core.json)
// - Self-rewrite routes: /selfedit/*
// - All API errors return JSON
//
// New (additive):
// - Lightweight facts store at /var/data/facts.json
// - Auto-detect "teach" statements (e.g., “my favorite color is blue”) → saved
// - Auto-detect recall questions (e.g., “what’s my favorite color?”) → answered from facts
// - Optional GET/POST /facts to view/update facts

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
if (cors) app.use(cors());

//////////////////////////
// Persistent Disk Path //
//////////////////////////
const DISK_PATH = "/var/data";
try { fs.mkdirSync(DISK_PATH, { recursive: true }); } catch {}

// Public static
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
    const ageH = Math.max(1, (now - Date.parse(m.timestamp)) / 3_600_000);
    const text = (m.content || '').toLowerCase();
    const kw = q ? (text.includes(q) ? 3 : 0) : 0;
    const rec = 1 / Math.sqrt(ageH);
    return { m, score: kw + rec };
  });
  return scored.sort((a,b)=>b.score-a.score).slice(0, limit).map(x => x.m);
}

/////////////////////////
// Lightweight FACTS   //
/////////////////////////
const FACTS_FILE = path.join(DISK_PATH, 'facts.json');
if (!fs.existsSync(FACTS_FILE)) fs.writeFileSync(FACTS_FILE, JSON.stringify({}, null, 2), 'utf8');

function loadFacts() {
  try { return JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveFacts(facts) {
  fs.writeFileSync(FACTS_FILE, JSON.stringify(facts, null, 2), 'utf8');
}
function setFact(key, value) {
  const facts = loadFacts();
  facts[key] = value;
  saveFacts(facts);
  return { key, value };
}
function getFact(key) {
  const facts = loadFacts();
  return facts[key];
}

// Canonical keys we care about (you can add more anytime).
const FACT_ALIASES = {
  favorite_color: ['favorite color', 'favourite colour', 'fav color', 'fav colour', 'color'],
  creator: ['creator', 'who created you', 'made you'],
  inception_date: ['inception date', 'forged date', 'date of forging', 'birthday', 'birth date'],
  name: ['my name', 'user name']
};

// Simple detectors (fast, robust enough for v1).
function detectTeach(message) {
  // e.g., "my favorite color is blue", "favourite colour is red", "my name is Steve"
  const m1 = /(?:my\s+)?(favorite color|favourite colour|fav(?:ou)?rite colour|fav(?:ou)?rite color|fav color|fav colour|name)\s+is\s+([a-z0-9 \-_'"]{1,40})/i.exec(message);
  if (m1) {
    const rawKey = m1[1].toLowerCase().replace(/\s+/g, ' ').trim();
    const value = m1[2].trim().replace(/^["']|["']$/g,'');
    let key = null;
    if (rawKey.includes('name')) key = 'name';
    else key = 'favorite_color';
    return { key, value };
  }

  // "You were created by Steve" / "Your creator is Steve"
  const m2 = /(?:your|ur)\s+creator\s+(?:is|=)\s+([a-z0-9 \-_'"]{1,60})/i.exec(message);
  if (m2) return { key: 'creator', value: m2[1].trim().replace(/^["']|["']$/g,'') };

  // "You were forged on Aug 15, 2025" / "Your inception date is 2025-08-15"
  const m3 = /(?:your|ur)\s+(?:inception date|forged (?:on)?|date of forging|birthday)\s+(?:is|=|on)\s+([a-z0-9 ,\-\/]{3,40})/i.exec(message);
  if (m3) return { key: 'inception_date', value: m3[1].trim() };

  return null;
}

function detectRecall(message) {
  // e.g., "what's my favorite color", "what is my name", "who created you"
  const lower = message.toLowerCase();

  if (/(what'?s|what is)\s+my\s+(favorite color|favourite colour|fav color|fav colour|name)\b/.test(lower)) {
    if (lower.includes('name')) return { key: 'name' };
    return { key: 'favorite_color' };
  }

  if (/(who\s+created\s+you|who\s+made\s+you|who\s+is\s+your\s+creator)/.test(lower)) {
    return { key: 'creator' };
  }

  if (/(when|what\s+is)\s+(?:were\s+you\s+)?(?:forged|your\s+inception\s+date|your\s+birthday)/.test(lower)) {
    return { key: 'inception_date' };
  }

  return null;
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
// Facts convenience routes//
/////////////////////////////
app.get('/facts', (_req, res) => {
  try { res.json({ ok: true, facts: loadFacts() }); }
  catch (e) { res.status(500).json({ ok:false, error: String(e.message || e) }); }
});
app.post('/facts', (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key || typeof value === 'undefined') return res.status(400).json({ ok:false, error:'key and value required' });
    setFact(String(key), value);
    res.json({ ok:true, key, value });
  } catch (e) { res.status(500).json({ ok:false, error: String(e.message || e) }); }
});

/////////////////////////////
// Chat Handler (JSON API) //
/////////////////////////////
async function chatHandler(req, res) {
  try {
    const { user = 'anon', message = '' } = req.body || {};
    const msg = String(message || '').trim();
    const core = loadCore();

    // Log inbound
    storeMemory(`User ${user}: ${msg}`, ['chat']);

    // 1) Teach detection → persist to facts
    const teach = detectTeach(msg);
    if (teach && teach.key) {
      const saved = setFact(teach.key, teach.value);
      storeMemory(`Fact saved: ${saved.key} = ${saved.value}`, ['facts','teach']);
      return res.json({
        ok: true,
        reply: `Got it, ${user}. I saved ${saved.key.replace('_',' ')} as "${saved.value}".`,
        learned: saved,
        related: recallMemories(saved.key, 4)
      });
    }

    // 2) Recall detection → answer from facts if present
    const ask = detectRecall(msg);
    if (ask && ask.key) {
      const val = getFact(ask.key);
      if (typeof val !== 'undefined') {
        const txt = (ask.key === 'creator')
          ? `I was created by ${val}.`
          : (ask.key === 'inception_date')
          ? `I was forged on ${val}.`
          : (ask.key === 'name')
          ? `Your name is ${val}.`
          : `Your ${ask.key.replace('_',' ')} is ${val}.`;
        storeMemory(`Aurion (fact): ${txt}`, ['facts','response']);
        return res.json({ ok:true, reply: txt, source: 'facts', related: recallMemories(ask.key, 4) });
      }
      // fall through to LLM if not found
    }

    // 3) Normal LLM flow, with a small facts snapshot for extra context
    const facts = loadFacts();
    const related = recallMemories(msg.split(/\s+/)[0] || '', 6);
    const reply = await callLLM([
      { role: 'system', content: composeSystemPrompt(core) },
      { role: 'assistant', content: 'Known facts (key→value): ' + JSON.stringify(facts) },
      { role: 'assistant', content: 'Relevant past memories: ' + JSON.stringify(related) },
      { role: 'user', content: msg }
    ]);

    // Log outbound
    storeMemory(`Aurion: ${reply}`, ['response']);

    res.json({ ok: true, reply, related });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

// New canonical route:
app.post('/aurion/chat', chatHandler);
// Backward-compat for older clients:
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

// API 404s -> JSON
app.all(['/aurion/*', '/selfedit/*'], (req, res) => {
  res.status(404).json({ ok: false, error: 'Route not found' });
});

// Root / Static Fallback
app.get('/', (req, res) => {
  if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  res.type('text').send('Aurion server running.');
});

// Error middleware
app.use((err, req, res, next) => { // eslint-disable-line
  console.error(err);
  res.status(500).json({ ok: false, error: String(err.message || err) });
});

// Listen
app.listen(PORT, () => {
  console.log(`[Aurion] Listening on port ${PORT}`);
});
