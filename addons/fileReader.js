
// addons/fileReader.js
// Read-only filesystem utilities for Aurion (safe, sandboxed)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DENY = [
  "node_modules/", "backups/", "proposals/", ".git/",
  ".env", ".env.local", ".env.production", ".env.development"
];
const MAX_BYTES = 256 * 1024; // 256 KB per read
const ROOT = process.cwd();

function normalize(relPath) {
  const abs = path.resolve(ROOT, relPath || ".");
  if (!abs.startsWith(ROOT)) throw new Error("Path traversal blocked");
  const rel = path.relative(ROOT, abs).replaceAll("\\", "/");
  for (const bad of DENY) {
    if (rel === bad || rel.startsWith(bad)) throw new Error(`Access denied: ${rel}`);
  }
  return { abs, rel };
}

function listTree(dir, depth = 0, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).replaceAll("\\", "/") + (e.isDirectory() ? "/" : "");
    if (DENY.some(d => rel === d || rel.startsWith(d))) continue;
    out.push({ rel, dir: e.isDirectory(), depth });
    if (e.isDirectory() && depth < 4) listTree(full, depth + 1, out);
  }
  return out;
}

function register(app) {
  // List project tree (shallow)
  app.get("/addon/file/tree", (_req, res) => {
    try { res.json({ ok: true, files: listTree(ROOT) }); }
    catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });

  // Read a slice of a file
  app.post("/addon/file/read", (req, res) => {
    try {
      const { path: relPath, start = 0, end = null, base64 = false } = req.body || {};
      if (!relPath) return res.status(400).json({ ok:false, error: "Missing 'path'" });
      const { abs, rel } = normalize(relPath);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return res.status(400).json({ ok:false, error: "Not a file" });
      const size = stat.size;
      const s = Math.max(0, Number(start) || 0);
      const e = end == null ? Math.min(size, s + MAX_BYTES) : Math.min(size, Number(end));
      if ((e - s) > MAX_BYTES) return res.status(413).json({ ok:false, error: "Slice too large" });

      const fd = fs.openSync(abs, "r");
      const buf = Buffer.alloc(e - s);
      fs.readSync(fd, buf, 0, e - s, s);
      fs.closeSync(fd);

      res.json({ ok: true, rel, size, start: s, end: e, content: base64 ? buf.toString("base64") : buf.toString("utf8") });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // Grep (safe)
  app.post("/addon/file/grep", (req, res) => {
    try {
      const { pattern, path: relPath = "." } = req.body || {};
      if (!pattern) return res.status(400).json({ ok:false, error: "Missing 'pattern'" });
      const { abs } = normalize(relPath);
      const rx = new RegExp(pattern, "i");
      const results = [];

      (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          const rel = path.relative(ROOT, full).replaceAll("\\", "/");
          if (DENY.some(d => rel === d || rel.startsWith(d))) continue;
          if (e.isDirectory()) { if (rel.split("/").length < 10) walk(full); continue; }
          const stat = fs.statSync(full);
          if (stat.size > MAX_BYTES) continue;
          let text = "";
          try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (rx.test(lines[i])) results.push({ file: rel, line: i + 1, preview: lines[i].slice(0, 300) });
            if (results.length >= 500) break;
          }
          if (results.length >= 500) break;
        }
      })(abs);

      res.json({ ok: true, pattern, hits: results.slice(0, 500) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // Integrity hash
  app.post("/addon/file/hash", (req, res) => {
    try {
      const { path: relPath } = req.body || {};
      if (!relPath) return res.status(400).json({ ok:false, error: "Missing 'path'" });
      const { abs, rel } = normalize(relPath);
      const data = fs.readFileSync(abs);
      const sha = crypto.createHash("sha256").update(data).digest("hex");
      res.json({ ok: true, rel, sha256: sha, bytes: data.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  console.log("[addon:fileReader] mounted");
}

module.exports = { register };
