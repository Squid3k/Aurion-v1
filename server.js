// server.js — Aurion v1 with persistent file memory + built-in web chat
// CommonJS, Node 18+ (global fetch), Render-ready

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

// ---- Storage dir selection ----
// If DB_PATH is set, use its folder (works great with Render Disk at /var/data).
// Else if /var/data exists, use it. Else fall back to /tmp (always writable).
const DATA_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : fs.existsSync('/var/data') ? '/var/data' : '/tmp/aurion-data';

const MSG_FILE = path.join(DATA_DIR, 'conversations.jsonl'); // append-only chat log
const MEM_FILE = path.join(DATA_DIR, 'memories.json');      // small JSON array

function ensurePaths() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(MSG_FILE)) fs.writeFileSync(MSG_FILE, '');
    if (!fs.existsSync(MEM_FILE)) fs.writeFileSync(MEM_FILE, '[]');
  } catch (e) {
    console.error('Init storage failed:', e);
  }
}
ensurePaths();

// ---- Middleware ----
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

// Static site for the chat UI (served at /)
app.use(express.static(path.join(__dirname, 'public')));

// Optional bearer auth for write endpoints
function maybeAuth(req, res, next) {
  if (!API_SECRET) return next();
  const h = req.get('Authorization') || '';
  if (h !== `Bearer ${API_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Identify user (header x-user-id), default "steve"
function getUserId(req) {
  const v = (req.get('x-user-id') || 'steve').toString().slice(0, 64);
  return v || 'steve';
}

// ---- File-memory helpers ----
async function loadRecentMessages(user, limit = 20) {
  try {
    const text = await fsp.readFile(MSG_FILE, 'utf8');
    const lines = text.trim() ? text.trim().split('\n') : [];
    const items = lines.map(l => JSON.parse(l)).filter(m => m.user === user);
    return items.slice(-limit);
  } catch {
    return [];
  }
}
async function saveMessage(user, role, content) {
  const rec = { t: Date.now(), user, role, content };
  await fsp.appendFile(MSG_FILE, JSON.stringify(rec) + '\n', 'utf8');
}
async function getMemories(user) {
  try {
    const arr = JSON.parse(await fsp.readFile(MEM_FILE, 'utf8'));
    return arr.filter(m => m.user === user);
  } catch {
    return [];
  }
}
async function addMemory(user, note) {
  const arr = JSON.parse(await fsp.readFile(MEM_FILE, 'utf8').catch(() => '[]'));
  arr.push({ t: Date.now(), user, note });
  await fsp.writeFile(MEM_FILE, JSON.stringify(arr, null, 2), 'utf8');
}
async function memoryPreamble(user) {
  const mems = (await getMemories(user)).slice(-4).reverse();
  if (mems.length === 0) return 'No saved memories yet.';
  return mems.map(m => `• ${m.note}`).join('\n');
}

// ---- Health & test ----
app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'aurion-v1', version: '0.4.0', model: MODEL, memory_dir: DATA_DIR });
});

app.get('/test', async (_req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ success: false, error: 'Missing OPENAI_API_KEY' });
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    });
    if (!r.ok) throw new Error(`OpenAI API error: ${r.status} ${r.statusText}`);
    const data = await r.json();
    res.json({ success: true, message: 'Aurion-v1 connected to OpenAI!', count: data.data?.length || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// ---- Memory endpoints ----
app.post('/mem/add', maybeAuth, async (req, res) => {
  const user = getUserId(req);
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ error: 'note required' });
  await addMemory(user, note);
  res.json({ ok: true });
});

app.get('/mem/list', maybeAuth, async (req, res) => {
  const user = getUserId(req);
  const mems = await getMemories(user);
  res.json({ ok: true, count: mems.length, memories: mems.slice(-20).reverse() });
});

// ---- OpenAI chat call ----
async function callOpenAI(messages) {
  const body = { model: MODEL, messages }; // o4-mini: no temperature override
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`OpenAI error ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

// ---- Chat endpoints ----
app.post('/chat', maybeAuth, async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    const user = getUserId(req);
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const recent = await loadRecentMessages(user, 12);
    const memText = await memoryPreamble(user);

    const messages = [
      { role: 'system', content: 'You are Aurion: precise, warm, mythic guide. Keep replies short, step-by-step, and practical. Use the memories context if helpful.' },
      { role: 'system', content: `Memories for ${user}:\n${memText}` },
      ...recent.map(r => ({ role: r.role, content: r.content })),
      { role: 'user', content: message }
    ];

    await saveMessage(user, 'user', message);
    const reply = await callOpenAI(messages);
    await saveMessage(user, 'assistant', reply);

    res.json({ success: true, reply });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

app.post('/chat-sync', maybeAuth, async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    const user = getUserId(req);
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const recent = await loadRecentMessages(user, 12);
    const memText = await memoryPreamble(user);
    const messages = [
      { role: 'system', content: 'You are Aurion: precise, warm, mythic guide. Keep replies short, step-by-step, and practical. Use memories if useful.' },
      { role: 'system', content: `Memories for ${user}:\n${memText}` },
      ...recent.map(r => ({ role: r.role, content: r.content })),
      { role: 'user', content: message }
    ];

    await saveMessage(user, 'user', message);
    const reply = await callOpenAI(messages);
    await saveMessage(user, 'assistant', reply);

    res.json({ message: reply });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---- Boot ----
app.listen(PORT, () => {
  console.log(`Aurion-v1 listening on ${PORT}; memory dir: ${DATA_DIR}`);
});
