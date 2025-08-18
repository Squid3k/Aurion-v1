// /memory/embeddings.js
const OpenAI = require("openai");
const client = new OpenAI();

async function embed(texts) {
  // Batches are fine; one call here
  const res = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: texts
  });
  return res.data.map(d => d.embedding);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i];
  }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-12);
}

module.exports = { embed, cosine };
