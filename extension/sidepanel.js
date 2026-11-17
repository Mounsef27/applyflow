const CHAT_ENDPOINT = "http://127.0.0.1:8000/chat";

const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const conversation = document.querySelector(".conversation");
const messages = document.querySelector("#messages");

function scrollToLatest() {
  conversation.scrollTop = conversation.scrollHeight;
}

function addMessage(role, text = "") {
  const message = document.createElement("div");
  message.classList.add("message", `message-${role}`);
  message.textContent = text;
  messages.append(message);
  scrollToLatest();
  return message;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || sendButton.disabled) {
    return;
  }

  addMessage("user", message);
  input.value = "";
  input.disabled = true;
  sendButton.disabled = true;

  const assistantMessage = addMessage("assistant");
  assistantMessage.textContent = "Thinking...";
  assistantMessage.classList.add("loading");

  try {
    const response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      throw new Error(`The backend returned HTTP ${response.status}.`);
    }
    if (!response.body) {
      throw new Error("The backend did not provide a response stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let responseText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      if (chunk) {
        responseText += chunk;
        assistantMessage.textContent = responseText;
        assistantMessage.classList.remove("loading");
        scrollToLatest();
      }
    }

    responseText += decoder.decode();
    assistantMessage.textContent = responseText;
    assistantMessage.classList.remove("loading");
    if (!responseText) {
      throw new Error("The backend returned an empty response.");
    }
  } catch (error) {
    assistantMessage.classList.remove("loading");
    assistantMessage.classList.add("message-error");
    assistantMessage.textContent =
      error instanceof TypeError
        ? "Could not connect to ApplyFlow. Check that the backend is running at http://127.0.0.1:8000."
        : error.message || "Something went wrong while contacting the backend.";
    scrollToLatest();
  } finally {
    input.disabled = false;
    sendButton.disabled = false;
    input.focus();
  }
});
