import { buildCsvRow, CSV_HEADER, downloadFile } from "./shared/export.js";
import { dedupePeople, normalizePeople } from "./shared/people.js";
import { compactResearchPayload, compactStructuredData, trimText } from "./shared/payload-cleaning.js";
import { fillList as fillSharedList, renderEmployeeExtras, renderPeople as renderPeopleList, syncSettingsUI } from "./shared/ui.js";
import {
  buildTeamDiscoveryPlan,
  gatherInternalLinks,
  scoreLink
} from "./shared/team-page-discovery.js";
import { getSettings, saveSettings as saveSettingsStore, getLatestResult as getLatestResultStore, setLatestResult as setLatestResultStore } from "./storage/manager.js";
import { normalizeApiKeysInput, validateApiKey, validateProviderApiKeys } from "./engine/utils.js";
import { isLocalOllamaBaseUrl } from "./config/settings.js";

const LATEST_RESULT_KEY = "latestAnalysis";
const KW_STORAGE_KEY = "serviceKeywords";
const MAX_RESEARCH_PAGES = 8;
const MAX_CRAWL_DEPTH = 5;
const MAX_CRAWL_PAGES = 8;
const MAX_PAGE_BODY_CHARS = 1400;
const MAX_EMPLOYEE_PAGE_BODY_CHARS = 8000;
const MAX_SUMMARY_BODY_CHARS = 1000;
const CRAWL_BASE_DELAY_MS = 1200;
const CRAWL_JITTER_MS = 900;
const CRAWL_SAFE_MODE_EXTRA_DELAY_MS = 1300;
const CRAWL_TAB_SETTLE_MS = 500;
const NON_HTML_RESOURCE_EXT = /\.(pdf|png|jpe?g|gif|webp|svg|zip|rar|7z|mp4|mp3|wav|avi|mov|m4a|docx?|xlsx?|pptx?)$/i;
const BUSINESS_PAGE_KEYWORD_REGEX = /\b(service|services|solution|solutions|product|products|offering|offerings|what-we-do|capabilit|industry|industries|sector|sectors|about|about-us|company|our-company|overview|expertise|specialt|practice|portfolio|case-stud|work|clients?|markets?)\b/i;
const DASH_LOG_PREFIX = "[BTD:Dashboard]";
let debugLogsEnabled = true;

let latestResult = null;
let serviceKeywords = [];
let rateLimitSafeMode = false;
let siteAnalysisInFlight = false;
let employeeAnalysisInFlight = false;
let employeeAnalysisInFlightRoot = "";
let currentRunController = null;
const activeOperationIds = new Set();
const openedTempTabIds = new Set();
let autoTriggerTimeout = null;
const autoEmployeeTriggerAtByRoot = new Map();
const AUTO_EMPLOYEE_TRIGGER_COOLDOWN_MS = 2 * 60 * 1000;
let launchQueryHandled = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isStopRequested() {
  return Boolean(currentRunController?.signal?.aborted);
}

function throwIfStopped() {
  if (isStopRequested()) {
    throw new DOMException("Analysis stopped.", "AbortError");
  }
}

function createOperationId(prefix = "analysis") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function beginAnalysisRun() {
  currentRunController = new AbortController();
  setBusy(true);
}

function endAnalysisRun() {
  currentRunController = null;
  activeOperationIds.clear();
  openedTempTabIds.clear();
  setBusy(false);
}

async function sendAnalysisMessage(message, prefix = "analysis") {
  throwIfStopped();
  const operationId = createOperationId(prefix);
  activeOperationIds.add(operationId);
  try {
    return await chrome.runtime.sendMessage({ ...message, operationId });
  } finally {
    activeOperationIds.delete(operationId);
  }
}

async function stopCurrentAnalysis() {
  if (!currentRunController || currentRunController.signal.aborted) return;
  currentRunController.abort();
  setStatus("Stopping analysis...");
  setStage("Stopping", "busy");
  for (const operationId of [...activeOperationIds]) {
    chrome.runtime.sendMessage({ type: "cancel-analysis", operationId }).catch(() => { });
  }
  for (const tabId of [...openedTempTabIds]) {
    chrome.tabs.remove(tabId).catch(() => { });
  }
}

function isStoppedError(error) {
  return error?.name === "AbortError" || /analysis stopped/i.test(String(error?.message || error || ""));
}

function friendlyErrorMessage(error) {
  const msg = String(error?.message || "Analysis failed.");
  if (/blocked|forbidden/i.test(msg) && /gemini/i.test(msg)) return msg + " Try switching to Groq in Settings.";
  if (/blocked|forbidden/i.test(msg)) return msg + " Try switching providers in Settings.";
  if (/api key/i.test(msg)) return msg + " Check your API key in Settings.";
  return msg;
}

function getCrawlDelayMs() {
  const base = CRAWL_BASE_DELAY_MS + (rateLimitSafeMode ? CRAWL_SAFE_MODE_EXTRA_DELAY_MS : 0);
  return base + Math.floor(Math.random() * (CRAWL_JITTER_MS + 1));
}

function logDebug(message, payload) {
  if (!debugLogsEnabled) return;
  if (typeof payload === "undefined") {
    console.log(`${DASH_LOG_PREFIX} ${message}`);
  } else {
    console.log(`${DASH_LOG_PREFIX} ${message}`, payload);
  }
}

const elements = {
  provider: document.getElementById("provider"),
  groqFields: document.getElementById("groqFields"),
  geminiFields: document.getElementById("geminiFields"),
  ollamaFields: document.getElementById("ollamaFields"),
  groqApiKey: document.getElementById("groqApiKey"),
  geminiApiKey: document.getElementById("geminiApiKey"),
  ollamaApiKey: document.getElementById("ollamaApiKey"),
  debugLogsEnabled: document.getElementById("debugLogsEnabled"),
  rateLimitSafeMode: document.getElementById("rateLimitSafeMode"),
  ollamaBaseUrl: document.getElementById("ollamaBaseUrl"),
  janFields: document.getElementById("janFields"),
  janBaseUrl: document.getElementById("janBaseUrl"),
  janModel: document.getElementById("janModel"),
  saveSettings: document.getElementById("saveSettings"),
  targetUrl: document.getElementById("targetUrl"),
  analyzeUrl: document.getElementById("analyzeUrl"),
  analyzeCurrent: document.getElementById("analyzeCurrent"),
  analyzeEmployees: document.getElementById("analyzeEmployees"),
  stopAnalysis: document.getElementById("stopAnalysis"),
  statusStrip: document.getElementById("statusStrip"),
  statusIcon: document.getElementById("statusIcon"),
  status: document.getElementById("status"),
  stageBadge: document.getElementById("stageBadge"),
  scopeBadge: document.getElementById("scopeBadge"),
  domainBadge: document.getElementById("domainBadge"),
  progressBar: document.getElementById("progressBar"),
  recentSiteNote: document.getElementById("recentSiteNote"),
  emptyState: document.getElementById("emptyState"),
  classificationStrip: document.getElementById("classificationStrip"),
  csBusinessType: document.getElementById("cs-businessType"),
  csIndustry: document.getElementById("cs-industry"),
  csServices: document.getElementById("cs-services"),
  csConfidenceWrap: document.getElementById("cs-confidenceWrap"),
  csConfidence: document.getElementById("cs-confidence"),
  result: document.getElementById("result"),
  businessType: document.getElementById("businessType"),
  confidence: document.getElementById("confidence"),
  summary: document.getElementById("summary"),
  industry: document.getElementById("industry"),
  peopleCount: document.getElementById("peopleCount"),
  pageCount: document.getElementById("pageCount"),
  websiteSignals: document.getElementById("websiteSignals"),
  services: document.getElementById("services"),
  people: document.getElementById("people"),
  peopleGrid: document.getElementById("peopleGrid"),
  peopleGridPanel: document.getElementById("peopleGridPanel"),
  teamSummary: document.getElementById("teamSummary"),
  evidence: document.getElementById("evidence"),
  raw: document.getElementById("raw"),
  copyJson: document.getElementById("copyJson"),
  exportCsv: document.getElementById("exportCsv")
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.color = isError ? "#b42318" : "#486581";
  if (isError) {
    setStage("Error", "error");
  }
}

function setStage(label = "Idle", tone = "idle") {
  const toneValue = ["idle", "busy", "success", "error"].includes(tone) ? tone : "idle";
  if (elements.statusStrip) {
    elements.statusStrip.classList.remove(
      "status-strip--idle",
      "status-strip--busy",
      "status-strip--success",
      "status-strip--error"
    );
    elements.statusStrip.classList.add(`status-strip--${toneValue}`);
  }
  if (elements.stageBadge) {
    elements.stageBadge.textContent = label || "Idle";
    elements.stageBadge.classList.remove(
      "stage-badge--idle",
      "stage-badge--busy",
      "stage-badge--success",
      "stage-badge--error"
    );
    elements.stageBadge.classList.add(`stage-badge--${toneValue}`);
  }
  if (elements.statusIcon) {
    elements.statusIcon.textContent = toneValue === "success"
      ? "done"
      : toneValue === "error"
        ? "error"
        : toneValue === "busy"
          ? "busy"
          : "idle";
  }
}

function setProgress(percent) {
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function updateDomainBadge(url) {
  if (!url) {
    elements.domainBadge.textContent = "No site selected";
    return;
  }
  try {
    elements.domainBadge.textContent = new URL(url).hostname;
  } catch {
    elements.domainBadge.textContent = url;
  }
}

function setBusy(isBusy) {
  elements.saveSettings.disabled = isBusy;
  elements.analyzeUrl.disabled = isBusy;
  elements.analyzeCurrent.disabled = isBusy;
  elements.analyzeEmployees.disabled = isBusy || !latestResult?.url;
  elements.stopAnalysis?.classList.toggle("hidden", !isBusy);
  if (elements.stopAnalysis) elements.stopAnalysis.disabled = false;
  window.BTDDashboardUI?.setAnalyzeBusyVisual(isBusy);
}

function setEmployeeButtonState() {
  elements.analyzeEmployees.disabled = !latestResult?.url;
}

function updateProviderFields(provider) {
  const isGroq = provider === "groq";
  const isGemini = provider === "gemini";
  const isOllama = provider === "ollama";
  const isJan = provider === "jan";
  elements.groqFields.classList.toggle("hidden", !isGroq);
  elements.geminiFields.classList.toggle("hidden", !isGemini);
  elements.ollamaFields.classList.toggle("hidden", !isOllama);
  if (elements.janFields) elements.janFields.classList.toggle("hidden", !isJan);
  window.BTDDashboardUI?.syncProviderFields(provider);
}

async function loadSettings() {
  const settings = await getSettings();
  await syncSettingsUI(elements, settings);
  const provider = settings.provider || "groq";
  const ollamaBaseUrl = settings.ollamaBaseUrl || "https://ollama.com";
  const janBaseUrl = settings.janBaseUrl || "http://127.0.0.1:1337/v1";
  const janModel = settings.janModel || "";
  const debugLogsEnabled = settings.debugLogsEnabled ?? true;
  const rateLimitSafeMode = settings.rateLimitSafeMode ?? false;

  updateProviderFields(provider);
  if (elements.janModel) {
    elements.janModel.value = janModel;
    try {
      const response = await fetch(`${janBaseUrl.replace(/\/+$/, "")}/models`);
      if (response.ok) {
        const payload = await response.json();
        const models = (payload?.data || [])
          .map(m => m.id)
          .filter(Boolean)
          .filter(id => !/whisper|tts|speech|audio|transcribe|guard|embedding|aqa|playai|orpheus/i.test(id));

        if (models.length > 0) {
          const dataList = document.getElementById("janModelList");
          if (dataList) {
            dataList.innerHTML = "";
            models.forEach(id => {
              const opt = document.createElement("option");
              opt.value = id;
              dataList.appendChild(opt);
            });
          }
          elements.janModel.value = models.includes(janModel) ? janModel : models[0];
        }
      }
    } catch (err) {
      logDebug("Could not fetch dynamic model list from Jan AI", err);
    }
  }
}

async function saveSettings() {
  const groqKey = elements.groqApiKey?.value;
  const geminiKey = elements.geminiApiKey?.value;
  const ollamaKey = elements.ollamaApiKey?.value?.trim() || "";
  const provider = elements.provider?.value || "groq";

  // 1. Validate active provider key
  if (provider === "groq") {
    const val = validateProviderApiKeys("groq", groqKey);
    if (!val.valid) {
      setStatus(val.error, true);
      throw new Error(val.error);
    }
  } else if (provider === "gemini") {
    const val = validateProviderApiKeys("gemini", geminiKey);
    if (!val.valid) {
      setStatus(val.error, true);
      throw new Error(val.error);
    }
  } else if (provider === "ollama") {
    const ollamaBaseUrl = elements.ollamaBaseUrl?.value?.trim() || "https://ollama.com";
    if (!isLocalOllamaBaseUrl(ollamaBaseUrl) || ollamaKey) {
      const val = validateProviderApiKeys("ollama", ollamaKey);
      if (!val.valid) {
        setStatus(val.error, true);
        throw new Error(val.error);
      }
    }
  }

  // 2. Optional: Validate other keys if they are provided (prevent typos)
  if (groqKey && provider !== "groq") {
    const val = validateProviderApiKeys("groq", groqKey);
    if (!val.valid) {
      const message = `Invalid Groq key: ${val.error}`;
      setStatus(message, true);
      throw new Error(message);
    }
  }
  if (geminiKey && provider !== "gemini") {
    const val = validateProviderApiKeys("gemini", geminiKey);
    if (!val.valid) {
      const message = `Invalid Gemini key: ${val.error}`;
      setStatus(message, true);
      throw new Error(message);
    }
  }
  if (ollamaKey && provider !== "ollama") {
    const val = validateProviderApiKeys("ollama", ollamaKey);
    if (!val.valid) {
      const message = `Invalid Ollama key: ${val.error}`;
      setStatus(message, true);
      throw new Error(message);
    }
  }

  const providerApiKeys = {
    groq: normalizeApiKeysInput(groqKey),
    gemini: normalizeApiKeysInput(geminiKey),
    ollama: normalizeApiKeysInput(ollamaKey)
  };
  const ollamaBaseUrl = elements.ollamaBaseUrl?.value?.trim() || "https://ollama.com";
  const janBaseUrl = elements.janBaseUrl?.value?.trim() || "http://127.0.0.1:1337/v1";
  const janModel = elements.janModel?.value?.trim() || "";


  const nextDebugLogsEnabled = elements.debugLogsEnabled ? !!elements.debugLogsEnabled.checked : true;
  const nextRateLimitSafeMode = elements.rateLimitSafeMode ? !!elements.rateLimitSafeMode.checked : false;

  debugLogsEnabled = nextDebugLogsEnabled;
  rateLimitSafeMode = nextRateLimitSafeMode;

  const preferences = {
    provider,
    ollamaBaseUrl,
    janBaseUrl,
    janModel,
    debugLogsEnabled: nextDebugLogsEnabled,
    rateLimitSafeMode: nextRateLimitSafeMode
  };
  const localSettings = {
    ...preferences,
    providerApiKeys,
  };

  try {
    await saveSettingsStore(preferences, localSettings);
    setStatus("Settings saved.");
  } catch (error) {
    throw new Error("Failed to save settings: " + error.message);
  }
}

function fillList(target, items, emptyText = "None found.") {
  fillSharedList(target, items, emptyText, { placeholderClass: "placeholder-text" });
}

function formatDateTime(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function getDomainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isSupportedUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

function toCanonicalUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

function toCanonicalPageKey(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname
    .replace(/\/+/g, "/")
    .replace(/\/index\.(html?|php|asp|aspx)$/i, "/");
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return `${parsed.origin}${parsed.pathname}`;
}

function isCrawlableUrl(url) {
  if (!isSupportedUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return !NON_HTML_RESOURCE_EXT.test(parsed.pathname || "");
  } catch {
    return false;
  }
}

function toRootUrl(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}/`;
}

function normalizeUrl(input) {
  const value = input.trim();
  if (!value) {
    throw new Error("Enter a domain or full URL.");
  }
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function renderPeople(target, people) {
  renderPeopleList(target, people, {
    employeeAnalysisComplete: !!latestResult?.employeeAnalysisComplete,
    placeholderClass: "placeholder-text"
  });
}

function makeCopyCell(value, options = {}) {
  const normalizedValue = String(value || "");
  const displayValue = normalizedValue || "-";
  const td = document.createElement("td");
  td.className = "pg-cell";
  const valueEl = options.link && normalizedValue
    ? document.createElement("a")
    : document.createElement("span");
  valueEl.className = "pg-cell-text";
  valueEl.textContent = displayValue;
  if (valueEl instanceof HTMLAnchorElement) {
    valueEl.href = normalizedValue;
    valueEl.target = "_blank";
    valueEl.rel = "noopener noreferrer";
  }
  const btn = document.createElement("button");
  btn.className = "pg-copy-btn";
  btn.type = "button";
  btn.title = "Copy";
  btn.setAttribute("aria-label", `Copy ${options.label || "cell value"}`);
  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 11H2a1 1 0 01-1-1V2a1 1 0 011-1h8a1 1 0 011 1v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(normalizedValue).then(() => {
      btn.classList.add("pg-copy-btn--copied");
      setTimeout(() => btn.classList.remove("pg-copy-btn--copied"), 1500);
    });
  });
  td.appendChild(valueEl);
  td.appendChild(btn);
  return td;
}

function renderPeopleGrid(target, people) {
  target.replaceChildren();
  const entries = normalizePeople(people);
  const leadership = normalizePeople(latestResult?.companyLeadership || []);
  const warnings = latestResult?.warnings || latestResult?.employeeWarnings || [];
  if (!entries.length) {
    const msg = document.createElement("p");
    msg.className = "placeholder-text";
    msg.textContent = latestResult?.employeeAnalysisComplete
      ? "No team or people details found."
      : "Run Analyze Employees to load people.";
    target.appendChild(msg);
    renderEmployeeExtras(target, latestResult || {}, { showChunks: false });
    return;
  }
  const table = document.createElement("table");
  table.className = "people-grid";
  const thead = document.createElement("thead");
  const hrow = document.createElement("tr");
  for (const col of ["Name", "Title", "Department", "Phone", "Email", "LinkedIn URL", "Confidence", "Source URL", "Bio"]) {
    const th = document.createElement("th");
    th.textContent = col;
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const person of entries) {
    const tr = document.createElement("tr");
    tr.appendChild(makeCopyCell(person.name, { label: "name" }));
    tr.appendChild(makeCopyCell(person.title, { label: "title" }));
    tr.appendChild(makeCopyCell(person.department, { label: "department" }));
    tr.appendChild(makeCopyCell(person.phone, { label: "phone" }));
    tr.appendChild(makeCopyCell(person.email, { label: "email" }));
    tr.appendChild(makeCopyCell(person.linkedinUrl, { label: "linkedin url", link: true }));
    tr.appendChild(makeCopyCell(person.confidence, { label: "confidence" }));
    tr.appendChild(makeCopyCell(person.sourceUrl, { label: "source url", link: true }));
    tr.appendChild(makeCopyCell(person.bio, { label: "bio" }));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  target.appendChild(table);
  renderEmployeeExtras(target, latestResult || {}, { showChunks: false });
}

function renderClassificationStrip(result) {
  if (!elements.classificationStrip) return;
  if (!result) {
    elements.classificationStrip.classList.add("hidden");
    elements.classificationStrip.style.setProperty("display", "none", "important");
    delete elements.classificationStrip.dataset.visible;
    return;
  }

  elements.classificationStrip.classList.remove("hidden");
  elements.classificationStrip.style.setProperty("display", "flex", "important");
  elements.classificationStrip.dataset.visible = "1";
  window.BTDDashboardUI?.activateTab("summary");

  if (elements.csBusinessType) {
    elements.csBusinessType.textContent = result.businessType || "Unknown";
  }
  if (elements.csIndustry) {
    elements.csIndustry.textContent = result.industry || "-";
  }

  if (elements.csServices) {
    elements.csServices.replaceChildren();
    const services = Array.isArray(result.services) ? result.services : (result.services ? [String(result.services)] : []);
    if (services.length) {
      for (const svc of services) {
        const tag = document.createElement("span");
        tag.className = "cs-service-tag";
        tag.textContent = svc;
        elements.csServices.appendChild(tag);
      }
    } else {
      const emptyTag = document.createElement("span");
      emptyTag.className = "placeholder-text";
      emptyTag.textContent = "No specific services detected.";
      elements.csServices.appendChild(emptyTag);
    }
  }

  if (elements.csConfidenceWrap) {
    if (typeof result.confidence === "number") {
      if (elements.csConfidence) {
        elements.csConfidence.textContent = `${Math.round(result.confidence * 100)}% confidence`;
      }
      elements.csConfidenceWrap.classList.remove("hidden");
    } else {
      elements.csConfidenceWrap.classList.add("hidden");
    }
  }
}

function buildConciseTeamSummary(chunkResults = [], mergedPeople = []) {
  const summaries = chunkResults
    .map((item) => String(item?.teamSummary || "").trim())
    .filter(Boolean);
  const unique = [...new Set(summaries)];
  const peopleCount = normalizePeople(mergedPeople).length;
  if (!unique.length) {
    return peopleCount > 0 ? `Team profile compiled from ${peopleCount} identified people across crawled pages.` : "";
  }

  const top = unique.slice(0, 3);
  const base = top.join(" ");
  const suffix = unique.length > 3 ? ` Additional team signals observed across ${unique.length} chunks.` : "";
  return `${base}${suffix}`.trim();
}

// Service keyword triggers

function renderKeywordTags() {
  const container = document.getElementById("kwTags");
  const statusEl = document.getElementById("kwStatus");
  container.replaceChildren();
  serviceKeywords.forEach((kw, i) => {
    const span = document.createElement("span");
    span.className = "kw-tag";
    span.append(document.createTextNode(kw));
    const remove = document.createElement("span");
    remove.className = "kw-tag-del";
    remove.dataset.i = String(i);
    remove.textContent = "x";
    span.appendChild(remove);
    container.appendChild(span);
  });
  if (serviceKeywords.length === 0) {
    statusEl.className = "kw-status kw-status--idle";
    statusEl.textContent = "No keywords set";
  } else {
    statusEl.className = "kw-status kw-status--match";
    statusEl.textContent = `Auto-trigger active - ${serviceKeywords.length} keyword${serviceKeywords.length > 1 ? "s" : ""}`;
  }
}

async function saveKeywords() {
  await chrome.storage.local.set({ [KW_STORAGE_KEY]: serviceKeywords });
}

async function loadKeywords() {
  const stored = await chrome.storage.local.get([KW_STORAGE_KEY]);
  serviceKeywords = stored[KW_STORAGE_KEY] || [];
  renderKeywordTags();
}

function addKeyword(value) {
  const kw = value.trim().toLowerCase();
  if (!kw || serviceKeywords.includes(kw)) return;
  serviceKeywords.push(kw);
  renderKeywordTags();
  saveKeywords();
}

function removeKeyword(index) {
  serviceKeywords.splice(index, 1);
  renderKeywordTags();
  saveKeywords();
}

function toRootKey(url) {
  try {
    return toRootUrl(url).toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

function checkAndAutoTriggerEmployee(result) {
  if (result?.employeeAnalysisComplete) return;
  const rootKey = toRootKey(result?.url || latestResult?.url);

  if (employeeAnalysisInFlight && rootKey && employeeAnalysisInFlightRoot === rootKey) {
    return;
  }
  if (!serviceKeywords.length || !result?.services?.length) return;

  const services = result.services.map(s => s.toLowerCase());
  const matched = serviceKeywords.find(kw =>
    services.some(svc => svc.includes(kw))
  );
  if (!matched) return;

  // NEW: Clear any pending triggers so they don't stack up and crash the API!
  if (autoTriggerTimeout) {
    clearTimeout(autoTriggerTimeout);
  }

  const statusEl = document.getElementById("kwStatus");
  if (statusEl) {
    statusEl.className = "kw-status kw-status--triggered";
    statusEl.textContent = `Matched "${matched}" - running employee analysis...`;
  }

  // Queue the single execution
  autoTriggerTimeout = setTimeout(() => {
    autoTriggerTimeout = null; // Reset the tracker
    if (latestResult?.url) {
      analyzeEmployeeDetailsForUrl(latestResult.url).catch(err => {
        setStatus(err.message || "Auto employee analysis failed.", true);
      });
    }
  }, 1000);
}

// Render result

function renderResult(result) {
  latestResult = result;
  renderClassificationStrip(result);
  if (!result) {
    elements.result.classList.add("hidden");
    elements.emptyState.classList.remove("hidden");
    elements.peopleCount.textContent = "0";
    elements.pageCount.textContent = "0";
    window.BTDDashboardUI?.updateTabBadges();
    setEmployeeButtonState();
    return;
  }

  elements.emptyState.classList.add("hidden");
  elements.result.classList.remove("hidden");
  if (elements.businessType) elements.businessType.textContent = result.businessType || "Unknown";
  const confidence = typeof result.confidence === "number" ? `${Math.round(result.confidence * 100)}%` : "n/a";
  if (elements.confidence) elements.confidence.textContent = `Confidence: ${confidence}`;
  elements.summary.textContent = result.summary || "";
  if (elements.industry) elements.industry.textContent = result.industry || "";
  elements.peopleCount.textContent = String(normalizePeople(result.people).length);
  elements.pageCount.textContent = String(result.researchedPageCount || 0);
  elements.websiteSignals.textContent = result.websiteSignals || "";
  fillList(elements.services, result.services);
  renderPeople(elements.people, result.people);
  renderEmployeeExtras(elements.people.parentElement, result, { headingTag: "h4", showChunks: false });
  if (elements.peopleGrid) {
    const people = normalizePeople(result.people);
    const leadership = normalizePeople(result.companyLeadership || []);
    const warnings = result.warnings || result.employeeWarnings || [];
    if (people.length || leadership.length || warnings.length || result.employeeAnalysisComplete) {
      elements.peopleGridPanel.classList.remove("hidden");
      try {
        renderPeopleGrid(elements.peopleGrid, result.people);
      } catch (error) {
        console.warn("People grid render failed", error);
      }
    } else {
      elements.peopleGridPanel.classList.add("hidden");
    }
  }
  elements.teamSummary.textContent = result.teamSummary || "Run Analyze Employee Details to load team information.";
  fillList(elements.evidence, result.evidence);
  elements.raw.textContent = JSON.stringify(result, null, 2);
  window.BTDDashboardUI?.updateTabBadges();
  updateDomainBadge(result.url);
  elements.recentSiteNote.textContent = `Latest site analyzed: ${result.url}`;

  setEmployeeButtonState();
  if (result && !result.employeeAnalysisComplete && !employeeAnalysisInFlight) {
    checkAndAutoTriggerEmployee(result);
  }
}

async function updatePartialResult(patch, options = {}) {
  const persist = options.persist === true;
  const base = latestResult || {};
  const merged = {
    ...base,
    ...patch
  };
  renderResult(merged);
  if (persist) {
    await chrome.storage.local.set({ [LATEST_RESULT_KEY]: merged });
  }
  return merged;
}

async function loadState() {
  // Load cached result but do NOT auto-trigger employee analysis from it
  const stored = await chrome.storage.local.get([LATEST_RESULT_KEY]);
  const cached = stored[LATEST_RESULT_KEY] || null;
  if (cached) {
    latestResult = cached;
    renderResult(cached);
  } else {
    renderResult(null);
  }
  setProgress(0);
  setStage("Idle", "idle");
  setEmployeeButtonState();
}

async function handleLaunchQuery() {
  if (launchQueryHandled) return;
  launchQueryHandled = true;

  const params = new URLSearchParams(window.location.search || "");
  const target = String(params.get("target") || "").trim();
  const autorun = params.get("autorun") === "1";
  const runEmployees = params.get("employees") === "1";
  if (!target) return;

  try {
    const normalizedTarget = toRootUrl(normalizeUrl(target));
    elements.targetUrl.value = normalizedTarget;
    updateDomainBadge(normalizedTarget);
    elements.recentSiteNote.textContent = `Launch target: ${normalizedTarget}`;
    if (!autorun) return;
    await analyzeTargetUrl();
    if (runEmployees && latestResult?.url) {
      await analyzeEmployeeDetailsForUrl(latestResult.url, { source: "popup-launch" });
    }
  } catch (error) {
    setStatus(error.message || "Failed to process launch URL.", true);
  }
}

async function exportCsv() {
  if (!latestResult) {
    setStatus("No analysis available to export.", true);
    return;
  }
  const header = CSV_HEADER.join(",");
  const lines = [header, buildCsvRow(latestResult)];
  downloadFile("business-type-history.csv", `${lines.join("\n")}\n`, "text/csv;charset=utf-8");
  setStatus("CSV exported.");
}

async function copyJson() {
  if (!latestResult) {
    setStatus("No result available yet.", true);
    return;
  }
  await navigator.clipboard.writeText(JSON.stringify(latestResult, null, 2));
  setStatus("JSON copied.");
}


function buildBusinessFallbackUrls(siteUrl, maxPages = 10) {
  const origin = new URL(siteUrl).origin;
  const commonPaths = [
    "/services",
    "/services/",
    "/what-we-do",
    "/what-we-do/",
    "/solutions",
    "/solutions/",
    "/products",
    "/products/",
    "/about",
    "/about/",
    "/about-us",
    "/about-us/",
    "/company",
    "/company/",
    "/our-company",
    "/our-company/",
    "/expertise",
    "/expertise/",
    "/industries",
    "/industries/",
    "/portfolio",
    "/portfolio/",
    "/work",
    "/work/",
    "/projects",
    "/projects/",
    "/contact",
    "/contact/"
  ].map((path) => `${origin}${path}`);
  return [...new Set(commonPaths)].slice(0, maxPages);
}

async function waitForTabComplete(tabId, signal = null) {
  return new Promise((resolve, reject) => {
    let loadingFallbackId = null;
    if (signal?.aborted) {
      reject(new DOMException("Analysis stopped.", "AbortError"));
      return;
    }
    const timeoutId = setTimeout(() => {
      clearTimeout(loadingFallbackId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      signal?.removeEventListener("abort", handleAbort);
      chrome.tabs.get(tabId).then(resolve).catch(() => {
        reject(new Error("The website took too long to load."));
      });
    }, 30000);

    function cleanup() {
      clearTimeout(timeoutId);
      clearTimeout(loadingFallbackId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      signal?.removeEventListener("abort", handleAbort);
    }

    function handleAbort() {
      cleanup();
      reject(new DOMException("Analysis stopped.", "AbortError"));
    }

    function handleUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        cleanup();
        resolve(tab);
      } else if (changeInfo.status === "loading" && tab.url && tab.url !== "about:blank") {
        clearTimeout(loadingFallbackId);
        loadingFallbackId = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(handleUpdated);
          clearTimeout(timeoutId);
          chrome.tabs.get(tabId).then(resolve).catch(reject);
        }, 8000);
      }
    }

    chrome.tabs.onUpdated.addListener(handleUpdated);
    signal?.addEventListener("abort", handleAbort, { once: true });
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        cleanup();
        resolve(tab);
      }
    }).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

async function extractPageDataFromTab(tabId, options = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab.url)) {
    throw new Error("This page cannot be analyzed. Use a regular website URL.");
  }
  let results;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["shared/page-extractor.js"]
    });

    // v10: Support expandTeamPage option for deep extraction
    if (options.expandTeamPage) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          if (globalThis.BTDPageExtractor?.expandTeamPage) {
            await globalThis.BTDPageExtractor.expandTeamPage();
          }
        }
      });
      // Extra settle time after expansion
      await sleep(1500);
    }

    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.BTDPageExtractor?.extractPageData()
    });
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/frame with id 0 is showing error page/i.test(message)) {
      throw new Error("Browser error page");
    }
    throw error;
  }
  const pageData = results?.[0]?.result;
  if (!pageData) {
    throw new Error("Unable to read that page.");
  }
  return pageData;
}

// v10: Discover profile links from a tab
async function discoverProfileLinksFromTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["shared/page-extractor.js"]
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.BTDPageExtractor?.discoverProfileLinks()
    });
    return results?.[0]?.result || [];
  } catch {
    return [];
  }
}

// v10: Calculate coverage score
function calculateCoverageScoreForPeople(people, pageData) {
  if (!globalThis.BTDPageExtractor?.calculateCoverageScore) {
    // Fallback inline implementation
    const hasTeamSection = /[tT]eam|[sS]taff|[pP]eople|[lL]eadership|[aA]gents|[rR]ealtors/.test(pageData.bodyText || "");
    const hasMultipleProfiles = people.length >= 3;
    const hasContactInfo = people.some(p => p.email || p.phone);
    const hasTitles = people.some(p => p.title);
    const hasLinkedin = people.some(p => p.linkedinUrl);

    let rawScore = 0;
    if (hasTeamSection) rawScore += 20;
    else rawScore += 10;
    if (hasMultipleProfiles) rawScore += 25;
    else if (people.length > 0) rawScore += 15;
    if (hasContactInfo) rawScore += 15;
    if (hasTitles) rawScore += 15;
    if (hasLinkedin) rawScore += 10;

    const completeProfiles = people.filter(p => {
      const fields = [p.name, p.title, p.email, p.phone].filter(Boolean);
      return fields.length >= 2;
    }).length;
    const completenessRatio = people.length > 0 ? completeProfiles / people.length : 0;
    rawScore += Math.round(completenessRatio * 15);

    const uniqueSources = new Set(people.map(p => p.sourceUrl)).size;
    rawScore += Math.min(10, uniqueSources * 2);

    return {
      total: Math.min(100, rawScore),
      factors: { hasTeamSection, hasMultipleProfiles, hasContactInfo, hasTitles, hasLinkedin, uniqueSources },
      warnings: [],
      recommendations: []
    };
  }
  return globalThis.BTDPageExtractor.calculateCoverageScore(people, pageData);
}

async function extractHomepageData(tabId) {
  return await extractPageDataFromTab(tabId);
}

async function fetchPageInBackground(url, options = {}) {
  const throttleMs = Math.max(0, Number(options.throttleMs) || 0);
  const settleMs = Math.max(0, Number(options.settleMs ?? CRAWL_TAB_SETTLE_MS) || 0);
  const signal = options.signal || currentRunController?.signal || null;
  let tempTab = null;
  try {
    throwIfStopped();
    if (throttleMs > 0) {
      await sleep(throttleMs);
      throwIfStopped();
    }
    tempTab = await chrome.tabs.create({ url, active: false });
    openedTempTabIds.add(tempTab.id);
    await waitForTabComplete(tempTab.id, signal);
    if (settleMs > 0) {
      await sleep(settleMs);
      throwIfStopped();
    }
    return await extractPageDataFromTab(tempTab.id);
  } catch (error) {
    if (isStoppedError(error)) throw error;
    return null;
  } finally {
    if (tempTab?.id) {
      openedTempTabIds.delete(tempTab.id);
      await chrome.tabs.remove(tempTab.id).catch(() => { });
    }
  }
}

function filterBusinessCandidateUrlsFromHomepage(links, rootOrigin) {
  const ranked = (links || [])
    .map((link) => {
      const href = link?.href || link?.url || "";
      const text = String(link?.text || "").trim();
      const source = link?.source || "body";
      try {
        const parsed = new URL(href);
        if (parsed.origin !== rootOrigin) return null;
        if (!isCrawlableUrl(parsed.toString())) return null;
        const haystack = `${parsed.pathname} ${text}`.toLowerCase();
        if (!BUSINESS_PAGE_KEYWORD_REGEX.test(haystack)) return null;
        return {
          href: toCanonicalUrl(parsed.toString()),
          score: scoreLink({ href, text, source }, rootOrigin, "business")
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const deduped = [];
  const seen = new Set();
  for (const item of ranked) {
    const key = toCanonicalPageKey(item.href);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item.href);
    if (deduped.length >= MAX_RESEARCH_PAGES) break;
  }

  return deduped;
}

async function crawlSiteFromHomepage(homepage, options = {}) {
  throwIfStopped();
  const maxDepth = options.maxDepth ?? MAX_CRAWL_DEPTH;
  const maxPages = options.maxPages ?? MAX_CRAWL_PAGES;
  const focus = options.focus || "employee";
  const expandFromDiscovered = options.expandFromDiscovered ?? true;
  const includeHomepage = options.includeHomepage ?? true;
  const rootOrigin = new URL(homepage.url).origin;
  logDebug("Crawl start", { rootOrigin, maxDepth, maxPages, focus, homepage: homepage.url, expandFromDiscovered, includeHomepage });
  const pages = includeHomepage ? [homepage] : [];
  const visited = includeHomepage ? new Set([toCanonicalPageKey(homepage.url)]) : new Set();
  const queued = new Set();
  const queue = [];

  const seedUrls = [
    ...(options.seedUrls || []),
    ...gatherInternalLinks(homepage, rootOrigin, focus)
  ];

  for (const url of seedUrls) {
    if (!isCrawlableUrl(url)) continue;
    let pageKey;
    try {
      const parsed = new URL(url);
      if (parsed.origin !== rootOrigin) continue;
      pageKey = toCanonicalPageKey(parsed.toString());
    } catch {
      continue;
    }
    if (visited.has(pageKey) || queued.has(pageKey)) continue;
    queued.add(pageKey);
    queue.push({ url: toCanonicalUrl(url), depth: 1 });
  }

  while (queue.length && pages.length < maxPages) {
    throwIfStopped();
    const next = queue.shift();
    if (!next || next.depth > maxDepth) continue;

    if (typeof options.onProgress === "function") {
      options.onProgress({ visited: pages.length, queued: queue.length, depth: next.depth, url: next.url });
    }
    logDebug("Crawl visiting", { depth: next.depth, url: next.url, visited: pages.length, queued: queue.length });

    const crawlDelayMs = getCrawlDelayMs();
    const page = await fetchPageInBackground(next.url, { throttleMs: crawlDelayMs, signal: currentRunController?.signal });
    throwIfStopped();
    if (!page || !isSupportedUrl(page.url)) continue;

    let canonicalPageUrl;
    let pageKey;
    try {
      const parsed = new URL(page.url);
      if (parsed.origin !== rootOrigin || !isCrawlableUrl(parsed.toString())) continue;
      canonicalPageUrl = toCanonicalUrl(parsed.toString());
      pageKey = toCanonicalPageKey(parsed.toString());
    } catch {
      continue;
    }

    if (visited.has(pageKey)) continue;
    visited.add(pageKey);
    pages.push(page);
    if (typeof options.onPage === "function") {
      try {
        await options.onPage(page, { depth: next.depth, visited: pages.length, queued: queue.length, url: next.url });
      } catch (error) {
        logDebug("onPage callback failed", error);
      }
    }

    if (!expandFromDiscovered) continue;
    if (next.depth >= maxDepth || pages.length >= maxPages) continue;

    const nextLinks = gatherInternalLinks(page, rootOrigin, focus);
    for (const link of nextLinks) {
      if (pages.length + queue.length >= maxPages * 2) break;
      let pageKey;
      try {
        const parsed = new URL(link);
        if (parsed.origin !== rootOrigin) continue;
        pageKey = toCanonicalPageKey(parsed.toString());
      } catch {
        continue;
      }
      if (visited.has(pageKey) || queued.has(pageKey)) continue;
      queued.add(pageKey);
      queue.push({ url: toCanonicalUrl(link), depth: next.depth + 1 });
    }
  }

  logDebug("Crawl complete", { pages: pages.length });
  return pages;
}

async function analyzeTab(tabId, preferredUrl = "") {
  if (siteAnalysisInFlight) {
    logDebug("Analyze tab skipped: analysis already running", { tabId });
    return;
  }
  siteAnalysisInFlight = true;
  const previousResult = latestResult ? { ...latestResult } : null;
  try {
    throwIfStopped();
    logDebug("Analyze tab start", { tabId });
    setStage("Loading", "busy");
    setStatus("Reading homepage links...");
    setProgress(20);
    let currentPage;
    try {
      currentPage = await extractHomepageData(tabId);
    } catch (error) {
      const message = String(error?.message || "");
      if (!/browser error page|error page/i.test(message)) {
        throw error;
      }
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const fallbackSeedUrl = preferredUrl || tab?.pendingUrl || tab?.url || "";
      if (!isSupportedUrl(fallbackSeedUrl)) {
        throw new Error("This tab is on a browser error page. Open a working website URL and try again.");
      }
      const fallbackRoot = toRootUrl(fallbackSeedUrl);
      setStatus("Detected browser error page. Retrying with background fetch...");
      currentPage = await fetchPageInBackground(fallbackRoot, { signal: currentRunController?.signal });
      if (!currentPage) {
        throw new Error(`Could not load ${fallbackRoot}. The website may be down or blocked.`);
      }
    }
    const rootUrl = toRootUrl(currentPage.url);
    const homepage = toCanonicalUrl(currentPage.url) === toCanonicalUrl(rootUrl)
      ? currentPage
      : (await fetchPageInBackground(rootUrl, { signal: currentRunController?.signal })) || currentPage;
    throwIfStopped();

    await updatePartialResult({
      analyzedAt: new Date().toISOString(),
      title: homepage.title || "",
      url: homepage.url,
      summary: "Homepage loaded. Gathering related business pages...",
      industry: "",
      businessType: "",
      confidence: null,
      services: [],
      evidence: [],
      websiteSignals: "",
      researchedPageCount: 1,
      cachedLinkList: (homepage.links || []).slice(0, 200).map((link) => ({
        text: link.text || "",
        url: link.href || ""
      })),
      employeeAnalysisComplete: false
    });

    const origin = new URL(homepage.url).origin;
    const homepageLinks = (homepage.links || [])
      .filter(l => {
        try {
          return new URL(l.href).origin === origin && isCrawlableUrl(l.href);
        } catch {
          return false;
        }
      })
      .slice(0, 400)
      .map(l => ({ text: l.text?.slice(0, 80), href: l.href, source: l.source || "body" }));
    logDebug("Homepage link candidates", { count: homepageLinks.length, homepage: homepage.url });

    setStatus("Filtering homepage links for business-related pages...");
    setStage("Crawling", "busy");
    setProgress(40);
    const businessCandidateUrls = filterBusinessCandidateUrlsFromHomepage(homepageLinks, origin)
      .filter((u) => toCanonicalUrl(u) !== toCanonicalUrl(homepage.url));

    const serviceRegex = /(\/services|\/solutions|\/what-we-do|\/capabilities|\/offerings|\/products)/i;
    const aboutRegex = /(\/about|\/company|\/about-us|\/our-story|\/who-we-are|\/overview)/i;

    const bestServiceUrl = businessCandidateUrls.find(url => serviceRegex.test(url));
    const bestAboutUrl = businessCandidateUrls.find(url => aboutRegex.test(url));

    let pickedUrls = [bestServiceUrl, bestAboutUrl].filter(Boolean);

    if (!pickedUrls.length) {
      pickedUrls = [`${origin}/services`, `${origin}/about`];
      logDebug("Business fallback URLs used", { count: pickedUrls.length, homepage: homepage.url });
    }
    const crawlCount = pickedUrls.length;
    logDebug("Business page filter result", {
      homepageLinks: homepageLinks.length,
      candidates: businessCandidateUrls.length,
      crawlCount
    });

    setStatus(`Fetching ${pickedUrls.length} related page(s)...`);
    setStage("Crawling", "busy");
    setProgress(60);

    const extraPages = [];
    for (let index = 0; index < pickedUrls.length; index++) {
      throwIfStopped();
      const pageUrl = pickedUrls[index];
      const crawlDelayMs = getCrawlDelayMs();
      setStatus(`Fetching related page ${index + 1}/${pickedUrls.length}...`);
      logDebug("Business crawl fetch", { index: index + 1, total: pickedUrls.length, url: pageUrl, delayMs: crawlDelayMs });
      const page = await fetchPageInBackground(pageUrl, { throttleMs: crawlDelayMs, signal: currentRunController?.signal });
      if (page) {
        extraPages.push(page);
      }
    }
    throwIfStopped();
    const allPages = [homepage, ...extraPages.filter(Boolean)];
    logDebug("Fetched business pages", { requested: pickedUrls.length, fetched: allPages.length });
    const allPeople = dedupePeople(allPages.flatMap(p => p.people || [])).slice(0, 25);
    const allTeamSnippets = [...new Set(allPages.flatMap(p => p.teamSnippets || []))].slice(0, 8);
    const preservePreviousPeople = previousResult?.url === homepage.url && !!previousResult?.employeeAnalysisComplete;

    await updatePartialResult({
      analyzedAt: new Date().toISOString(),
      title: homepage.title || "",
      url: homepage.url,
      researchedPageCount: allPages.length,
      summary: `Fetched ${allPages.length} page(s). Running business classification...`,
      people: preservePreviousPeople ? (previousResult?.people || []) : [],
      cachedLinkList: homepageLinks.map((link) => ({ text: link.text, url: link.href }))
    });

    const researchPayload = {
      title: homepage.title,
      url: homepage.url,
      description: homepage.description,
      headings: (homepage.headings || []).slice(0, 8),
      metadata: Object.fromEntries(Object.entries(homepage.metadata || {}).slice(0, 8)),
      bodyText: (homepage.bodyText || "").slice(0, MAX_SUMMARY_BODY_CHARS),
      people: normalizePeople(allPeople).slice(0, 8),
      structuredData: compactStructuredData(homepage.structuredData),
      extractedEmails: homepage.extractedEmails || [],
      extractedPhones: homepage.extractedPhones || [],
      extractionStats: homepage.extractionStats || null,
      teamSnippets: allTeamSnippets.slice(0, 4).map(s => trimText(s, 240)),
      discoveredPages: allPages.map(p => ({
        title: p.title,
        url: p.url,
        headings: (p.headings || []).slice(0, 6),
        bodyText: trimText(p.bodyText, MAX_PAGE_BODY_CHARS),
        people: normalizePeople(p.people || []).slice(0, 6),
        structuredData: compactStructuredData(p.structuredData),
        extractedEmails: p.extractedEmails || [],
        extractedPhones: p.extractedPhones || [],
        extractionStats: p.extractionStats || null
      }))
    };

    setStatus("Classifying business type and services...");
    setStage("AI extracting", "busy");
    setProgress(80);

    const response = await sendAnalysisMessage({
      type: "analyze-page",
      pageData: researchPayload
    }, "business");

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown analysis error.");
    }
    throwIfStopped();
    logDebug("Business analysis done", { modelUsed: response?.result?.modelUsed, services: response?.result?.services?.length || 0 });

    const result = {
      ...response.result,
      analyzedAt: new Date().toISOString(),
      title: homepage.title,
      url: homepage.url,
      researchedPageCount: allPages.length,
      cachedLinkList: homepageLinks.map((link) => ({ text: link.text, url: link.href })),
      people: preservePreviousPeople ? (previousResult?.people || []) : [],
      teamSummary: preservePreviousPeople ? (previousResult?.teamSummary || "") : "",
      companyLeadership: preservePreviousPeople ? (previousResult?.companyLeadership || []) : [],
      warnings: preservePreviousPeople ? (previousResult?.warnings || previousResult?.employeeWarnings || []) : [],
      employeeAnalysisComplete: preservePreviousPeople
    };

    await updatePartialResult(result, { persist: true });
    setProgress(100);
    const providerUsed = result.providerUsed || elements.provider.value;
    const modelUsed = result.modelUsed || "unknown-model";
    setStage("Complete", "success");
    setStatus(`Analysis complete (${providerUsed} / ${modelUsed}).`);
  } finally {
    siteAnalysisInFlight = false;
  }
}

async function analyzeCurrentTab() {
  if (siteAnalysisInFlight) {
    logDebug("analyzeCurrentTab skipped: analysis already running");
    return;
  }
  beginAnalysisRun();
  renderResult(null);
  try {
    throwIfStopped();
    setStage("Loading", "busy");
    await saveSettings();
    setProgress(10);
    setStatus("Finding a website tab...");
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const websiteTabs = tabs.filter((tab) => isSupportedUrl(tab.url));
    const targetTab = websiteTabs.find((tab) => tab.active)
      || websiteTabs
        .slice()
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (!targetTab?.id) {
      throw new Error("No regular website tab found in this window.");
    }
    updateDomainBadge(targetTab.url);
    elements.recentSiteNote.textContent = `Using recent tab: ${targetTab.url}`;
    await analyzeTab(targetTab.id, targetTab.url);
  } catch (error) {
    setProgress(0);
    if (isStoppedError(error)) {
      setStage("Idle", "idle");
      setStatus("Analysis stopped.");
    } else {
      setStage("Error", "error");
      setStatus(friendlyErrorMessage(error), true);
    }
  } finally {
    endAnalysisRun();
  }
}

async function analyzeTargetUrl() {
  if (siteAnalysisInFlight) {
    logDebug("analyzeTargetUrl skipped: analysis already running");
    return;
  }
  beginAnalysisRun();
  renderResult(null);
  let openedTabId = null;
  try {
    setStage("Loading", "busy");
    await saveSettings();
    const url = toRootUrl(normalizeUrl(elements.targetUrl.value));
    updateDomainBadge(url);
    elements.recentSiteNote.textContent = `Root URL selected: ${url}`;
    setProgress(10);
    setStatus("Opening website...");
    const tab = await chrome.tabs.create({ url, active: false });
    openedTabId = tab.id;
    openedTempTabIds.add(tab.id);
    await waitForTabComplete(tab.id, currentRunController?.signal);
    openedTempTabIds.delete(tab.id);
    await analyzeTab(tab.id, url);
    if (openedTabId) {
      await chrome.tabs.remove(openedTabId).catch(() => { });
      openedTabId = null;
    }
  } catch (error) {
    setProgress(0);
    if (isStoppedError(error)) {
      setStage("Idle", "idle");
      setStatus("Analysis stopped.");
    } else {
      setStage("Error", "error");
      setStatus(friendlyErrorMessage(error), true);
    }
  } finally {
    if (openedTabId) {
      openedTempTabIds.delete(openedTabId);
      await chrome.tabs.remove(openedTabId).catch(() => { });
    }
    endAnalysisRun();
  }
}

async function analyzeEmployeeDetailsForUrl(url) {
  if (!url) return;
  if (employeeAnalysisInFlight) {
    logDebug("Employee analysis already in flight, skipping double trigger.");
    return;
  }

  // LOCK THE PIPELINE
  employeeAnalysisInFlight = true;
  employeeAnalysisInFlightRoot = toRootKey(url);

  beginAnalysisRun();
  setStage("Initializing", "busy");
  setProgress(10);
  setStatus("Preparing employee analysis...");
  elements.result.classList.add("hidden");

  try {
    throwIfStopped();
    await saveSettings();
    const homepage = await fetchPageInBackground(url, { signal: currentRunController?.signal });
    if (!homepage) throw new Error("Could not load the target website.");

    setProgress(30);
    setStage("Crawling", "busy");
    setStatus("Finding team and employee pages...");

    const {
      homepageLinks,
      directTeamLinks,
      seedUrls,
      dynamicDepth,
      dynamicMaxPages,
      status: discoveryStatus
    } = buildTeamDiscoveryPlan(homepage, { maxCrawlPages: MAX_CRAWL_PAGES });
    setStatus(discoveryStatus);

    logDebug("Dynamic Crawl Limits Calculated", {
      totalLinks: homepageLinks.length,
      directTeamLinks: directTeamLinks.length,
      dynamicDepth,
      dynamicMaxPages
    });
    const analysisPromises = [];
    const discoveredPages = [];
    const chunkResults = [];
    const chunkWarnings = [];
    const chunkEvidence = new Set();
    let pendingQueue = [];
    let activeWorkers = 0;
    let scheduledChunks = 0;
    let completedChunks = 0;
    const MAX_CHUNK_CONCURRENCY = 2;

    const recomputeAndPersistProgress = async (isFinal = false) => {
      const crawledPeople = normalizePeople(dedupePeople([homepage, ...discoveredPages].flatMap((p) => p.people || [])));
      const aiPeople = normalizePeople(dedupePeople(chunkResults.flatMap((item) => item.people || [])));
      const mergedPeople = normalizePeople(dedupePeople([...aiPeople, ...crawledPeople]));
      const leadership = normalizePeople(dedupePeople(chunkResults.flatMap((item) => item.companyLeadership || [])));
      const teamSummary = buildConciseTeamSummary(chunkResults, mergedPeople);
      const warnings = [...new Set([...(latestResult?.warnings || []), ...chunkWarnings])];
      const coverageScore = calculateCoverageScoreForPeople(
        crawledPeople,
        { bodyText: [homepage.bodyText || "", ...discoveredPages.map((p) => p.bodyText || "")].join(" ") }
      );

      await updatePartialResult({
        analyzedAt: new Date().toISOString(),
        title: homepage.title || latestResult?.title || "",
        url: homepage.url || latestResult?.url || "",
        people: mergedPeople,
        companyLeadership: leadership,
        teamSummary,
        employeeChunks: chunkResults.map((item, index) => ({
          index: item.index || index + 1,
          total: item.total || Math.max(1, scheduledChunks),
          pages: item.pages || [],
          people: item.people || [],
          companyLeadership: item.companyLeadership || [],
          warnings: item.warnings || [],
          teamSummary: item.teamSummary || "",
          providerUsed: item.providerUsed || "",
          modelUsed: item.modelUsed || "",
          promptTierUsed: item.promptTierUsed || "",
          error: item.error || ""
        })),
        warnings,
        evidence: [...new Set([...(latestResult?.evidence || []), ...chunkEvidence])],
        coverage: {
          pagesCrawled: discoveredPages.length + 1,
          employeesFound: mergedPeople.length,
          score: coverageScore.total
        },
        employeeAnalysisComplete: isFinal
      }, { persist: true });
    };

    const processChunkQueue = async () => {
      if (isStopRequested()) return;
      if (activeWorkers >= MAX_CHUNK_CONCURRENCY || pendingQueue.length === 0) return;
      const task = pendingQueue.shift();
      if (!task) return;
      activeWorkers += 1;

      const run = (async () => {
        throwIfStopped();
        const page = task.page;
        const chunkMeta = {
          index: task.index,
          total: Math.max(task.index, dynamicMaxPages),
          pages: [{ title: page.title || "", url: page.url || "" }]
        };
        const payload = {
          ...homepage,
          discoveredPages: [page]
        };

        const response = await sendAnalysisMessage({
          type: "analyze-employee-page-chunk",
          pageData: compactResearchPayload(payload, {
            isEmployee: true,
            maxPages: 3,
            employeeBodyChars: MAX_EMPLOYEE_PAGE_BODY_CHARS,
            summaryBodyChars: MAX_SUMMARY_BODY_CHARS,
            cleanBodyText: true
          }),
          chunkMeta
        }, "employee-chunk");

        if (!response?.ok) {
          throw new Error(response?.error || `Chunk ${task.index} failed`);
        }

        const result = response.result || {};
        chunkResults.push({
          index: task.index,
          total: Math.max(task.index, dynamicMaxPages),
          pages: [{ title: page.title || "", url: page.url || "" }],
          people: normalizePeople(result.people || []),
          companyLeadership: normalizePeople(result.companyLeadership || []),
          warnings: result.warnings || [],
          teamSummary: result.teamSummary || "",
          providerUsed: result.providerUsed || "",
          modelUsed: result.modelUsed || "",
          promptTierUsed: result.promptTierUsed || ""
        });
        for (const warning of (result.warnings || [])) chunkWarnings.push(warning);
        for (const item of (result.evidence || [])) chunkEvidence.add(item);
      })()
        .catch((error) => {
          if (isStoppedError(error)) return;
          chunkWarnings.push(`Chunk ${task.index} failed: ${error.message || error}`);
          chunkResults.push({
            index: task.index,
            total: Math.max(task.index, dynamicMaxPages),
            pages: [{ title: task.page?.title || "", url: task.page?.url || "" }],
            people: [],
            companyLeadership: [],
            warnings: [`Chunk ${task.index} failed: ${error.message || error}`],
            teamSummary: "",
            providerUsed: "",
            modelUsed: "",
            promptTierUsed: "",
            error: error.message || String(error)
          });
        })
        .finally(async () => {
          if (isStopRequested()) return;
          completedChunks += 1;
          activeWorkers -= 1;
          const crawlProgress = Math.min(65, 20 + Math.round((discoveredPages.length / Math.max(1, dynamicMaxPages)) * 45));
          const aiProgress = Math.min(30, Math.round((completedChunks / Math.max(1, scheduledChunks || 1)) * 30));
          setProgress(Math.min(95, crawlProgress + aiProgress));
          setStage("Analyzing", "busy");
          const crawledCount = discoveredPages.length + 1; // include homepage
          setStatus(`Streaming employee extraction: crawled ${crawledCount} page(s), analyzed ${completedChunks}/${Math.max(1, scheduledChunks)} queued page(s)...`);
          await recomputeAndPersistProgress(false);
          while (activeWorkers < MAX_CHUNK_CONCURRENCY && pendingQueue.length > 0) {
            await processChunkQueue();
          }
        });

      analysisPromises.push(run);
    };

    const enqueueChunk = async (page) => {
      throwIfStopped();
      scheduledChunks += 1;
      pendingQueue.push({ page, index: scheduledChunks });
      while (activeWorkers < MAX_CHUNK_CONCURRENCY && pendingQueue.length > 0) {
        await processChunkQueue();
      }
    };

    // Analyze homepage immediately so user sees first results quickly.
    await enqueueChunk(homepage);

    // --- SMART BFS CRAWL + streaming chunk analysis ---
    await crawlSiteFromHomepage(homepage, {
      focus: "employee",
      maxDepth: dynamicDepth,
      maxPages: dynamicMaxPages,
      seedUrls,
      includeHomepage: false,
      expandFromDiscovered: true,
      onProgress: ({ visited, depth }) => {
        setStage("Crawling", "busy");
        setStatus(`Crawling depth ${depth} (${visited}/${dynamicMaxPages} max pages) while extracting...`);
      },
      onPage: async (page) => {
        if (!page) return;

        console.log("CRAWLED PAGE:", page.url);
        console.log("PAGE PEOPLE:", page.people);
        console.log("EXTRACTION STATS:", page.extractionStats);

        discoveredPages.push(page);
        await enqueueChunk(page);
      }
    });

    await Promise.all(analysisPromises);
    throwIfStopped();
    await recomputeAndPersistProgress(true);

    setStatus("Employee analysis complete.");
    setStage("Complete", "success");
    setProgress(100);

  } catch (error) {
    if (isStoppedError(error)) {
      setStatus("Analysis stopped.");
      setStage("Idle", "idle");
      setProgress(0);
    } else {
      setStatus(error.message || "Employee analysis failed.", true);
      setStage("Error", "error");
    }
  } finally {
    endAnalysisRun();

    // UNLOCK THE PIPELINE
    employeeAnalysisInFlight = false;
    employeeAnalysisInFlightRoot = "";
  }
}

// Event listeners

elements.saveSettings.addEventListener("click", () => {
  saveSettings().catch((error) => setStatus(error.message || "Save failed.", true));
});
elements.analyzeUrl.addEventListener("click", () => {
  analyzeTargetUrl().catch((error) => setStatus(error.message || "Analysis failed.", true));
});
elements.analyzeCurrent.addEventListener("click", () => {
  analyzeCurrentTab().catch((error) => setStatus(error.message || "Analysis failed.", true));
});
elements.analyzeEmployees.addEventListener("click", () => {
  if (!latestResult?.url) {
    setStatus("Analyze a website first.", true);
    return;
  }
  analyzeEmployeeDetailsForUrl(latestResult.url).catch((error) => {
    setStatus(error.message || "Employee analysis failed.", true);
  });
});
elements.stopAnalysis?.addEventListener("click", () => {
  stopCurrentAnalysis().catch((error) => setStatus(error.message || "Stop failed.", true));
});
elements.copyJson.addEventListener("click", () => {
  copyJson().catch((error) => setStatus(error.message || "Copy failed.", true));
});
elements.exportCsv.addEventListener("click", () => {
  exportCsv().catch((error) => setStatus(error.message || "Export failed.", true));
});
elements.targetUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    analyzeTargetUrl().catch((error) => setStatus(error.message || "Analysis failed.", true));
  }
});
elements.targetUrl.addEventListener("input", () => {
  updateDomainBadge(elements.targetUrl.value.trim());
});
elements.provider.addEventListener("change", () => {
  updateProviderFields(elements.provider.value);
});

document.getElementById("kwAdd").addEventListener("click", () => {
  const input = document.getElementById("kwInput");
  addKeyword(input.value);
  input.value = "";
});
document.getElementById("kwInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const input = document.getElementById("kwInput");
    addKeyword(input.value);
    input.value = "";
  }
});
document.getElementById("kwTags").addEventListener("click", (e) => {
  const i = e.target.dataset.i;
  if (i !== undefined) removeKeyword(+i);
});

Promise.all([loadSettings(), loadState(), loadKeywords()])
  .then(() => handleLaunchQuery())
  .catch((error) => {
    setStatus(error.message || "Failed to load dashboard.", true);
  });
