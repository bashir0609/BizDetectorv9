import { buildCsvRow, CSV_HEADER, downloadFile } from "./shared/export.js";
import { dedupePeople, normalizePeople } from "./shared/people.js";
import { fillList as fillSharedList, renderEmployeeExtras, renderPeople as renderPeopleList, syncSettingsUI } from "./shared/ui.js";
import { getSettings, saveSettings as saveSettingsStore, getLatestResult as getLatestResultStore, setLatestResult as setLatestResultStore } from "./storage/manager.js";
import { normalizeApiKeysInput, validateApiKey, validateProviderApiKeys } from "./engine/utils.js";

const LATEST_RESULT_KEY = "latestAnalysis";
const KW_STORAGE_KEY = "serviceKeywords";
const MAX_RESEARCH_PAGES = 8;
const MAX_CRAWL_DEPTH = 5;
const MAX_CRAWL_PAGES = 15;
const MAX_PAGE_BODY_CHARS = 700;
const MAX_EMPLOYEE_PAGE_BODY_CHARS = 2400;
const MAX_SUMMARY_BODY_CHARS = 1000;
const CRAWL_BASE_DELAY_MS = 1200;
const CRAWL_JITTER_MS = 900;
const CRAWL_SAFE_MODE_EXTRA_DELAY_MS = 1300;
const CRAWL_TAB_SETTLE_MS = 500;
const NON_HTML_RESOURCE_EXT = /\.(pdf|png|jpe?g|gif|webp|svg|zip|rar|7z|mp4|mp3|wav|avi|mov|m4a|docx?|xlsx?|pptx?)$/i;
const BUSINESS_PAGE_KEYWORD_REGEX = /\b(service|services|solution|solutions|product|products|offering|offerings|what-we-do|capabilit|industry|industries|sector|sectors|about|about-us|company|our-company|overview|expertise|specialt|practice|portfolio|case-stud|work|clients?|markets?)\b/i;
const TEAM_PAGE_KEYWORD_REGEX = /\b(team|our-team|people|staff|leadership|leaders|management|founders?|directors?|executives?|agents?|brokers?|realtors?|advisors?|who-we-are|meet-the-team|directory|professionals|about|about-us|company|office|locations?|contact)\b/i;
const DASH_LOG_PREFIX = "[BTD:Dashboard]";
let debugLogsEnabled = true;

let latestResult = null;
let serviceKeywords = [];
let rateLimitSafeMode = false;
let siteAnalysisInFlight = false;
let employeeAnalysisInFlight = false;
let employeeAnalysisInFlightRoot = "";
let autoTriggerTimeout = null;
const autoEmployeeTriggerAtByRoot = new Map();
const AUTO_EMPLOYEE_TRIGGER_COOLDOWN_MS = 2 * 60 * 1000;
let launchQueryHandled = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
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
  const provider = elements.provider?.value || "groq";

  // 1. Validate active provider key
  if (provider === "groq") {
    const val = validateProviderApiKeys("groq", groqKey);
    if (!val.valid) {
      setStatus(val.error, true);
      return;
    }
  } else if (provider === "gemini") {
    const val = validateProviderApiKeys("gemini", geminiKey);
    if (!val.valid) {
      setStatus(val.error, true);
      return;
    }
  } else if (provider === "ollama") {
    const val = validateProviderApiKeys("ollama", elements.ollamaApiKey?.value);
    if (!val.valid) {
      setStatus(val.error, true);
      return;
    }
  }

  // 2. Optional: Validate other keys if they are provided (prevent typos)
  if (groqKey && provider !== "groq") {
    const val = validateProviderApiKeys("groq", groqKey);
    if (!val.valid) {
      setStatus(`Invalid Groq key: ${val.error}`, true);
      return;
    }
  }
  if (geminiKey && provider !== "gemini") {
    const val = validateProviderApiKeys("gemini", geminiKey);
    if (!val.valid) {
      setStatus(`Invalid Gemini key: ${val.error}`, true);
      return;
    }
  }
  if (elements.ollamaApiKey?.value && provider !== "ollama") {
    const val = validateProviderApiKeys("ollama", elements.ollamaApiKey.value);
    if (!val.valid) {
      setStatus(`Invalid Ollama key: ${val.error}`, true);
      return;
    }
  }

  const providerApiKeys = {
    groq: normalizeApiKeysInput(groqKey),
    gemini: normalizeApiKeysInput(geminiKey),
    ollama: normalizeApiKeysInput(elements.ollamaApiKey?.value)
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

function cleanTextForAi(value, maxChars) {
  const noisePattern = /(cookie|privacy policy|terms of use|accept all|subscribe|newsletter|all rights reserved)/i;
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !noisePattern.test(line));
  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped.join("\n").slice(0, maxChars);
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
    renderEmployeeExtras(target, latestResult || {});
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
  renderEmployeeExtras(target, latestResult || {});
}

function trimText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function compactPageData(page) {
  return {
    title: page.title,
    url: page.url,
    description: trimText(page.description, 160),
    headings: (page.headings || []).slice(0, 6),
    people: normalizePeople(page.people).slice(0, 80),
    structuredData: compactStructuredData(page.structuredData),
    extractedEmails: (page.extractedEmails || []).slice(0, 20),
    extractedPhones: (page.extractedPhones || []).slice(0, 20),
    extractionStats: page.extractionStats || null,
    teamSnippets: (page.teamSnippets || []).slice(0, 8).map((item) => cleanTextForAi(item, 260)),
    bodyText: cleanTextForAi(page.bodyText, MAX_EMPLOYEE_PAGE_BODY_CHARS)
  };
}

function compactStructuredData(data) {
  const source = data || {};
  return {
    organizations: (source.organizations || []).slice(0, 4),
    contacts: (source.contacts || []).slice(0, 6),
    addresses: (source.addresses || []).slice(0, 4),
    socialLinks: (source.socialLinks || []).slice(0, 8)
  };
}

function compactResearchPayload(pageData, isEmployee = false, maxPages = MAX_RESEARCH_PAGES) {
  if (typeof isEmployee === "number") {
    maxPages = isEmployee;
    isEmployee = false;
  }
  const discoveredPages = (pageData.discoveredPages || []).slice(0, maxPages).map(compactPageData);
  return {
    title: pageData.title,
    url: pageData.url,
    description: trimText(pageData.description, 180),
    headings: (pageData.headings || []).slice(0, 8),
    metadata: Object.fromEntries(Object.entries(pageData.metadata || {}).slice(0, 8)),
    bodyText: trimText(pageData.bodyText, isEmployee ? MAX_EMPLOYEE_PAGE_BODY_CHARS : MAX_SUMMARY_BODY_CHARS),
    people: normalizePeople(pageData.people).slice(0, 100),
    structuredData: compactStructuredData(pageData.structuredData),
    extractedEmails: (pageData.extractedEmails || []).slice(0, 30),
    extractedPhones: (pageData.extractedPhones || []).slice(0, 30),
    extractionStats: pageData.extractionStats || null,
    teamSnippets: (pageData.teamSnippets || []).slice(0, 4).map((item) => trimText(item, 120)),
    discoveredPages
  };
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
  if (!result) {
    elements.result.classList.add("hidden");
    elements.emptyState.classList.remove("hidden");
    elements.classificationStrip.classList.add("hidden");
    elements.peopleCount.textContent = "0";
    elements.pageCount.textContent = "0";
    setEmployeeButtonState();
    return;
  }

  elements.emptyState.classList.add("hidden");
  elements.result.classList.remove("hidden");
  elements.businessType.textContent = result.businessType || "Unknown";
  const confidence = typeof result.confidence === "number" ? `${Math.round(result.confidence * 100)}%` : "n/a";
  elements.confidence.textContent = `Confidence: ${confidence}`;
  elements.summary.textContent = result.summary || "";
  elements.industry.textContent = result.industry || "";
  elements.peopleCount.textContent = String(normalizePeople(result.people).length);
  elements.pageCount.textContent = String(result.researchedPageCount || 0);
  elements.websiteSignals.textContent = result.websiteSignals || "";
  fillList(elements.services, result.services);
  renderPeople(elements.people, result.people);
  renderEmployeeExtras(elements.people.parentElement, result, { headingTag: "h4" });
  if (elements.peopleGrid) {
    const people = normalizePeople(result.people);
    const leadership = normalizePeople(result.companyLeadership || []);
    const warnings = result.warnings || result.employeeWarnings || [];
    if (people.length || leadership.length || warnings.length || result.employeeAnalysisComplete) {
      elements.peopleGridPanel.classList.remove("hidden");
      renderPeopleGrid(elements.peopleGrid, result.people);
    } else {
      elements.peopleGridPanel.classList.add("hidden");
    }
  }
  elements.teamSummary.textContent = result.teamSummary || "Run Analyze Employee Details to load team information.";
  fillList(elements.evidence, result.evidence);
  elements.raw.textContent = JSON.stringify(result, null, 2);
  updateDomainBadge(result.url);
  elements.recentSiteNote.textContent = `Latest site analyzed: ${result.url}`;

  elements.csBusinessType.textContent = result.businessType || "Unknown";
  elements.csIndustry.textContent = result.industry || "-";
  elements.csServices.replaceChildren();

  const services = result.services && result.services.length ? result.services : [];
  if (services.length) {
    for (const svc of services) {
      const tag = document.createElement("span");
      tag.className = "cs-service-tag";
      tag.textContent = svc;
      elements.csServices.appendChild(tag);
    }
  } else {
    // NEW: Show a clear empty state in the Summary tab instead of a dash
    const emptyTag = document.createElement("span");
    emptyTag.className = "placeholder-text";
    emptyTag.textContent = "No specific services detected.";
    elements.csServices.appendChild(emptyTag);
  }
  if (typeof result.confidence === "number") {
    elements.csConfidence.textContent = `${Math.round(result.confidence * 100)}% confidence`;
    elements.csConfidenceWrap.classList.remove("hidden");
  } else {
    elements.csConfidenceWrap.classList.add("hidden");
  }
  elements.classificationStrip.classList.remove("hidden");

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


function getSiteRoot(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}/`;
}

function scoreLink(link, origin, focus = "business") {
  try {
    const parsed = new URL(link.href);
    if (parsed.origin !== origin) return -1;
    let score = 0;

    // The haystack combines the visible link text and the URL path
    const haystack = `${link.text} ${parsed.pathname}`.toLowerCase();

    if (link.source === "nav") score += 6;
    if (link.source === "footer") score += 4;
    if (link.source === "sitemap") score += 5;
    if (link.source === "profile") score += 8;

    if (focus === "employee") {
      // 1. High Value: Explicit team/agent keywords anywhere in the text or URL
      const isHighValue = /\b(team|people|staff|crew|leadership|leaders|management|founders?|directors?|executives?|board|advisors?|partners?|agents?|brokers?|realtors?|professionals|attorneys|lawyers|doctors|therapists)\b/i.test(haystack) || /(ourteam|meettheteam|ourpeople|whoweare)/i.test(haystack);

      // 2. Medium Value: General company information pages
      const isAbout = /\b(about|about-?us|company|our-?story|overview|who-?we-?are)\b/i.test(haystack);

      // 3. Low Value: Contact pages where agent directories sometimes hide
      const isContact = /\b(contact|locations?|offices?)\b/i.test(haystack);

      // 4. Noise: Places we definitely do not want to crawl for employees
      const isNoise = /\b(blog|news|press|jobs|careers|products|services|pricing|faq|support|category|article)\b/i.test(parsed.pathname);

      if (isHighValue) score += 20;
      else if (isAbout) score += 10;
      else if (isContact) score += 5;

      if (isNoise) score -= 15;

    } else {
      // --- Business Focus Scoring ---
      const isServices = /\b(services?|solutions?|what-?we-?do|capabilities|offerings?|products?|expertise|specialties|practice-?areas)\b/i.test(haystack);
      const isAbout = /\b(about|company|about-?us|our-?story|who-?we-?are|overview)\b/i.test(haystack);
      const isPortfolio = /\b(industries|clients|portfolio|case-?studies|projects|results|work)\b/i.test(haystack);
      const isNoise = /\b(blog|news|press|jobs|careers|faq|support|help|team|people|staff|agents)\b/i.test(parsed.pathname);

      if (isServices) score += 20;
      else if (isAbout) score += 12;
      else if (isPortfolio) score += 8;

      if (isNoise) score -= 10;
    }

    if (parsed.pathname === "/" || parsed.pathname === "") score += (focus === "employee" ? 1 : 6);
    if (parsed.hash) score -= 3;

    return score;
  } catch {
    return -1;
  }
}

function buildCandidateUrls(pageData, maxPages = MAX_RESEARCH_PAGES, focus = "business") {
  const origin = new URL(pageData.url).origin;
  const rankedLinks = (pageData.links || [])
    .map((link) => ({ ...link, score: scoreLink(link, origin, focus) }))
    .filter((link) => link.score > 0)
    .sort((a, b) => b.score - a.score);
  const seedUrls = focus === "employee" ? [pageData.url] : [pageData.url, getSiteRoot(pageData.url)];
  const urls = [...seedUrls];
  for (const link of rankedLinks) {
    if (!urls.includes(link.href)) urls.push(link.href);
    if (urls.length >= maxPages + 2) break;
  }
  return [...new Set(urls)].slice(0, maxPages);
}

function buildEmployeeFallbackUrls(siteUrl, links = [], maxPages = 14) {
  const origin = new URL(siteUrl).origin;
  const normalizedLinks = (links || [])
    .map((link) => ({
      text: link.text || "",
      href: link.href || link.url || "",
      source: link.source || "cached"
    }))
    .filter((link) => {
      try {
        return link.href && new URL(link.href).origin === origin;
      } catch {
        return false;
      }
    });

  const rankedLinks = normalizedLinks
    .map((link) => ({ ...link, score: scoreLink(link, origin, "employee") }))
    .filter((link) => link.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((link) => link.href);

  const commonPaths = [
    "/agents",
    "/agents/",
    "/agent",
    "/agent/",
    "/consultants",
    "/consultants/",
    "/meet-our-team",
    "/meet-our-team/",
    "/meet-the-team",
    "/meet-the-team/",
    "/our-team",
    "/our-team/",
    "/team",
    "/team/",
    "/people",
    "/staff",
    "/team-members",
    "/about/meet-the-team",
    "/about/meet-the-team/",
    "/about/our-team",
    "/about/our-team/",
    "/about/team",
    "/about/team/",
    "/about",
    "/about-us",
    "/about-us/our-team",
    "/about-us/team",
    "/contact"
  ].map((path) => `${origin}${path}`);

  return [...new Set([...commonPaths, ...rankedLinks])].slice(0, maxPages);
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

async function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let loadingFallbackId = null;
    const timeoutId = setTimeout(() => {
      clearTimeout(loadingFallbackId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      chrome.tabs.get(tabId).then(resolve).catch(() => {
        reject(new Error("The website took too long to load."));
      });
    }, 30000);

    function cleanup() {
      clearTimeout(timeoutId);
      clearTimeout(loadingFallbackId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
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

async function extractPageDataFromTab(tabId) {
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

async function extractHomepageData(tabId) {
  return await extractPageDataFromTab(tabId);
}

async function fetchPageInBackground(url, options = {}) {
  const throttleMs = Math.max(0, Number(options.throttleMs) || 0);
  const settleMs = Math.max(0, Number(options.settleMs ?? CRAWL_TAB_SETTLE_MS) || 0);
  let tempTab = null;
  try {
    if (throttleMs > 0) {
      await sleep(throttleMs);
    }
    tempTab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tempTab.id);
    if (settleMs > 0) {
      await sleep(settleMs);
    }
    return await extractPageDataFromTab(tempTab.id);
  } catch {
    return null;
  } finally {
    if (tempTab?.id) await chrome.tabs.remove(tempTab.id).catch(() => { });
  }
}

function gatherInternalLinks(pageData, rootOrigin, focus = "employee") {
  const ranked = (pageData?.links || [])
    .map((link) => {
      const href = link?.href || link?.url || "";
      const text = String(link?.text || "").trim();

      // STRICT FILTER: If it's an employee crawl, drop anything that doesn't look like a team page
      if (focus === "employee") {
        try {
          const parsed = new URL(href);
          if (parsed.origin !== rootOrigin) return { href, score: -1 };
          const haystack = `${parsed.pathname} ${text}`.toLowerCase();
          if (!TEAM_PAGE_KEYWORD_REGEX.test(haystack)) {
            return { href, score: -1 }; // Force drop generic links
          }
        } catch {
          return { href, score: -1 };
        }
      }

      return {
        href,
        score: scoreLink({ href, text, source: link?.source || "body" }, rootOrigin, focus)
      };
    })
    .filter((link) => link.score > -1 && isCrawlableUrl(link.href)) // Only follow valid scores
    .sort((a, b) => b.score - a.score)
    .map((link) => link.href);

  return [...new Set(ranked)];
}

function filterTeamCandidateUrlsFromHomepage(links, rootOrigin) {
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
        if (!TEAM_PAGE_KEYWORD_REGEX.test(haystack)) return null;
        return {
          href: toCanonicalUrl(parsed.toString()),
          score: scoreLink({ href, text, source }, rootOrigin, "employee")
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
    if (deduped.length >= MAX_CRAWL_PAGES) break;
  }

  return deduped;
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
    const next = queue.shift();
    if (!next || next.depth > maxDepth) continue;

    if (typeof options.onProgress === "function") {
      options.onProgress({ visited: pages.length, queued: queue.length, depth: next.depth, url: next.url });
    }
    logDebug("Crawl visiting", { depth: next.depth, url: next.url, visited: pages.length, queued: queue.length });

    const crawlDelayMs = getCrawlDelayMs();
    const page = await fetchPageInBackground(next.url, { throttleMs: crawlDelayMs });
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
      currentPage = await fetchPageInBackground(fallbackRoot);
      if (!currentPage) {
        throw new Error(`Could not load ${fallbackRoot}. The website may be down or blocked.`);
      }
    }
    const rootUrl = toRootUrl(currentPage.url);
    const homepage = toCanonicalUrl(currentPage.url) === toCanonicalUrl(rootUrl)
      ? currentPage
      : (await fetchPageInBackground(rootUrl)) || currentPage;

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
      const pageUrl = pickedUrls[index];
      const crawlDelayMs = getCrawlDelayMs();
      setStatus(`Fetching related page ${index + 1}/${pickedUrls.length}...`);
      logDebug("Business crawl fetch", { index: index + 1, total: pickedUrls.length, url: pageUrl, delayMs: crawlDelayMs });
      const page = await fetchPageInBackground(pageUrl, { throttleMs: crawlDelayMs });
      if (page) {
        extraPages.push(page);
      }
    }
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
      teamSnippets: allTeamSnippets.slice(0, 4).map(s => trimText(s, 120)),
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

    const response = await chrome.runtime.sendMessage({
      type: "analyze-page",
      pageData: researchPayload
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown analysis error.");
    }
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
  setBusy(true);
  renderResult(null);
  try {
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
    setStage("Error", "error");
    setStatus(friendlyErrorMessage(error), true);
  } finally {
    setBusy(false);
  }
}

async function analyzeTargetUrl() {
  if (siteAnalysisInFlight) {
    logDebug("analyzeTargetUrl skipped: analysis already running");
    return;
  }
  setBusy(true);
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
    await waitForTabComplete(tab.id);
    await analyzeTab(tab.id, url);
    if (openedTabId) {
      await chrome.tabs.remove(openedTabId).catch(() => { });
      openedTabId = null;
    }
  } catch (error) {
    setProgress(0);
    setStage("Error", "error");
    setStatus(friendlyErrorMessage(error), true);
  } finally {
    if (openedTabId) {
      await chrome.tabs.remove(openedTabId).catch(() => { });
    }
    setBusy(false);
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

  setBusy(true);
  setStage("Initializing", "busy");
  setProgress(10);
  setStatus("Preparing employee analysis...");
  elements.result.classList.add("hidden");

  try {
    await saveSettings();
    const homepage = await fetchPageInBackground(url);
    if (!homepage) throw new Error("Could not load the target website.");

    setProgress(30);
    setStage("Crawling", "busy");
    setStatus("Finding team and employee pages...");

    const seedUrls = [homepage.url];

    // --- ADAPTIVE CRAWL HEURISTICS ---
    const homepageLinks = homepage.links || [];
    const directTeamLinks = homepageLinks.filter(l => {
      const text = String(l.text || "").toLowerCase();
      const href = String(l.href || l.url || "").toLowerCase();
      return TEAM_PAGE_KEYWORD_REGEX.test(text) || TEAM_PAGE_KEYWORD_REGEX.test(href);
    });

    let dynamicDepth;
    let dynamicMaxPages;

    if (homepageLinks.length <= 5) {
      dynamicDepth = 1;
      dynamicMaxPages = Math.max(1, homepageLinks.length);
      setStatus(`Micro-site detected. Starting fast shallow scan...`);
    } else if (directTeamLinks.length > 0) {
      dynamicDepth = 2;
      dynamicMaxPages = Math.min(15, directTeamLinks.length + 3);
      setStatus(`Found direct team links. Starting targeted crawl...`);
    } else if (homepageLinks.length > 80) {
      dynamicDepth = 3;
      dynamicMaxPages = 15;
      setStatus(`Large site structure detected. Starting deep crawl...`);
    } else {
      dynamicDepth = 2;
      dynamicMaxPages = 10;
      setStatus(`Standard site detected. Starting adaptive crawl...`);
    }

    logDebug("Dynamic Crawl Limits Calculated", {
      totalLinks: homepageLinks.length,
      directTeamLinks: directTeamLinks.length,
      dynamicDepth,
      dynamicMaxPages
    });

    // --- SMART BFS CRAWL ---
    const crawledPages = await crawlSiteFromHomepage(homepage, {
      focus: "employee",
      maxDepth: dynamicDepth,
      maxPages: dynamicMaxPages,
      seedUrls,
      includeHomepage: false,
      expandFromDiscovered: true,
      onProgress: ({ visited, depth, queued }) => {
        setStage("Crawling", "busy");
        setStatus(`Crawling depth ${depth} (${visited}/${dynamicMaxPages} max pages)...`);
      }
    });

    const validPages = crawledPages.filter(Boolean).slice(0, dynamicMaxPages);
    logDebug("Employee crawled pages", { count: validPages.length, root: homepage.url });

    setProgress(70);
    setStage("Analyzing", "busy");
    setStatus("Extracting employee details with AI...");

    const pageData = {
      ...homepage,
      discoveredPages: validPages
    };

    const response = await chrome.runtime.sendMessage({
      type: "analyze-employee-details",
      pageData: compactResearchPayload(pageData, true)
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown employee analysis error.");
    }

    const result = {
      ...(latestResult || {}),
      ...(response.result || {}),
      people: normalizePeople((response.result?.people?.length ? response.result.people : pageData.people) || []),
      teamSummary: response.result?.teamSummary || latestResult?.teamSummary || "",
      companyLeadership: response.result?.companyLeadership || latestResult?.companyLeadership || [],
      warnings: response.result?.warnings || latestResult?.warnings || [],
      employeeAnalysisComplete: true,
      evidence: [...new Set([...(latestResult?.evidence || []), ...(response.result?.evidence || [])])]
    };

    renderResult(result);
    await chrome.storage.local.set({ [LATEST_RESULT_KEY]: result });

    setStatus("Employee analysis complete.");
    setStage("Complete", "success");
    setProgress(100);

  } catch (error) {
    setStatus(error.message || "Employee analysis failed.", true);
    setStage("Error", "error");
  } finally {
    setBusy(false);

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
