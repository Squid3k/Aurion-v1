// /memory/semantic.js
const { readJSON, writeJSON } = require("./store");
const { embed, cosine } = require("./embeddings");

const VEC_FILE = "vectors.json";
// shape: { items: [{ id, bucket, text, meta, vec }] }
function load() { return readJSON(VEC_FILE, { items: [] }); }
function save(v) { writeJSON(VEC_FILE, v); }

async function addToVectors({ id, bucket, text, meta = {} }) {
  const v = load();
  const [vec] = await embed([text]);
  v.items.push({ id, bucket, text, meta, vec });
  save(v);
}

async function searchVectors({ query, buckets = [], k = 5 }) {
  const v = load();
  const [qvec] = await embed([query]);
  const pool = buckets.length ? v.items.filter(i => buckets.includes(i.bucket)) : v.items;
  const scored = pool.map(i => ({ item: i, score: cosine(qvec, i.vec) }));
  scored.sort((a,b) => b.score - a.score);
  return scored.slice(0, k).map(s => ({ text: s.item.text, meta: s.item.meta, score: s.score, bucket: s.item.bucket }));
}

module.exports = { addToVectors, searchVectors };
