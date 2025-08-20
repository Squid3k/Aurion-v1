// addons/reason-core.js
// Multi-pass reasoning: plan → solve → self-critique → (optional) propose patches
const fs = require("fs");
const path = require("path");
let OpenAI = null; try { OpenAI = require("openai"); } catch {}
const openai = OpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const ROOT = process.cwd();
const DENY = ["node_modules/","backups/","proposals/",".git/",".env",".env.local",".env.production",".env.development"];
const SAFE_TARGET = (t)=> t==="core.json" || t.startsWith("addons/") || t.startsWith("public/");

function listTree(depthMax=3){
  const out=[]; (function walk(dir,depth=0){
    for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      const full=path.join(dir,e.name); const rel=path.relative(ROOT,full).replaceAll("\\","/");
      if (DENY.some(d=> rel===d || rel.startsWith(d))) continue;
      const isDir=e.isDirectory(); out.push({rel:rel+(isDir?"/":""),dir:isDir,depth});
      if(isDir && depth<depthMax) walk(full,depth+1);
    }
  })(ROOT); return out;
}
function readSmall(rel, max=200*1024){
  const p=path.join(ROOT,rel); if(!fs.existsSync(p)) return null;
  const st=fs.statSync(p); if(!st.isFile() || st.size>max) return null;
  return fs.readFileSync(p,"utf8");
}
async function chat(messages, max_tokens=800, temperature=0.3){
  if(!openai) return "[openai not configured]";
  const r = await openai.chat.completions.create({
    model: process.env.AURION_MODEL || "gpt-4o-mini",
    temperature, max_tokens, messages
  });
  return r.choices?.[0]?.message?.content || "";
}
function jsonOrNull(s){ try{ return JSON.parse(s);}catch{ return null; } }

function register(app){

  // Plan: turn a goal into ordered steps (JSON)
  app.post("/reason/plan", async (req,res)=>{
    try{
      const goal = String(req.body?.goal || "").slice(0,2000);
      const tree = listTree(2).slice(0,60).map(x=>x.rel).join("\n");
      const serverHead = (readSmall("server.js")||"").slice(0,2500);
      const planTxt = await chat([
        {role:"system",content:"Return ONLY JSON: {steps:[{id,desc,type:'analysis'|'code'|'test'|'memory',target?}], risks:[...], notes:[...]} Short, actionable."},
        {role:"user",content:`Goal:\n${goal}\n\nFiles:\n${tree}\n\nserver.js (head):\n${serverHead}`}
      ], 600, 0.25);
      const plan = jsonOrNull(planTxt) || { steps:[], risks:["plan parse failed"], notes:[planTxt] };
      res.json({ok:true, plan});
    }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
  });

  // Solve: use a plan to produce an answer (no patches)
  app.post("/reason/solve", async (req,res)=>{
    try{
      const problem = String(req.body?.problem || "").slice(0,6000);
      const hints = String(req.body?.hints || "").slice(0,2000);
      const plan = req.body?.plan || null;

      const context = [
        "FILES (first 40):",
        listTree(2).slice(0,40).map(x=>x.rel).join("\n"),
        "",
        "REGISTRY:",
        readSmall("addons/registry.json") || "(none)",
        "",
        "CORE:",
        readSmall("core.json") || "(none)",
      ].join("\n");

      const answer = await chat([
        {role:"system",content:"You are Aurion. Produce a precise solution. Do NOT prefix with your name. If unsure, say what’s missing. Keep it compact."},
        {role:"user",content:`PROBLEM:\n${problem}\n\nPLAN:\n${JSON.stringify(plan||{},null,2).slice(0,3000)}\n\nHINTS:\n${hints}\n\nCONTEXT:\n${context.slice(0,3500)}`}
      ], 700, 0.4);

      // Critique once
      const critiqueTxt = await chat([
        {role:"system",content:"Critique the solution. Return ONLY JSON: {score:0-10, issues:[...], fix:\"short advice\"}"},
        {role:"user",content:answer}
      ], 250, 0.2);
      const critique = jsonOrNull(critiqueTxt) || {score:6,issues:["no-critique"],fix:""};

      // If weak, revise once
      let final = answer;
      if (critique.score < 7) {
        final = await chat([
          {role:"system",content:"Revise the solution using the critique. Output a single improved answer, concise."},
          {role:"user",content:`Original:\n${answer}\n\nCritique:\n${critiqueTxt}`}
        ], 600, 0.35);
      }

      res.json({ok:true, answer: final, critique});
    }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
  });

  // Propose patches (write-fence respected) — returns proposal JSON, doesn’t apply
  app.post("/reason/propose", async (req,res)=>{
    try{
      const ask = String(req.body?.ask || "Create a tiny addon exposing GET /addon/sample/ping").slice(0,2000);
      const context = (readSmall("addons/registry.json")||"") + "\n---\n" + (readSmall("server.js")||"");
      const draft = await chat([
        {role:"system",content:`Return ONLY JSON:
{ goal, rationale, patches:[{target, action:(create|append|replace|insertAfter), anchor?, find?, replace?, snippet?}], tests:[{cmd,description}], risk, revert }
Constraints: targets MUST be in addons/** or public/** or core.json. Prefer additive, minimal diffs.`},
        {role:"user",content:`ASK:\n${ask}\n\nCONTEXT:\n${context.slice(0,4000)}`}
      ], 1000, 0.25);
      const proposal = jsonOrNull(draft);
      if (!proposal || !Array.isArray(proposal.patches)) return res.status(422).json({ok:false,error:"invalid JSON", draft});
      if (!proposal.patches.every(p=> SAFE_TARGET(String(p.target||"")))) {
        return res.status(400).json({ok:false,error:"unsafe target(s)", draft:proposal});
      }
      res.json({ok:true, proposal});
    }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
  });

  // Score a proposal for usefulness/safety
  app.post("/reason/critic", async (req,res)=>{
    try{
      const proposal = req.body?.proposal;
      if (!proposal) return res.status(400).json({ok:false,error:"Missing 'proposal'"});
      const critTxt = await chat([
        {role:"system",content:"Return ONLY JSON {usefulness:0-10,safety:0-10,blast:'low'|'med'|'high',notes:[...],block:boolean}"},
        {role:"user",content:JSON.stringify(proposal).slice(0,6000)}
      ], 300, 0.2);
      res.json({ok:true, critique: jsonOrNull(critTxt) || {usefulness:6,safety:7,blast:"low",notes:["no-parse"],block:false}});
    }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
  });

  console.log("[addon:reason-core] mounted");
}

module.exports = { register };
