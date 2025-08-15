// Aurion v1 — autosave transcripts + persistent memory + core memories + web chat
// Node 18+, CommonJS, Render-ready

require('dotenv').config();
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'o4-mini';
const API_SECRET = process.env.AURION_API_SECRET || '';

// -------- Storage selection --------
const DATA_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : (fs.existsSync('/var/data') ? '/var/data' : '/tmp/aurion-data');

const MSG_FILE  = path.join(DATA_DIR, 'conversations.jsonl'); // global append log
const MEM_FILE  = path.join(DATA_DIR, 'memories.json');       // [{t,user,note}]
const CORE_FILE = path.join(DATA_DIR, 'core_memories.txt');   // seed text
const TX_DIR    = path.join(DATA_DIR, 'transcripts');         // per-user, per-day jsonl

function ensurePaths() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MSG_FILE)) fs.writeFileSync(MSG_FILE, '');
  if (!fs.existsSync(MEM_FILE)) fs.writeFileSync(MEM_FILE, '[]');
  if (!fs.existsSync(TX_DIR))   fs.mkdirSync(TX_DIR, { recursive: true });
  if (!fs.existsSync(CORE_FILE)) {
    const bundled = path.join(__dirname, 'core_memories.txt');
    fs.writeFileSync(CORE_FILE, fs.existsSync(bundled) ? fs.readFileSync(bundled, 'utf8') : '');
  }
}
ensurePaths();

function loadCore() {
  try { return fs.readFileSync(CORE_FILE, 'utf8'); } catch { return ''; }
}
let CORE_TEXT = loadCore();

// -------- Middleware --------
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));
app.use(express.static(path.join(__dirname, 'public'))); // serves the chat UI

function maybeAuth(req, res, next) {
  if (!API_SECRET) return next();
  const h = req.get('Authorization') || '';
  if (h !== `Bearer ${API_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  next();
}
const userId = req => (req.get('x-user-id') || 'steve').toString().slice(0, 64) || 'steve';
const todayStr = () => new Date().toISOString().slice(0,10);
const safe = s => s.replace(/[^a-z0-9_\-]/gi, '_');

// -------- File helpers --------
async function appendMsg(user, role, content) {
  const rec = { t: Date.now(), user, role, content };
  await fsp.appendFile(MSG_FILE, JSON.stringify(rec) + '\n', 'utf8');
}
async function listMems(user) {
  try {
    const arr = JSON.parse(await fsp.readFile(MEM_FILE, 'utf8'));
    return arr.filter(m => m.user === user);
  } catch { return []; }
}
async function addMem(user, note) {
  const arr = JSON.parse(await fsp.readFile(MEM_FILE, 'utf8').catch(() => '[]'));
  arr.push({ t: Date.now(), user, note });
  await fsp.writeFile(MEM_FILE, JSON.stringify(arr, null, 2), 'utf8');
}
async function memPreamble(user) {
  const mems = (await listMems(user)).slice(-4).reverse();
  return mems.length ? mems.map(m => `• ${m.note}`).join('\n') : 'No saved memories yet.';
}
async function loadRecent(user, n = 20) {
  try {
    const text = await fsp.readFile(MSG_FILE, 'utf8');
    const lines = text.trim() ? text.trim().split('\n') : [];
    return lines.map(l => JSON.parse(l)).filter(m => m.user === user).slice(-n);
  } catch { return []; }
}

// -------- Transcript helpers (per user/day) --------
function txPath(user, date = todayStr()) {
  return path.join(TX_DIR, `${safe(user)}-${date}.jsonl`);
}
async function txAppend(user, role, content) {
  const line = JSON.stringify({ t: Date.now(), role, content }) + '\n';
  await fsp.appendFile(txPath(user), line, 'utf8');
}
async function txRead(user, date = todayStr()) {
  try { return await fsp.readFile(txPath(user, date), 'utf8'); } catch { return ''; }
}
async function txList(user) {
  try {
    const files = await fsp.readdir(TX_DIR);
    return files.filter(f => f.startsWith(safe(user) + '-')).sort();
  } catch { return []; }
}

// -------- Health & OpenAI test --------
app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'aurion-v1', version: '1.2.0', model: MODEL, memory_dir: DATA_DIR, core_bytes: CORE_TEXT.length });
});
app.get('/test', async (_req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ success: false, error: 'Missing OPENAI_API_KEY' });
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const data = await r.json();
    res.json({ success: true, message: 'Aurion connected!', count: data.data?.length || 0 });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

// -------- Memory endpoints --------
app.post('/mem/add', maybeAuth, async (req, res) => {
  const u = userId(req);
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ error: 'note required' });
  await addMem(u, note);
  res.json({ ok: true });
});
app.get('/mem/list', maybeAuth, async (req, res) => {
  const u = userId(req);
  const mems = await listMems(u);
  res.json({ ok: true, count: mems.length, memories: mems.slice(-20).reverse() });
});

// -------- Core memories (admin) --------
app.get('/admin/core', maybeAuth, (_req, res) => res.json({ ok: true, text: CORE_TEXT }));
app.post('/admin/set-core', maybeAuth, async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  await fsp.writeFile(CORE_FILE, text, 'utf8');
  CORE_TEXT = text;
  res.json({ ok: true, bytes: CORE_TEXT.length });
});
app.post('/admin/refresh-core', maybeAuth, (_req, res) => {
  CORE_TEXT = loadCore();
  res.json({ ok: true, bytes: CORE_TEXT.length });
});

// -------- Transcript endpoints --------
app.get('/transcript/list', maybeAuth, async (req, res) => {
  const u = userId(req);
  const files = await txList(u);
  res.json({ ok: true, files });
});
app.get('/transcript/today', maybeAuth, async (req, res) => {
  const u = userId(req);
  const text = await txRead(u);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(text || '');
});
app.get('/transcript/download', maybeAuth, async (req, res) => {
  const u = userId(req);
  const date = (req.query.date || todayStr()).toString();
  const file = txPath(u, date);
  try {
    await fsp.access(file);
    res.download(file, `${safe(u)}-${date}.jsonl`);
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});

// -------- OpenAI chat --------
async function chatOpenAI(messages) {
  const body = { model: MODEL, messages }; // o4-mini: no temperature override
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

// -------- Chat endpoint (autosaves transcripts) --------
app.post('/chat', maybeAuth, async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    const u = userId(req);
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    // Save user line immediately (global + transcript)
    await appendMsg(u, 'user', message);
    await txAppend(u, 'user', message);

    // Build context
    const recent = await loadRecent(u, 12);
    const memText = await memPreamble(u);
    const messages = [
      { role: 'system', content: 'You are Aurion: precise, warm, mythic guide. Keep replies short and actionable.' },
      { role: 'system', content: `Core Memories:\n${CORE_TEXT || 'None'}` },
      { role: 'system', content: `Memories for ${u}:\n${memText}` },
      ...recent.map(r => ({ role: r.role, content: r.content })),
      { role: 'user', content: message }
    ];

    const reply = await chatOpenAI(messages);

    // Save assistant line (global + transcript)
    await appendMsg(u, 'assistant', reply);
    await txAppend(u, 'assistant', reply);

    res.json({ success: true, reply });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

// -------- Boot --------
app.listen(PORT, () => {
  console.log(`Aurion v1 listening on ${PORT}; memory dir: ${DATA_DIR}; transcripts: ${TX_DIR}`);
});
