// server.js — Aurion v1 (v0.4.1) with persistent memory on Render Disk + web chat
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

// ---- choose persistent folder ----
const DATA_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : fs.existsSync('/var/data') ? '/var/data' : '/tmp/aurion-data';

const MSG_FILE = path.join(DATA_DIR, 'conversations.jsonl');
const MEM_FILE = path.join(DATA_DIR, 'memories.json');

function ensurePaths() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MSG_FILE)) fs.writeFileSync(MSG_FILE, '');
  if (!fs.existsSync(MEM_FILE)) fs.writeFileSync(MEM_FILE, '[]');
}
ensurePaths();

// ---- middleware ----
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));
app.use(express.static(path.join(__dirname, 'public'))); // web chat

function maybeAuth(req, res, next) {
  if (!API_SECRET) return next();
  const h = req.get('Authorization') || '';
  if (h !== `Bearer ${API_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  next();
}
const userId = req => (req.get('x-user-id') || 'steve').toString().slice(0, 64) || 'steve';

// ---- file helpers ----
async function loadRecent(user, n = 20) {
  try {
    const text = await fsp.readFile(MSG_FILE, 'utf8');
    const lines = text.trim() ? text.trim().split('\n') : [];
    return lines.map(l => JSON.parse(l)).filter(m => m.user === user).slice(-n);
  } catch { return []; }
}
async function appendMsg(user, role, content) {
  await fsp.appendFile(MSG_FILE, JSON.stringify({ t: Date.now(), user, role, content }) + '\n', 'utf8');
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

// ---- health/test ----
app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'aurion-v1', version: '0.4.1', model: MODEL, memory_dir: DATA_DIR });
});
app.get('/test', async (_req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ success: false, error: 'Missing OPENAI_API_KEY' });
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }});
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const data = await r.json();
    res.json({ success: true, message: 'Aurion-v1 connected to OpenAI!', count: data.data?.length || 0 });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

// ---- memory endpoints ----
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

// ---- OpenAI chat ----
async function chatOpenAI(messages) {
  const body = { model: MODEL, messages };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

// ---- chat endpoints ----
app.post('/chat', maybeAuth, async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    const u = userId(req);
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const recent = await loadRecent(u, 12);
    const memText = await memPreamble(u);
    const messages = [
      { role: 'system', content: 'You are Aurion: precise, warm, mythic guide. Keep replies short and actionable.' },
      { role: 'system', content: `Memories for ${u}:\n${memText}` },
      ...recent.map(r => ({ role: r.role, content: r.content })),
      { role: 'user', content: message }
    ];

    await appendMsg(u, 'user', message);
    const reply = await chatOpenAI(messages);
    await appendMsg(u, 'assistant', reply);
    res.json({ success: true, reply });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

app.listen(PORT, () => {
  console.log(`Aurion-v1 listening on ${PORT}; memory dir: ${DATA_DIR}`);
});
