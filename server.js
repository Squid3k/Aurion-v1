// server.js
import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import bodyParser from "body-parser";
import multer from "multer";

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Storage dirs (Render Disk preferred) ----------
const ROOT = process.cwd();
const PERSIST = process.env.MEM_DIR || "/data";                 // Render Disk mount (if added)
const FALLBACK = "/tmp/aurion-data";                            // Ephemeral fallback
const DATA_DIR = fs.existsSync(PERSIST) ? PERSIST : FALLBACK;

const TX_FILE   = path.join(DATA_DIR, "transcripts.jsonl");
const CORE_FILE = path.join(DATA_DIR, "core.json");
const BAK_DIR   = path.join(DATA_DIR, "backups");

// ensure dirs/files
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BAK_DIR,   { recursive: true });
if (!fs.existsSync(TX_FILE))   fs.writeFileSync(TX_FILE, "");
if (!fs.existsSync(CORE_FILE)) fs.writeFileSync(CORE_FILE, JSON.stringify({ core: [] }, null, 2));

// ---------- Middleware ----------
app.use(bodyParser.json({ limit: "2mb" }));
app.use(express.static("public"));

// for drag & drop uploads
const upload = multer({ storage: multer.memoryStorage() });

// ---------- Helpers ----------
const txAppend = (user, role, content) => {
  fs.appendFileSync(TX_FILE, JSON.stringify({ user, role, content, time: Date.now() }) + "\n");
};
const getCore  = () => JSON.parse(fs.readFileSync(CORE_FILE, "utf8"));
const saveCore = (data) => fs.writeFileSync(CORE_FILE, JSON.stringify(data, null, 2));

const ts = () => new Date().toISOString().replace(/[:.]/g, "-");

// limit what files Aurion is allowed to change
const ALLOWLIST = new Set([
  "server.js",
  "package.json",
  "public/index.html",
  "public/dev.html",
  "public/admin.html",
  "public/chat.html",
  "public/styles.css"
]);

// ensure path is inside project + allowlisted
function sanitizeAndCheck(relPath) {
  if (!relPath) throw new Error("Missing path");
  const normalized = path.posix.normalize(relPath).replace(/^\/+/, "");
  const abs = path.join(ROOT, normalized);
  if (!ALLOWLIST.has(normalized)) {
    throw new Error(`Path not allowed: ${normalized}`);
  }
  if (!abs.startsWith(ROOT)) throw new Error("Path escapes project root");
  return { abs, normalized };
}

function backupFile(absPath, normalized) {
  if (!fs.existsSync(absPath)) return null;
  const bname = normalized.replace(/\//g, "__");
  const file = path.join(BAK_DIR, `${bname}.${ts()}.bak`);
  fs.copyFileSync(absPath, file);
  return file;
}

// ---------- Health ----------
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Aurion-v1 connected to OpenAI!",
    count: 79,
    dataDir: DATA_DIR
  });
});

// ---------- Chat ----------
app.post("/chat", async (req, res) => {
  try {
    const { message, u = "guest", prime, core } = req.body;
    if (!message) return res.status(400).json({ success: false, error: "message required" });

    // load recent history
    const history = fs.readFileSync(TX_FILE, "utf8")
      .trim().split("\n").filter(Boolean)
      .map(line => JSON.parse(line))
      .slice(-15);

    const coreData = getCore();

    const messages = [
      { role: "system", content: "You are Aurion, guide to Steve Reyher. Speak with precision, warmth, mythic fire, and light humor." },
      prime ? { role: "system", content: prime } : null,
      (core && coreData.core?.length)
        ? { role: "system", content: `Core memories: ${coreData.core.join("; ")}` }
        : null,
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: "user", content: message }
    ].filter(Boolean);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages })
    });

    const j = await r.json();
    let reply = j?.choices?.[0]?.message?.content || "(silent embers)";
    reply = `Aurion: ${reply}`;

    txAppend(u, "user", message);
    txAppend(u, "assistant", reply);

    res.json({ success: true, reply });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// ---------- Core memory admin ----------
app.get("/core", (req, res) => res.json(getCore()));

app.post("/core", (req, res) => {
  try {
    const { core } = req.body;
    if (!Array.isArray(core)) return res.status(400).json({ ok: false, error: "core must be an array of strings" });
    saveCore({ core });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- Developer console: stage/apply with backups ----------
app.post("/dev/stage", (req, res) => {
  try {
    const { path: relPath, content } = req.body;
    if (!content && content !== "") return res.status(400).json({ ok: false, error: "content required" });

    const { abs, normalized } = sanitizeAndCheck(relPath);
    const bakPath = backupFile(abs, normalized);

    // ensure parent dir
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);

    res.json({
      ok: true,
      wrote: normalized,
      backup: bakPath ? path.basename(bakPath) : null,
      note: "File staged successfully"
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

// list backups
app.get("/dev/backups", (req, res) => {
  try {
    const files = fs.readdirSync(BAK_DIR)
      .filter(f => f.endsWith(".bak"))
      .sort()
      .reverse()
      .slice(0, 200); // cap
    res.json({ ok: true, backups: files });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// restore a backup
app.post("/dev/restore", (req, res) => {
  try {
    const { backup } = req.body; // e.g. "public__dev.html.2025-08-15T19-55-01-234Z.bak"
    if (!backup || backup.includes("..") || backup.includes("/")) {
      return res.status(400).json({ ok: false, error: "invalid backup name" });
    }
    const bakAbs = path.join(BAK_DIR, backup);
    if (!fs.existsSync(bakAbs)) return res.status(404).json({ ok: false, error: "backup not found" });

    // infer target file from backup name
    const originalRel = backup.replace(/\.([0-9T\-]+)\.bak$/, "").replace(/__/g, "/");
    const { abs, normalized } = sanitizeAndCheck(originalRel);

    // backup current before restore
    backupFile(abs, normalized);
    fs.copyFileSync(bakAbs, abs);

    res.json({ ok: true, restored: normalized });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

// optional: drag & drop upload (multipart) -> writes to allowlisted file
app.post("/dev/upload", upload.single("file"), (req, res) => {
  try {
    const relPath = req.body.path;
    if (!req.file) return res.status(400).json({ ok: false, error: "no file uploaded" });
    const content = req.file.buffer.toString("utf8");
    const { abs, normalized } = sanitizeAndCheck(relPath);
    const bakPath = backupFile(abs, normalized);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    res.json({ ok: true, wrote: normalized, backup: bakPath ? path.basename(bakPath) : null });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Aurion v1 listening on ${PORT}, data dir: ${DATA_DIR}`);
});
