// public/aurion-client.js
async function sendToAurion(userMessage) {
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userMessage })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    return data.reply;
  } catch (err) {
    console.error("Aurion client error:", err);
    return "(error: " + err.message + ")";
  }
}

// Hook into your chat UI
document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("#chat-form");
  const input = document.querySelector("#chat-input");
  const chatBox = document.querySelector("#chat-box");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const userMessage = input.value.trim();
    if (!userMessage) return;

    // Show user msg
    chatBox.innerHTML += `<div class="user">You: ${userMessage}</div>`;
    input.value = "";

    // Get Aurion’s reply
    const reply = await sendToAurion(userMessage);

    // Show Aurion msg
    chatBox.innerHTML += `<div class="aurion">Aurion: ${reply}</div>`;
    chatBox.scrollTop = chatBox.scrollHeight;
  });
});
