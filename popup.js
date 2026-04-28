import { buildCsvRow, CSV_HEADER, downloadFile } from "./shared/export.js";
import { dedupePeople, normalizePeople } from "./shared/people.js";
import { fillList, renderEmployeeExtras, renderPeople as renderPeopleList, syncSettingsUI } from "./shared/ui.js";
import { getSettings, saveSettings as saveSettingsStore, getLatestResult } from "./storage/manager.js";
import { normalizeApiKeysInput, validateApiKey, validateProviderApiKeys } from "./engine/utils.js";

const LATEST_RESULT_KEY = "latestAnalysis";
const MAX_RESEARCH_PAGES = 2;
const MAX_EMPLOYEE_RESEARCH_PAGES = 10;
const MAX_PAGE_BODY_CHARS = 700;
const MAX_EMPLOYEE_PAGE_BODY_CHARS = 2400;
const MAX_SUMMARY_BODY_CHARS = 1000;

let latestResult = null;
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
  const preferences = { provider, ollamaBaseUrl, janBaseUrl, janModel };
  const localSettings = { ...preferences, providerApiKeys };

  
  try {
    await saveSettingsStore(preferences, localSettings);
    setStatus("Settings saved.");
  } catch (error) {
    setStatus(error.message || "Save failed.", true);
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
    teamSnippets: (page.teamSnippets || []).slice(0, 8).map((item) => trimText(item, 260)),
    bodyText: trimText(page.bodyText, MAX_EMPLOYEE_PAGE_BODY_CHARS)
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

function compactResearchPayload(pageData, isEmployee = false) {
  const discoveredPages = (pageData.discoveredPages || []).slice(0, MAX_RESEARCH_PAGES).map(compactPageData);

  // Use 12,000 chars for employees, 1,000 chars for quick business summary
  const bodyLimit = isEmployee ? MAX_EMPLOYEE_PAGE_BODY_CHARS : MAX_SUMMARY_BODY_CHARS;

  return {
    title: pageData.title,
    url: pageData.url,
    description: trimText(pageData.description, 180),
    headings: (pageData.headings || []).slice(0, 8),
    metadata: Object.fromEntries(Object.entries(pageData.metadata || {}).slice(0, 8)),
    bodyText: trimText(pageData.bodyText, bodyLimit), // Dynamic limit applied here
    people: normalizePeople(pageData.people || []).slice(0, 100),
    structuredData: compactStructuredData(pageData.structuredData),
    extractedEmails: (pageData.extractedEmails || []).slice(0, 30),
    extractedPhones: (pageData.extractedPhones || []).slice(0, 30),
    extractionStats: pageData.extractionStats || null,
    teamSnippets: (pageData.teamSnippets || []).slice(0, 4).map((item) => trimText(item, 120)),
    discoveredPages
  };
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


function getSiteRoot(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}/`;
}

function scoreLink(link, origin, focus = "business") {
  try {
    const parsed = new URL(link.href);
    if (parsed.origin !== origin) {
      return -1;
    }
    let score = 0;
    const haystack = `${link.text} ${parsed.pathname}`.toLowerCase();
    if (focus === "employee") {
      if (/(team|people|leadership|staff|management|founder|employee|our-team|meet-the-team|executive|board|advisor|who-we-are)/.test(haystack)) score += 12;
      if (/(about|company|overview)/.test(haystack)) score += 8;
      if (/(contact|locations|office)/.test(haystack)) score += 3;
      if (/(services|solutions|what-we-do|capabilities)/.test(haystack)) score += 1;
    } else {
      if (/(services|solutions|what-we-do|capabilities|offerings|products)/.test(haystack)) score += 12;
      if (/(about|company|overview)/.test(haystack)) score += 8;
      if (/(industries|clients|portfolio|case-studies)/.test(haystack)) score += 4;
      if (/(contact|locations|office)/.test(haystack)) score += 2;
      if (/(team|people|leadership|staff|management|founder|employee|our-team|meet-the-team|executive|board|advisor|who-we-are)/.test(haystack)) score += 1;
    }
    if (parsed.pathname === "/" || parsed.pathname === "") score += 6;
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
    .filter((link) => link.score >= 0)
    .sort((a, b) => b.score - a.score);

  const urls = [pageData.url, getSiteRoot(pageData.url)];
  for (const link of rankedLinks) {
    urls.push(link.href);
    if (urls.length >= maxPages * 2) {
      break;
    }
  }

  return [...new Set(urls)].slice(0, maxPages);
}

async function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      reject(new Error("The website took too long to load."));
    }, 10000);

    function cleanup() {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
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
    const tab = await chrome.tabs.create({ url, active: false });
    openedTabId = tab.id;
    await waitForTabComplete(tab.id);
    return await extractPageDataFromTab(tab.id);
  } finally {
    if (openedTabId) {
      await chrome.tabs.remove(openedTabId).catch(() => {});
    }
  }
}

async function crawlEmployeePagesFromCurrentPage(primaryPage) {
  const urls = buildCandidateUrls(primaryPage, MAX_EMPLOYEE_RESEARCH_PAGES + 1, "employee")
    .filter((candidateUrl) => candidateUrl !== primaryPage.url)
    .slice(0, MAX_EMPLOYEE_RESEARCH_PAGES);


  const pages = [];
  for (const url of urls) {
    try {
      const page = await fetchPageInBackground(url);
      if (page) pages.push(page);
    } catch (error) {
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
  const response = await chrome.runtime.sendMessage({
    type: "analyze-page",
    pageData: compactResearchPayload(pageData, false)
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unknown analysis error.");
  }

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
  setBusy(true);
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
    setStatus(error.message || "Something went wrong.", true);
  } finally {
    setBusy(false);
  }
}

async function analyzeEmployeeDetailsForUrl(url) {
  setBusy(true);
  setStatus("Reading current page for employee details...");

  try {
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
    setStatus(error.message || "Employee analysis failed.", true);
  } finally {
    setBusy(false);
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
