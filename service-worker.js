import { 
  PERSON_NAME_BLOCKLIST_TERMS, 
  TITLE_BLOCKLIST_TERMS, 
  SOURCE_CONTEXT_TERMS, 
  ROLE_KEYWORDS, 
  buildWordBoundaryRegex 
} from "./role-taxonomy.js";

import { DEFAULT_SETTINGS, PROVIDER_LABELS } from "./config/settings.js";
import { getSettings, saveSettings, getLatestResult, setLatestResult } from "./storage/manager.js";
import { 
  getModelCandidates, 
  modelMatchesProvider, 
  requestModel 
} from "./engine/analysis.js";
import { 
  recordRateLimitEvent, 
  isAutoSafeModeActive, 
  pickAvailableKey, 
  markKeyModelRateLimited, 
  msUntilAnyKeyAvailable, 
  resolveRateLimitWaitMs 
} from "./engine/rate-limiter.js";
import { 
  safeParseModelJson, 
  parseProviderApiKeys 
} from "./engine/utils.js";
import { dedupePeople } from "./shared/people.js";

const sleep = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (chrome.runtime?.getPlatformInfo) {
      await chrome.runtime.getPlatformInfo();
    }
  }
};

const EMPLOYEE_PROMPT_TIERS = {
  normal: { pages: 3, pageBody: 2600, peoplePerPage: 40, totalPeople: 120, snippets: 20, snippetChars: 280, emails: 60, phones: 50, headings: 14, description: 220, structuredOrganizations: 3, structuredContacts: 8, structuredSocialLinks: 10, completionTokens: 1200 },
  small: { pages: 2, pageBody: 1400, peoplePerPage: 25, totalPeople: 70, snippets: 12, snippetChars: 180, emails: 35, phones: 30, headings: 8, description: 160, structuredOrganizations: 2, structuredContacts: 5, structuredSocialLinks: 6, completionTokens: 900 },
  tiny: { pages: 1, pageBody: 700, peoplePerPage: 15, totalPeople: 35, snippets: 6, snippetChars: 120, emails: 20, phones: 15, headings: 5, description: 120, structuredOrganizations: 1, structuredContacts: 3, structuredSocialLinks: 4, completionTokens: 650 }
};

function getEmployeePromptTier(tier = "normal") {
  return EMPLOYEE_PROMPT_TIERS[tier] || EMPLOYEE_PROMPT_TIERS.normal;
}

function buildAuthErrorMessage(settings, error) {
  const providerLabel = PROVIDER_LABELS[settings.provider] || settings.provider;
  return `Authentication failed for ${providerLabel}. Please check your API key.`;
}

async function analyzeWithApi(settings, promptBuilder, isEmployeeAnalysis = false) {
  const providerOrder = getProviderFallbackOrder(settings);
  const providerErrors = [];

  for (const provider of providerOrder) {
    try {
      return await analyzeWithProvider({ ...settings, provider }, promptBuilder, isEmployeeAnalysis);
    } catch (error) {
      providerErrors.push(`${PROVIDER_LABELS[provider] || provider}: ${error.message || error}`);
    }
  }

  throw new Error(`All configured providers failed. ${providerErrors.join(" | ")}`);
}

async function analyzeWithProvider(settings, promptBuilder, isEmployeeAnalysis = false) {
  let safeModeActive = Boolean(settings.rateLimitSafeMode) || isAutoSafeModeActive();
  
  const rawCandidates = await getModelCandidates(settings, isEmployeeAnalysis);
  const candidates = rawCandidates.filter((model) => modelMatchesProvider(settings.provider, model));
  if (!candidates.length) {
    throw new Error(`No compatible models found for ${PROVIDER_LABELS[settings.provider] || settings.provider}.`);
  }
  
  const rawProviderKeys = settings.providerApiKeys?.[settings.provider] ?? settings.apiKey;
  const providerKeys = ["groq", "gemini", "ollama"].includes(settings.provider)
    ? parseProviderApiKeys(rawProviderKeys)
    : ["local"];

  if (["groq", "gemini", "ollama"].includes(settings.provider) && providerKeys.length === 0) {
    throw new Error(`Missing API key for ${PROVIDER_LABELS[settings.provider] || settings.provider}.`);
  }

  let currentAttempt = 0;
  while (currentAttempt < candidates.length) {
    const model = candidates[currentAttempt];
    const activeKey = pickAvailableKey(providerKeys, model);

    if (!activeKey) {
      const wait = msUntilAnyKeyAvailable(providerKeys, model);
      if (wait > 0) {
        await sleep(wait);
        continue;
      }
      throw new Error("All API keys are currently rate-limited.");
    }

    const promptTiers = isEmployeeAnalysis ? ["normal", "small", "tiny"] : ["normal"];
    for (const tier of promptTiers) {
      try {
        const maxTokens = isEmployeeAnalysis ? getEmployeePromptTier(tier).completionTokens : 1200;
        const result = await requestModel(settings, promptBuilder(tier), model, maxTokens, activeKey, isEmployeeAnalysis ? "employee" : "business");
        const parsed = safeParseModelJson(result.content);
        const normalized = isEmployeeAnalysis ? parsed : normalizeBusinessAnalysisResult(parsed);
        return { ...normalized, modelUsed: result.modelUsed, providerUsed: settings.provider, promptTierUsed: tier };
      } catch (error) {
        if (error.status === 429) {
          const wait = resolveRateLimitWaitMs(error, error.responseText);
          markKeyModelRateLimited(activeKey, model, wait);
          recordRateLimitEvent();
          currentAttempt++;
          break;
        }
        if (isModelUnsupportedForChat(error)) {
          currentAttempt++;
          break;
        }
        if (shouldTryNextModel(error)) {
          if (isEmployeeAnalysis && tier !== promptTiers[promptTiers.length - 1]) {
            continue;
          }
          currentAttempt++;
          break;
        }
        throw error;
      }
    }
  }
  throw new Error("All candidate models failed.");
}

function getProviderFallbackOrder(settings) {
  const selected = settings.provider || DEFAULT_SETTINGS.provider;
  const configured = ["groq", "gemini", "jan", "ollama"].filter((provider) => {
    if (provider === selected) return true;
    if (provider === "groq" || provider === "gemini" || provider === "ollama") {
      return parseProviderApiKeys(settings.providerApiKeys?.[provider]).length > 0;
    }
    if (provider === "jan") {
      return Boolean(settings.janModel);
    }
    return false;
  });
  return [selected, ...configured.filter((provider) => provider !== selected)];
}

function isModelUnsupportedForChat(error) {
  const text = `${error?.message || ""} ${error?.responseText || ""}`;
  return /does not support chat completions|not support chat|unsupported.*chat|model.*not.*chat/i.test(text);
}


function normalizeWebsiteSignals(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean).join(" | ");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, val]) => `${key}: ${Array.isArray(val) ? val.join(", ") : val}`)
      .map((item) => item.trim())
      .filter(Boolean)
      .join(" | ");
  }
  return String(value || "").trim();
}

function normalizeBusinessAnalysisResult(result = {}) {
  const normalized = { ...result };
  normalized.websiteSignals = normalizeWebsiteSignals(
    normalized.websiteSignals || normalized.signals || normalized.websiteSignal || normalized.marketSignals || normalized.businessSignals
  );
  if (!Array.isArray(normalized.services)) {
    normalized.services = normalized.services ? [String(normalized.services)] : [];
  }
  return normalized;
}

function shouldTryNextModel(error) {
  const text = `${error?.message || ""} ${error?.responseText || ""}`;
  if (error?.status === 413 || /request entity too large|request_too_large|reduce the length of the messages|context_length|maximum context|too many tokens/i.test(text)) return true;
  if (/requires a subscription|upgrade for access|subscription.*required/i.test(text)) return true;
  if (/model.*not found|model.*unavailable|not available/i.test(text)) return true;
  return false;
}

function truncateText(value, maxLength = 12000) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function compactStructuredDataForPrompt(data, limits = getEmployeePromptTier()) {
  const source = data || {};
  return {
    organizations: (source.organizations || []).slice(0, limits.structuredOrganizations),
    contacts: (source.contacts || []).slice(0, limits.structuredContacts),
    socialLinks: (source.socialLinks || []).slice(0, limits.structuredSocialLinks)
  };
}

function compactPerson(person) {
  return {
    name: person?.name || "",
    title: person?.title || person?.role || "",
    department: person?.department || "",
    email: person?.email || "",
    phone: person?.phone || "",
    linkedin: person?.linkedin || person?.linkedIn || person?.linkedinUrl || person?.profileUrl || "",
    linkedinUrl: person?.linkedinUrl || person?.linkedin || person?.linkedIn || person?.profileUrl || "",
    sourceUrl: person?.sourceUrl || person?.url || "",
    bio: person?.bio || person?.summary || person?.description || "",
    confidence: person?.confidence || "medium"
  };
}

function buildEmployeeResearchPayload(pageData = {}, tier = "normal") {
  const limits = getEmployeePromptTier(tier);
  const pages = [pageData, ...(pageData.discoveredPages || [])].filter(Boolean);
  const people = [];
  const teamSnippets = [];
  const emails = new Set(pageData.extractedEmails || pageData.emails || []);
  const phones = new Set(pageData.extractedPhones || pageData.phones || []);

  const relevantPages = pages.slice(0, limits.pages).map((page) => {
    (page.people || []).forEach((person) => people.push(compactPerson({ ...person, sourceUrl: person.sourceUrl || page.url })));
    (page.teamSnippets || []).forEach((snippet) => teamSnippets.push({ sourceUrl: page.url || "", text: truncateText(snippet, limits.snippetChars) }));
    (page.extractedEmails || page.emails || []).forEach((email) => emails.add(email));
    (page.extractedPhones || page.phones || []).forEach((phone) => phones.add(phone));

    return {
      title: page.title || "",
      url: page.url || "",
      headings: (page.headings || []).slice(0, limits.headings),
      description: truncateText(page.description, limits.description),
      teamSnippets: (page.teamSnippets || []).slice(0, 3).map((snippet) => truncateText(snippet, limits.snippetChars)),
      people: (page.people || []).slice(0, limits.peoplePerPage).map((person) => compactPerson({ ...person, sourceUrl: person.sourceUrl || page.url })),
      structuredData: compactStructuredDataForPrompt(page.structuredData, limits),
      bodyText: truncateText(page.bodyText, limits.pageBody)
    };
  });

  return {
    company: {
      title: pageData.title || "",
      url: pageData.url || "",
      description: truncateText(pageData.description, limits.description)
    },
    extractedPeople: people.slice(0, limits.totalPeople),
    teamSnippets: teamSnippets.slice(0, limits.snippets),
    emails: [...emails].slice(0, limits.emails),
    phones: [...phones].slice(0, limits.phones),
    pages: relevantPages
  };
}

function buildBusinessPrompt(pageData = {}) {
  const payload = {
    title: pageData.title || "",
    url: pageData.url || "",
    description: pageData.description || "",
    headings: (pageData.headings || []).slice(0, 12),
    metadata: pageData.metadata || {},
    structuredData: pageData.structuredData || {},
    bodyText: truncateText(pageData.bodyText, 12000),
    discoveredPages: (pageData.discoveredPages || []).slice(0, 4).map((page) => ({
      title: page.title || "",
      url: page.url || "",
      headings: (page.headings || []).slice(0, 8),
      bodyText: truncateText(page.bodyText, 3000)
    }))
  };

  return `Analyze this website research payload and return only the requested business JSON schema.\n\nRequired fields include businessType, industry, services, confidence, summary, evidence, and websiteSignals.\nwebsiteSignals must be a single concise string describing observable signals from the website, or an empty string if none are visible.\nServices must be clear customer-facing service names, not one-word navigation labels when a clearer name is possible.\n\nResearch payload:\n${JSON.stringify(payload, null, 2)}`;
}

function buildEmployeeChunks(pageData = {}, pagesPerChunk = 2) {
  const homepage = { ...pageData, discoveredPages: [] };
  const discovered = Array.isArray(pageData.discoveredPages) ? pageData.discoveredPages.filter(Boolean) : [];
  const pages = [homepage, ...discovered].filter(Boolean);
  const chunks = [];
  for (let index = 0; index < pages.length; index += pagesPerChunk) {
    const chunkPages = pages.slice(index, index + pagesPerChunk);
    const first = chunkPages[0] || homepage;
    chunks.push({
      index: chunks.length + 1,
      total: Math.ceil(pages.length / pagesPerChunk),
      pages: chunkPages.map((page) => ({ title: page.title || "", url: page.url || "" })),
      pageData: {
        ...homepage,
        title: first.title || homepage.title || "",
        url: first.url || homepage.url || "",
        bodyText: first.bodyText || "",
        headings: first.headings || [],
        description: first.description || homepage.description || "",
        people: chunkPages.flatMap((page) => (page.people || []).map((person) => ({ ...person, sourceUrl: person.sourceUrl || page.url }))),
        extractedEmails: [...new Set(chunkPages.flatMap((page) => page.extractedEmails || page.emails || []))],
        extractedPhones: [...new Set(chunkPages.flatMap((page) => page.extractedPhones || page.phones || []))],
        teamSnippets: chunkPages.flatMap((page) => (page.teamSnippets || []).map((snippet) => (page.url || "") + ": " + snippet)),
        structuredData: first.structuredData || homepage.structuredData || {},
        discoveredPages: chunkPages.slice(1)
      }
    });
  }
  return chunks;
}

function normalizeEmployeeAnalysisResult(result = {}) {
  const normalized = { ...result };
  normalized.people = dedupePeople(normalized.people || normalized.employees || []);
  normalized.companyLeadership = dedupePeople(normalized.companyLeadership || normalized.leadership || []);
  normalized.warnings = Array.isArray(normalized.warnings || normalized.employeeWarnings)
    ? (normalized.warnings || normalized.employeeWarnings).map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  normalized.evidence = Array.isArray(normalized.evidence) ? normalized.evidence.map((item) => String(item || "").trim()).filter(Boolean) : [];
  normalized.teamSummary = String(normalized.teamSummary || normalized.summary || "").trim();
  return normalized;
}

function mergeEmployeeChunkResults(chunks = [], fallbackPeople = []) {
  const allPeople = []; const allLeadership = []; const warnings = []; const evidence = []; const summaries = [];
  for (const chunk of chunks) {
    const result = normalizeEmployeeAnalysisResult(chunk.result || {});
    allPeople.push(...result.people); allLeadership.push(...result.companyLeadership); warnings.push(...result.warnings); evidence.push(...result.evidence);
    if (result.teamSummary) summaries.push("Chunk " + chunk.index + ": " + result.teamSummary);
  }
  const people = dedupePeople(allPeople.length ? allPeople : fallbackPeople);
  if (!allPeople.length && fallbackPeople.length) warnings.push("AI returned no people across chunks; showing crawler-extracted people instead.");
  return {
    people, companyLeadership: dedupePeople(allLeadership), warnings: [...new Set(warnings)], evidence: [...new Set(evidence)], teamSummary: summaries.join("\n"),
    employeeChunks: chunks.map((chunk) => {
      const result = normalizeEmployeeAnalysisResult(chunk.result || {});
      return { index: chunk.index, total: chunk.total, pages: chunk.pages, people: result.people, companyLeadership: result.companyLeadership, warnings: result.warnings, teamSummary: result.teamSummary, providerUsed: chunk.providerUsed || chunk.result?.providerUsed || "", modelUsed: chunk.modelUsed || chunk.result?.modelUsed || "", promptTierUsed: chunk.promptTierUsed || chunk.result?.promptTierUsed || "", error: chunk.error || "" };
    })
  };
}

async function analyzeEmployeeDetailsChunked(settings, pageData = {}) {
  const chunks = buildEmployeeChunks(pageData, 2);
  const analyzedChunks = [];
  for (const chunk of chunks) {
    try {
      const promptBuilder = (tier = "normal") => buildEmployeePrompt(chunk.pageData, tier, chunk);
      const result = normalizeEmployeeAnalysisResult(await analyzeWithApi(settings, promptBuilder, true));
      analyzedChunks.push({ ...chunk, result, providerUsed: result.providerUsed, modelUsed: result.modelUsed, promptTierUsed: result.promptTierUsed });
    } catch (error) {
      analyzedChunks.push({ ...chunk, result: { people: [], companyLeadership: [], warnings: ["Chunk " + chunk.index + " failed: " + (error.message || error)] }, error: error.message || String(error) });
    }
  }
  const fallbackPeople = [...(Array.isArray(pageData?.people) ? pageData.people : []), ...(pageData?.discoveredPages || []).flatMap((page) => page.people || [])];
  return mergeEmployeeChunkResults(analyzedChunks, fallbackPeople);
}
function buildEmployeePrompt(pageData = {}, tier = "normal", chunk = null) {
  const payload = buildEmployeeResearchPayload(pageData, tier);
  const chunkIntro = chunk ? "This is employee analysis chunk " + chunk.index + " of " + chunk.total + ". Only extract people supported by the pages in this chunk.\nPages in this chunk: " + chunk.pages.map((page) => page.url).filter(Boolean).join(" | ") + "\n\n" : "";
  return `${chunkIntro}Analyze employees and team members from this research payload.\n\nRules:\n- Extract only people actually supported by the payload.\n- Prefer names with job titles, bios, profile URLs, emails, phones, or source URLs.\n- Deduplicate the same person across pages.\n- Use confidence values of high, medium, or low.\n- Include sourceUrl for each person whenever possible.\n- Return only valid JSON matching the employee schema. The top-level people array is required; do not use employees as the field name.
- Use bio for role descriptions. companyLeadership must be an array of person objects using the same fields as people, not strings.\n\nResearch payload:\n${JSON.stringify(payload, null, 2)}`;
}


// Simplified orchestration for the example, but maintains core logic
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "analyze-page") {
    (async () => {
      try {
        const settings = await getSettings();
        const promptBuilder = () => buildBusinessPrompt(message.pageData);
        const result = await analyzeWithApi(settings, promptBuilder, false);
        await setLatestResult(result);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  
  if (message.type === "analyze-employee-details") {
    (async () => {
      try {
        const settings = await getSettings();
        const result = await analyzeEmployeeDetailsChunked(settings, message.pageData || {});
        const latest = await getLatestResult();
        const merged = { ...latest, ...result, employeeAnalysisComplete: true };
        await setLatestResult(merged);
        sendResponse({ ok: true, result: merged });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});
