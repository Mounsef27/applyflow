const CHAT_ENDPOINT = "http://127.0.0.1:8000/chat";

const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const conversation = document.querySelector(".conversation");
const messages = document.querySelector("#messages");
const newChatButton = document.querySelector("#new-chat-button");
const conversationStatus = document.querySelector("#conversation-status");
const allowSiteButton = document.querySelector("#allow-site-button");
const websiteAccessStatus = document.querySelector("#website-access-status");
const inspectPageButton = document.querySelector("#inspect-page-button");
const inspectionStatus = document.querySelector("#inspection-status");
const MAX_PAGE_CONTENT_LENGTH = 12000;
const MAX_FILL_FORM_FIELDS = 50;
const MAX_INSPECTED_CONTROLS = 300;
const MAX_INSPECTION_RETRIES = 3;
const INSPECTION_RETRY_DELAY_MS = 150;
const THREAD_ID_STORAGE_KEY = "applyflow_thread_id";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let lastInspectedPage = null;
let lastInspectedTabId = null;
let lastInspectedPermissionPattern = null;
let lastInspectedFrameTokens = new Map();
let lastDeniedPermissionPattern = null;
let pageAccessRefreshId = 0;
let threadId = null;
let threadIdPromise = null;
let isChatStreaming = false;

function scrollToLatest() {
  conversation.scrollTop = conversation.scrollHeight;
}

function isHttpPage(url) {
  return url.protocol === "http:" || url.protocol === "https:";
}

function errorDetails(error) {
  return error instanceof Error ? error.message : String(error);
}

function isValidThreadId(value) {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function createThreadId() {
  if (typeof crypto.randomUUID !== "function") {
    throw new Error("This browser does not support secure conversation IDs.");
  }
  const generatedId = crypto.randomUUID();
  if (!isValidThreadId(generatedId)) {
    throw new Error("The browser generated an invalid conversation ID.");
  }
  return generatedId;
}

async function loadOrCreateThreadId() {
  const stored = await chrome.storage.local.get(THREAD_ID_STORAGE_KEY);
  if (isValidThreadId(stored[THREAD_ID_STORAGE_KEY])) {
    threadId = stored[THREAD_ID_STORAGE_KEY];
    return threadId;
  }

  const generatedId = createThreadId();
  await chrome.storage.local.set({ [THREAD_ID_STORAGE_KEY]: generatedId });
  threadId = generatedId;
  return threadId;
}

function getThreadId() {
  if (isValidThreadId(threadId)) {
    return Promise.resolve(threadId);
  }
  if (!threadIdPromise) {
    threadIdPromise = loadOrCreateThreadId()
      .then((id) => {
        conversationStatus.textContent = "Conversation ready.";
        newChatButton.disabled = isChatStreaming;
        return id;
      })
      .catch((error) => {
        threadIdPromise = null;
        threadId = null;
        newChatButton.disabled = isChatStreaming;
        const storageError = new Error(
          `Could not initialize conversation storage: ${errorDetails(error)}`,
        );
        storageError.code = "conversation-storage";
        conversationStatus.textContent = storageError.message;
        throw storageError;
      });
  }
  return threadIdPromise;
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

async function getActivePageContext({ allowLastFocusedFallback = true } = {}) {
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
    allowLastFocusedFallback &&
    (!tab ||
      !Number.isInteger(tab.id) ||
      typeof tab.url !== "string" ||
      tab.url.length === 0)
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
  lastInspectedPage = null;
  lastInspectedTabId = null;
  lastInspectedPermissionPattern = null;
  lastInspectedFrameTokens.clear();
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

  let pageDataInjections;
  let frameInjectionError = null;
  let lastInspectionError = null;
  const hasInspectedControls = (injections) =>
    injections?.some(({ result }) =>
      result &&
      ((result.controls || []).length > 0 ||
        (result.forms || []).some((pageForm) => (pageForm.fields || []).length > 0)),
    );
  for (let attempt = 0; attempt < MAX_INSPECTION_RETRIES; attempt += 1) {
    try {
      pageDataInjections = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: collectPageData,
        args: [MAX_PAGE_CONTENT_LENGTH, MAX_INSPECTED_CONTROLS],
      });
      if (hasInspectedControls(pageDataInjections) || attempt + 1 === MAX_INSPECTION_RETRIES) {
        break;
      }
    } catch (error) {
      frameInjectionError = error;
      try {
        pageDataInjections = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: collectPageData,
          args: [MAX_PAGE_CONTENT_LENGTH, MAX_INSPECTED_CONTROLS],
        });
        if (hasInspectedControls(pageDataInjections) || attempt + 1 === MAX_INSPECTION_RETRIES) {
          break;
        }
      } catch (fallbackError) {
        lastInspectionError = fallbackError;
      }
    }

    if (attempt + 1 < MAX_INSPECTION_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, INSPECTION_RETRY_DELAY_MS));
    }
  }

  if (!pageDataInjections?.some((injection) => injection?.result)) {
    const error = lastInspectionError || frameInjectionError;
    const errorMessage = error
      ? errorDetails(error)
      : "No frame returned inspection data.";
    console.error("[ApplyFlow] Page data injection failed", {
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      hostname: pageUrl.hostname,
      error: errorMessage,
    });
    throw new Error(
      `Could not inspect ${pageUrl.hostname}. The page may be restricted or may have changed; confirm access and try again. Browser reported: ${errorMessage}`,
    );
  }

  const frameData = pageDataInjections
    .filter((injection) => injection?.result)
    .map((injection) => ({
      ...injection.result,
      frameId: injection.frameId,
    }));
  const mainFrameData = frameData.find((frame) => frame.frameId === 0);
  if (!mainFrameData) {
    throw new Error("The active page did not return inspection data for its main frame.");
  }

  const inspectedFrames = frameData.map((frame) => {
    let origin = "";
    try {
      origin = new URL(frame.url).origin;
    } catch {
      // The frame URL is not used to authorize or target page actions.
    }
    return {
      frameId: frame.frameId,
      origin,
      diagnostics: frame.diagnostics,
    };
  });
  const pageData = {
    title: mainFrameData.title,
    url: mainFrameData.url,
    headings: frameData.flatMap((frame) =>
      (frame.headings || []).map((heading) => ({ ...heading, frameId: frame.frameId })),
    ),
    content: frameData
      .map((frame) => frame.content)
      .filter(Boolean)
      .join("\n")
      .slice(0, MAX_PAGE_CONTENT_LENGTH),
    forms: frameData.flatMap((frame) =>
      (frame.forms || []).map((pageForm) => ({
        ...pageForm,
        frameId: frame.frameId,
        fields: (pageForm.fields || []).map((field) => ({
          ...field,
          frameId: frame.frameId,
        })),
      })),
    ),
    controls: frameData.flatMap((frame) =>
      (frame.controls || []).map((control) => ({
        ...control,
        frameId: frame.frameId,
      })),
    ),
    frames: inspectedFrames,
    diagnostics: {
      framesInspected: frameData.length,
      framesNotInspected: Math.max(
        0,
        Math.max(0, mainFrameData.diagnostics?.iframeCount || 0) -
          Math.max(0, frameData.length - 1),
      ),
      frameInjectionError: frameInjectionError
        ? errorDetails(frameInjectionError).slice(0, 300)
        : null,
      standardControlsFound: frameData.reduce(
        (total, frame) => total + (frame.diagnostics?.standardControlsFound || 0),
        0,
      ),
      customControlsFound: frameData.reduce(
        (total, frame) => total + (frame.diagnostics?.customControlsFound || 0),
        0,
      ),
      noControlsFound: frameData.every(
        (frame) => Boolean(frame.diagnostics?.noControlsFound),
      ),
      possibleLoadingState: frameData.some(
        (frame) => Boolean(frame.diagnostics?.possibleLoadingState),
      ),
      frameDiagnostics: inspectedFrames,
    },
  };
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

  lastInspectedPage = pageData;
  lastInspectedTabId = tab.id;
  lastInspectedPermissionPattern = permissionPattern;
  lastInspectedFrameTokens = new Map(
    frameData.map((frame) => [
      frame.frameId,
      { documentTimeOrigin: frame.documentTimeOrigin, url: frame.url },
    ]),
  );
  console.info("[ApplyFlow] Page inspection completed", {
    tabId: tab.id,
    framesInspected: pageData.diagnostics.framesInspected,
    framesNotInspected: pageData.diagnostics.framesNotInspected,
    standardControlsFound: pageData.diagnostics.standardControlsFound,
    customControlsFound: pageData.diagnostics.customControlsFound,
    possibleLoadingState: pageData.diagnostics.possibleLoadingState,
  });
  return pageData;
}

async function getBrowserActionContext(frameId = 0) {
  const context = await getActivePageContext({ allowLastFocusedFallback: false });
  const { tab, pageUrl, permissionPattern } = context;
  let hasPermission;
  try {
    hasPermission = await chrome.permissions.contains({
      origins: [permissionPattern],
    });
  } catch (error) {
    throw pageError(
      "permission-check-failed",
      `Could not check website access: ${errorDetails(error)}`,
    );
  }
  if (!hasPermission) {
    const message = `Website access is not granted for ${pageUrl.hostname}. Click "Allow This Site" first.`;
    setWebsiteAccessStatus("required", message);
    throw pageError("permission-required", message);
  }
  if (
    !lastInspectedPage ||
    lastInspectedTabId !== tab.id ||
    lastInspectedPermissionPattern !== permissionPattern ||
    lastInspectedPage.url !== pageUrl.href
  ) {
    throw pageError(
      "inspection-required",
      "Inspect this active page first. Browser action selectors must come from its latest inspection.",
    );
  }
  if (!Number.isInteger(frameId) || frameId < 0 || !lastInspectedFrameTokens.has(frameId)) {
    throw pageError(
      "frame-not-inspected",
      "That frame was not included in the latest page inspection. Inspect the active page again.",
    );
  }

  const currentContext = await getActivePageContext({ allowLastFocusedFallback: false });
  if (currentContext.tab.id !== tab.id || currentContext.pageUrl.href !== pageUrl.href) {
    throw pageError(
      "active-tab-changed",
      "The active tab changed. Inspect the intended page again before using browser tools.",
    );
  }
  return {
    ...context,
    documentTimeOrigin: lastInspectedFrameTokens.get(frameId).documentTimeOrigin,
    frameUrl: lastInspectedFrameTokens.get(frameId).url,
    frameId,
  };
}

async function fillForm(fields) {
  let context;
  try {
    context = await getBrowserActionContext(0);
  } catch (error) {
    if (error?.code === "unsupported-page") {
      showPageAccessError(error);
    } else if (error?.code === "permission-required") {
      setWebsiteAccessStatus("required", error.message);
    }
    throw error;
  }
  const { tab, pageUrl } = context;
  if (!Array.isArray(fields)) {
    throw new Error("Form fields must be provided as an array.");
  }
  if (fields.length > MAX_FILL_FORM_FIELDS) {
    throw new Error(`A maximum of ${MAX_FILL_FORM_FIELDS} fields can be filled at once.`);
  }

  const inspectedFields = (lastInspectedPage.forms || [])
    .flatMap((pageForm) => pageForm.fields || [])
    .filter((field) => field.frameId === 0)
    .filter((field) => typeof field.selector === "string" && field.selector.length > 0);

  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillFormFields,
      args: [fields, inspectedFields, context.documentTimeOrigin, pageUrl.href],
    });
  } catch (error) {
    console.error("[ApplyFlow] Form fill injection failed", {
      tabId: tab.id,
      hostname: pageUrl.hostname,
      error: errorDetails(error),
    });
    throw new Error(
      `Could not fill fields on ${pageUrl.hostname}. The page may have changed or become restricted. Browser reported: ${errorDetails(error)}`,
    );
  }

  if (
    !injection?.result ||
    typeof injection.result.success !== "boolean" ||
    !Number.isInteger(injection.result.filled) ||
    !Array.isArray(injection.result.failed)
  ) {
    throw new Error("The page did not return a valid form-filling result.");
  }
  return injection.result;
}

function collectPageData(maxContentLength, maxControls) {
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
  const sensitiveMetadata =
    /password|passwd|secret|token|csrf|auth|credential|session|api.?key|access.?key|private.?key|one.?time|otp|verification.?code|security.?code|credit.?card|card.?number|cc.?number|payment|bank|routing|account.?number|cvv|cvc|ssn|social.?security|national.?id|passport|tax.?id|date.?of.?birth|birth.?date|user.?name|login|sign.?in|captcha|recaptcha|hcaptcha|accept.{0,12}terms?|agree.{0,12}terms?|agreement|consent|privacy.?policy/i;
  const controlSelector =
    "input, textarea, select, button, a[href], [role='button'], [role='link'], [role='textbox'], [role='combobox'], [role='listbox'], [role='option'], [role='checkbox'], [role='radio'], [role='switch'], [contenteditable='true']";

  function hasSensitiveMetadata(element) {
    const labels = Array.from(element.labels || [])
      .map((label) => label.textContent || "")
      .join(" ");
    const metadata = [
      element.type,
      element.name,
      element.id,
      element.getAttribute("name"),
      element.getAttribute("autocomplete"),
      element.getAttribute("aria-label"),
      element.getAttribute("data-sensitive"),
      labels,
    ].join(" ");
    return element.hasAttribute("data-sensitive") || sensitiveMetadata.test(metadata);
  }

  function composedParent(element) {
    return element.parentElement || element.getRootNode()?.host || null;
  }

  function isVisible(element) {
    if (!element || !element.getClientRects().length) {
      return false;
    }
    for (let current = element; current; current = composedParent(current)) {
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

  function queryDeep(selector) {
    const results = [];
    const seenElements = new Set();
    const seenRoots = new Set();
    const roots = [document];
    let visitedNodes = 0;
    while (roots.length && results.length < maxControls) {
      const root = roots.shift();
      if (!root || seenRoots.has(root)) {
        continue;
      }
      seenRoots.add(root);
      for (const element of root.querySelectorAll(selector)) {
        if (!seenElements.has(element)) {
          seenElements.add(element);
          results.push(element);
          if (results.length >= maxControls) {
            break;
          }
        }
      }
      for (const element of root.querySelectorAll("*")) {
        visitedNodes += 1;
        if (element.shadowRoot && roots.length < 50) {
          roots.push(element.shadowRoot);
        }
        if (visitedNodes >= 15000 || results.length >= maxControls) {
          break;
        }
      }
      if (visitedNodes >= 15000) {
        break;
      }
    }
    return results;
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
      for (let current = node.parentElement; current; current = composedParent(current)) {
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

  function getLabel(element) {
    const labels = Array.from(element.labels || [])
      .filter(isVisible)
      .map((label) => visibleText(label, 500))
      .filter(Boolean);
    if (labels.length) {
      return labels.join(" ");
    }

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return ariaLabel.trim().slice(0, 500);
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const root = element.getRootNode();
      const labelText = labelledBy
        .split(/\s+/)
        .map((id) => {
          const label = root.getElementById?.(id) ||
            root.querySelector?.(`#${CSS.escape(id)}`);
          return label && isVisible(label) ? visibleText(label, 500) : "";
        })
        .filter(Boolean)
        .join(" ");
      if (labelText) {
        return labelText;
      }
    }
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button" || tagName === "a" || element.getAttribute("role") === "option") {
      return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
    }
    return (element.getAttribute("placeholder") || element.getAttribute("title") || "").trim().slice(0, 500);
  }

  function selectorInRoot(element, root) {
    const tag = element.tagName.toLowerCase();
    const candidates = [];
    if (element.id) {
      candidates.push(`#${CSS.escape(element.id)}`);
    }
    for (const attribute of ["data-automation-id", "data-testid", "name", "aria-label"]) {
      const value = element.getAttribute(attribute);
      if (value) {
        candidates.push(`${tag}[${attribute}=${JSON.stringify(value)}]`);
      }
    }
    for (const selector of candidates) {
      try {
        const matches = root.querySelectorAll(selector);
        if (matches.length === 1 && matches[0] === element) {
          return selector;
        }
      } catch {
        // Invalid site-provided selector candidates are ignored.
      }
    }
    return "";
  }

  function getStableSelector(element) {
    const segments = [];
    let current = element;
    let root = current.getRootNode();
    while (root) {
      const selector = selectorInRoot(current, root);
      if (!selector || selector.includes(" >>> ")) {
        return "";
      }
      segments.unshift(selector);
      if (!root.host) {
        break;
      }
      current = root.host;
      root = current.getRootNode();
    }
    return segments.join(" >>> ");
  }

  function isField(element) {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    return (
      ["input", "textarea", "select"].includes(tag) ||
      ["textbox", "combobox", "checkbox", "radio", "switch"].includes(role) ||
      element.isContentEditable
    );
  }

  function getFieldData(field) {
    const tag = field.tagName.toLowerCase();
    const role = field.getAttribute("role") || "";
    const type = tag === "textarea"
      ? "textarea"
      : tag === "select"
        ? "select"
        : tag === "input"
          ? String(field.type || "text").toLowerCase()
          : role || (field.isContentEditable ? "contenteditable" : "custom");
    if (
      (tag === "input" && ["hidden", "password", "button", "submit", "reset", "image", "file"].includes(type)) ||
      hasSensitiveMetadata(field)
    ) {
      return null;
    }
    const supportedForFill =
      tag === "textarea" ||
      (tag === "input" && ["text", "email", "tel", "url", "search"].includes(type)) ||
      (role === "textbox" && tag !== "input") ||
      field.isContentEditable;
    const supportedForDate =
      (tag === "input" && ["date", "text", "number"].includes(type)) ||
      tag === "textarea" ||
      tag === "select" ||
      role === "combobox";
    return {
      tag,
      type,
      role,
      name: field.name || field.getAttribute("name") || "",
      id: field.id || "",
      selector: getStableSelector(field),
      label: getLabel(field),
      placeholder: field.getAttribute("placeholder") || "",
      required: Boolean(field.required || field.getAttribute("aria-required")?.toLowerCase() === "true"),
      visible: isVisible(field),
      disabled: Boolean(field.disabled || field.getAttribute("aria-disabled")?.toLowerCase() === "true"),
      readOnly: Boolean(field.readOnly || field.getAttribute("aria-readonly")?.toLowerCase() === "true"),
      supportedForFill,
      supportedForDate,
      invalid: field.getAttribute("aria-invalid")?.toLowerCase() === "true" ||
        Boolean(field.validity && !field.validity.valid),
    };
  }

  const elements = Array.from(new Set([
    ...queryDeep(controlSelector),
    ...queryDeep("[data-automation-id]"),
  ])).slice(0, maxControls);
  const fieldPairs = elements
    .filter(isField)
    .map((element) => ({ element, data: getFieldData(element) }))
    .filter((pair) => pair.data);
  const fields = fieldPairs.map((pair) => pair.data);
  const formElements = queryDeep("form");
  const forms = formElements
    .map((form) => ({
      label: form.getAttribute("aria-label") || form.getAttribute("name") || "",
      fields: fieldPairs
        .filter(({ element }) => element.form === form || element.closest("form") === form)
        .map((pair) => pair.data),
    }))
    .filter((form) => form.fields.length > 0);
  const formFieldSelectors = new Set(forms.flatMap((form) => form.fields.map((field) => field.selector)));
  const standaloneFields = fields.filter((field) => field.selector && !formFieldSelectors.has(field.selector));
  if (standaloneFields.length) {
    forms.push({ label: "Unassociated fields", fields: standaloneFields });
  }

  const controls = elements
    .filter((element) => !hasSensitiveMetadata(element))
    .map((element) => {
      const tag = element.tagName.toLowerCase();
      const field = isField(element) ? getFieldData(element) : null;
      return {
        tag,
        type: field?.type || element.getAttribute("type") || "",
        role: element.getAttribute("role") || "",
        selector: field?.selector || getStableSelector(element),
        label: field?.label || getLabel(element),
        name: field?.name || element.getAttribute("name") || "",
        placeholder: field?.placeholder || element.getAttribute("placeholder") || "",
        visible: isVisible(element),
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled")?.toLowerCase() === "true"),
        required: Boolean(element.required || element.getAttribute("aria-required")?.toLowerCase() === "true"),
        hasPopup: element.getAttribute("aria-haspopup") || "",
        supportedForFill: field?.supportedForFill || false,
        supportedForDate: field?.supportedForDate || false,
      };
    })
    .filter((control) => control.selector || control.label)
    .slice(0, maxControls);

  const headings = queryDeep("h1, h2, h3")
    .filter(isVisible)
    .map((heading) => ({
      level: heading.tagName.toLowerCase(),
      text: visibleText(heading, 1000),
    }))
    .filter((heading) => heading.text);
  const loadingIndicators = queryDeep('[aria-busy="true"], [role="progressbar"]')
    .some(isVisible);
  const iframeCount = queryDeep("iframe, frame").length;
  const standardControlsFound = fields.filter((field) =>
    ["input", "textarea", "select"].includes(field.tag),
  ).length;
  const customControlsFound = fields.length - standardControlsFound;

  return {
    title: document.title,
    url: window.location.href,
    documentTimeOrigin: performance.timeOrigin,
    headings,
    content: visibleText(document.body),
    forms,
    controls,
    diagnostics: {
      documentReadyState: document.readyState,
      iframeCount,
      openShadowRoots: Math.max(0, new Set(
        elements.map((element) => element.getRootNode()).filter((root) => root.host),
      ).size),
      standardControlsFound,
      customControlsFound,
      noControlsFound: controls.length === 0,
      possibleLoadingState: document.readyState !== "complete" || loadingIndicators,
      controlsTruncated: elements.length >= maxControls,
      fieldsWithoutStableSelectors: fields.filter((field) => !field.selector).length,
    },
  };
}

function fillFormFields(fields, inspectedFields, expectedTimeOrigin, expectedUrl) {
  const supportedInputTypes = new Set(["text", "email", "tel", "url", "search"]);
  const sensitiveMetadata =
    /password|passwd|secret|token|csrf|auth|credential|session|api.?key|access.?key|private.?key|one.?time|otp|verification.?code|security.?code|credit.?card|card.?number|cc.?number|cc[-_.]?(?:exp|csc|cvc|name|type|given.?name|family.?name)|payment|bank|routing|account.?number|cvv|cvc|ssn|social.?security|national.?id|passport|tax.?id|date.?of.?birth|birth.?date|user.?name|login|captcha|recaptcha|hcaptcha|accept.{0,12}terms?|agree.{0,12}terms?|terms?.{0,12}(?:condition|service)|agreement|consent|privacy.?policy/i;
  const inspectedFieldMap = new Map(
    inspectedFields.map((field) => [field.selector, field]),
  );
  const results = [];
  if (
    performance.timeOrigin !== expectedTimeOrigin ||
    window.location.href !== expectedUrl
  ) {
    return {
      success: false,
      filled: 0,
      failed: fields.map((field) => ({
        selector: typeof field?.selector === "string" ? field.selector : "",
        error: "The page changed after inspection. Inspect it again before filling fields.",
      })),
    };
  }

  function resolveDeepSelector(selector) {
    const segments = selector.split(" >>> ").map((segment) => segment.trim());
    let root = document;
    let element = null;
    for (let index = 0; index < segments.length; index += 1) {
      let matches;
      try {
        matches = root.querySelectorAll(segments[index]);
      } catch {
        throw new Error("Invalid CSS selector.");
      }
      if (matches.length === 0) {
        throw new Error("No element matches this selector.");
      }
      if (matches.length > 1) {
        throw new Error("Selector matches multiple elements.");
      }
      element = matches[0];
      if (index < segments.length - 1) {
        if (!element.shadowRoot) {
          throw new Error("The selector's open Shadow DOM path is no longer available.");
        }
        root = element.shadowRoot;
      }
    }
    return element;
  }

  for (const field of fields) {
    const selector =
      field && typeof field.selector === "string" ? field.selector : null;
    try {
      if (!field || typeof field !== "object" || Array.isArray(field)) {
        throw new Error("Field must be an object.");
      }
      const fieldKeys = Object.keys(field);
      if (
        fieldKeys.length !== 2 ||
        !fieldKeys.includes("selector") ||
        !fieldKeys.includes("value")
      ) {
        throw new Error("Field must contain only selector and value.");
      }
      if (typeof selector !== "string" || selector.trim().length === 0) {
        throw new Error("Selector must be a non-empty string.");
      }
      if (typeof field.value !== "string") {
        throw new Error("Value must be a string.");
      }
      const inspection = inspectedFieldMap.get(selector);
      if (!inspection) {
        throw new Error("Selector was not present in the latest page inspection.");
      }

      const element = resolveDeepSelector(selector);
      if (!element || !element.isConnected) {
        throw new Error("The field was removed from the page.");
      }

      const tagName = element.tagName.toLowerCase();
      const isTextarea = tagName === "textarea";
      const inputType = tagName === "input" ? String(element.type).toLowerCase() : "";
      const isContentEditable = element.isContentEditable;
      const isTextbox = element.getAttribute("role") === "textbox";
      if (tagName === "input" && !supportedInputTypes.has(inputType)) {
        throw new Error("Only text, email, telephone, URL, and search inputs are supported.");
      }
      if (
        !isTextarea &&
        !isContentEditable &&
        !isTextbox &&
        (tagName !== "input" || !supportedInputTypes.has(inputType))
      ) {
        throw new Error("Only text, email, telephone, URL, search inputs, and textareas are supported.");
      }

      const labelledBy = element.getAttribute("aria-labelledby");
      const metadata = [
        element.name,
        element.id,
        element.getAttribute("autocomplete"),
        element.getAttribute("aria-label"),
        element.getAttribute("placeholder"),
        element.getAttribute("data-sensitive"),
        Array.from(element.labels || [])
          .map((label) => label.textContent || "")
          .join(" "),
        labelledBy
          ? labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent || "")
              .join(" ")
          : "",
      ].join(" ");
      if (element.hasAttribute("data-sensitive") || sensitiveMetadata.test(metadata)) {
        throw new Error("Sensitive or authentication fields cannot be filled.");
      }
      if (
        element.disabled ||
        element.matches(":disabled") ||
        element.getAttribute("aria-disabled")?.toLowerCase() === "true"
      ) {
        throw new Error("Field is disabled.");
      }
      if (
        element.readOnly ||
        element.getAttribute("aria-readonly")?.toLowerCase() === "true"
      ) {
        throw new Error("Field is read-only.");
      }
      if (
        !element.getClientRects().length ||
        element.getAttribute("aria-hidden")?.toLowerCase() === "true"
      ) {
        throw new Error("Field is not visible.");
      }

      if (isContentEditable) {
        element.textContent = field.value;
      } else if (isTextbox && !("value" in element)) {
        element.textContent = field.value;
      } else {
        const prototype = isTextarea
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (!valueSetter) {
          throw new Error("Could not access the native field value setter.");
        }
        valueSetter.call(element, field.value);
      }

      element.dispatchEvent(
        typeof InputEvent === "function"
          ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: field.value })
          : new Event("input", { bubbles: true }),
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
      if (!element.isConnected) {
        throw new Error("The field was removed during filling.");
      }
      const actualValue = "value" in element
        ? String(element.value)
        : element.textContent || "";
      if (actualValue !== field.value) {
        throw new Error("The page did not retain the requested text.");
      }
      results.push({ selector, success: true });
    } catch (error) {
      results.push({
        selector,
        success: false,
        error: error instanceof Error ? error.message : "Could not fill this field.",
      });
    }
  }

  const failed = results
    .filter((result) => !result.success)
    .map(({ selector, error }) => ({ selector, error }));
  return {
    success: failed.length === 0,
    filled: results.length - failed.length,
    failed,
  };
}

async function runBrowserPageTool(tool, args, expectedUrl, expectedTimeOrigin) {
  const sensitiveMetadata =
    /password|passwd|secret|token|csrf|auth|credential|session|api.?key|access.?key|private.?key|one.?time|otp|verification.?code|security.?code|credit.?card|card.?number|cc.?number|payment|bank|routing|account.?number|cvv|cvc|ssn|social.?security|national.?id|passport|tax.?id|date.?of.?birth|birth.?date|user.?name|login|sign.?in|captcha|recaptcha|hcaptcha|accept.{0,12}terms?|agree.{0,12}terms?|agreement|consent|privacy.?policy/i;

  function fail(code, message, details = {}) {
    return { success: false, error: { code, message }, ...details };
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  }

  function composedParent(element) {
    return element.parentElement || element.getRootNode()?.host || null;
  }

  function isVisible(element) {
    if (!element || !element.isConnected || !element.getClientRects().length) {
      return false;
    }
    for (let current = element; current; current = composedParent(current)) {
      const style = window.getComputedStyle(current);
      if (
        current.hidden ||
        current.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
    }
    return true;
  }

  function getMetadata(element) {
    const labels = Array.from(element.labels || [])
      .map((label) => label.textContent || "")
      .join(" ");
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => element.getRootNode().getElementById?.(id)?.textContent || "")
          .join(" ")
      : "";
    return [
      element.type,
      element.name,
      element.id,
      element.getAttribute("name"),
      element.getAttribute("autocomplete"),
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("data-sensitive"),
      labels,
      labelledText,
    ].join(" ");
  }

  function isSensitive(element) {
    return element.hasAttribute("data-sensitive") || sensitiveMetadata.test(getMetadata(element));
  }

  function isSubmitButton(element) {
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    if (tag === "input") {
      return ["submit", "image"].includes(type);
    }
    return tag === "button" &&
      (!type || type === "submit") &&
      Boolean(element.form || element.closest("form"));
  }

  function getAccessibleName(element) {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return ariaLabel.trim();
    }
    const labels = Array.from(element.labels || [])
      .map((label) => (label.innerText || label.textContent || "").trim())
      .filter(Boolean);
    if (labels.length) {
      return labels.join(" ");
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const name = labelledBy
        .split(/\s+/)
        .map((id) => element.getRootNode().getElementById?.(id)?.textContent || "")
        .join(" ")
        .trim();
      if (name) {
        return name;
      }
    }
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    if (["button", "a"].includes(tag) || ["button", "link", "option"].includes(role)) {
      return (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
    }
    return (element.getAttribute("placeholder") || element.title || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }

  function resolveDeepSelector(selector) {
    if (typeof selector !== "string" || !selector.trim()) {
      return { error: "INVALID_SELECTOR", message: "Selector must be a non-empty string." };
    }
    const segments = selector.split(" >>> ").map((segment) => segment.trim());
    let root = document;
    let element = null;
    for (let index = 0; index < segments.length; index += 1) {
      let matches;
      try {
        matches = root.querySelectorAll(segments[index]);
      } catch {
        return { error: "INVALID_SELECTOR", message: "Selector is not valid CSS." };
      }
      if (matches.length === 0) {
        return { error: "ELEMENT_NOT_FOUND", message: "No element matches this selector." };
      }
      if (matches.length > 1) {
        return { error: "AMBIGUOUS_SELECTOR", message: "Selector matches multiple elements." };
      }
      element = matches[0];
      if (index < segments.length - 1) {
        if (!element.shadowRoot) {
          return {
            error: "SHADOW_ROOT_UNAVAILABLE",
            message: "The selector's open Shadow DOM path is no longer available.",
          };
        }
        root = element.shadowRoot;
      }
    }
    return { element };
  }

  function assertCurrentPage() {
    if (
      window.location.href !== expectedUrl ||
      performance.timeOrigin !== expectedTimeOrigin
    ) {
      return fail(
        "PAGE_CHANGED",
        "The page changed after inspection. Inspect it again before using browser tools.",
      );
    }
    return null;
  }

  function dispatchValueEvents(element, value) {
    element.dispatchEvent(
      typeof InputEvent === "function"
        ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })
        : new Event("input", { bubbles: true }),
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setTextValue(element, value) {
    if (element.disabled || element.matches(":disabled") ||
        element.getAttribute("aria-disabled")?.toLowerCase() === "true") {
      return "Field is disabled.";
    }
    if (element.readOnly || element.getAttribute("aria-readonly")?.toLowerCase() === "true") {
      return "Field is read-only.";
    }
    if (!isVisible(element)) {
      return "Field is not visible.";
    }
    if (element.isContentEditable) {
      element.textContent = value;
    } else if (element.tagName.toLowerCase() === "textarea") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) {
        return "Could not access the native field value setter.";
      }
      setter.call(element, value);
    } else if (element.tagName.toLowerCase() === "input") {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) {
        return "Could not access the native field value setter.";
      }
      setter.call(element, value);
    } else if (element.getAttribute("role") === "textbox" && !("value" in element)) {
      element.textContent = value;
    } else {
      return "The selected control does not support safe text entry.";
    }
    dispatchValueEvents(element, value);
    if (!element.isConnected) {
      return "The field was removed while it was being updated.";
    }
    const actualValue = "value" in element ? String(element.value) : element.textContent || "";
    return actualValue === value ? null : "The page did not retain the requested text.";
  }

  function deepQuery(selector) {
    const results = [];
    const seen = new Set();
    const roots = [document];
    let visited = 0;
    while (roots.length && results.length < 500) {
      const root = roots.shift();
      if (!root) {
        continue;
      }
      for (const element of root.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          results.push(element);
        }
      }
      for (const element of root.querySelectorAll("*")) {
        visited += 1;
        if (element.shadowRoot && roots.length < 50) {
          roots.push(element.shadowRoot);
        }
        if (visited >= 15000) {
          return results;
        }
      }
    }
    return results;
  }

  function getNativeSelectMatch(element, requestedOption) {
    const options = Array.from(element.options).filter((option) => !option.disabled);
    const byValue = options.filter((option) => option.value === requestedOption);
    if (byValue.length === 1) {
      return byValue[0];
    }
    if (byValue.length > 1) {
      return null;
    }
    const normalized = normalizeText(requestedOption);
    const byLabel = options.filter((option) => normalizeText(option.label || option.textContent) === normalized);
    return byLabel.length === 1 ? byLabel[0] : null;
  }

  async function selectOption(selector, requestedOption) {
    const resolved = resolveDeepSelector(selector);
    if (resolved.error) {
      return fail(resolved.error, resolved.message);
    }
    const element = resolved.element;
    if (isSensitive(element)) {
      return fail("SENSITIVE_FIELD", "Sensitive fields cannot be changed by this tool.");
    }
    if (!isVisible(element)) {
      return fail("ELEMENT_NOT_VISIBLE", "The control is not visible.");
    }
    if (element.disabled || element.matches(":disabled") ||
        element.getAttribute("aria-disabled")?.toLowerCase() === "true") {
      return fail("ELEMENT_DISABLED", "The control is disabled.");
    }

    if (element.tagName.toLowerCase() === "select") {
      const option = getNativeSelectMatch(element, requestedOption);
      if (!option) {
        return fail("OPTION_NOT_FOUND_OR_AMBIGUOUS", "No unique enabled option matches the requested value or label.");
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (!setter) {
        return fail("SETTER_UNAVAILABLE", "Could not access the native select value setter.");
      }
      setter.call(element, option.value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      if (element.value !== option.value) {
        return fail("SELECTION_UNVERIFIED", "The page did not retain the requested option.");
      }
      return {
        success: true,
        selected: true,
        selectedLabel: (option.label || option.textContent || "").trim().slice(0, 200),
      };
    }

    const role = element.getAttribute("role");
    if (role !== "combobox" && role !== "listbox" &&
        element.getAttribute("aria-haspopup") !== "listbox") {
      return fail("UNSUPPORTED_CONTROL", "Only native selects and accessible listbox controls are supported.");
    }
    if (isSubmitButton(element)) {
      return fail("FINAL_ACTION_BLOCKED", "A submit-type control cannot be opened by select_option.");
    }
    const before = normalizeText(
      element.value || element.getAttribute("aria-valuetext") || getAccessibleName(element),
    );
    if (element.getAttribute("aria-expanded") !== "true") {
      element.click();
    }
    let optionElements = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const controls = (element.getAttribute("aria-controls") || element.getAttribute("aria-owns") || "")
        .split(/\s+/)
        .filter(Boolean);
      let controlledRoots = [];
      for (const id of controls) {
        const controlled = element.getRootNode().getElementById?.(id) ||
          document.getElementById(id);
        if (controlled) {
          controlledRoots.push(controlled);
        }
      }
      if (!controlledRoots.length) {
        controlledRoots = deepQuery('[role="listbox"]')
          .filter((listbox) => isVisible(listbox) &&
            (listbox.getAttribute("aria-expanded") !== "false"));
      }
      optionElements = controlledRoots.flatMap((root) =>
        root.matches?.('[role="option"]')
          ? [root, ...Array.from(root.querySelectorAll('[role="option"]'))]
          : Array.from(root.querySelectorAll('[role="option"]')),
      ).filter(isVisible);
      if (optionElements.length) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const normalizedOption = normalizeText(requestedOption);
    const matches = optionElements.filter((option) =>
      normalizeText(getAccessibleName(option) || option.textContent) === normalizedOption,
    );
    if (matches.length === 0) {
      return fail("OPTION_NOT_FOUND", "No visible accessible option matches the requested value.");
    }
    if (matches.length > 1) {
      return fail("AMBIGUOUS_OPTION", "More than one visible option matches the requested value.");
    }
    const option = matches[0];
    if (option.disabled || option.getAttribute("aria-disabled")?.toLowerCase() === "true") {
      return fail("OPTION_DISABLED", "The matching option is disabled.");
    }
    if (isSubmitButton(option)) {
      return fail("FINAL_ACTION_BLOCKED", "A submit-type option cannot be activated.");
    }
    const optionLabel = (getAccessibleName(option) || option.textContent || "").trim().slice(0, 200);
    option.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const selected =
      option.getAttribute("aria-selected")?.toLowerCase() === "true" ||
      normalizeText(element.getAttribute("aria-valuetext")) === normalizedOption ||
      normalizeText(element.value) === normalizedOption ||
      normalizeText(getAccessibleName(element)) === normalizedOption ||
      (before !== normalizeText(getAccessibleName(element)) &&
        normalizeText(getAccessibleName(element)).includes(normalizedOption));
    if (!selected) {
      return fail(
        "SELECTION_UNVERIFIED",
        "The option was activated, but the control did not expose a verifiable selected state.",
        { selected: false, selectedLabel: optionLabel },
      );
    }
    return { success: true, selected: true, selectedLabel: optionLabel };
  }

  function isISODate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day;
  }

  function getFormattedDate(isoDate, format, element) {
    const [year, month, day] = isoDate.split("-");
    let dateFormat = format;
    if (!dateFormat) {
      const hint = [
        element.getAttribute("placeholder"),
        element.getAttribute("aria-label"),
        element.getAttribute("data-date-format"),
      ].join(" ").toUpperCase();
      if (/D{1,2}[^A-Z]*M{1,2}[^A-Z]*Y{2,4}/.test(hint)) {
        dateFormat = "DD/MM/YYYY";
      } else if (/M{1,2}[^A-Z]*D{1,2}[^A-Z]*Y{2,4}/.test(hint)) {
        dateFormat = "MM/DD/YYYY";
      } else if (/Y{4}[^A-Z]*M{1,2}[^A-Z]*D{1,2}/.test(hint)) {
        dateFormat = "YYYY-MM-DD";
      }
    }
    if (!dateFormat) {
      return null;
    }
    if (dateFormat === "DD/MM/YYYY") {
      return { value: `${day}/${month}/${year}`, format: dateFormat };
    }
    if (dateFormat === "MM/DD/YYYY") {
      return { value: `${month}/${day}/${year}`, format: dateFormat };
    }
    if (dateFormat === "YYYY-MM-DD") {
      return { value: isoDate, format: dateFormat };
    }
    return null;
  }

  async function fillDate(args) {
    if (!isISODate(args.date)) {
      return fail("INVALID_DATE", "Date must be a real calendar date in YYYY-MM-DD format.");
    }
    if (args.selectors) {
      const parts = args.date.split("-");
      const values = { year: parts[0], month: parts[1], day: parts[2] };
      const results = [];
      for (const part of ["year", "month", "day"]) {
        const resolved = resolveDeepSelector(args.selectors[part]);
        if (resolved.error) {
          results.push({ part, success: false, error: resolved.message });
          continue;
        }
        const element = resolved.element;
        if (isSensitive(element)) {
          results.push({ part, success: false, error: "Sensitive fields cannot be changed." });
          continue;
        }
        if (!isVisible(element) || element.disabled ||
            element.getAttribute("aria-disabled")?.toLowerCase() === "true") {
          results.push({ part, success: false, error: "Date field is not visible or is disabled." });
          continue;
        }
        if (element.readOnly ||
            element.getAttribute("aria-readonly")?.toLowerCase() === "true") {
          results.push({ part, success: false, error: "Date field is read-only." });
          continue;
        }
        if (element.tagName.toLowerCase() === "select") {
          const option = getNativeSelectMatch(element, values[part]);
          if (!option) {
            results.push({ part, success: false, error: `No unique ${part} option matches the date.` });
            continue;
          }
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
          if (!setter) {
            results.push({ part, success: false, error: "Could not access the native select value setter." });
            continue;
          }
          setter.call(element, option.value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          results.push({ part, success: element.value === option.value });
          continue;
        }
        const error = setTextValue(element, values[part]);
        results.push({ part, success: !error, ...(error ? { error } : {}) });
      }
      const failed = results.filter((result) => !result.success);
      return {
        success: failed.length === 0,
        filled: results.length - failed.length,
        failed,
        date: args.date,
      };
    }

    const resolved = resolveDeepSelector(args.selector);
    if (resolved.error) {
      return fail(resolved.error, resolved.message);
    }
    const element = resolved.element;
    if (isSensitive(element)) {
      return fail("SENSITIVE_FIELD", "Sensitive fields cannot be changed by this tool.");
    }
    const tag = element.tagName.toLowerCase();
    const type = tag === "input" ? String(element.type).toLowerCase() : "";
    if (tag === "input" && type === "date") {
      const error = setTextValue(element, args.date);
      if (error) {
        return fail("DATE_FILL_FAILED", error);
      }
      return element.value === args.date
        ? { success: true, filled: true, date: args.date }
        : fail("DATE_VALIDATION_FAILED", "The page did not retain the requested date.");
    }

    if (tag === "input" || tag === "textarea") {
      const formatted = getFormattedDate(args.date, args.format, element);
      if (!formatted) {
        return fail(
          "DATE_FORMAT_UNKNOWN",
          "Date format is not clear. Provide DD/MM/YYYY, MM/DD/YYYY, or YYYY-MM-DD explicitly.",
        );
      }
      const error = setTextValue(element, formatted.value);
      if (error) {
        return fail("DATE_FILL_FAILED", error);
      }
      return String(element.value) === formatted.value
        ? { success: true, filled: true, date: args.date, format: formatted.format }
        : fail("DATE_VALIDATION_FAILED", "The page did not retain the requested date.");
    }

    const isSubmitControl =
      isSubmitButton(element) ||
      element.getAttribute("role") === "button" &&
        element.getAttribute("aria-haspopup") !== "dialog" &&
        element.getAttribute("aria-haspopup") !== "grid";
    if (isSubmitControl || !isVisible(element) ||
        element.disabled || element.getAttribute("aria-disabled")?.toLowerCase() === "true") {
      return fail("UNSUPPORTED_DATE_PICKER", "This date picker trigger is not safely supported.");
    }
    element.click();
    let dateCandidates = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      dateCandidates = deepQuery(
        '[data-date], [datetime], [role="gridcell"][aria-label], button[aria-label], [role="option"][aria-label]',
      ).filter(isVisible);
      if (dateCandidates.length) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const matchingDates = dateCandidates.filter((candidate) => {
      const attributeDate = candidate.getAttribute("data-date") || candidate.getAttribute("datetime");
      if (attributeDate && attributeDate.slice(0, 10) === args.date) {
        return true;
      }
      const label = candidate.getAttribute("aria-label");
      if (!label) {
        return false;
      }
      const parsed = Date.parse(label);
      return Number.isFinite(parsed) &&
        new Date(parsed).toISOString().slice(0, 10) === args.date;
    });
    if (matchingDates.length !== 1) {
      return fail(
        matchingDates.length ? "AMBIGUOUS_DATE" : "UNSUPPORTED_DATE_PICKER",
        matchingDates.length
          ? "More than one calendar date matches the requested date."
          : "The calendar does not expose a unique accessible date for safe selection.",
      );
    }
    if (isSubmitButton(matchingDates[0])) {
      return fail("FINAL_ACTION_BLOCKED", "A submit-type calendar option cannot be activated.");
    }
    matchingDates[0].click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const observedValue = normalizeText(
      element.value || element.getAttribute("aria-valuetext") || getAccessibleName(element),
    );
    const acceptedLabel = normalizeText(
      matchingDates[0].getAttribute("aria-label") || matchingDates[0].getAttribute("data-date"),
    );
    const selectedByState =
      matchingDates[0].getAttribute("aria-selected")?.toLowerCase() === "true" ||
      matchingDates[0].getAttribute("aria-pressed")?.toLowerCase() === "true";
    const selectedByDateText = (() => {
      const parsed = Date.parse(
        matchingDates[0].getAttribute("aria-label") ||
          matchingDates[0].getAttribute("data-date") ||
          matchingDates[0].getAttribute("datetime") ||
          "",
      );
      return Number.isFinite(parsed) &&
        new Date(parsed).toISOString().slice(0, 10) === args.date;
    })();
    if (!observedValue.includes(normalizeText(args.date)) &&
        !acceptedLabel.includes(normalizeText(args.date)) &&
        !(selectedByState && selectedByDateText)) {
      return fail(
        "DATE_SELECTION_UNVERIFIED",
        "The date was activated, but the selected value could not be verified.",
      );
    }
    return { success: true, filled: true, date: args.date };
  }

  function verifyForm() {
    const selector =
      "input, textarea, select, [role='textbox'], [role='combobox'], [role='checkbox'], [role='radio'], [role='switch'], [contenteditable='true']";
    const visibleElements = deepQuery(selector).filter(isVisible);
    const sensitiveRequired = visibleElements.filter((element) =>
      (element.required || element.getAttribute("aria-required")?.toLowerCase() === "true") &&
      isSensitive(element),
    );
    const elements = visibleElements.filter((element) =>
      !(element.tagName.toLowerCase() === "input" &&
        ["hidden", "password", "file", "button", "submit", "reset"].includes(
          String(element.type).toLowerCase(),
        )) &&
      !isSensitive(element),
    );
    const missingRequired = [];
    const invalidFields = [];
    const unsupportedFields = sensitiveRequired.map(() => ({
      label: "Sensitive field not inspected",
      type: "sensitive",
    }));
    let requiredFields = sensitiveRequired.length;
    let completedRequiredFields = 0;

    for (const element of elements) {
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role") || "";
      const selectorForElement = element.id ? `#${CSS.escape(element.id)}` : "";
      const label = getAccessibleName(element) || element.name || selectorForElement || "Unlabeled field";
      const required = Boolean(
        element.required || element.getAttribute("aria-required")?.toLowerCase() === "true",
      );
      const supported =
        ["input", "textarea", "select"].includes(tag) ||
        ["textbox", "combobox", "checkbox", "radio", "switch"].includes(role) ||
        element.isContentEditable;
      const fieldInfo = {
        label: label.slice(0, 200),
        selector: selectorForElement,
        type: tag === "input" ? String(element.type).toLowerCase() : role || tag,
      };
      if (!supported) {
        if (required) {
          unsupportedFields.push(fieldInfo);
        }
        continue;
      }

      const type = tag === "input" ? String(element.type).toLowerCase() : "";
      const isToggle = ["checkbox", "radio"].includes(type) ||
        ["checkbox", "radio", "switch"].includes(role);
      const radioGroup = type === "radio" && element.name
        ? deepQuery('input[type="radio"]').filter((candidate) =>
            candidate.name === element.name && candidate.form === element.form,
          )
        : [];
      const hasValue = type === "radio" && radioGroup.length
        ? radioGroup.some((candidate) => candidate.checked)
        : isToggle
          ? Boolean(element.checked || element.getAttribute("aria-checked")?.toLowerCase() === "true")
          : tag === "select"
          ? Boolean(element.value)
          : String("value" in element ? element.value : element.textContent || "").trim().length > 0;
      if (required) {
        requiredFields += 1;
        if (hasValue) {
          completedRequiredFields += 1;
        } else {
          missingRequired.push(fieldInfo);
        }
      }
      const invalid = element.getAttribute("aria-invalid")?.toLowerCase() === "true" ||
        Boolean(element.validity && !element.validity.valid);
      if (invalid) {
        invalidFields.push(fieldInfo);
      }
    }

    const validationMessages = deepQuery('[role="alert"], [aria-live="assertive"]')
      .filter(isVisible)
      .map((element) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((message) => {
        let safeMessage = message;
        for (const element of elements) {
          const value = "value" in element
            ? String(element.value || "").trim()
            : String(element.textContent || "").trim();
          if (value.length >= 3) {
            safeMessage = safeMessage.split(value).join("[redacted]");
          }
        }
        return safeMessage.slice(0, 300);
      });
    return {
      success: true,
      valid: missingRequired.length === 0 &&
        invalidFields.length === 0 &&
        unsupportedFields.length === 0,
      verificationComplete: unsupportedFields.length === 0,
      requiredFields,
      completedRequiredFields,
      missingRequired,
      invalidFields,
      unsupportedFields,
      validationMessages,
    };
  }

  const stalePage = assertCurrentPage();
  if (stalePage) {
    return stalePage;
  }
  if (tool === "verify_form") {
    return verifyForm();
  }
  if (tool === "select_option") {
    return selectOption(args.selector, args.option);
  }
  if (tool === "fill_date") {
    return fillDate(args);
  }
  if (tool !== "click_element") {
    return fail("UNSUPPORTED_TOOL", "This browser tool is not supported.");
  }

  const resolved = resolveDeepSelector(args.selector);
  if (resolved.error) {
    return fail(resolved.error, resolved.message);
  }
  const element = resolved.element;
  const role = element.getAttribute("role");
  const isButtonInput =
    element.tagName.toLowerCase() === "input" &&
    String(element.type).toLowerCase() === "button";
  if (
    !["button", "a"].includes(element.tagName.toLowerCase()) &&
    !isButtonInput &&
    !["button", "link"].includes(role)
  ) {
    return fail("UNSUPPORTED_ELEMENT", "Only inspected buttons and links can be clicked.");
  }
  if (isSensitive(element)) {
    return fail("SENSITIVE_TARGET", "Sensitive or authentication controls cannot be clicked.");
  }
  if (!isVisible(element)) {
    return fail("ELEMENT_NOT_VISIBLE", "The target is not visible.");
  }
  if (element.disabled || element.matches(":disabled") ||
      element.getAttribute("aria-disabled")?.toLowerCase() === "true") {
    return fail("ELEMENT_DISABLED", "The target is disabled.");
  }
  if (element.getAttribute("target")?.toLowerCase() === "_blank") {
    return fail("NEW_TAB_BLOCKED", "Links that open a new tab are not clicked by this tool.");
  }
  const label = normalizeText(getAccessibleName(element));
  const intermediateAction =
    /^(next|continue|save|save and continue|back|previous|add (education|experience|employment|another))/i
      .test(label);
  const blockedAction =
    /\b(submit(?: application)?|send application|confirm(?: and send)?|delete(?: account| application)?|pay(?:ment)?|complete application|finish application|finali[sz]e|accept (?:terms|agreement)|agree to terms)\b/i
      .test(label);
  const applyAction = /^(apply|apply now|apply application)$/.test(label);
  const consentAction = /\b(?:accept|agree)\b.*\b(?:terms|agreement|consent)\b/i.test(label);
  const isSubmit = isSubmitButton(element);
  if (
    blockedAction ||
    consentAction ||
    applyAction ||
    (isSubmit && !intermediateAction)
  ) {
    return fail(
      "FINAL_ACTION_BLOCKED",
      "This action may submit, delete, pay, or accept a legal agreement and requires manual user control.",
    );
  }
  const href = element.tagName.toLowerCase() === "a" ? element.getAttribute("href") : null;
  if (href && /^\s*(javascript|data):/i.test(href)) {
    return fail("UNSAFE_LINK_BLOCKED", "Script and data links are not clicked.");
  }

  let clickObserved = false;
  element.addEventListener("click", () => {
    clickObserved = true;
  }, { once: true, capture: true });
  const previousUrl = window.location.href;
  element.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  return {
    success: clickObserved,
    clicked: clickObserved,
    navigationDetected: window.location.href !== previousUrl,
    requiresReinspection: true,
    ...(clickObserved
      ? {}
      : { error: { code: "CLICK_NOT_OBSERVED", message: "The page did not dispatch a click event." } }),
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
    const diagnostics = lastInspectedPage.diagnostics;
    const controlCount = lastInspectedPage.controls.length;
    inspectionStatus.textContent = diagnostics.noControlsFound
      ? `Page inspected, but no supported controls were detected across ${diagnostics.framesInspected} accessible frame(s).`
      : `Page inspected: ${controlCount} controls across ${diagnostics.framesInspected} accessible frame(s).`;
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

newChatButton.addEventListener("click", async () => {
  if (isChatStreaming) {
    return;
  }

  newChatButton.disabled = true;
  try {
    const newThreadId = createThreadId();
    await chrome.storage.local.set({
      [THREAD_ID_STORAGE_KEY]: newThreadId,
    });
    threadId = newThreadId;
    threadIdPromise = Promise.resolve(newThreadId);
    messages.replaceChildren();
    conversationStatus.textContent = "New conversation started.";
  } catch (error) {
    conversationStatus.textContent =
      `Could not start a new conversation: ${errorDetails(error)}`;
  } finally {
    newChatButton.disabled = isChatStreaming;
  }
});

void getThreadId().catch(() => {});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || sendButton.disabled) {
    return;
  }

  isChatStreaming = true;
  newChatButton.disabled = true;
  addMessage("user", message);
  input.value = "";
  input.disabled = true;
  sendButton.disabled = true;

  const assistantMessage = addMessage("assistant");
  assistantMessage.textContent = "Thinking...";
  assistantMessage.classList.add("loading");
  let responseText = "";

  try {
    const activeThreadId = await getThreadId();
    const response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        thread_id: activeThreadId,
      }),
    });

    if (!response.ok) {
      throw new Error(`The backend returned HTTP ${response.status}.`);
    }
    if (!response.body) {
      throw new Error("The backend did not provide a response stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

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
    const errorMessage =
      error?.code === "conversation-storage"
        ? error.message
        : error instanceof TypeError
          ? responseText
            ? "The response stream was interrupted."
            : "Could not connect to ApplyFlow. Check that the backend is running at http://127.0.0.1:8000."
          : error.message || "Something went wrong while contacting the backend.";
    assistantMessage.textContent = responseText
      ? `${responseText}\n\n[Response interrupted: ${errorMessage}]`
      : errorMessage;
    scrollToLatest();
  } finally {
    isChatStreaming = false;
    newChatButton.disabled = false;
    input.disabled = false;
    sendButton.disabled = false;
    input.focus();
  }
});

const BROWSER_BRIDGE_URL = "ws://127.0.0.1:8000/ws/browser";
const ALLOWED_BROWSER_TOOLS = new Set([
  "inspect_page",
  "fill_form",
  "click_element",
  "select_option",
  "fill_date",
  "verify_form",
]);
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
    let id = null;
    try {
      const oversizedCommand = JSON.parse(data);
      if (
        oversizedCommand !== null &&
        typeof oversizedCommand === "object" &&
        !Array.isArray(oversizedCommand) &&
        typeof oversizedCommand.id === "string" &&
        oversizedCommand.id.trim().length > 0 &&
        oversizedCommand.id.length <= MAX_REQUEST_ID_LENGTH &&
        !/[\u0000-\u001f\u007f]/.test(oversizedCommand.id)
      ) {
        id = oversizedCommand.id;
      }
    } catch {
      // Invalid oversized JSON cannot be associated with a pending request.
    }
    return { error: "Command is too large.", id };
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

  if (typeof command.tool !== "string") {
    return { error: "Command tool must be a string.", id };
  }
  if (!ALLOWED_BROWSER_TOOLS.has(command.tool)) {
    return { error: "Unsupported browser tool.", id };
  }

  const keys = Object.keys(command);
  if (command.tool === "inspect_page") {
    if (keys.length !== 2 || !keys.includes("id") || !keys.includes("tool")) {
      return { error: "inspect_page command must contain only id and tool.", id };
    }
    return { id, tool: command.tool };
  }

  if (
    keys.length !== 3 ||
    !keys.includes("id") ||
    !keys.includes("tool") ||
    !keys.includes("args")
  ) {
    return { error: "Browser command must contain only id, tool, and args.", id };
  }
  const args = command.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { error: `${command.tool} args must be an object.`, id };
  }
  const argKeys = Object.keys(args);
  const hasOnlyKeys = (allowed, required = []) =>
    argKeys.every((key) => allowed.includes(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(args, key));
  const validFrameId =
    args.frameId === undefined ||
    (Number.isInteger(args.frameId) && args.frameId >= 0 && args.frameId <= 10000);
  if (!validFrameId) {
    return { error: "frameId must be a non-negative integer.", id };
  }

  if (command.tool === "fill_form") {
    if (!hasOnlyKeys(["fields"], ["fields"]) || !Array.isArray(args.fields)) {
      return { error: "fill_form args must contain only a fields array.", id };
    }
    return { id, tool: command.tool, fields: args.fields };
  }

  if (command.tool === "click_element") {
    if (
      !hasOnlyKeys(["selector", "frameId"], ["selector"]) ||
      typeof args.selector !== "string" ||
      !args.selector.trim() ||
      args.selector.length > 1024
    ) {
      return { error: "click_element requires a non-empty inspected selector.", id };
    }
    return { id, tool: command.tool, args };
  }

  if (command.tool === "select_option") {
    if (
      !hasOnlyKeys(["selector", "option", "frameId"], ["selector", "option"]) ||
      typeof args.selector !== "string" ||
      !args.selector.trim() ||
      args.selector.length > 1024 ||
      typeof args.option !== "string" ||
      !args.option.trim() ||
      args.option.length > 256
    ) {
      return { error: "select_option requires a selector and a non-empty option string.", id };
    }
    return { id, tool: command.tool, args };
  }

  if (command.tool === "fill_date") {
    if (!hasOnlyKeys(["selector", "date", "format", "selectors", "frameId"], ["date"])) {
      return { error: "fill_date args contain unsupported properties.", id };
    }
    const hasSelectorKey = Object.prototype.hasOwnProperty.call(args, "selector");
    const hasPartsKey = Object.prototype.hasOwnProperty.call(args, "selectors");
    const hasSelector =
      typeof args.selector === "string" &&
      Boolean(args.selector.trim());
    const hasParts =
      args.selectors !== null &&
      typeof args.selectors === "object" &&
      !Array.isArray(args.selectors);
    if (hasSelectorKey === hasPartsKey || (hasSelectorKey && !hasSelector) ||
        (hasPartsKey && !hasParts)) {
      return { error: "fill_date requires either selector or selectors, but not both.", id };
    }
    if (
      (hasSelector && args.selector.length > 1024) ||
      typeof args.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.date)
    ) {
      return { error: "fill_date requires a selector and date in YYYY-MM-DD format.", id };
    }
    if (
      args.format !== undefined &&
      !["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"].includes(args.format)
    ) {
      return { error: "format must be DD/MM/YYYY, MM/DD/YYYY, or YYYY-MM-DD.", id };
    }
    if (hasParts) {
      const partKeys = Object.keys(args.selectors);
      if (
        partKeys.length !== 3 ||
        !["day", "month", "year"].every((key) =>
          typeof args.selectors[key] === "string" &&
          args.selectors[key].trim() &&
          args.selectors[key].length <= 1024
        )
      ) {
        return { error: "selectors must contain non-empty day, month, and year selectors.", id };
      }
    }
    return { id, tool: command.tool, args };
  }

  if (command.tool === "verify_form") {
    if (!hasOnlyKeys(["frameId"])) {
      return { error: "verify_form accepts only an optional frameId.", id };
    }
    return { id, tool: command.tool, args };
  }

  return { error: "Unsupported browser tool.", id };
}

function getObservedControl(selector, frameId) {
  const controls = [
    ...(lastInspectedPage?.controls || []),
    ...(lastInspectedPage?.forms || []).flatMap((pageForm) => pageForm.fields || []),
  ];
  return controls.find(
    (control) => control.selector === selector && control.frameId === frameId,
  );
}

async function performBrowserTool(tool, args) {
  const frameId = args.frameId ?? 0;
  const context = await getBrowserActionContext(frameId);
  const observedControls = [];
  if (tool !== "verify_form") {
    const selectors = tool === "fill_date" && args.selectors
      ? Object.values(args.selectors)
      : [args.selector];
    for (const selector of selectors) {
      const observed = getObservedControl(selector, frameId);
      if (!observed) {
        return {
          success: false,
          error: {
            code: "SELECTOR_NOT_INSPECTED",
            message: "Selector was not present in the latest inspection of this frame.",
          },
        };
      }
      observedControls.push(observed);
      if (tool === "click_element" &&
          !["button", "a"].includes(observed.tag) &&
          !(observed.tag === "input" && observed.type === "button") &&
          !["button", "link"].includes(observed.role)) {
        return {
          success: false,
          error: {
            code: "UNSUPPORTED_ELEMENT",
            message: "click_element only accepts inspected buttons and links.",
          },
        };
      }
      if (tool === "select_option" &&
          observed.tag !== "select" &&
          !["combobox", "listbox"].includes(observed.role) &&
          observed.hasPopup !== "listbox") {
        return {
          success: false,
          error: {
            code: "UNSUPPORTED_CONTROL",
            message: "select_option only accepts an inspected select or accessible listbox.",
          },
        };
      }
      if (tool === "fill_date" && !observed.supportedForDate &&
          !["date", "combobox", "number", "select"].includes(observed.type) &&
          observed.tag !== "select" &&
          !["combobox"].includes(observed.role) &&
          !(observed.tag === "button" && /date|calendar/i.test(observed.label || ""))) {
        return {
          success: false,
          error: {
            code: "UNSUPPORTED_DATE_CONTROL",
            message: "The inspected control is not a supported date field or date picker.",
          },
        };
      }
    }
  }

  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId: context.tab.id, frameIds: [frameId] },
      func: runBrowserPageTool,
      args: [
        tool,
        { ...args, observedControls },
        context.frameUrl,
        context.documentTimeOrigin,
      ],
    });
  } catch (error) {
    console.error("[ApplyFlow] Browser tool execution failed", {
      tool,
      tabId: context.tab.id,
      frameId,
      hostname: context.pageUrl.hostname,
      error: errorDetails(error),
    });
    return {
      success: false,
      error: {
        code: "SCRIPT_EXECUTION_FAILED",
        message: `Could not execute ${tool} on the inspected page: ${errorDetails(error)}`,
      },
    };
  }

  if (!injection?.result || typeof injection.result.success !== "boolean") {
    return {
      success: false,
      error: {
        code: "INVALID_TOOL_RESULT",
        message: "The page did not return a valid browser-tool result.",
      },
    };
  }
  if (tool === "click_element" && injection.result.success) {
    lastInspectedPage = null;
    lastInspectedTabId = null;
    lastInspectedPermissionPattern = null;
    lastInspectedFrameTokens.clear();
  }
  return injection.result;
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
    if (command.tool === "inspect_page") {
      const result = await inspectPage();
      lastInspectedPage = result;
      sendBridgeResponse(socket, {
        id: command.id,
        success: true,
        result,
      });
      return;
    }

    if (command.tool === "fill_form") {
      const result = await fillForm(command.fields);
      sendBridgeResponse(socket, {
        id: command.id,
        ...result,
      });
      return;
    }

    const result = await performBrowserTool(command.tool, command.args);
    sendBridgeResponse(socket, {
      id: command.id,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not execute the browser tool.";
    sendBridgeResponse(socket, command.tool === "fill_form" || command.tool === "inspect_page"
      ? {
          id: command.id,
          success: false,
          error: message,
        }
      : {
          id: command.id,
          success: false,
          error: {
            code: error?.code || "BROWSER_TOOL_FAILED",
            message,
          },
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
