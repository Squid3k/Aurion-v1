// rollback.js
const fs = require("fs");
const path = require("path");

const BACKUP_DIR = "/var/data/aurion/backups";
const TARGET_FILE = "server.js";

function listBackups() {
  const files = fs.readdirSync(BACKUP_DIR).sort();
  return files;
}

function restoreLatest() {
  const backups = listBackups();
  if (backups.length === 0) {
    console.error("No backups found.");
    process.exit(1);
  }
  const latest = backups[backups.length - 1];
  const src = path.join(BACKUP_DIR, latest);
  fs.copyFileSync(src, TARGET_FILE);
  console.log(`✅ Restored from backup: ${latest}`);
}

if (require.main === module) {
  restoreLatest();
}
