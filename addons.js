// addons.js — simple loader
const fs = require('fs');
const path = require('path');

const ADDONS_DIR = path.join(process.cwd(), 'addons');
function loadAddons(app) {
  if (!fs.existsSync(ADDONS_DIR)) return;
  const files = fs.readdirSync(ADDONS_DIR).filter(f => f.endsWith('.js'));
  for (const file of files) {
    try {
      const mod = require(path.join(ADDONS_DIR, file));
      if (typeof mod.register === 'function') {
        mod.register(app);
        console.log(`[Aurion] Add-on loaded: ${file}`);
      }
    } catch (e) {
      console.error(`[Aurion] Failed to load add-on ${file}:`, e);
    }
  }
}
module.exports = { loadAddons };
