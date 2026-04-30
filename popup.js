import { buildCsvRow, CSV_HEADER, downloadFile } from "./shared/export.js";
import { normalizePeople } from "./shared/people.js";
import { compactResearchPayload } from "./shared/payload-cleaning.js";
import { buildCandidateUrls } from "./shared/team-page-discovery.js";
import { fillList, renderEmployeeExtras, renderPeople as renderPeopleList, syncSettingsUI } from "./shared/ui.js";
import { getSettings, saveSettings as saveSettingsStore, getLatestResult } from "./storage/manager.js";
import { normalizeApiKeysInput, validateApiKey, validateProviderApiKeys } from "./engine/utils.js";
import { isLocalOllamaBaseUrl } from "./config/settings.js";

const LATEST_RESULT_KEY = "latestAnalysis";
const MAX_RESEARCH_PAGES = 2;
const MAX_EMPLOYEE_RESEARCH_PAGES = 15;
const MAX_PAGE_BODY_CHARS = 1400;
const MAX_EMPLOYEE_PAGE_BODY_CHARS = 4800;
const MAX_SUMMARY_BODY_CHARS = 1000;

let latestResult = null;
let currentRunController = null;
const activeOperationIds = new Set();
const openedTempTabIds = new Set();
const elements = {
  settingsPanel: document.getElementById("settingsPanel"),
  compactBar: document.getElementById("compactBar"),
  reAnalyze: document.getElementById("reAnalyze"),
  toggleSettings: document.getElementById("toggleSettings"),
  provider: document.getElementById("provider"),
  groqFields: document.getElementById("groqFields"),
  geminiFields: document.getElementById("geminiFields"),
  ollamaFields: document.getElementById("ollamaFields"),
  janFields: document.getElementById("janFields"),
  groqApiKey: document.getElementById("groqApiKey"),
  geminiApiKey: document.getElementById("geminiApiKey"),
  ollamaApiKey: document.getElementById("ollamaApiKey"),
  ollamaBaseUrl: document.getElementById("ollamaBaseUrl"),
  janBaseUrl: document.getElementById("janBaseUrl"),
  janModel: document.getElementById("janModel"),
  analyze: document.getElementById("analyze"),
  analyzeEmployees: document.getElementById("analyzeEmployees"),
  stopAnalysis: document.getElementById("stopAnalysis"),
  status: document.getElementById("status"),
  result: document.getElementById("result"),
  businessType: document.getElementById("businessType"),
  confidence: document.getElementById("confidence"),
  summary: document.getElementById("summary"),
  industry: document.getElementById("industry"),
  websiteSignals: document.getElementById("websiteSignals"),
  services: document.getElementById("services"),
  people: document.getElementById("people"),
  teamSummary: document.getElementById("teamSummary"),
  evidence: document.getElementById("evidence"),
  raw: document.getElementById("raw"),
  copyJson: document.getElementById("copyJson"),
  exportCsv: document.getElementById("exportCsv"),
  openDashboard: document.getElementById("openDashboard")
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.color = isError ? "#b42318" : "#486581";
}

function isStopRequested() {
  return Boolean(currentRunController?.signal?.aborted);
}

function throwIfStopped() {
  if (isStopRequested()) {
    throw new DOMException("Analysis stopped.", "AbortError");
  }
}

function isStoppedError(error) {
  return error?.name === "AbortError" || /analysis stopped/i.test(String(error?.message || error || ""));
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
  for (const operationId of [...activeOperationIds]) {
    chrome.runtime.sendMessage({ type: "cancel-analysis", operationId }).catch(() => { });
  }
  for (const tabId of [...openedTempTabIds]) {
    chrome.tabs.remove(tabId).catch(() => { });
  }
}

function showSettings() {
  elements.settingsPanel.classList.remove("hidden");
  elements.compactBar.classList.add("hidden");
}

function showResults() {
  elements.settingsPanel.classList.add("hidden");
  elements.compactBar.classList.remove("hidden");
}

function setBusy(isBusy) {
  elements.analyze.disabled = isBusy;
  elements.analyzeEmployees.disabled = isBusy || !latestResult?.url;
  elements.stopAnalysis?.classList.toggle("hidden", !isBusy);
  if (elements.stopAnalysis) elements.stopAnalysis.disabled = false;
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
  elements.janFields?.classList.toggle("hidden", !isJan);
}

async function loadSettings() {
  const settings = await getSettings();
  await syncSettingsUI(elements, settings);
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
  const preferences = { provider, ollamaBaseUrl, janBaseUrl, janModel };
  const localSettings = { ...preferences, providerApiKeys };


  try {
    await saveSettingsStore(preferences, localSettings);
    setStatus("Settings saved.");
  } catch (error) {
    setStatus(error.message || "Save failed.", true);
    throw error;
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

function formatDateTime(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function renderPeople(target, people) {
  renderPeopleList(target, people, {
    employeeAnalysisComplete: !!latestResult?.employeeAnalysisComplete
  });
}

async function loadState() {
  setEmployeeButtonState();
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }
  return tab;
}


async function waitForTabComplete(tabId, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Analysis stopped.", "AbortError"));
      return;
    }
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      signal?.removeEventListener("abort", handleAbort);
      reject(new Error("The website took too long to load."));
    }, 10000);

    function cleanup() {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      signal?.removeEventListener("abort", handleAbort);
    }

    function handleAbort() {
      cleanup();
      reject(new DOMException("Analysis stopped.", "AbortError"));
    }

    function handleUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.status === "complete") {
        cleanup();
        resolve(tab);
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

async function extractPageDataFromTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab.url)) {
    throw new Error("This page cannot be analyzed. Open a regular website first.");
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["shared/page-extractor.js"]
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      if (globalThis.BTDPageExtractor?.expandTeamPage) {
        await globalThis.BTDPageExtractor.expandTeamPage();
      }
    }
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => globalThis.BTDPageExtractor?.extractPageData()
  });


  const pageData = results?.[0]?.result;
  if (!pageData) {
    throw new Error("Unable to read the current page.");
  }

  return pageData;
}

async function fetchPageInBackground(url) {
  let openedTabId = null;
  try {
    throwIfStopped();
    const tab = await chrome.tabs.create({ url, active: false });
    openedTabId = tab.id;
    openedTempTabIds.add(openedTabId);
    await waitForTabComplete(tab.id, currentRunController?.signal);
    throwIfStopped();
    return await extractPageDataFromTab(tab.id);
  } finally {
    if (openedTabId) {
      openedTempTabIds.delete(openedTabId);
      await chrome.tabs.remove(openedTabId).catch(() => { });
    }
  }
}

async function crawlEmployeePagesFromCurrentPage(primaryPage) {
  const urls = buildCandidateUrls(primaryPage, MAX_EMPLOYEE_RESEARCH_PAGES + 1, "employee")
    .filter((candidateUrl) => candidateUrl !== primaryPage.url)
    .slice(0, MAX_EMPLOYEE_RESEARCH_PAGES);


  const pages = [];
  for (const url of urls) {
    throwIfStopped();
    try {
      const page = await fetchPageInBackground(url);
      if (page) pages.push(page);
    } catch (error) {
      if (isStoppedError(error)) throw error;
      console.warn("Employee page crawl skipped", url, error);
    }
  }
  return pages;
}


function renderResult(result) {
  latestResult = result;
  elements.result.classList.remove("hidden");
  elements.businessType.textContent = result.businessType || "Unknown";
  const confidence = typeof result.confidence === "number" ? `${Math.round(result.confidence * 100)}%` : "n/a";
  elements.confidence.textContent = `Confidence: ${confidence}`;
  elements.summary.textContent = result.summary || "";
  elements.industry.textContent = result.industry || "";
  elements.websiteSignals.textContent = result.websiteSignals || "";
  fillList(elements.services, result.services);
  renderPeople(elements.people, result.people);
  elements.teamSummary.textContent = result.teamSummary || "Run Analyze Employee Details to load team information.";
  renderEmployeeExtras(elements.teamSummary.parentElement, result, { headingTag: "h4" });
  fillList(elements.evidence, result.evidence);
  elements.raw.textContent = JSON.stringify(result, null, 2);
  setEmployeeButtonState();
  elements.result.scrollIntoView({ behavior: "smooth", block: "start" });
  showResults();
}

async function copyJson() {
  if (!latestResult) {
    setStatus("Run an analysis first.", true);
    return;
  }

  await navigator.clipboard.writeText(JSON.stringify(latestResult, null, 2));
  setStatus("JSON copied.");
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

async function runAnalysisForTab(tabId) {
  throwIfStopped();
  setStatus("Reading current page...");
  // Popup only analyzes the single current page; no background tab crawling.
  const primaryPage = await extractPageDataFromTab(tabId);
  const pageData = {
    ...primaryPage,
    discoveredPages: [],
    extractedEmails: primaryPage.extractedEmails || [],
    extractedPhones: primaryPage.extractedPhones || [],
    people: normalizePeople(primaryPage.people || []),
    teamSnippets: primaryPage.teamSnippets || []
  };

  setStatus("Classifying business type, services, and team details...");
  const response = await sendAnalysisMessage({
    type: "analyze-page",
    pageData: compactResearchPayload(pageData, {
      isEmployee: false,
      maxPages: MAX_RESEARCH_PAGES,
      employeeBodyChars: MAX_EMPLOYEE_PAGE_BODY_CHARS,
      summaryBodyChars: MAX_SUMMARY_BODY_CHARS
    })
  }, "business");

  if (!response?.ok) {
    throw new Error(response?.error || "Unknown analysis error.");
  }
  throwIfStopped();

  const result = {
    ...response.result,
    analyzedAt: new Date().toISOString(),
    title: pageData.title,
    url: pageData.url,
    people: latestResult?.url === pageData.url ? latestResult.people || [] : [],
    teamSummary: latestResult?.url === pageData.url ? latestResult.teamSummary || "" : "",
    companyLeadership: latestResult?.url === pageData.url ? (latestResult.companyLeadership || []) : [],
    warnings: latestResult?.url === pageData.url ? (latestResult.warnings || latestResult.employeeWarnings || []) : [],
    employeeAnalysisComplete: latestResult?.url === pageData.url ? !!latestResult.employeeAnalysisComplete : false
  };

  renderResult(result);
  await chrome.storage.local.set({ [LATEST_RESULT_KEY]: result });
  setStatus("Analysis complete.");
}

async function openSidePanel(windowId) {
  const response = await chrome.runtime.sendMessage({
    type: "open-side-panel",
    windowId
  });

  if (!response?.ok) {
    return {
      ok: false,
      error: response?.error || "Unable to open side panel."
    };
  }
  return response;
}

async function analyzeCurrentTab() {
  beginAnalysisRun();
  setStatus("Reading current page...");
  elements.result.classList.add("hidden");

  try {
    await saveSettings();
    const tab = await getCurrentTab();
    if (!isSupportedUrl(tab.url)) {
      throw new Error("This page cannot be analyzed. Open a regular website first.");
    }

    await runAnalysisForTab(tab.id);

  } catch (error) {
    setStatus(isStoppedError(error) ? "Analysis stopped." : (error.message || "Something went wrong."), !isStoppedError(error));
  } finally {
    endAnalysisRun();
  }
}

async function analyzeEmployeeDetailsForUrl(url) {
  beginAnalysisRun();
  setStatus("Reading current page for employee details...");

  try {
    throwIfStopped();
    await saveSettings();
    const tab = await getCurrentTab();

    const primaryPage = await extractPageDataFromTab(tab.id);

    setStatus("Finding employee/team pages...");
    const discoveredPages = await crawlEmployeePagesFromCurrentPage(primaryPage);

    const coverage = {
      pagesCrawled: discoveredPages.length + 1,
      employeesFound: 0 // Will be calculated after analysis
    };


    const pageData = {
      ...primaryPage,
      discoveredPages,
      extractedEmails: primaryPage.extractedEmails || [],
      extractedPhones: primaryPage.extractedPhones || [],
      people: normalizePeople(primaryPage.people || []),
      teamSnippets: primaryPage.teamSnippets || []
    };

    setStatus("Extracting employee details...");
    const response = await sendAnalysisMessage({
      type: "analyze-employee-details",
      pageData: compactResearchPayload(pageData, {
        isEmployee: true,
        maxPages: MAX_EMPLOYEE_RESEARCH_PAGES,
        employeeBodyChars: MAX_EMPLOYEE_PAGE_BODY_CHARS,
        summaryBodyChars: MAX_SUMMARY_BODY_CHARS
      })
    }, "employee");

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown employee analysis error.");
    }
    throwIfStopped();

    const result = {
      ...(latestResult || {}),
      ...(response.result || {}),
      people: normalizePeople((response.result?.people?.length ? response.result.people : pageData.people) || []),
      teamSummary: response.result?.teamSummary || latestResult?.teamSummary || "",
      companyLeadership: response.result?.companyLeadership || latestResult?.companyLeadership || [],
      warnings: response.result?.warnings || latestResult?.warnings || [],
      employeeAnalysisComplete: true,
      evidence: [...new Set([...(latestResult?.evidence || []), ...(response.result?.evidence || [])])],
      coverage: {
        pagesCrawled: coverage.pagesCrawled,
        employeesFound: (response.result?.people || []).length || pageData.people.length
      }
    };

    renderResult(result);
    await chrome.storage.local.set({ [LATEST_RESULT_KEY]: result });
    setStatus("Employee analysis complete.");

  } catch (error) {
    setStatus(isStoppedError(error) ? "Analysis stopped." : (error.message || "Employee analysis failed."), !isStoppedError(error));
  } finally {
    endAnalysisRun();
  }
}

// Ensure the event listeners are wired up correctly at the bottom:
elements.analyze.addEventListener("click", analyzeCurrentTab);
elements.reAnalyze?.addEventListener("click", analyzeCurrentTab);
elements.toggleSettings?.addEventListener("click", showSettings);
elements.provider.addEventListener("change", () => {
  updateProviderFields(elements.provider.value);
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
elements.openDashboard.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }).catch((error) => {
    setStatus(error.message || "Unable to open dashboard.", true);
  });
});
elements.copyJson.addEventListener("click", () => {
  copyJson().catch((error) => setStatus(error.message || "Copy failed.", true));
});
elements.exportCsv.addEventListener("click", () => {
  exportCsv().catch((error) => setStatus(error.message || "Export failed.", true));
});
Promise.all([loadSettings(), loadState()]).catch((error) => {
  setStatus(error.message || "Failed to load popup.", true);
});
