// Aurion v1 — lean build: persistent transcripts, auto-remember, core admin, no UI memories.
// Node 18+ CommonJS

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

// ---------- storage ----------
const DATA_DIR = fs.existsSync('/var/data') ? '/var/data' : '/tmp/aurion-data';
const TX_DIR = path.join(DATA_DIR, 'transcripts');
const CORE_FILE = path.join(DATA_DIR, 'core_memories.txt');
const PRIME_FILE = path.join(DATA_DIR, 'prime_objective.txt');

for (const p of [DATA_DIR, TX_DIR]) if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
if (!fs.existsSync(CORE_FILE)) fs.writeFileSync(CORE_FILE, '');
if (!fs.existsSync(PRIME_FILE)) fs.writeFileSync(PRIME_FILE, '');

const today = () => new Date().toISOString().slice(0,10);
const safe = s => (s || '').toString().replace(/[^a-z0-9_\-]/gi,'_');
const userId = req => (req.get('x-user-id') || 'steve');

// ---------- express ----------
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));
app.use(express.static(path.join(__dirname, 'public')));

function maybeAuth(req, res, next){
  if (!API_SECRET) return next();
  if ((req.get('Authorization') || '') !== `Bearer ${API_SECRET}`)
    return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---------- helpers ----------
function txPath(u, d = today()){ return path.join(TX_DIR, `${safe(u)}-${d}.jsonl`); }

async function txAppend(u, role, content){
  const line = JSON.stringify({ t: Date.now(), role, content }) + '\n';
  await fsp.appendFile(txPath(u), line, 'utf8');
}

async function txRead(u, d = today()){
  try {
    const text = await fsp.readFile(txPath(u, d), 'utf8');
    return text.trim() ? text.trim().split('\n').map(l => JSON.parse(l)) : [];
  } catch { return []; }
}

function loadFile(file){
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// ---------- health ----------
app.get('/health', (_req,res)=>{
  res.json({
    ok:true, name:'aurion-v1', version:'1.3.0', model:MODEL,
    memory_dir: DATA_DIR,
    core_bytes: loadFile(CORE_FILE).length
  });
});

// ---------- admin: core memories ----------
app.get('/admin/core', maybeAuth, (_req,res)=> res.json({ ok:true, text: loadFile(CORE_FILE) }));
app.post('/admin/set-core', maybeAuth, async (req,res)=>{
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error:'text required' });
  await fsp.writeFile(CORE_FILE, text, 'utf8');
  res.json({ ok:true, bytes: text.length });
});

// (Optional but useful) prime objective endpoints
app.get('/admin/prime', maybeAuth, (_req,res)=> res.json({ ok:true, text: loadFile(PRIME_FILE) }));
app.post('/admin/set-prime', maybeAuth, async (req,res)=>{
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error:'text required' });
  await fsp.writeFile(PRIME_FILE, text, 'utf8');
  res.json({ ok:true, bytes: text.length });
});

// ---------- transcripts for UI ----------
app.get('/history', maybeAuth, async (req,res)=>{
  const u = userId(req);
  const d = (req.query.date || today()).toString();
  const items = await txRead(u, d);
  res.json({ ok:true, date:d, items });
});

// ---------- OpenAI ----------
async function chatOpenAI(messages){
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${OPENAI_API_KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ model: MODEL, messages })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

// ---------- chat ----------
app.post('/chat', maybeAuth, async (req,res)=>{
  try{
    if (!OPENAI_API_KEY) return res.status(500).json({ error:'OPENAI_API_KEY not set' });
    const u = userId(req);
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error:'message required' });

    // append user turn
    await txAppend(u, 'user', message);

    // build context: prime + core + full today history
    const prime = loadFile(PRIME_FILE);
    const core  = loadFile(CORE_FILE);
    const history = await txRead(u); // full today

    const messages = [
      { role:'system', content:
        `You are Aurion, Steve Satoshi’s precise, warm, mythic guide. Keep replies concise and actionable.` },
      prime ? { role:'system', content:`Prime Objective:\n${prime}` } : null,
      core  ? { role:'system', content:`Core Memories:\n${core}` } : null,
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role:'user', content: message }
    ].filter(Boolean);

    const reply = await chatOpenAI(messages);

    await txAppend(u, 'assistant', reply);

    res.json({ success:true, reply });
  }catch(e){
    res.status(500).json({ success:false, error:String(e.message||e) });
  }
});

app.listen(PORT, ()=> console.log(`Aurion v1 listening on ${PORT}, data: ${DATA_DIR}`));
