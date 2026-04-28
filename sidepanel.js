import { buildCsvRow, CSV_HEADER, downloadFile } from "./shared/export.js";
import { fillList as fillSharedList, renderEmployeeExtras, renderPeople as renderPeopleList } from "./shared/ui.js";

const LATEST_RESULT_KEY = "latestAnalysis";

let latestResult = null;

const elements = {
  status: document.getElementById("status"),
  emptyState: document.getElementById("emptyState"),
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
  exportCsv: document.getElementById("exportCsv")
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.color = isError ? "#b42318" : "#486581";
}

function renderPeople(target, people) {
  renderPeopleList(target, people, {
    employeeAnalysisComplete: !!latestResult?.employeeAnalysisComplete,
    placeholderClass: "placeholder-text"
  });
}

function fillList(target, items, emptyText = "None found.") {
  fillSharedList(target, items, emptyText, { placeholderClass: "placeholder-text" });
}

function renderResult(result) {
  latestResult = result;

  if (!result) {
    elements.result.classList.add("hidden");
    elements.emptyState.classList.remove("hidden");
    return;
  }

  elements.emptyState.classList.add("hidden");
  elements.result.classList.remove("hidden");
  elements.businessType.textContent = result.businessType || "Unknown";
  const confidence = typeof result.confidence === "number"
    ? `${Math.round(result.confidence * 100)}%`
    : "n/a";
  elements.confidence.textContent = `Confidence: ${confidence}`;
  elements.summary.textContent = result.summary || "";
  elements.industry.textContent = result.industry || "";
  elements.websiteSignals.textContent = result.websiteSignals || "";
  fillList(elements.services, result.services);
  renderPeople(elements.people, result.people);
  elements.teamSummary.textContent = result.teamSummary || "No team summary available.";
  renderEmployeeExtras(elements.teamSummary.parentElement || elements.result, result, { headingTag: "h4" });
  fillList(elements.evidence, result.evidence);
  elements.raw.textContent = JSON.stringify(result, null, 2);
}

async function loadState() {
  const stored = await chrome.storage.local.get([LATEST_RESULT_KEY]);
  renderResult(stored[LATEST_RESULT_KEY] || null);
}

async function copyJson() {
  if (!latestResult) {
    setStatus("No result available yet.", true);
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes[LATEST_RESULT_KEY]) {
    renderResult(changes[LATEST_RESULT_KEY].newValue || null);
  }
});

elements.copyJson.addEventListener("click", () => {
  copyJson().catch((error) => setStatus(error.message || "Copy failed.", true));
});
elements.exportCsv.addEventListener("click", () => {
  exportCsv().catch((error) => setStatus(error.message || "Export failed.", true));
});
loadState().catch((error) => setStatus(error.message || "Failed to load panel state.", true));
