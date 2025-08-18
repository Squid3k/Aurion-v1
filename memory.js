// memory.js
const fs = require('fs');
const path = require('path');

const DISK_PATH = "/var/data";
const MEMORY_FILE = path.join(DISK_PATH, 'aurion_memory.jsonl');

// Ensure disk mount exists (local dev safety)
try { fs.mkdirSync(DISK_PATH, { recursive: true }); } catch {}

// Ensure memory file exists
if (!fs.existsSync(MEMORY_FILE)) {
  fs.writeFileSync(MEMORY_FILE, '', 'utf8');
}

function storeMemory(content, tags = []) {
  const entry = { timestamp: new Date().toISOString(), content, tags };
  fs.appendFileSync(MEMORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function loadMemories() {
  if (!fs.existsSync(MEMORY_FILE)) return [];
  const raw = fs.readFileSync(MEMORY_FILE, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// Simple recall: recency + keyword score
function recallMemories(query, limit = 6) {
  const q = (query || '').toLowerCase();
  const now = Date.now();
  const mems = loadMemories();

  const scored = mems.map(m => {
    const ageHours = Math.max(1, (now - Date.parse(m.timestamp)) / 3_600_000);
    const text = (m.content || '').toLowerCase();
    const kwScore = q ? (text.includes(q) ? 3 : 0) : 0;
    // recency weight (newer = higher)
    const timeScore = 1 / Math.sqrt(ageHours);
    return { m, score: kwScore + timeScore };
  });

  return scored.sort((a,b)=>b.score-a.score).slice(0, limit).map(s => s.m);
}

module.exports = {
  storeMemory,
  loadMemories,
  recallMemories,
  MEMORY_FILE,
  DISK_PATH
};
