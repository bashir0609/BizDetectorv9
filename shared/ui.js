import { normalizePeople } from "./people.js";

export function fillList(target, items, emptyText = "None found.", options = {}) {
  target.replaceChildren();
  const values = items?.length ? items : [emptyText];
  for (const item of values) {
    const li = document.createElement("li");
    li.textContent = item;
    if (options.placeholderClass && item === emptyText) {
      li.className = options.placeholderClass;
    }
    target.appendChild(li);
  }
}

export function renderPeople(target, people, options = {}) {
  target.replaceChildren();
  const entries = normalizePeople(people);
  if (!entries.length) {
    const li = document.createElement("li");
    if (options.placeholderClass) {
      li.className = options.placeholderClass;
    }
    li.textContent = options.employeeAnalysisComplete
      ? "No team or people details found."
      : (options.emptyText || "Run Analyze Employee Details to load people information.");
    target.appendChild(li);
    return;
  }

  for (const person of entries) {
    const li = document.createElement("li");
    li.textContent = [
      person.name,
      person.title,
      person.department,
      person.email,
      person.phone,
      person.linkedinUrl,
      person.confidence,
      person.sourceUrl,
      person.bio
    ].filter(Boolean).join(" | ");
    target.appendChild(li);
  }
}

export async function syncSettingsUI(elements, settings) {
  if (!elements) return;
  if (elements.provider) elements.provider.value = settings.provider || "groq";
  if (elements.groqApiKey) elements.groqApiKey.value = settings.providerApiKeys?.groq || "";
  if (elements.geminiApiKey) elements.geminiApiKey.value = settings.providerApiKeys?.gemini || "";
  if (elements.ollamaApiKey) elements.ollamaApiKey.value = settings.providerApiKeys?.ollama || "";
  if (elements.ollamaBaseUrl) elements.ollamaBaseUrl.value = settings.ollamaBaseUrl || "https://ollama.com";
  if (elements.janBaseUrl) elements.janBaseUrl.value = settings.janBaseUrl || "http://127.0.0.1:1337/v1";
  if (elements.janModel) elements.janModel.value = settings.janModel || "";
  if (elements.debugLogsEnabled) elements.debugLogsEnabled.checked = settings.debugLogsEnabled !== false;
  if (elements.rateLimitSafeMode) elements.rateLimitSafeMode.checked = !!settings.rateLimitSafeMode;
  
  // Update visibility
  const provider = elements.provider?.value;
  if (elements.groqFields) elements.groqFields.classList.toggle("hidden", provider !== "groq");
  if (elements.geminiFields) elements.geminiFields.classList.toggle("hidden", provider !== "gemini");
  if (elements.ollamaFields) elements.ollamaFields.classList.toggle("hidden", provider !== "ollama");
  if (elements.janFields) elements.janFields.classList.toggle("hidden", provider !== "jan");
}


export function renderEmployeeExtras(container, result = {}, options = {}) {
  if (!container) return;
  const existing = container.querySelector(".employee-extras");
  if (existing) existing.remove();

  const showChunks = options.showChunks !== false;
  const warnings = result.warnings || result.employeeWarnings || [];
  const leadership = normalizePeople(result.companyLeadership || []);
  const chunks = showChunks && Array.isArray(result.employeeChunks) ? result.employeeChunks : [];
  if (!warnings.length && !leadership.length && !chunks.length) return;

  const wrapper = document.createElement("div");
  wrapper.className = "employee-extras";

  if (result.coverage) {
    const coverageDiv = document.createElement("div");
    coverageDiv.className = "employee-coverage";
    const coverageText = document.createElement("div");
    coverageText.className = "placeholder-text";
    coverageText.textContent = `Coverage: ${result.coverage.pagesCrawled} pages crawled, ${result.coverage.employeesFound} employees found`;
    coverageDiv.appendChild(coverageText);
    wrapper.appendChild(coverageDiv);
  }
  if (leadership.length) {
    const title = document.createElement(options.headingTag || "h4");
    title.textContent = "Company leadership";
    wrapper.appendChild(title);

    const list = document.createElement("ul");
    for (const person of leadership) {
      const li = document.createElement("li");
      li.textContent = [
        person.name,
        person.title,
        person.department,
        person.email,
        person.phone,
        person.linkedinUrl,
        person.sourceUrl,
        person.confidence,
        person.bio
      ].filter(Boolean).join(" | ");
      list.appendChild(li);
    }
    wrapper.appendChild(list);
  }

  if (chunks.length) {
    const title = document.createElement(options.headingTag || "h4");
    title.textContent = "Employee analysis chunks";
    wrapper.appendChild(title);
    for (const chunk of chunks) {
      const section = document.createElement("div");
      section.className = "employee-chunk";
      const heading = document.createElement("strong");
      const count = normalizePeople(chunk.people || []).length;
      heading.textContent = "Chunk " + (chunk.index || "?") + "/" + (chunk.total || chunks.length) + ": " + count + " people found";
      section.appendChild(heading);
      const meta = document.createElement("div");
      meta.className = "placeholder-text";
      const urls = (chunk.pages || []).map((page) => page.url).filter(Boolean).join(" | ");
      meta.textContent = [urls, chunk.modelUsed ? "Model: " + chunk.modelUsed : "", chunk.promptTierUsed ? "Tier: " + chunk.promptTierUsed : ""].filter(Boolean).join(" — ");
      section.appendChild(meta);
      const people = normalizePeople(chunk.people || []);
      if (people.length) {
        const list = document.createElement("ul");
        for (const person of people) {
          const li = document.createElement("li");
          li.textContent = [person.name, person.title, person.department, person.email, person.phone, person.linkedinUrl, person.sourceUrl, person.confidence, person.bio].filter(Boolean).join(" | ");
          list.appendChild(li);
        }
        section.appendChild(list);
      }
      if (chunk.teamSummary) { const summary = document.createElement("div"); summary.className = "placeholder-text"; summary.textContent = chunk.teamSummary; section.appendChild(summary); }
      const chunkWarnings = chunk.warnings || [];
      if (chunk.error || chunkWarnings.length) { const warning = document.createElement("div"); warning.className = "placeholder-text employee-warnings"; warning.textContent = [chunk.error, ...chunkWarnings].filter(Boolean).join(" | "); section.appendChild(warning); }
      wrapper.appendChild(section);
    }
  }
  if (warnings.length) {
    const warningBox = document.createElement("div");
    warningBox.className = "placeholder-text employee-warnings";
    warningBox.textContent = `Employee analysis warnings: ${warnings.join(" | ")}`;
    wrapper.appendChild(warningBox);
  }

  container.appendChild(wrapper);
}
