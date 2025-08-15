// server.js — Aurion v1 (CommonJS, Node 18+)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'o4-mini';
const API_SECRET = process.env.AURION_API_SECRET || '';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 60 })); // basic guard

// Optional bearer auth for write endpoints
function maybeAuth(req, res, next) {
  if (!API_SECRET) return next();
  const h = req.get('Authorization') || '';
  if (h !== `Bearer ${API_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---- Health ----
app.get('/', (_req, res) => {
  res.json({ ok: true, name: 'aurion-v1', version: '0.2.0', model: MODEL });
});

// ---- OpenAI connectivity test ----
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

// ---- Chat (simple) ----
// POST /chat  { "message": "Hello Aurion" }
app.post('/chat', maybeAuth, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

    const body = {
      model: MODEL, // o4-mini by default
      messages: [
        { role: 'system', content: 'You are Aurion: precise, warm, mythic guide. Keep replies short, step-by-step, and practical.' },
        { role: 'user', content: message }
      ],
      temperature: 0.35
    };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`OpenAI error ${r.status}: ${txt}`);
    }

    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content || '';
    res.json({ success: true, reply });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// ---- Chat alias kept for compatibility ----
app.post('/chat-sync', maybeAuth, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are Aurion: precise, warm, mythic guide. Keep replies short, step-by-step, and practical.' },
        { role: 'user', content: message }
      ],
      temperature: 0.35
    };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`OpenAI error ${r.status}: ${txt}`);
    }

    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content || '';
    res.json({ message: reply });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Aurion-v1 listening on ${PORT}`);
});
