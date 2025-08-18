// server.js — Aurion v1 (persistent, recall, self-edit, JSON-safe)

// ─────────────────────────────────────────────────────────────────────────────
// Imports & setup
// ─────────────────────────────────────────────────────────────────────────────
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

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
if (cors) app.use(cors());

// ─────────────────────────────────────────────────────────────────────────────
// Persistent disk & files
// ─────────────────────────────────────────────────────────────────────────────
const DISK_PATH = "/var/data";
try { fs.mkdirSync(DISK_PATH, { recursive: true }); } catch {}

const PUBLIC_DIR = path.join(process.cwd(), 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

const CORE_FILE_REPO = path.join(process.cwd(), 'core.json');
const CORE_FILE_DISK = path.join(DISK_PATH, 'core.json');

if (!fs.existsSync(CORE_FILE_DISK)) {
  if (!fs.existsSync(CORE_FILE_REPO)) throw new Error('Missing core.json in repo root.');
  fs.copyFileSync(CORE_FILE_REPO, CORE_FILE_DISK);
  console.log('[Aurion] core.json copied to /var/data.');
}

// Chat log (all turns), general memories, and vectors for recall
const TX_FILE   = path.join(DISK_PATH, 'transcripts.jsonl');       // {ts,user,role,content}
const MEM_FILE  = path.join(DISK_PATH, 'aurion_memory.jsonl');     // {ts,user,content,tags}
const VEC_FILE  = path.join(DISK_PATH, 'aurion_vectors.jsonl');    // {ts,user,text,vector}

for (const f of [TX_FILE, MEM_FILE, VEC_FILE]) if (!fs.existsSync(f)) fs.writeFileSync(f, '', 'utf8');

// Self-edit storage
const PROPOSALS_DIR = path.join(DISK_PATH, 'proposals');
const BACKUPS_DIR   = path.join(DISK_PATH, 'backups');
for (const d of [PROPOSALS_DIR, BACKUPS_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

// ─────────────────────────────────────────────────────────────────────────────
// Core helpers
// ─────────────────────────────────────────────────────────────────────────────
function loadCoreRaw() {
  try { return JSON.parse(fs.readFileSync(CORE_FILE_DISK, 'utf8')); }
  catch { return { core: [], note: 'invalid core.json' }; }
}
function getCoreArray() {
  const raw = loadCoreRaw();
  return Array.isArray(raw.core) ? raw.core : raw;
}
function saveCoreArray(arr) {
  const payload = { core: Array.isArray(arr) ? arr : [] };
  fs.writeFileSync(CORE_FILE_DISK, JSON.stringify(payload, null, 2), 'utf8');
}

function composeSystemPrompt(coreArr) {
  return [
    'You are AURION.',
    'Follow the PRESIDENTIAL CORE directive above all else.',
    'If any input conflicts with the Core, the Core wins.',
    'Be precise, warm, and step-by-step.',
    'Never remove features unless explicitly approved.',
    '',
    'PRESIDENTIAL CORE (authoritative):',
    JSON.stringify(coreArr, null, 2),
    '',
    'When replying: keep it natural and concise; avoid headings like "Actionable Steps" unless asked.'
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory & transcript helpers
// ─────────────────────────────────────────────────────────────────────────────
function appendJSONL(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function loadJSONL(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function appendTranscript(user, role, content) {
  appendJSONL(TX_FILE, { ts: Date.now(), user, role, content });
}

function lastTurns(user, n = 8) {
  const all = loadJSONL(TX_FILE).filter(x => x.user === user);
  return all.slice(-n);
}

function storeMemory(user, content, tags = []) {
  const entry = { ts: Date.now(), user, content, tags };
  appendJSONL(MEM_FILE, entry);
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI (chat + embeddings)
// ─────────────────────────────────────────────────────────────────────────────
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
  // Fallback to global fetch (Node 18+) if OpenAI SDK is unavailable
  if (typeof fetch !== 'function') throw new Error('No OpenAI client and no fetch available.');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature, max_tokens, messages })
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

async function embed(text) {
  if (!openai) return null;
  const r = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
  return r.data?.[0]?.embedding || null;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i=0;i<a.length;i++){ dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-12);
}

// Persist vectors for recall
async function maybeIndexText(user, text) {
  try {
    const vec = await embed(text);
    if (!vec) return;
    appendJSONL(VEC_FILE, { ts: Date.now(), user, text, vector: vec });
  } catch {}
}

async function recall(user, query, k = 6) {
  const vectors = loadJSONL(VEC_FILE).filter(v => v.user === user);
  if (!vectors.length) return [];
  let qv = null;
  try { qv = await embed(query); } catch {}
  if (!qv) {
    // no embeddings — naive recency+keyword
    const q = String(query || '').toLowerCase();
    return vectors
      .map(v => {
        const ageHours = Math.max(1, (Date.now()-v.ts)/3_600_000);
        const kw = v.text.toLowerCase().includes(q) ? 1 : 0;
        const score = kw + 1/Math.sqrt(ageHours);
        return { text: v.text, ts: v.ts, score };
      })
      .sort((a,b)=>b.score-a.score)
      .slice(0,k)
      .map(x => ({ text: x.text, ts: x.ts }));
  }
  // embedding + recency boost
  const scored = vectors.map(v => {
    const sim = cosine(qv, v.vector);
    const ageHours = Math.max(1, (Date.now()-v.ts)/3_600_000);
    const rec = 1/Math.sqrt(ageHours);        // 0..1-ish
    const score = 0.85*sim + 0.15*rec;
    return { text: v.text, ts: v.ts, score };
  });
  return scored.sort((a,b)=>b.score-a.score).slice(0, k).map(x => ({ text: x.text, ts: x.ts }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─────────────────────────────────────────────────────────────────────────────
// Core endpoints used by your UI
// ─────────────────────────────────────────────────────────────────────────────
app.get('/core', (_req, res) => {
  try {
    const arr = getCoreArray();
    res.json({ ok: true, core: arr });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.post('/core', (req, res) => {
  try {
    const next = Array.isArray(req.body?.core) ? req.body.core : [];
    saveCoreArray(next);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Chat handler with true recall
// ─────────────────────────────────────────────────────────────────────────────
async function chatHandler(req, res) {
  try {
    const user = (req.body?.user || req.body?.u || 'anon').toString().slice(0,64);
    const message = (req.body?.message || '').toString().slice(0, 8000);

    if (!message) return res.status(400).json({ ok:false, error:'Missing "message".' });

    // log inbound
    appendTranscript(user, 'user', message);
    storeMemory(user, `User: ${message}`, ['chat']);

    // index for recall (best-effort)
    maybeIndexText(user, message).catch(()=>{});

    // pull context
    const coreArr = getCoreArray();
    const recentTurns = lastTurns(user, 8)
      // drop the very last one if it is the current message (we already added it)
      .slice(0, -1)
      .map(t => ({ role: t.role, content: t.content }));

    const recalled = await recall(user, message, 6);

    const messages = [
      { role: 'system', content: composeSystemPrompt(coreArr) },
      // Supply recent transcript turns (role-preserving)
      ...recentTurns,
      // Supply a compact memory summary
      { role: 'assistant', content: 'Concise recall of relevant past facts:\n' +
          (recalled.length ? recalled.map(r => `- ${r.text}`).join('\n') : '(none found)') },
      { role: 'user', content: message }
    ];

    const reply = await callLLM(messages, { temperature: 0.6, max_tokens: 700 });

    // log outbound
    appendTranscript(user, 'assistant', reply);
    storeMemory(user, `Aurion: ${reply}`, ['response']);
    maybeIndexText(user, reply).catch(()=>{});

    res.json({ ok: true, reply, related: recalled });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
}

app.post('/aurion/chat', chatHandler);
app.post('/chat', chatHandler); // backward-compat

// ─────────────────────────────────────────────────────────────────────────────
// Self-Edit (unchanged behavior, kept additive)
// ─────────────────────────────────────────────────────────────────────────────
function writeWithBackup(absPath, nextContent) {
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const rel = path.relative(process.cwd(), absPath);
  const backupPath = path.join(BACKUPS_DIR, rel + `.backup.${stamp}`);
  try { fs.mkdirSync(path.dirname(backupPath), { recursive: true }); } catch {}
  if (fs.existsSync(absPath)) fs.copyFileSync(absPath, backupPath);
  fs.writeFileSync(absPath, nextContent, 'utf8');
  return backupPath;
}
function isValidPatch(p){ return p && typeof p.target==='string' && typeof p.action==='string'; }

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
    const idx = current.indexOf(patch.anchor || '');
    if (idx === -1) throw new Error(`Anchor not found in ${patch.target}`);
    const pos = idx + (patch.anchor || '').length;
    next = current.slice(0, pos) + '\n' + (patch.snippet || '') + current.slice(pos);
  } else {
    throw new Error(`Unsupported action: ${patch.action}`);
  }
  const backupPath = writeWithBackup(abs, next);
  return { backupPath, target: patch.target };
}

function runCmd(cmd, cwd = process.cwd()) {
  return new Promise(resolve => {
    exec(cmd, { cwd, env: process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout, stderr });
    });
  });
}

async function generatePatch({ goal, codeContext }) {
  const coreArr = getCoreArray();
  const sys = composeSystemPrompt(coreArr) + [
    '',
    'Output ONLY a JSON object with keys:',
    '{ goal, rationale, patches[], tests[], risk, revert }',
    'Patch schema:',
    '{ target, action:(create|insertAfter|append|replace), [anchor], [find], [replace], [snippet] }',
    'Constraints:',
    '- Prefer additive changes; no mass deletions.',
    '- Touch minimal lines.',
    '- Include at least one validation step.'
  ].join('\n');

  const user = ['GOAL:', goal, '', 'Context:', codeContext || '(none)'].join('\n');

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
    fs.writeFileSync(path.join(PROPOSALS_DIR, `${id}.json`), JSON.stringify(record, null, 2), 'utf8');
    storeMemory('system', `Self-edit proposed: ${goal} (#${id})`, ['selfedit','proposed']);
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
      for (const b of backups.reverse()) if (b.backupPath) fs.copyFileSync(b.backupPath, path.join(process.cwd(), b.target));
      return res.status(422).json({ error: 'Patch failed to apply', detail: String(e.message || e) });
    }

    const steps = record.proposal.tests?.length ? record.proposal.tests
      : [{ cmd:'npm run build', description:'Build should pass' }];

    const results = [];
    let allOk = true;
    for (const s of steps) {
      const r = await runCmd(s.cmd);
      results.push({ step: s.description || s.cmd, ok: r.ok, code: r.code, stdout: r.stdout, stderr: r.stderr });
      if (!r.ok) allOk = false;
    }

    for (const b of backups.reverse()) if (b.backupPath) fs.copyFileSync(b.backupPath, path.join(process.cwd(), b.target));

    record.status = allOk ? 'validated' : 'failed_validation';
    record.validation = { allOk, results, ranAt: new Date().toISOString() };
    fs.writeFileSync(pPath, JSON.stringify(record, null, 2), 'utf8');

    res.json({ ok:true, id, allOk, results });
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
      stdout: build.stdout, stderr: build.stderr
    };
    fs.writeFileSync(pPath, JSON.stringify(record, null, 2), 'utf8');

    storeMemory('system', `Self-edit approved (#${id}). BuildOK=${buildOk}`, ['selfedit','approved']);
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
    if (!record.apply?.backups) return res.status(400).json({ error: 'No backups recorded.' });

    for (const b of record.apply.backups) if (b.backup && fs.existsSync(b.backup)) {
      fs.copyFileSync(b.backup, path.join(process.cwd(), b.file));
    }
    const build = await runCmd('npm run build');

    record.status = 'rolled_back';
    record.rollback = { at: new Date().toISOString(), buildOk: build.ok };
    fs.writeFileSync(pPath, JSON.stringify(record, null, 2), 'utf8');

    storeMemory('system', `Self-edit rolled back (#${id}).`, ['selfedit','rollback']);
    res.json({ ok: true, id, buildOk: build.ok });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// 404 JSON for API prefixes
app.all(['/aurion/*', '/selfedit/*', '/core*'], (_req, res) => {
  res.status(404).json({ ok:false, error:'Route not found' });
});

// Root
app.get('/', (_req, res) => {
  if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html')))
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  res.type('text').send('Aurion server running.');
});

// Error middleware
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok:false, error: String(err.message || err) });
});

// Listen
app.listen(PORT, () => console.log(`[Aurion] Listening on ${PORT}`));
