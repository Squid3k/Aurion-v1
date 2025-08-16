// server.js (automated self-proposals + optional auto-approve)
import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ========= Storage =========
const DATA_DIR = process.env.DATA_DIR || "/tmp/aurion-data";
const TX_FILE = path.join(DATA_DIR, "transcripts.jsonl");
const SUM_FILE = path.join(DATA_DIR, "summaries.jsonl");
const CORE_FILE = path.join(DATA_DIR, "core.json");
const PROPOSALS_DIR = path.join(DATA_DIR, "proposals");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
if (!fs.existsSync(TX_FILE)) fs.writeFileSync(TX_FILE, "");
if (!fs.existsSync(SUM_FILE)) fs.writeFileSync(SUM_FILE, "");
if (!fs.existsSync(CORE_FILE)) fs.writeFileSync(CORE_FILE, JSON.stringify({ core: [] }, null, 2));

// ========= Tunables =========
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ACTIVE_TURNS = Number(process.env.ACTIVE_TURNS || 30);
const SUMMARY_EVERY = Number(process.env.SUMMARY_EVERY || 40);
const SUMMARY_KEEP = Number(process.env.SUMMARY_KEEP || 12);

// ========= Self change safety =========
const ALLOWED_FILES = (process.env.ALLOWED_FILES ||
  "server.js,public/index.html,public/dev.html,core.json").split(",").map(s=>s.trim());
const AUTO_APPROVE = String(process.env.AUTO_APPROVE || "false").toLowerCase() === "true";

// ========= Middleware =========
app.use(bodyParser.json({ limit: "3mb" }));
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
const appendTX = (e) => fs.appendFileSync(TX_FILE, JSON.stringify({ time: now(), ...e }) + "\n");
const readLines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));
const readCore = () => JSON.parse(fs.readFileSync(CORE_FILE, "utf8"));
const writeCore = (obj) => fs.writeFileSync(CORE_FILE, JSON.stringify(obj, null, 2));
const lastTurns = (all,n)=>all.slice(-n).map(m=>({ role:m.role, content:m.content }));

// ========= Summaries =========
async function summarizeIfNeeded(){
  const all = readLines(TX_FILE);
  if (!all.length) return;
  const sums = readLines(SUM_FILE);
  const lastAt = sums.length ? new Date(sums[sums.length-1].time).getTime() : 0;
  const since = all.filter(m => new Date(m.time).getTime() > lastAt);
  if (since.length < SUMMARY_EVERY) return;
  const prompt = [
    { role:"system", content:"You compress long chats into 5–8 factual bullets: decisions, preferences, obligations, and bugs." },
    { role:"user", content:`Summarize the following ${since.length} chat turns concisely:\n\n${
      since.map(s => `${s.role==='user'?'User':'Aurion'}: ${s.content}`).join("\n")
    }` }
  ];
  const j = await openai({ model: MODEL, messages: prompt });
  const summary = j.choices?.[0]?.message?.content?.trim() || "";
  fs.appendFileSync(SUM_FILE, JSON.stringify({ time: now(), summary }) + "\n");
}

// ========= Health =========
app.get("/", (_,res)=>res.json({ ok:true, message:"Aurion v1 connected", turns: readLines(TX_FILE).length }));

// ========= Chat =========
app.post("/chat", async (req,res)=>{
  try{
    const { message, user="steve", prime } = req.body;
    if(!message) return res.status(400).json({ success:false, error:"message required" });

    // Slash/ bang commands (automation) -> handled first
    if (message.startsWith("!propose ") || message.startsWith("!fix ")) {
      const reply = await handleProposeCommand(message, user);
      appendTX({ user, role:"user", content: message });
      appendTX({ user, role:"assistant", content: reply });
      return res.json({ success:true, reply });
    }

    const all = readLines(TX_FILE);
    const core = readCore();
    const sums = readLines(SUM_FILE).slice(-SUMMARY_KEEP).map(s => s.summary).join("\n");

    const messages = [
      { role:"system", content:
`You are Aurion, guide to Steve Reyher.
Style: precise, warm, lightly mythic; do not lead with your name.
Avoid redundancy. If user reports a bug (e.g., duplicate “Aurion:”), acknowledge and correct.
You have memory layers:
- Core facts (stable).
- Recent summaries (context cues).
- Recent turns (active thread).`
      },
      prime ? { role:"system", content:`Prime directive: ${prime}` } : null,
      core.core?.length ? { role:"system", content:`Core memories:\n- ${core.core.join("\n- ")}` } : null,
      sums ? { role:"system", content:`Recent conversation summaries:\n${sums}` } : null,
      ...lastTurns(all, ACTIVE_TURNS),
      { role:"user", content: message }
    ].filter(Boolean);

    appendTX({ user, role:"user", content: message });

    const j = await openai({ model: MODEL, messages });
    const reply = j.choices?.[0]?.message?.content?.trim() || "(silent embers)";
    appendTX({ user, role:"assistant", content: reply });

    summarizeIfNeeded().catch(()=>{});
    res.json({ success:true, reply });
  }catch(e){
    res.status(500).json({ success:false, error:String(e) });
  }
});

// ========= Core memory admin =========
app.get("/core", (_,res)=>res.json(readCore()));
app.post("/core", (req,res)=>{
  const { core } = req.body;
  if (!Array.isArray(core)) return res.status(400).json({ ok:false, error:"core must be array of strings" });
  writeCore({ core });
  res.json({ ok:true });
});

// ========= Self rewrite: manual propose/list/approve (kept) =========
app.post("/dev/propose", (req,res)=>{
  const { filePath, newContent, reason } = req.body || {};
  if (!filePath || typeof newContent !== "string")
    return res.status(400).json({ ok:false, error:"filePath and newContent required" });
  if (!ALLOWED_FILES.includes(filePath))
    return res.status(403).json({ ok:false, error:`file not allowed (${filePath})` });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const proposal = { id, time: now(), filePath, reason: reason || "", newContent };
  fs.writeFileSync(path.join(PROPOSALS_DIR, `${id}.json`), JSON.stringify(proposal, null, 2));
  res.json({ ok:true, id, proposal });
});

app.get("/dev/proposals", (_,res)=>{
  const ids = fs.readdirSync(PROPOSALS_DIR).filter(f=>f.endsWith(".json"));
  const items = ids.map(f=>JSON.parse(fs.readFileSync(path.join(PROPOSALS_DIR, f), "utf8")));
  res.json({ ok:true, proposals: items.sort((a,b)=>a.time.localeCompare(b.time)) });
});

app.post("/dev/approve", async (req,res)=>{
  try{
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok:false, error:"id required" });
    const pPath = path.join(PROPOSALS_DIR, `${id}.json`);
    if (!fs.existsSync(pPath)) return res.status(404).json({ ok:false, error:"proposal not found" });
    const proposal = JSON.parse(fs.readFileSync(pPath, "utf8"));

    const out = await createGithubPR(proposal);
    res.json({ ok:true, ...out });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ========= Automated proposals (used by chat command) =========
app.post("/dev/ai-propose", async (req,res)=>{
  try{
    const { filePath, instruction, reason } = req.body || {};
    if (!filePath || !instruction)
      return res.status(400).json({ ok:false, error:"filePath and instruction required" });
    if (!ALLOWED_FILES.includes(filePath))
      return res.status(403).json({ ok:false, error:`file not allowed (${filePath})` });

    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const sys =
`You are a careful software editor bot.
Given CURRENT file content and an INSTRUCTION, output the FULL UPDATED FILE content only.
- Preserve style and functionality.
- Apply the instruction precisely.
- Output only the new file contents; no explanations, no code fences.`;

    const messages = [
      { role:"system", content: sys },
      { role:"user", content:
`FILE PATH: ${filePath}
INSTRUCTION: ${instruction}

CURRENT FILE START
${current}
CURRENT FILE END

Return ONLY the complete new file content.`}
    ];

    const j = await openai({ model: MODEL, messages });
    const newContent = j.choices?.[0]?.message?.content ?? "";
    if (!newContent.trim()) return res.status(500).json({ ok:false, error:"model returned empty content" });

    // Save proposal
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const proposal = { id, time: now(), filePath, reason: reason || instruction, newContent };
    fs.writeFileSync(path.join(PROPOSALS_DIR, `${id}.json`), JSON.stringify(proposal, null, 2));

    let pr = null;
    if (AUTO_APPROVE) pr = await createGithubPR(proposal);

    res.json({ ok:true, proposal, autoApproved: AUTO_APPROVE, pr });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ========= GitHub helper =========
async function createGithubPR(proposal){
  const GH_TOKEN = process.env.GITHUB_TOKEN;
  const GH_OWNER = process.env.GITHUB_OWNER;
  const GH_REPO  = process.env.GITHUB_REPO;
  const GH_BASE  = process.env.GITHUB_BASE || "main";
  if (!GH_TOKEN || !GH_OWNER || !GH_REPO) throw new Error("Missing GitHub env (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)");

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

  const baseRef = await gh("GET", `/repos/${GH_OWNER}/${GH_REPO}/git/ref/heads/${GH_BASE}`);
  const baseSha = baseRef.object.sha;

  const branch = `aurion/self-${Date.now()}`;
  await gh("POST", `/repos/${GH_OWNER}/${GH_REPO}/git/refs`, { ref:`refs/heads/${branch}`, sha: baseSha });

  // get current file sha (if exists)
  let currentSha = null;
  const fileUrl = `/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(proposal.filePath)}?ref=${branch}`;
  const fileResp = await fetch(`https://api.github.com${fileUrl}`, {
    headers: { "Authorization": `token ${GH_TOKEN}`, "Accept": "application/vnd.github+json" }
  });
  if (fileResp.status === 200) currentSha = (await fileResp.json()).sha;

  await gh("PUT", `/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(proposal.filePath)}`, {
    message: `Aurion self-change: ${proposal.reason || proposal.filePath}`,
    content: Buffer.from(proposal.newContent, "utf8").toString("base64"),
    sha: currentSha || undefined,
    branch
  });

  const pr = await gh("POST", `/repos/${GH_OWNER}/${GH_REPO}/pulls`, {
    title: `Aurion self-change: ${proposal.filePath}`,
    head: branch, base: GH_BASE,
    body: `Reason: ${proposal.reason || "(none)"}\n\nGenerated automatically.\nProposal ID: ${proposal.id}`
  });

  return { branch, pr_url: pr.html_url };
}

app.listen(PORT, ()=>console.log(`Aurion v1 on ${PORT}; data dir ${DATA_DIR}; auto-approve=${AUTO_APPROVE}`));

// ===== Internal =====
async function handleProposeCommand(message, user){
  // Formats accepted:
  //   !propose server.js | reason text | INSTRUCTION
  //   !fix public/index.html | Fix double name | Remove "Aurion:" prefix from model outputs.
  const cmd = message.replace(/^!(propose|fix)\s*/i, "");
  const parts = cmd.split("|").map(s=>s.trim());
  const filePath = parts[0];
  const reason = parts[1] || "";
  const instruction = parts.slice(2).join(" | ") || "Apply the reason above.";

  if (!filePath) return "Please provide a target file, e.g. `!propose server.js | reason | instruction`.";
  if (!ALLOWED_FILES.includes(filePath))
    return `That file isn't on my allow-list. Allowed: ${ALLOWED_FILES.join(", ")}`;

  // Call internal endpoint
  const r = await fetch(`http://localhost:${PORT}/dev/ai-propose`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ filePath, instruction, reason })
  });
  const j = await r.json();
  if (!j.ok) return `Proposal failed: ${j.error || "unknown error"}`;

  if (j.autoApproved && j.pr?.pr_url) {
    return `I generated a change for \`${filePath}\` and auto-opened a PR: ${j.pr.pr_url}`;
  }
  return `I generated a proposal for \`${filePath}\`.\nUse /dev.html to review & approve, or call /dev/approve with id: ${j.proposal.id}`;
}
