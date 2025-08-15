import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { OpenAI } from 'openai';
import Database from 'better-sqlite3';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Slow down abusers
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

// Secrets & model
const API_SECRET = process.env.AURION_API_SECRET || crypto.randomBytes(16).toString('hex');
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple database (persists if you mount /var/data on Render)
const dbPath = process.env.DB_PATH || './aurion.sqlite';
const db = new Database(dbPath);
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_id TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id TEXT,
  role TEXT,
  content TEXT,
  ts INTEGER
);
`);

function auth(req, res, next) {
  const h = req.get('Authorization') || '';
  if (h !== `Bearer ${API_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Health check
app.get('/', (_req, res) => res.json({ ok: true, name: 'aurion-v1', version: '0.1', streaming: true }));

// Simple, non-streaming chat (easy from phone)
app.post('/chat-sync', auth, async (req, res) => {
  try {
    const { user_id = 'phone', conv_id, message, system } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const cid = conv_id || crypto.randomUUID();
    db.prepare('INSERT OR IGNORE INTO conversations (id, user_id, created_at) VALUES (?,?,?)')
      .run(cid, user_id, Date.now());

    const history = db
      .prepare('SELECT role, content FROM messages WHERE conv_id=? ORDER BY id ASC')
      .all(cid)
      .map(r => ({ role: r.role, content: r.content }));

    const messages = [
      { role: 'system', content: system || 'You are Aurion: precise, warm guide. Return short, step-by-step actions and working code.' },
      ...history,
      { role: 'user', content: message }
    ];

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.3
    });

    const text = completion.choices?.[0]?.message?.content || '';

    // Store both sides
    db.prepare('INSERT INTO messages (conv_id, role, content, ts) VALUES (?,?,?,?)')
      .run(cid, 'user', message, Date.now());
    db.prepare('INSERT INTO messages (conv_id, role, content, ts) VALUES (?,?,?,?)')
      .run(cid, 'assistant', text, Date.now());

    res.json({ conv_id: cid, message: text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'chat-failed', detail: String(e?.message || e) });
  }
});

// (Optional) streaming endpoint for web clients
app.post('/chat', auth, async (req, res) => {
  try {
    const { user_id = 'phone', conv_id, message, system } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const cid = conv_id || crypto.randomUUID();

    const history = db
      .prepare('SELECT role, content FROM messages WHERE conv_id=? ORDER BY id ASC')
      .all(cid)
      .map(r => ({ role: r.role, content: r.content }));

    const messages = [
      { role: 'system', content: system || 'You are Aurion: precise, warm, actionable.' },
      ...history,
      { role: 'user', content: message }
    ];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    db.prepare('INSERT OR IGNORE INTO conversations (id, user_id, created_at) VALUES (?,?,?)')
      .run(cid, user_id, Date.now());
    db.prepare('INSERT INTO messages (conv_id, role, content, ts) VALUES (?,?,?,?)')
      .run(cid, 'user', message, Date.now());

    const stream = await openai.chat.completions.create({ model: MODEL, messages, stream: true, temperature: 0.3 });

    let buffer = '';
    for await (const part of stream) {
      const chunk = part.choices?.[0]?.delta?.content || '';
      if (chunk) {
        buffer += chunk;
        res.write(`data: ${JSON.stringify({ type: 'text', data: chunk })}\n\n`);
      }
    }

    db.prepare('INSERT INTO messages (conv_id, role, content, ts) VALUES (?,?,?,?)')
      .run(cid, 'assistant', buffer, Date.now());

    res.write(`data: ${JSON.stringify({ type: 'done', conv_id: cid })}\n\n`);
    res.end();
  } catch (e) {
    console.error(e);
    res.write(`data: ${JSON.stringify({ type: 'error', detail: String(e?.message || e) })}\n\n`);
    res.end();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`aurion-v1 listening on ${port}`));
