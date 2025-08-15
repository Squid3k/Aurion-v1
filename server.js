const express = require("express");
const fetch = require("node-fetch"); // Make sure node-fetch is in your package.json

const app = express();
const PORT = process.env.PORT || 10000;

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Aurion-v1 server is running" });
});

// Test OpenAI connection
app.get("/test", async (req, res) => {
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json();
    res.json({
      success: true,
      message: "Aurion-v1 connected to OpenAI!",
      models: data.data.map(m => m.id)
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Aurion-v1 listening on port ${PORT}`);
});
