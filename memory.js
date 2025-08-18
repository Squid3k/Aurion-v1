const fs = require('fs');
const path = require('path');

const DISK_PATH = "/var/data";  // your Render disk mount
const MEMORY_FILE = path.join(DISK_PATH, 'aurion_memory.jsonl');

function storeMemory(content, tags = []) {
  const entry = {
    timestamp: new Date().toISOString(),
    content,
    tags
  };
  fs.appendFileSync(MEMORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function loadMemories() {
  if (!fs.existsSync(MEMORY_FILE)) return [];
  return fs.readFileSync(MEMORY_FILE, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
}

function searchMemories(keyword) {
  const mems = loadMemories();
  return mems.filter(m => m.content.toLowerCase().includes(keyword.toLowerCase()));
}

module.exports = { storeMemory, loadMemories, searchMemories, MEMORY_FILE };
