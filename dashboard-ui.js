/* Tab switching */
function activateTab(name) {
  document.querySelectorAll('.nav-tab').forEach(t => {
    const match = t.dataset.tab === name;
    t.classList.toggle('active', match);
    t.setAttribute('aria-selected', match ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === 'tab-' + name);
  });
}
document.querySelectorAll('.nav-tab').forEach(t =>
  t.addEventListener('click', () => activateTab(t.dataset.tab))
);

/* Tab badges */
function updateTabBadges() {
  [['services', 'badge-services'], ['people', 'badge-people'], ['evidence', 'badge-evidence']].forEach(([listId, badgeId]) => {
    const items = document.getElementById(listId).querySelectorAll('li:not(.placeholder-text)');
    const badge = document.getElementById(badgeId);
    if (items.length > 0) {
      badge.textContent = items.length;
      badge.classList.remove('hidden');
    }
  });
}

/* Auto-switch to Summary when result appears */
const observer = new MutationObserver(() => {
  if (!document.getElementById('classificationStrip').classList.contains('hidden')) {
    activateTab('summary');
    updateTabBadges();
  }
});
observer.observe(document.getElementById('classificationStrip'), {
  attributes: true, attributeFilter: ['class']
});

/* Settings drawer: provider toggle */
document.getElementById('provider').addEventListener('change', function () {
  document.getElementById('groqFields').classList.toggle('hidden', this.value !== 'groq');
  document.getElementById('geminiFields').classList.toggle('hidden', this.value !== 'gemini');
  document.getElementById('ollamaFields').classList.toggle('hidden', this.value !== 'ollama');
  document.getElementById('janFields').classList.toggle('hidden', this.value !== 'jan');
});

/* Analyzing state: spin the button */
const analyzeBtn = document.getElementById('analyzeUrl');
const btnLabel   = analyzeBtn.querySelector('.btn-label');
const btnSpinner = analyzeBtn.querySelector('.btn-spinner');
const btnIcon    = analyzeBtn.querySelector('.btn-icon');

function setBusyVisual(busy) {
  if (busy) {
    btnLabel.textContent = 'Analyzing...';
    btnSpinner.classList.remove('hidden');
    btnIcon.classList.add('hidden');
    analyzeBtn.classList.add('btn-primary--busy');
  } else {
    btnLabel.textContent = 'Analyze site';
    btnSpinner.classList.add('hidden');
    btnIcon.classList.remove('hidden');
    analyzeBtn.classList.remove('btn-primary--busy');
  }
}

/* Watch disabled state of analyzeUrl to sync spinner */
const btnObserver = new MutationObserver(() => {
  setBusyVisual(analyzeBtn.disabled);
});
btnObserver.observe(analyzeBtn, { attributes: true, attributeFilter: ['disabled'] });

/* Status strip coloring */
const statusEl    = document.getElementById('status');
const statusStrip = document.getElementById('statusStrip');
const statusIcon  = document.getElementById('statusIcon');

const statusObserver = new MutationObserver(() => {
  const text = statusEl.textContent.toLowerCase();
  const isExplicitError = statusStrip.classList.contains('status-strip--error');
  if (isExplicitError || text.includes('fail') || text.includes('error')) {
    statusStrip.className = 'status-strip status-strip--error';
    statusIcon.textContent = 'error';
  } else if (text.includes('complete') || text.includes('saved') || text.includes('copied') || text.includes('export')) {
    statusStrip.className = 'status-strip status-strip--success';
    statusIcon.textContent = 'done';
  } else if (text === 'ready') {
    statusStrip.className = 'status-strip status-strip--idle';
    statusIcon.textContent = 'idle';
  } else {
    statusStrip.className = 'status-strip status-strip--busy';
    statusIcon.textContent = 'busy';
  }
});
statusObserver.observe(statusEl, { childList: true, characterData: true, subtree: true });
