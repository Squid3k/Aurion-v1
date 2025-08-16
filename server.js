import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import bodyParser from 'body-parser';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the public directory
app.use(express.static('public'));
app.use(bodyParser.json());
app.use(cors());

// Data directories and files
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'aurion-data');
const TX_FILE = path.join(DATA_DIR, 'transcripts.jsonl');
const CORE_FILE = path.join(DATA_DIR, 'core.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PATCH_DIR = path.join(DATA_DIR, 'patches');

// Ensure directories exist
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(PATCH_DIR, { recursive: true });
if (!fs.existsSync(TX_FILE)) fs.writeFileSync(TX_FILE, '');
if (!fs.existsSync(CORE_FILE)) fs.writeFileSync(CORE_FILE, JSON.stringify({ core: [] }, null, 2));

// Utility functions
function loadCore() {
  return JSON.parse(fs.readFileSync(CORE_FILE, 'utf-8'));
}

function saveCore(data) {
  fs.writeFileSync(CORE_FILE, JSON.stringify(data, null, 2));
}

function appendTx(user, role, content) {
  const entry = { user, role, content, time: Date.now() };
  fs.appendFileSync(TX_FILE, JSON.stringify(entry) + '\n');
}

function getHistory(user, limit = 15) {
  const lines = fs.readFileSync(TX_FILE, 'utf-8')
    .trim().split('\n')
    .filter(Boolean)
    .map(l => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean)
    .filter(e => e.user === user)
    .slice(-limit);
  return lines.map(e => ({ role: e.role, content: e.content }));
}

// Chat endpoint
app.post('/chat', async (req, res) => {
  try {
    const { message, u = 'default', prime = '', core = false } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'No message provided' });
    }

    const history = getHistory(u);
    const messages = [];

    // Base system prompt
    messages.push({
      role: 'system',
      content: 'You are Aurion, a friendly and mythic guide. Speak with precision, warmth, light humor, and a touch of legend.'
    });

    // Optional prime prompt
    if (prime) {
      messages.push({ role: 'system', content: prime });
    }

    // Optional core memories
    if (core) {
      const coreData = loadCore();
      if (coreData.core && coreData.core.length) {
        messages.push({ role: 'system', content: `Core memories: ${coreData.core.join('; ')}` });
      }
    }

    // Conversation history and new user message
    messages.push(...history);
    messages.push({ role: 'user', content: message });

    // Call OpenAI
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        messages
      })
    });
    const data = await response.json();
    let reply = data.choices?.[0]?.message?.content?.trim() || '(silent embers)';

    // Ensure single "Aurion:" prefix
    if (!/^Aurion:\s*/i.test(reply)) {
      reply = `Aurion: ${reply}`;
    }

    appendTx(u, 'user', message);
    appendTx(u, 'assistant', reply);

    res.json({ reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error) });
  }
});

// Core memory endpoints
app.get('/core', (req, res) => {
  res.json(loadCore());
});
app.post('/core', (req, res) => {
  const { core } = req.body;
  if (!Array.isArray(core)) {
    return res.status(400).json({ error: 'core must be an array of strings' });
  }
  saveCore({ core });
  res.json({ ok: true });
});

// Propose patch endpoint (simple validation)
app.post('/dev/propose', (req, res) => {
  const { patch } = req.body;
  if (!patch) {
    return res.status(400).json({ ok: false, error: 'No patch provided' });
  }
  res.json({ ok: true, patch });
});

// Apply patch endpoint with backup
app.post('/dev/apply', (req, res) => {
  const { patch, target = 'server.js' } = req.body;
  try {
    if (!patch) {
      return res.status(400).json({ ok: false, error: 'No patch provided' });
    }
    const targetPath = path.join(process.cwd(), target);
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ ok: false, error: `Target file ${target} not found` });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `${timestamp}_${target}`);
    fs.copyFileSync(targetPath, backupPath);

    const patchFile = path.join(PATCH_DIR, `${timestamp}.patch`);
    fs.writeFileSync(patchFile, patch);

    // Write the patch content directly as the new file contents
    fs.writeFileSync(targetPath, patch);
    res.json({ ok: true, backup: path.basename(backupPath), patch: path.basename(patchFile) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Aurion v1 listening on port ${PORT}`);
});
