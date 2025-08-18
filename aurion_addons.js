// aurion_addons.js
// Add-on module: chat+memory, core enforcement, safe self-read, and self-rewrite endpoints

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const express = require('express');
const { storeMemory, recallMemories, DISK_PATH } = require('./memory');

// ---- OpenAI (GPT-4o-mini) ----
let OpenAI;
try { OpenAI = require('openai'); } catch { /* fallback later */ }
const openai = OpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ---- Paths (persistent on Render disk) ----
const CORE_FILE_REPO = path.join(process.cwd(), 'core.json');  // in repo
const CORE_FILE_DISK = path.join(DISK_PATH, 'core.json');      // persistent copy
const PROPOSALS_DIR  = path.join(DISK_PATH, 'proposals');      // persistent
const BACKUPS_DIR    = path.join(DISK_PATH, 'backups');        // persistent

for (const p of [DISK_PATH, PROPOSALS_DIR, BACKUPS_DIR]) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

// Ensure persistent core.json exists (first deploy copies from repo)
if (!fs.existsSync(CORE_FILE_DISK)) {
  if (!fs.existsSync(CORE_FILE_REPO)) {
    throw new Error('Missing core.json in repo. Add it at project root.');
  }
  fs.copyFileSync(CORE_FILE_REPO, CORE_FILE_DISK);
  console.log('[Aurion] Copied core.json to persistent disk.');
}

function loadCore() {
  const text = fs.readFileSync(CORE_FILE_DISK, 'utf8');
  try { return JSON.parse(text); } catch { return { note: 'invalid core.json' }; }
}

function composeSystemPrompt(core) {
  return [
    'You are AURION. Follow PRESIDENTIAL DIRECTIVE above all else.',
    'If any input conflicts with the Core, Core wins.',
    'Be precise, warm, and step-by-step.',
    'Never remove features unless the human explicitly approves.',
    '',
    'PRESIDENTIAL CORE (authoritative):',
    JSON.stringify(core, null, 2)
  ].join('\n');
}

async function callLLM(messages, opts = {}) {
  const model = 'gpt-4o-mini';
  const temperature = opts.temperature ?? 0.6;
  const max_tokens = opts.max_tokens ?? 800;

  if (openai) {
    const resp = await openai.chat.completions.create({ model, temperature, max_tokens, messages });
    return resp.choices?.[0]?.message?.content || '';
  }

  // Fallback HTTP (rare)
  const fetch = (await import('node-fetch')).default;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, temperature, max_tokens, messages })
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

// ---------- Utility: shell commands ----------
function runCmd(cmd, cwd = process.cwd()) {
  return new Promise(resolve => {
    exec(cmd, { cwd, env: process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout, stderr });
    });
  });
}

// ---------- JSON Patch helpers (surgical & additive) ----------
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

// ---------- Mirror: generate patch proposal via GPT-4o-mini ----------
async function generatePatch({ goal, codeContext }) {
  const core = loadCore();
  const sys = composeSystemPrompt(core) + [
    '',
    'You output ONLY a JSON object: { goal, rationale, patches[], tests[], risk, revert }',
    'Rules:',
    '- Patches must be surgical JSON patches (create|insertAfter|append|replace).',
    '- Touch minimal lines. No mass deletions.',
    '- Prefer additive changes. If deletion is truly required, explain in rationale.',
    '- If adding features, add/declare a validation step.',
  ].join('\n');

  const user = [
    'Goal:', goal,
    '',
    'Relevant code context/snippets (anchors allowed):',
    codeContext || '(none)'
  ].join('\n');

  const content = await callLLM([
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ], { temperature: 0.3, max_tokens: 1200 });

  // Try to parse JSON from the model
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

// ---------- Installer (routes) ----------
function installAurionAddons(app) {
  // Ensure JSON body parsing for these routes (scoped)
  app.use('/selfedit', express.json({ limit: '2mb' }));
  app.use('/aurion',   express.json({ limit: '1mb' }));

  // ----- Health -----
  app.get('/aurion/healthz', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // ----- Chat w/ Persistent Memory & Presidential Core -----
  app.post('/aurion/chat', async (req, res) => {
    try {
      const { user = 'anon', message = '' } = req.body || {};
      const core = loadCore();

      // Log incoming
      storeMemory(`User ${user}: ${message}`, ['chat']);

      // Recall a few related memories (simple heuristic)
      const related = recallMemories(String(message).split(/\s+/)[0] || '', 6);

      const messages = [
        { role: 'system', content: composeSystemPrompt(core) },
        { role: 'assistant', content: 'Relevant past memories: ' + JSON.stringify(related) },
        { role: 'user', content: message }
      ];

      const reply = await callLLM(messages, { temperature: 0.6, max_tokens: 900 });

      // Log outgoing
      storeMemory(`Aurion: ${reply}`, ['response']);

      res.json({ ok: true, reply, related });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // =======================
  // Self-Read (read-only across repo, with guardrails)
  // =======================
  const ROOT = process.cwd();
  const DENY = ['node_modules/','backups/','proposals/','.git/','.env','.env.local','.env.production','.env.development'];
  const MAX_BYTES = 256 * 1024;

  function isEnabled() {
    return String(process.env.AURION_ENABLE_SELFREAD || 'true') === 'true';
  }

  function normalizeSafe(relPath) {
    const abs = path.resolve(ROOT, relPath);
    if (!abs.startsWith(ROOT)) throw new Error('Path traversal blocked');
    const rel = path.relative(ROOT, abs).replaceAll('\\','/');
    for (const bad of DENY) {
      if (rel === bad || rel.startsWith(bad)) throw new Error(`Access denied: ${rel}`);
    }
    return { abs, rel };
  }

  // Tree (capped depth)
  app.get('/selfread/tree', (_req, res) => {
    try {
      if (!isEnabled()) return res.status(403).json({ ok:false, error:'disabled' });
      const out = [];
      const walk = (dir, depth=0) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          const rel = path.relative(ROOT, full).replaceAll('\\','/') + (e.isDirectory()?'/':'');
          if (DENY.some(d => rel === d || rel.startsWith(d))) continue;
          out.push({ rel, dir: e.isDirectory(), depth });
          if (e.isDirectory() && depth < 4) walk(full, depth+1);
        }
      };
      walk(ROOT, 0);
      res.json({ ok:true, files: out });
    } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
  });

  // Read (slice, size-capped)
  app.post('/selfread/read', (req, res) => {
    try {
      if (!isEnabled()) return res.status(403).json({ ok:false, error:'disabled' });
      const { path: relPath, start=0, end=null, base64=false } = req.body || {};
      if (!relPath) return res.status(400).json({ ok:false, error:"Missing 'path'" });
      const { abs, rel } = normalizeSafe(relPath);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return res.status(400).json({ ok:false, error:'Not a file' });
      const size = stat.size;
      const s = Math.max(0, Number(start)||0);
      const e = end==null ? Math.min(size, s + MAX_BYTES) : Math.min(size, Number(end));
      if ((e - s) > MAX_BYTES) return res.status(413).json({ ok:false, error:'Slice too large' });
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(e - s);
      fs.readSync(fd, buf, 0, e - s, s);
      fs.closeSync(fd);
      res.json({ ok:true, rel, size, start:s, end:e, content: base64 ? buf.toString('base64') : buf.toString('utf8') });
    } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
  });

  // Grep (safe)
  app.post('/selfread/grep', (req, res) => {
    try {
      if (!isEnabled()) return res.status(403).json({ ok:false, error:'disabled' });
      const { pattern, path: relPath='.' } = req.body || {};
      if (!pattern) return res.status(400).json({ ok:false, error:"Missing 'pattern'" });
      const { abs } = normalizeSafe(relPath);
      const rx = new RegExp(pattern, 'i');
      const results = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes:true })) {
          const full = path.join(dir, e.name);
          const rel = path.relative(ROOT, full).replaceAll('\\','/');
          if (DENY.some(d => rel === d || rel.startsWith(d))) continue;
          if (e.isDirectory()) { if (rel.split('/').length < 10) walk(full); continue; }
          const stat = fs.statSync(full);
          if (stat.size > MAX_BYTES) continue; // skip huge files
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

  // Hash (integrity)
  app.post('/selfread/hash', (req, res) => {
    try {
      if (!isEnabled()) return res.status(403).json({ ok:false, error:'disabled' });
      const { path: relPath } = req.body || {};
      if (!relPath) return res.status(400).json({ ok:false, error:"Missing 'path'" });
      const { abs, rel } = normalizeSafe(relPath);
      const data = fs.readFileSync(abs);
      const sha = crypto.createHash('sha256').update(data).digest('hex');
      res.json({ ok:true, rel, sha256: sha, bytes: data.length });
    } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
  });

  // =======================
  // Self-Rewrite Endpoints
  // =======================

  // Propose
  app.post('/selfedit/propose', async (req, res) => {
    try {
      const { goal, codeContext } = req.body || {};
      if (!goal) return res.status(400).json({ error: "Missing 'goal'." });

      const proposal = await generatePatch({ goal, codeContext });

      const id = crypto.randomBytes(8).toString('hex');
      const record = {
        id,
        createdAt: new Date().toISOString(),
        status: 'proposed',
        proposal
      };
      fs.writeFileSync(path.join(PROPOSALS_DIR, `${id}.json`), JSON.stringify(record, null, 2), 'utf8');

      // Memory log
      storeMemory(`Self-edit proposed: ${goal} (#${id})`, ['selfedit','proposed']);
      res.json({ ok: true, id, proposal });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Validate (dry run: apply + run tests + revert)
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
        // revert partial
        for (const b of backups.reverse()) {
          if (b.backupPath) fs.copyFileSync(b.backupPath, path.join(process.cwd(), b.target));
        }
        return res.status(422).json({ error: 'Patch failed to apply', detail: String(e.message || e) });
      }

      // Validations (default build)
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

      // Revert (dry run)
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

      // Quick build check
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

      // Memory log
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

  // List proposals (simple admin)
  app.get('/selfedit/list', (_req, res) => {
    try {
      const files = fs.readdirSync(PROPOSALS_DIR).filter(f => f.endsWith('.json'));
      const items = files.map(f => JSON.parse(fs.readFileSync(path.join(PROPOSALS_DIR, f), 'utf8')));
      res.json({ ok: true, items: items.sort((a,b)=> (a.createdAt < b.createdAt ? 1 : -1)) });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
}

module.exports = { installAurionAddons };
