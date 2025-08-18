// /memory/policy.js
// Map intents/routes to memory buckets (names are arbitrary but consistent)
const ROUTES = {
  "code-edit": ["eng-decisions", "core-goals", "summaries"],
  "ui": ["ui-decisions", "summaries"],
  "general": ["summaries", "core-goals"],
  "memory": ["summaries", "core-goals"],
};

function bucketsForIntent(intent = "general") {
  return ROUTES[intent] || ROUTES.general;
}

module.exports = { bucketsForIntent };
