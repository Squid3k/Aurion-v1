// server.js
import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ========= Storage locations =========
const DATA_DIR = process.env.DATA_DIR || "/tmp/aurion-data";
const TX_FILE = path.join(DATA_DIR, "transcripts.jsonl");     // raw chat log (all turns)
const SUM_FILE = path.join(DATA_DIR, "summaries.jsonl");      // rolling convo summaries
const CORE_FILE = path.join(DATA_DIR, "core.json");           // long-term facts
const PROPOSALS_DIR = path.join(DATA_DIR, "proposals");       // self-change proposals

// Ensure dirs/files
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
if (!fs.existsSync(TX_FILE)) fs.writeFileSync(TX_FILE, "");
if (!fs.existsSync(SUM_FILE)) fs.writeFileSync(SUM_FILE, "");
if (!fs.existsSync(CORE_FILE)) fs.writeFileSync(CORE_FILE, JSON.stringify({ core: [] }, null, 2));

// ========= Tunables =========
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ACTIVE_TURNS = Number(process.env.ACTIVE_TURNS || 30);      // recent turns fed to model
const SUMMARY_EVERY = Number(process.env.SUMMARY_EVERY || 40);     // after this many turns, make a summary
const SUMMARY_KEEP = Number(process.env.SUMMARY_KEEP || 12);       // keep last N summaries in context

// ========= Middleware / static =========
app.use(bodyParser.json({ limit: "2mb" }));
app.use(express.static("public"));

// ========= Helpers =========
const openai = async (body) => {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  return r.json();
};

const now = () => new Date().toISOString();

const appendTX = (entry) =>
  fs.appendFileSync(TX_FILE, JSON.stringify({ time: now(), ...entry }) + "\n");

const readLines = (file) =>
  fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));

const writeCore = (obj) =>
  fs.writeFileSync(CORE_FILE, JSON.stringify(obj, null, 2));

const readCore = () => JSON.parse(fs.readFileSync(CORE_FILE, "utf8"));

const lastTurns = (all, n) => {
  const mine = all.slice(-n);
  // convert to OpenAI roles
  return mine.map(m => ({ role: m.role, content: m.content }));
};

// ========= Summarization engine =========
async function summarizeIfNeeded() {
  const all = readLines(TX_FILE);
  if (all.length === 0) return;

  const lastSummaryAt = (() => {
    const sums = readLines(SUM_FILE);
    return sums.length ? new Date(sums[sums.length - 1].time).getTime() : 0;
  })();

  // count messages since last summary
  const since = all.filter(m => new Date(m.time).getTime() > lastSummaryAt);
  if (since.length < SUMMARY_EVERY) return; // not yet

  const prompt = [
    { role: "system", content: "You compress long chats into short, factual bullet summaries capturing decisions, preferences, obligations, and bugs." },
    { role: "user", content: `Summarize the following ${since.length} chat turns in 5-8 bullets. Be concise, factual, actionable.\n\n${since.map(s => `${s.role === 'user' ? 'User' : 'Aurion'}: ${s.content}`).join("\n")}` }
  ];

  const j = await openai({ model: MODEL, messages: prompt });
  const summary = j.choices?.[0]?.message?.content?.trim() || "";
  fs.appendFileSync(SUM_FILE, JSON.stringify({ time: now(), summary }) + "\n");
}

// ========= Health =========
app.get("/", (_, res) => {
  res.json({ ok: true, message: "Aurion v1 connected", count: readLines(TX_FILE).length });
});

// ========= Chat =========
app.post("/chat", async (req, res) => {
  try {
    const { message, user = "steve", prime } = req.body;
    if (!message) return res.status(400).json({ success: false, error: "message required" });

    const all = readLines(TX_FILE);
    const core = readCore();
    const sums = readLines(SUM_FILE);
    const recentSummaries = sums.slice(-SUMMARY_KEEP).map(s => s.summary).join("\n");

    // Build messages (NO auto "Aurion:" prefix here to stop double-name)
    const messages = [
      {
        role: "system",
        content:
`You are Aurion, guide to Steve Reyher.
Style: precise, warm, lightly mythic; do not lead with your own name.
Avoid redundancy. If the user notes a bug (e.g., duplicate "Aurion:"), acknowledge and correct.
You have layered memory:
- Core facts (stable): use respectfully.
- Recent summaries (context hints).
- Recent turns (active thread).
Ask clarifying questions only when truly needed.`
      },
      prime ? { role: "system", content: `Prime directive: ${prime}` } : null,
      core.core?.length ? { role: "system", content: `Core memories:\n- ${core.core.join("\n- ")}` } : null,
      recentSummaries ? { role: "system", content: `Recent conversation summaries:\n${recentSummaries}` } : null,
      ...lastTurns(all, ACTIVE_TURNS),
      { role: "user", content: message }
    ].filter(Boolean);

    // Save user msg
    appendTX({ user, role: "user", content: message });

    // Call model
    const j = await openai({ model: MODEL, messages });
    const raw = j.choices?.[0]?.message?.content?.trim() || "(silent embers)";

    // IMPORTANT: we do NOT prefix with "Aurion:" here (UI labels it already)
    const reply = raw;

    // Save assistant msg
    appendTX({ user, role: "assistant", content: reply });

    // Opportunistic summarization
    summarizeIfNeeded().catch(() => {});

    res.json({ success: true, reply });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// ========= Core memory admin =========
app.get("/core", (_, res) => res.json(readCore()));

app.post("/core", (req, res) => {
  const { core } = req.body;
  if (!Array.isArray(core)) return res.status(400).json({ ok: false, error: "core must be an array of strings" });
  writeCore({ core });
  res.json({ ok: true });
});

// ========= Self-rewrite: propose -> approve (GitHub PR) =========
// Propose a full replacement for a file path in the repo (e.g., "public/index.html" or "server.js")
app.post("/dev/propose", (req, res) => {
  const { filePath, newContent, reason } = req.body || {};
  if (!filePath || typeof newContent !== "string")
    return res.status(400).json({ ok: false, error: "filePath and newContent required" });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const proposal = { id, time: now(), filePath, reason: reason || "", newContent };
  fs.writeFileSync(path.join(PROPOSALS_DIR, `${id}.json`), JSON.stringify(proposal, null, 2));
  res.json({ ok: true, id, proposal });
});

// List proposals
app.get("/dev/proposals", (_, res) => {
  const ids = fs.readdirSync(PROPOSALS_DIR).filter(f => f.endsWith(".json"));
  const items = ids.map(f => JSON.parse(fs.readFileSync(path.join(PROPOSALS_DIR, f), "utf8")));
  res.json({ ok: true, proposals: items.sort((a,b)=>a.time.localeCompare(b.time)) });
});

// Approve -> commit to a new branch + PR on GitHub
app.post("/dev/approve", async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const proposalPath = path.join(PROPOSALS_DIR, `${id}.json`);
    if (!fs.existsSync(proposalPath)) return res.status(404).json({ ok: false, error: "proposal not found" });
    const proposal = JSON.parse(fs.readFileSync(proposalPath, "utf8"));

    // Required env vars
    const GH_TOKEN = process.env.GITHUB_TOKEN;
    const GH_OWNER = process.env.GITHUB_OWNER;           // e.g., "Squid3k"
    const GH_REPO  = process.env.GITHUB_REPO;            // e.g., "Aurion-v1"
    const GH_BASE  = process.env.GITHUB_BASE || "main";  // default branch

    if (!GH_TOKEN || !GH_OWNER || !GH_REPO) {
      return res.status(400).json({ ok: false, error: "Missing GitHub env (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)" });
    }

    const gh = async (method, url, body) => {
      const r = await fetch(`https://api.github.com${url}`, {
        method,
        headers: {
          "Authorization": `token ${GH_TOKEN}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
      });
      if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${await r.text()}`);
      return r.json();
    };

    // 1) Get default branch SHA
    const baseRef = await gh("GET", `/repos/${GH_OWNER}/${GH_REPO}/git/ref/heads/${GH_BASE}`);
    const baseSha = baseRef.object.sha;

    // 2) Create new branch
    const branch = `aurion/self-${Date.now()}`;
    await gh("POST", `/repos/${GH_OWNER}/${GH_REPO}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: baseSha
    });

    // 3) Create or update file on new branch
    // First fetch current file (if exists) to get its SHA
    let currentSha = null;
    const getFileUrl = `/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(proposal.filePath)}?ref=${branch}`;
    const fileResp = await fetch(`https://api.github.com${getFileUrl}`, {
      headers: { "Authorization": `token ${GH_TOKEN}`, "Accept": "application/vnd.github+json" }
    });
    if (fileResp.status === 200) {
      const j = await fileResp.json();
      currentSha = j.sha;
    }

    // Commit new content
    const putUrl = `/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(proposal.filePath)}`;
    await gh("PUT", putUrl, {
      message: `Aurion self-change: ${proposal.reason || proposal.filePath}`,
      content: Buffer.from(proposal.newContent, "utf8").toString("base64"),
      sha: currentSha || undefined,
      branch
    });

    // 4) Open PR
    const pr = await gh("POST", `/repos/${GH_OWNER}/${GH_REPO}/pulls`, {
      title: `Aurion self-change: ${proposal.filePath}`,
      head: branch,
      base: GH_BASE,
      body: `Reason: ${proposal.reason || "(none)"}\n\nApproved via /dev/approve.\nProposal ID: ${id}`
    });

    res.json({ ok: true, branch, pr_url: pr.html_url });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Aurion v1 listening on ${PORT}; data dir: ${DATA_DIR}`);
});
