function activateTab(name) {
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    const match = tab.dataset.tab === name;
    tab.classList.toggle("active", match);
    tab.setAttribute("aria-selected", match ? "true" : "false");
  });

  document.querySelectorAll(".tab-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === `tab-${name}`);
  });
}

function updateTabBadges() {
  [
    ["services", "badge-services"],
    ["people", "badge-people"],
    ["evidence", "badge-evidence"]
  ].forEach(([listId, badgeId]) => {
    const list = document.getElementById(listId);
    const badge = document.getElementById(badgeId);
    if (!list || !badge) return;

    const count = list.querySelectorAll("li:not(.placeholder-text)").length;
    badge.textContent = String(count);
    badge.classList.toggle("hidden", count === 0);
  });
}

function syncProviderFields(provider) {
  document.getElementById("groqFields")?.classList.toggle("hidden", provider !== "groq");
  document.getElementById("geminiFields")?.classList.toggle("hidden", provider !== "gemini");
  document.getElementById("ollamaFields")?.classList.toggle("hidden", provider !== "ollama");
  document.getElementById("janFields")?.classList.toggle("hidden", provider !== "jan");
}

function setAnalyzeBusyVisual(busy) {
  const analyzeBtn = document.getElementById("analyzeUrl");
  if (!analyzeBtn) return;

  const btnLabel = analyzeBtn.querySelector(".btn-label");
  const btnSpinner = analyzeBtn.querySelector(".btn-spinner");
  const btnIcon = analyzeBtn.querySelector(".btn-icon");

  if (btnLabel) btnLabel.textContent = busy ? "Analyzing..." : "Analyze site";
  btnSpinner?.classList.toggle("hidden", !busy);
  btnIcon?.classList.toggle("hidden", busy);
  analyzeBtn.classList.toggle("btn-primary--busy", busy);
}

document.querySelectorAll(".nav-tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

window.BTDDashboardUI = {
  activateTab,
  updateTabBadges,
  syncProviderFields,
  setAnalyzeBusyVisual
};
