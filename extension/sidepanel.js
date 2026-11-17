const CHAT_ENDPOINT = "http://127.0.0.1:8000/chat";

const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const conversation = document.querySelector(".conversation");
const messages = document.querySelector("#messages");
const allowSiteButton = document.querySelector("#allow-site-button");
const websiteAccessStatus = document.querySelector("#website-access-status");
const inspectPageButton = document.querySelector("#inspect-page-button");
const inspectionStatus = document.querySelector("#inspection-status");
const MAX_PAGE_CONTENT_LENGTH = 12000;

let lastInspectedPage = null;
let lastDeniedPermissionPattern = null;
let pageAccessRefreshId = 0;

function scrollToLatest() {
  conversation.scrollTop = conversation.scrollHeight;
}

function isHttpPage(url) {
  return url.protocol === "http:" || url.protocol === "https:";
}

function errorDetails(error) {
  return error instanceof Error ? error.message : String(error);
}

function pageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function setWebsiteAccessStatus(state, text) {
  websiteAccessStatus.dataset.state = state;
  websiteAccessStatus.textContent = text;
}

function showPageAccessError(error) {
  if (error?.code === "unsupported-page") {
    setWebsiteAccessStatus("unsupported", error.message);
  } else {
    setWebsiteAccessStatus("error", errorDetails(error));
  }
}

async function getActivePageContext() {
  let tab;
  let tabSelection = "currentWindow";
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (error) {
    console.error("[ApplyFlow] Active-tab query failed", {
      selection: tabSelection,
      error: errorDetails(error),
    });
  }

  if (
    !tab ||
    !Number.isInteger(tab.id) ||
    typeof tab.url !== "string" ||
    tab.url.length === 0
  ) {
    tabSelection = "lastFocusedWindow fallback";
    try {
      const [fallbackTab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (
        fallbackTab &&
        Number.isInteger(fallbackTab.id) &&
        typeof fallbackTab.url === "string" &&
        fallbackTab.url.length > 0
      ) {
        tab = fallbackTab;
      }
    } catch (error) {
      console.error("[ApplyFlow] Active-tab fallback query failed", {
        selection: tabSelection,
        error: errorDetails(error),
      });
    }
  }

  if (!tab || !Number.isInteger(tab.id)) {
    console.warn("[ApplyFlow] No active tab was returned", { selection: tabSelection });
    throw pageError("no-active-tab", "No active tab is available.");
  }

  if (typeof tab.url !== "string" || tab.url.length === 0) {
    throw pageError(
      "missing-tab-url",
      "Cannot determine this tab's website. Try reopening ApplyFlow from the active tab.",
    );
  }

  let pageUrl;
  try {
    pageUrl = new URL(tab.url);
  } catch (error) {
    console.error("[ApplyFlow] Active tab returned an invalid URL", {
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      selection: tabSelection,
      error: errorDetails(error),
    });
    throw pageError("invalid-tab-url", "The active tab returned an invalid URL.");
  }

  console.info("[ApplyFlow] Selected active tab", {
    tabId: tab.id,
    windowId: tab.windowId ?? null,
    selection: tabSelection,
    urlProtocol: pageUrl.protocol,
    isHttpOrHttps: isHttpPage(pageUrl),
  });

  if (!isHttpPage(pageUrl) || !pageUrl.hostname) {
    throw pageError(
      "unsupported-page",
      "This page is restricted. ApplyFlow can inspect regular HTTP and HTTPS websites only.",
    );
  }

  return {
    tab,
    pageUrl,
    permissionPattern: `${pageUrl.protocol}//${pageUrl.hostname}/*`,
  };
}

async function requestPageAccess() {
  let context;
  try {
    context = await getActivePageContext();
  } catch (error) {
    showPageAccessError(error);
    return false;
  }

  try {
    const alreadyGranted = await chrome.permissions.contains({
      origins: [context.permissionPattern],
    });
    if (alreadyGranted) {
      lastDeniedPermissionPattern = null;
      setWebsiteAccessStatus("granted", `Website access granted for ${context.pageUrl.hostname}.`);
      return true;
    }

    const granted = await chrome.permissions.request({
      origins: [context.permissionPattern],
    });
    if (!granted) {
      lastDeniedPermissionPattern = context.permissionPattern;
      setWebsiteAccessStatus(
        "denied",
        `Permission denied for ${context.pageUrl.hostname}. You can allow access and try again.`,
      );
      return false;
    }

    lastDeniedPermissionPattern = null;
    setWebsiteAccessStatus("granted", `Website access granted for ${context.pageUrl.hostname}.`);
    console.info("[ApplyFlow] Optional website permission granted", {
      hostname: context.pageUrl.hostname,
      protocol: context.pageUrl.protocol,
    });
    return true;
  } catch (error) {
    console.error("[ApplyFlow] Website permission request failed", {
      hostname: context.pageUrl.hostname,
      error: errorDetails(error),
    });
    setWebsiteAccessStatus(
      "error",
      `Could not request access to ${context.pageUrl.hostname}: ${errorDetails(error)}`,
    );
    return false;
  }
}

async function refreshPageAccessStatus() {
  const refreshId = ++pageAccessRefreshId;
  let context;
  try {
    context = await getActivePageContext();
  } catch (error) {
    if (refreshId === pageAccessRefreshId) {
      showPageAccessError(error);
    }
    return;
  }

  try {
    const granted = await chrome.permissions.contains({
      origins: [context.permissionPattern],
    });
    if (refreshId !== pageAccessRefreshId) {
      return;
    }
    if (granted) {
      lastDeniedPermissionPattern = null;
      setWebsiteAccessStatus("granted", `Website access granted for ${context.pageUrl.hostname}.`);
    } else if (lastDeniedPermissionPattern === context.permissionPattern) {
      setWebsiteAccessStatus(
        "denied",
        `Permission denied for ${context.pageUrl.hostname}. You can allow access and try again.`,
      );
    } else {
      setWebsiteAccessStatus(
        "required",
        `Website access is required for ${context.pageUrl.hostname}.`,
      );
    }
  } catch (error) {
    if (refreshId === pageAccessRefreshId) {
      console.error("[ApplyFlow] Website permission check failed", {
        hostname: context.pageUrl.hostname,
        error: errorDetails(error),
      });
      setWebsiteAccessStatus("error", "Could not check website access. Try again.");
    }
  }
}

async function inspectPage() {
  let context;
  try {
    context = await getActivePageContext();
  } catch (error) {
    showPageAccessError(error);
    throw error;
  }
  const { tab, pageUrl, permissionPattern } = context;

  let hasPagePermission;
  try {
    hasPagePermission = await chrome.permissions.contains({
      origins: [permissionPattern],
    });
  } catch (error) {
    console.error("[ApplyFlow] Website permission check failed", {
      hostname: pageUrl.hostname,
      error: errorDetails(error),
    });
    throw new Error(`Could not check website access: ${errorDetails(error)}`);
  }
  if (!hasPagePermission) {
    const denied = lastDeniedPermissionPattern === permissionPattern;
    const message = denied
      ? `Permission was denied for ${pageUrl.hostname}. Click "Allow This Site" to try again.`
      : `Website access is not granted for ${pageUrl.hostname}. Click "Allow This Site" first.`;
    setWebsiteAccessStatus(denied ? "denied" : "required", message);
    throw new Error(message);
  }

  let pageDataInjection;
  try {
    [pageDataInjection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectPageData,
      args: [MAX_PAGE_CONTENT_LENGTH],
    });
  } catch (error) {
    console.error("[ApplyFlow] Page data injection failed", {
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      hostname: pageUrl.hostname,
      error: errorDetails(error),
    });
    throw new Error(
      `Could not inspect ${pageUrl.hostname}. The page may be restricted or may have changed; confirm access and try again. Browser reported: ${errorDetails(error)}`,
    );
  }

  if (!pageDataInjection?.result) {
    console.error("[ApplyFlow] Page data injection returned no result", {
      tabId: tab.id,
      windowId: tab.windowId ?? null,
    });
    throw new Error("The active page did not return inspection data.");
  }

  const pageData = pageDataInjection.result;
  let inspectedUrl;
  try {
    inspectedUrl = new URL(pageData.url);
  } catch (error) {
    console.error("[ApplyFlow] Inspected page returned an invalid URL", {
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      error: errorDetails(error),
    });
    throw new Error("The inspected page returned an invalid URL.");
  }
  console.info("[ApplyFlow] Page data injection succeeded", {
    tabId: tab.id,
    windowId: tab.windowId ?? null,
    urlProtocol: inspectedUrl.protocol,
    isHttpOrHttps: isHttpPage(inspectedUrl),
  });
  if (!isHttpPage(inspectedUrl)) {
    throw pageError(
      "unsupported-page",
      "This page is restricted. ApplyFlow can inspect regular HTTP and HTTPS websites only.",
    );
  }
  const inspectedPermissionPattern = `${inspectedUrl.protocol}//${inspectedUrl.hostname}/*`;
  if (
    inspectedPermissionPattern !== permissionPattern ||
    !(await chrome.permissions.contains({ origins: [inspectedPermissionPattern] }))
  ) {
    throw new Error(
      "The active page changed to a website that has not been authorized. Allow access to that site and try again.",
    );
  }

  return pageData;
}

function collectPageData(maxContentLength) {
  const ignoredTags = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "OPTION",
  ]);
  const sensitiveAttribute = /password|passwd|secret|token|csrf|auth|credential|session|api.?key|access.?key|private.?key/i;

  function hasSensitiveMetadata(element) {
    const metadata = [
      element.name,
      element.id,
      element.getAttribute("name"),
      element.getAttribute("autocomplete"),
      element.getAttribute("aria-label"),
      element.getAttribute("data-sensitive"),
    ].join(" ");
    return element.hasAttribute("data-sensitive") || sensitiveAttribute.test(metadata);
  }

  function isVisible(element) {
    if (!element || !element.getClientRects().length) {
      return false;
    }
    for (let current = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (
        current.hidden ||
        current.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.contentVisibility === "hidden" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
    }
    return true;
  }

  function isSensitiveField(field) {
    return hasSensitiveMetadata(field);
  }

  function visibleText(root, limit = maxContentLength) {
    if (!isVisible(root)) {
      return "";
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    let length = 0;
    let node;

    while ((node = walker.nextNode()) && length < limit) {
      const text = node.nodeValue.replace(/\s+/g, " ").trim();
      if (!text) {
        continue;
      }

      let ignored = false;
      for (let current = node.parentElement; current; current = current.parentElement) {
        if (
          ignoredTags.has(current.tagName) ||
          current.isContentEditable ||
          (current !== root && hasSensitiveMetadata(current)) ||
          !isVisible(current)
        ) {
          ignored = true;
          break;
        }
        if (current === root) {
          break;
        }
      }
      if (ignored) {
        continue;
      }

      const remaining = limit - length;
      const part = text.slice(0, remaining);
      parts.push(part);
      length += part.length + 1;
    }
    return parts.join(" ").slice(0, limit);
  }

  function getLabel(field) {
    const labels = Array.from(field.labels || [])
      .filter(isVisible)
      .map((label) => visibleText(label, 500))
      .filter(Boolean);
    if (labels.length) {
      return labels.join(" ");
    }

    const ariaLabel = field.getAttribute("aria-label");
    if (ariaLabel) {
      return ariaLabel.trim();
    }
    const labelledBy = field.getAttribute("aria-labelledby");
    if (!labelledBy) {
      return "";
    }
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((element) => element && isVisible(element))
      .map((element) => visibleText(element, 500))
      .filter(Boolean)
      .join(" ");
  }

  function getFieldData(field) {
    const tag = field.tagName.toLowerCase();
    const type = tag === "textarea" ? "textarea" : field.type || "text";
    if (
      (tag === "input" && ["hidden", "password", "button", "submit", "reset", "image"].includes(type)) ||
      isSensitiveField(field)
    ) {
      return null;
    }
    return {
      tag,
      type,
      name: field.name || "",
      id: field.id || "",
      label: getLabel(field),
      placeholder: field.getAttribute("placeholder") || "",
      required: Boolean(field.required),
    };
  }

  return {
    title: document.title,
    url: window.location.href,
    headings: Array.from(document.querySelectorAll("h1, h2, h3"))
      .filter(isVisible)
      .map((heading) => ({
        level: heading.tagName.toLowerCase(),
        text: visibleText(heading, 1000),
      }))
      .filter((heading) => heading.text),
    content: visibleText(document.body),
    forms: Array.from(document.forms)
      .filter(isVisible)
      .map((form) => ({
        fields: Array.from(form.elements)
          .filter((field) => ["INPUT", "TEXTAREA", "SELECT"].includes(field.tagName) && isVisible(field))
          .map(getFieldData)
          .filter(Boolean),
      })),
  };
}

function addMessage(role, text = "") {
  const message = document.createElement("div");
  message.classList.add("message", `message-${role}`);
  message.textContent = text;
  messages.append(message);
  scrollToLatest();
  return message;
}

allowSiteButton.addEventListener("click", async () => {
  allowSiteButton.disabled = true;
  await requestPageAccess();
  allowSiteButton.disabled = false;
});

chrome.tabs.onActivated.addListener(() => {
  void refreshPageAccessStatus();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status === "complete")) {
    void refreshPageAccessStatus();
  }
});
chrome.windows.onFocusChanged.addListener(() => {
  void refreshPageAccessStatus();
});
chrome.permissions.onAdded.addListener(() => {
  void refreshPageAccessStatus();
});
chrome.permissions.onRemoved.addListener(() => {
  void refreshPageAccessStatus();
});
void refreshPageAccessStatus();

inspectPageButton.addEventListener("click", async () => {
  inspectPageButton.disabled = true;
  inspectionStatus.classList.remove("error");
  inspectionStatus.textContent = "Inspecting the active page...";
  lastInspectedPage = null;

  try {
    lastInspectedPage = await inspectPage();
    inspectionStatus.textContent = "Page inspected. Data is ready for future integration.";
  } catch (error) {
    if (error?.code === "unsupported-page") {
      setWebsiteAccessStatus("unsupported", error.message);
    } else if (error.message?.includes("not granted")) {
      setWebsiteAccessStatus("required", error.message);
    }
    inspectionStatus.classList.add("error");
    inspectionStatus.textContent =
      error instanceof Error ? error.message : "Could not inspect the active page.";
  } finally {
    inspectPageButton.disabled = false;
  }
});

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

const BROWSER_BRIDGE_URL = "ws://127.0.0.1:8000/ws/browser";
const ALLOWED_BROWSER_TOOLS = new Set(["inspect_page"]);
const MAX_BRIDGE_MESSAGE_LENGTH = 8192;
const MAX_REQUEST_ID_LENGTH = 128;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];
const BRIDGE_STABLE_CONNECTION_MS = 30000;
const bridgeStatus = document.querySelector("#bridge-status");
const bridgeStatusText = document.querySelector("#bridge-status-text");

let browserBridgeSocket = null;
let reconnectTimer = null;
let stableConnectionTimer = null;
let reconnectAttempt = 0;
let closingSidePanel = false;

function setBridgeStatus(state, text) {
  bridgeStatus.dataset.state = state;
  bridgeStatusText.textContent = text;
}

function sendBridgeResponse(socket, response) {
  if (socket.readyState !== WebSocket.OPEN) {
    console.warn("[ApplyFlow] Browser Bridge disconnected before a response could be sent");
    setBridgeStatus("offline", "Disconnected");
    return false;
  }
  try {
    socket.send(JSON.stringify(response));
    return true;
  } catch {
    console.error("[ApplyFlow] Could not send Browser Bridge response");
    setBridgeStatus("error", "Could not send result");
    return false;
  }
}

function validateBridgeCommand(data) {
  if (typeof data !== "string") {
    return { error: "Commands must be JSON text.", id: null };
  }
  if (data.length > MAX_BRIDGE_MESSAGE_LENGTH) {
    return { error: "Command is too large.", id: null };
  }

  let command;
  try {
    command = JSON.parse(data);
  } catch {
    return { error: "Command is not valid JSON.", id: null };
  }

  const isObject = command !== null && typeof command === "object" && !Array.isArray(command);
  const id =
    isObject &&
    typeof command.id === "string" &&
    command.id.trim().length > 0 &&
    command.id.length <= MAX_REQUEST_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(command.id)
      ? command.id
      : null;

  if (!isObject || !id) {
    return { error: "Command must include a valid request id.", id };
  }

  const keys = Object.keys(command);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("tool")) {
    return { error: "Command must contain only id and tool.", id };
  }
  if (typeof command.tool !== "string") {
    return { error: "Command tool must be a string.", id };
  }
  if (!ALLOWED_BROWSER_TOOLS.has(command.tool)) {
    return { error: "Unsupported browser tool.", id };
  }

  return { id, tool: command.tool };
}

async function handleBrowserBridgeMessage(socket, data) {
  const command = validateBridgeCommand(data);
  if (command.error) {
    sendBridgeResponse(socket, {
      id: command.id,
      success: false,
      error: command.error,
    });
    return;
  }

  try {
    const result = await inspectPage();
    lastInspectedPage = result;
    sendBridgeResponse(socket, {
      id: command.id,
      success: true,
      result,
    });
  } catch (error) {
    sendBridgeResponse(socket, {
      id: command.id,
      success: false,
      error: error instanceof Error ? error.message : "Could not inspect the active tab.",
    });
  }
}

function scheduleBrowserBridgeReconnect() {
  if (closingSidePanel || reconnectTimer !== null) {
    return;
  }
  if (reconnectAttempt >= RECONNECT_DELAYS.length) {
    setBridgeStatus("offline", "Offline - reload panel to retry");
    return;
  }

  const delay = RECONNECT_DELAYS[reconnectAttempt];
  reconnectAttempt += 1;
  setBridgeStatus("connecting", `Retry ${reconnectAttempt}/${RECONNECT_DELAYS.length}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBrowserBridge();
  }, delay);
}

function connectBrowserBridge() {
  if (closingSidePanel || reconnectTimer !== null) {
    return;
  }
  if (
    browserBridgeSocket &&
    (browserBridgeSocket.readyState === WebSocket.CONNECTING ||
      browserBridgeSocket.readyState === WebSocket.OPEN)
  ) {
    return;
  }

  setBridgeStatus("connecting", reconnectAttempt ? "Reconnecting" : "Connecting");
  let socket;
  try {
    socket = new WebSocket(BROWSER_BRIDGE_URL);
  } catch {
    browserBridgeSocket = null;
    scheduleBrowserBridgeReconnect();
    return;
  }

  browserBridgeSocket = socket;
  socket.addEventListener("open", () => {
    if (browserBridgeSocket !== socket) {
      return;
    }
    setBridgeStatus("connected", "Connected");
    stableConnectionTimer = setTimeout(() => {
      if (browserBridgeSocket === socket && socket.readyState === WebSocket.OPEN) {
        reconnectAttempt = 0;
      }
      stableConnectionTimer = null;
    }, BRIDGE_STABLE_CONNECTION_MS);
  });
  socket.addEventListener("message", (event) => {
    void handleBrowserBridgeMessage(socket, event.data);
  });
  socket.addEventListener("error", () => {
    if (browserBridgeSocket === socket) {
      console.error("[ApplyFlow] Browser Bridge connection error");
      setBridgeStatus("error", "Connection error");
    }
  });
  socket.addEventListener("close", () => {
    if (browserBridgeSocket !== socket) {
      return;
    }
    browserBridgeSocket = null;
    console.warn("[ApplyFlow] Browser Bridge disconnected");
    if (stableConnectionTimer !== null) {
      clearTimeout(stableConnectionTimer);
      stableConnectionTimer = null;
    }
    if (!closingSidePanel) {
      scheduleBrowserBridgeReconnect();
    }
  });
}

window.addEventListener(
  "pagehide",
  () => {
    closingSidePanel = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (stableConnectionTimer !== null) {
      clearTimeout(stableConnectionTimer);
      stableConnectionTimer = null;
    }
    if (browserBridgeSocket) {
      browserBridgeSocket.close();
      browserBridgeSocket = null;
    }
  },
  { once: true },
);

connectBrowserBridge();
