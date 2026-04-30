import { DEFAULT_SETTINGS, PROVIDER_LABELS, isLocalOllamaBaseUrl } from "./config/settings.js";
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
import { trimText as truncateText } from "./shared/payload-cleaning.js";
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
  normal: { pages: 3, pageBody: 3000, peoplePerPage: 100, totalPeople: 260, snippets: 20, snippetChars: 260, emails: 100, phones: 90, headings: 16, description: 220, structuredOrganizations: 3, structuredContacts: 10, structuredSocialLinks: 12, completionTokens: 2600 },
  small: { pages: 2, pageBody: 1600, peoplePerPage: 60, totalPeople: 140, snippets: 12, snippetChars: 180, emails: 60, phones: 50, headings: 10, description: 160, structuredOrganizations: 2, structuredContacts: 6, structuredSocialLinks: 8, completionTokens: 1600 },
  tiny: { pages: 1, pageBody: 900, peoplePerPage: 35, totalPeople: 80, snippets: 8, snippetChars: 140, emails: 30, phones: 25, headings: 6, description: 130, structuredOrganizations: 1, structuredContacts: 4, structuredSocialLinks: 4, completionTokens: 750 }
};

function getEmployeePromptTier(tier = "normal") {
  return EMPLOYEE_PROMPT_TIERS[tier] || EMPLOYEE_PROMPT_TIERS.normal;
}

const BUSINESS_PROMPT_TIERS = {
  normal: { discoveredPages: 6, homepageBody: 12000, pageBody: 3200, headings: 12, pageHeadings: 8 },
  small: { discoveredPages: 4, homepageBody: 7000, pageBody: 1800, headings: 10, pageHeadings: 6 },
  tiny: { discoveredPages: 2, homepageBody: 3500, pageBody: 1000, headings: 8, pageHeadings: 5 }
};

function getBusinessPromptTier(tier = "normal") {
  return BUSINESS_PROMPT_TIERS[tier] || BUSINESS_PROMPT_TIERS.normal;
}

function buildAuthErrorMessage(settings, error) {
  const providerLabel = PROVIDER_LABELS[settings.provider] || settings.provider;
  return `Authentication failed for ${providerLabel}. Please check your API key.`;
}

const activeOperations = new Map();

function getOperationSignal(operationId) {
  if (!operationId) return null;
  let controller = activeOperations.get(operationId);
  if (!controller || controller.signal.aborted) {
    controller = new AbortController();
    activeOperations.set(operationId, controller);
  }
  return controller.signal;
}

function completeOperation(operationId) {
  if (operationId) activeOperations.delete(operationId);
}

function abortOperation(operationId) {
  const controller = activeOperations.get(operationId);
  if (!controller) return false;
  controller.abort();
  activeOperations.delete(operationId);
  return true;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("Analysis stopped.", "AbortError");
  }
}

function normalizeStopError(error) {
  if (error?.name === "AbortError") return "Analysis stopped.";
  return error?.message || String(error);
}

async function analyzeWithApi(settings, promptBuilder, isEmployeeAnalysis = false, signal = null) {
  throwIfAborted(signal);
  const providerOrder = getProviderFallbackOrder(settings);
  const providerErrors = [];

  for (const provider of providerOrder) {
    try {
      throwIfAborted(signal);
      return await analyzeWithProvider({ ...settings, provider }, promptBuilder, isEmployeeAnalysis, signal);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      providerErrors.push(`${PROVIDER_LABELS[provider] || provider}: ${error.message || error}`);
    }
  }

  throw new Error(`All configured providers failed. ${providerErrors.join(" | ")}`);
}

async function analyzeWithProvider(settings, promptBuilder, isEmployeeAnalysis = false, signal = null) {
  throwIfAborted(signal);
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

  if (settings.provider === "ollama" && providerKeys.length === 0 && isLocalOllamaBaseUrl(settings.ollamaBaseUrl)) {
    providerKeys.push("local-ollama");
  }

  if (["groq", "gemini", "ollama"].includes(settings.provider) && providerKeys.length === 0) {
    throw new Error(`Missing API key for ${PROVIDER_LABELS[settings.provider] || settings.provider}.`);
  }

  let currentAttempt = 0;
  while (currentAttempt < candidates.length) {
    throwIfAborted(signal);
    const model = candidates[currentAttempt];
    const activeKey = pickAvailableKey(providerKeys, model);

    if (!activeKey) {
      const wait = msUntilAnyKeyAvailable(providerKeys, model);
      if (wait > 0) {
        await sleep(wait);
        throwIfAborted(signal);
        continue;
      }
      throw new Error("All API keys are currently rate-limited.");
    }

    const promptTiers = ["normal", "small", "tiny"];
    for (const tier of promptTiers) {
      try {
        throwIfAborted(signal);
        const maxTokens = isEmployeeAnalysis ? getEmployeePromptTier(tier).completionTokens : (tier === "normal" ? 1400 : tier === "small" ? 1100 : 900);
        const result = await requestModel(settings, promptBuilder(tier), model, maxTokens, activeKey, isEmployeeAnalysis ? "employee" : "business", signal);
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

function deriveWebsiteSignalsFromPageData(pageData = {}) {
  const signals = [];
  const root = pageData || {};
  const discoveredPages = Array.isArray(root.discoveredPages) ? root.discoveredPages : [];
  const allPages = [root, ...discoveredPages].filter(Boolean);
  const allPeople = allPages.flatMap((page) => page.people || []);
  const allTeamSnippets = allPages.flatMap((page) => page.teamSnippets || []);
  const allEmails = new Set(allPages.flatMap((page) => page.extractedEmails || page.emails || []));
  const allPhones = new Set(allPages.flatMap((page) => page.extractedPhones || page.phones || []));
  const allHeadings = allPages.flatMap((page) => page.headings || []).map((heading) => String(heading || "").toLowerCase());
  const structuredOrganizations = allPages.flatMap((page) => page.structuredData?.organizations || []);
  const structuredContacts = allPages.flatMap((page) => page.structuredData?.contacts || []);

  if (discoveredPages.length > 0) signals.push(`Reviewed ${discoveredPages.length + 1} internal page(s).`);
  if (allPeople.length >= 3) signals.push(`Visible team footprint with ${Math.min(allPeople.length, 99)} people signals.`);
  if (allTeamSnippets.length > 0 || allHeadings.some((text) => /(team|leadership|staff|our people)/i.test(text))) {
    signals.push("Team or leadership content is present.");
  }
  if (allEmails.size > 0 || allPhones.size > 0 || structuredContacts.length > 0) {
    signals.push("Direct contact channels are published on-site.");
  }
  if (structuredOrganizations.length > 0) {
    signals.push("Structured organization metadata is embedded (JSON-LD).");
  }
  if (allHeadings.some((text) => /(services|solutions|capabilities|offerings|products)/i.test(text))) {
    signals.push("Service-oriented navigation and offering terms are visible.");
  }

  return signals.join(" ");
}

function shouldTryNextModel(error) {
  const text = `${error?.message || ""} ${error?.responseText || ""}`;
  if (error?.status === 413 || /request entity too large|request_too_large|reduce the length of the messages|context_length|maximum context|too many tokens/i.test(text)) return true;
  if (/json_validate_failed|failed to generate json|failed_generation|max completion tokens reached before generating a valid document|model returned invalid json/i.test(text)) return true;
  if (/requires a subscription|upgrade for access|subscription.*required/i.test(text)) return true;
  if (/model.*not found|model.*unavailable|not available/i.test(text)) return true;
  return false;
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
    sourcePageType: classifySourcePageType(person?.sourceUrl || person?.url || ""),
    bio: person?.bio || person?.summary || person?.description || "",
    confidence: person?.confidence || "medium"
  };
}

function classifySourcePageType(url) {
  const value = String(url || "").toLowerCase();
  if (!value) return "unknown";
  if (/\/(our-team|team|people|staff|leadership|profile|our-team)\b/.test(value)) return "team_profile";
  if (/\/(testimonial|reviews|review)\b/.test(value)) return "testimonial";
  if (/\/(about|about-us)\b/.test(value)) return "about";
  if (/\/(commercial|residential|property-management|properties|leasing|sales)\b/.test(value)) return "service_or_listing";
  return "other";
}

function buildDeterministicPeopleSnapshot(pageData = {}, maxPeople = 300) {
  const basePeople = Array.isArray(pageData.people) ? pageData.people : [];
  const discoveredPeople = (pageData.discoveredPages || []).flatMap((page) => page.people || []);
  return dedupePeople([...basePeople, ...discoveredPeople]).slice(0, maxPeople).map((person) => compactPerson(person));
}

function buildEmployeeResearchPayload(pageData = {}, tier = "normal") {
  const limits = getEmployeePromptTier(tier);
  const pages = [pageData, ...(pageData.discoveredPages || [])].filter(Boolean);
  const deterministicCandidates = buildDeterministicPeopleSnapshot(pageData, limits.totalPeople);
  const hasStrongDeterministicCandidates = deterministicCandidates.length >= 40;
  const bodyCharBudget = hasStrongDeterministicCandidates
    ? Math.max(900, Math.floor(limits.pageBody * 0.55))
    : limits.pageBody;
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
      sourcePageType: classifySourcePageType(page.url || ""),
      headings: (page.headings || []).slice(0, limits.headings),
      description: truncateText(page.description, limits.description),
      teamSnippets: (page.teamSnippets || []).slice(0, 3).map((snippet) => truncateText(snippet, limits.snippetChars)),
      people: (page.people || []).slice(0, limits.peoplePerPage).map((person) => compactPerson({ ...person, sourceUrl: person.sourceUrl || page.url })),
      structuredData: compactStructuredDataForPrompt(page.structuredData, limits),
      bodyText: truncateText(page.bodyText, bodyCharBudget)
    };
  });

  return {
    company: {
      title: pageData.title || "",
      url: pageData.url || "",
      description: truncateText(pageData.description, limits.description)
    },
    deterministicCandidates,
    extractedPeople: people.slice(0, limits.totalPeople),
    teamSnippets: teamSnippets.slice(0, limits.snippets),
    emails: [...emails].slice(0, limits.emails),
    phones: [...phones].slice(0, limits.phones),
    pages: relevantPages
  };
}

function buildBusinessPrompt(pageData = {}, tier = "normal") {
  const limits = getBusinessPromptTier(tier);
  const payload = {
    title: pageData.title || "",
    url: pageData.url || "",
    description: pageData.description || "",
    headings: (pageData.headings || []).slice(0, limits.headings),
    metadata: pageData.metadata || {},
    structuredData: pageData.structuredData || {},
    bodyText: truncateText(pageData.bodyText, limits.homepageBody),
    discoveredPages: (pageData.discoveredPages || []).slice(0, limits.discoveredPages).map((page) => ({
      title: page.title || "",
      url: page.url || "",
      headings: (page.headings || []).slice(0, limits.pageHeadings),
      bodyText: truncateText(page.bodyText, limits.pageBody)
    }))
  };

  return `Analyze this website research payload and return only the requested business JSON schema.\n\nRequired fields include businessType, industry, services, confidence, summary, evidence, and websiteSignals.\nwebsiteSignals must be a single concise string describing observable signals from the website, or an empty string if none are visible.\nServices must be clear customer-facing service names, not one-word navigation labels when a clearer name is possible.\nKeep services to at most 10 entries and evidence to at most 8 short entries.\n\nResearch payload:\n${JSON.stringify(payload, null, 2)}`;
}

function buildBusinessChunks(pageData = {}, pagesPerChunk = 2) {
  const homepage = { ...pageData, discoveredPages: [] };
  const discovered = Array.isArray(pageData.discoveredPages) ? pageData.discoveredPages.filter(Boolean) : [];
  if (!discovered.length) {
    return [{ index: 1, total: 1, pageData: { ...homepage, discoveredPages: [] }, pages: [{ title: homepage.title || "", url: homepage.url || "" }] }];
  }

  const chunks = [];
  for (let index = 0; index < discovered.length; index += pagesPerChunk) {
    const chunkPages = discovered.slice(index, index + pagesPerChunk);
    chunks.push({
      index: chunks.length + 1,
      total: Math.ceil(discovered.length / pagesPerChunk),
      pageData: { ...homepage, discoveredPages: chunkPages },
      pages: chunkPages.map((page) => ({ title: page.title || "", url: page.url || "" }))
    });
  }
  return chunks;
}

function mergeBusinessChunkResults(chunkResults = [], pageData = {}) {
  const successful = chunkResults.filter((item) => item && item.result && !item.error);
  if (!successful.length) {
    throw new Error("All business analysis chunks failed.");
  }

  const pickBest = successful
    .map((item) => item.result)
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))[0];

  const services = [...new Set(successful.flatMap((item) => item.result.services || []).map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 12);
  const evidence = [...new Set(successful.flatMap((item) => item.result.evidence || []).map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 16);
  const websiteSignalsJoined = [...new Set(successful.map((item) => String(item.result.websiteSignals || "").trim()).filter(Boolean))].join(" ");

  const merged = {
    ...pickBest,
    services,
    evidence,
    websiteSignals: websiteSignalsJoined || pickBest.websiteSignals || deriveWebsiteSignalsFromPageData(pageData),
    businessChunks: chunkResults.map((item) => ({
      index: item.index,
      total: item.total,
      pages: item.pages || [],
      businessType: item.result?.businessType || "",
      industry: item.result?.industry || "",
      confidence: item.result?.confidence ?? null,
      websiteSignals: item.result?.websiteSignals || "",
      providerUsed: item.result?.providerUsed || "",
      modelUsed: item.result?.modelUsed || "",
      promptTierUsed: item.result?.promptTierUsed || "",
      error: item.error || ""
    }))
  };

  return normalizeBusinessAnalysisResult(merged);
}

async function analyzeBusinessChunked(settings, pageData = {}, signal = null) {
  throwIfAborted(signal);
  const shouldChunk = (pageData?.discoveredPages || []).length > 2 || String(pageData?.bodyText || "").length > 5000;
  if (!shouldChunk) {
    const promptBuilder = (tier = "normal") => buildBusinessPrompt(pageData, tier);
    return analyzeWithApi(settings, promptBuilder, false, signal);
  }

  const chunks = buildBusinessChunks(pageData, 2);
  const analyzed = [];
  for (const chunk of chunks) {
    throwIfAborted(signal);
    try {
      const promptBuilder = (tier = "normal") => buildBusinessPrompt(chunk.pageData, tier);
      const result = normalizeBusinessAnalysisResult(await analyzeWithApi(settings, promptBuilder, false, signal));
      analyzed.push({ ...chunk, result });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      analyzed.push({ ...chunk, error: error.message || String(error) });
    }
  }

  return mergeBusinessChunkResults(analyzed, pageData);
}

function buildEmployeeChunks(pageData = {}, pagesPerChunk = 2) {
  const discovered = Array.isArray(pageData.discoveredPages) ? pageData.discoveredPages.filter(Boolean) : [];
  const homepage = { ...pageData, discoveredPages: [] };
  const allDiscovered = discovered;
  const pages = [homepage, ...allDiscovered].filter(Boolean);
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

function normalizePhoneForKey(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

function normalizeNameForKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildEmployeeEvidenceSnapshot(pageData = {}) {
  const pages = [pageData, ...(Array.isArray(pageData?.discoveredPages) ? pageData.discoveredPages : [])].filter(Boolean);
  const deterministic = buildDeterministicPeopleSnapshot(pageData, 500);
  const crawledUrls = new Set(pages.map((page) => String(page?.url || "").trim()).filter(Boolean));
  const names = new Set();
  const emails = new Set();
  const phones = new Set();

  for (const person of deterministic) {
    const nameKey = normalizeNameForKey(person?.name);
    if (nameKey) names.add(nameKey);
    const emailKey = String(person?.email || "").trim().toLowerCase().replace(/^mailto:/i, "");
    if (emailKey) emails.add(emailKey);
    const phoneKey = normalizePhoneForKey(person?.phone);
    if (phoneKey) phones.add(phoneKey);
  }

  for (const page of pages) {
    for (const email of (page?.extractedEmails || page?.emails || [])) {
      const emailKey = String(email || "").trim().toLowerCase().replace(/^mailto:/i, "");
      if (emailKey) emails.add(emailKey);
    }
    for (const phone of (page?.extractedPhones || page?.phones || [])) {
      const phoneKey = normalizePhoneForKey(phone);
      if (phoneKey) phones.add(phoneKey);
    }
  }

  return { names, emails, phones, crawledUrls };
}

function isLikelyCompanyLinkedin(url) {
  const value = String(url || "").toLowerCase();
  return /linkedin\.com\/company\//.test(value);
}

function filterUngroundedPeople(people = [], pageData = {}) {
  const evidence = buildEmployeeEvidenceSnapshot(pageData);
  const dropped = [];
  const kept = [];

  for (const person of dedupePeople(people || [])) {
    const nameKey = normalizeNameForKey(person?.name);
    const emailKey = String(person?.email || "").trim().toLowerCase().replace(/^mailto:/i, "");
    const phoneKey = normalizePhoneForKey(person?.phone);
    const sourceUrl = String(person?.sourceUrl || "").trim();
    const sourceKnown = !sourceUrl || evidence.crawledUrls.has(sourceUrl);
    const nameSupported = !!nameKey && evidence.names.has(nameKey);
    const emailSupported = !!emailKey && evidence.emails.has(emailKey);
    const phoneSupported = !!phoneKey && evidence.phones.has(phoneKey);

    const allText = [
      pageData?.bodyText || "",
      ...(pageData?.discoveredPages || []).map(p => p.bodyText || "")
    ].join(" ").toLowerCase();

    const titleWords = String(person.title || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3);

    const titleSupported =
      titleWords.length > 0 &&
      titleWords.every(word => allText.includes(word));

    const hasStrongSupport =
      nameSupported ||
      emailSupported ||
      phoneSupported ||
      titleSupported;

    const companyLinkedinOnly = isLikelyCompanyLinkedin(
      person?.linkedinUrl || person?.linkedin
    );

    if ((hasStrongSupport && sourceKnown) && !(companyLinkedinOnly && !emailSupported && !phoneSupported)) {
      kept.push({
        ...person,
        title: titleSupported ? person.title : "",
        email: emailSupported ? person.email : "",
        phone: phoneSupported ? person.phone : ""
      });
    } else {
      dropped.push(person);
    }
  }

  return { kept: dedupePeople(kept), dropped };
}

const ROLE_LIKE_NAME_REGEX = /\b(agent|consultant|manager|director|auctioneer|associate|coordinator|assistant|administrator|administration|reception|officer|executive|founder|principal|advisor|specialist|sales|property|finance|operations|marketing|client|onboarding|general manager)\b/i;

function isLikelyRoleLikeName(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return ROLE_LIKE_NAME_REGEX.test(text);
}

function shouldRunAiNameTitleRepair(result = {}) {
  const people = dedupePeople(result.people || []);
  if (!people.length) return false;
  let roleLikeNameCount = 0;
  for (const person of people) {
    if (isLikelyRoleLikeName(person.name)) roleLikeNameCount += 1;
  }
  return roleLikeNameCount > 0;
}

function buildEmployeeRepairPrompt(employeeResult = {}) {
  const compact = {
    people: dedupePeople(employeeResult.people || []).map((p) => ({
      name: p.name || "",
      title: p.title || "",
      department: p.department || "",
      email: p.email || "",
      phone: p.phone || "",
      linkedin: p.linkedin || p.linkedinUrl || "",
      linkedinUrl: p.linkedinUrl || p.linkedin || "",
      bio: p.bio || "",
      sourceUrl: p.sourceUrl || "",
      confidence: p.confidence || "medium"
    })),
    companyLeadership: dedupePeople(employeeResult.companyLeadership || []).map((p) => ({
      name: p.name || "",
      title: p.title || "",
      department: p.department || "",
      email: p.email || "",
      phone: p.phone || "",
      linkedin: p.linkedin || p.linkedinUrl || "",
      linkedinUrl: p.linkedinUrl || p.linkedin || "",
      bio: p.bio || "",
      sourceUrl: p.sourceUrl || "",
      confidence: p.confidence || "medium"
    })),
    teamSummary: employeeResult.teamSummary || "",
    evidence: employeeResult.evidence || [],
    warnings: employeeResult.warnings || []
  };

  return `Repair this employee JSON so person names and titles are correctly mapped.

Rules:
- name must be a person's real name, not a role label.
- If name contains role text (for example "General Manager", "Sales Consultant"), move that text to title.
- If email clearly indicates a name (example katrina.jardine@...), infer full name and use it.
- Keep only real people records; remove placeholders and non-person rows.
- Preserve valid contact data and sourceUrl.
- Return only valid JSON matching the employee schema.

Input JSON:
${JSON.stringify(compact, null, 2)}`;
}

async function maybeRepairEmployeeResultWithAi(settings, employeeResult = {}, signal = null) {
  if (!shouldRunAiNameTitleRepair(employeeResult)) return employeeResult;
  try {
    throwIfAborted(signal);
    const repairPrompt = buildEmployeeRepairPrompt(employeeResult);
    const repaired = normalizeEmployeeAnalysisResult(await analyzeWithApi(settings, () => repairPrompt, true, signal));
    if ((repaired.people || []).length) {
      return {
        ...employeeResult,
        people: dedupePeople(repaired.people || []),
        companyLeadership: dedupePeople([...(employeeResult.companyLeadership || []), ...(repaired.companyLeadership || [])]),
        teamSummary: repaired.teamSummary || employeeResult.teamSummary || "",
        evidence: [...new Set([...(employeeResult.evidence || []), ...(repaired.evidence || [])])],
        warnings: [...new Set([...(employeeResult.warnings || []), ...(repaired.warnings || []), "Applied AI name/title repair pass."])]
      };
    }
  } catch {
    // Keep original result if repair pass fails.
  }
  return employeeResult;
}

async function analyzeEmployeePageChunk(settings, pageData = {}, chunkMeta = null, signal = null) {
  throwIfAborted(signal);
  const promptBuilder = (tier = "normal") => buildEmployeePrompt(pageData, tier, chunkMeta);
  let result = normalizeEmployeeAnalysisResult(await analyzeWithApi(settings, promptBuilder, true, signal));
  result = await maybeRepairEmployeeResultWithAi(settings, result, signal);
  const groundedPeople = filterUngroundedPeople(result.people || [], pageData);
  const groundedLeadership = filterUngroundedPeople(result.companyLeadership || [], pageData);
  const groundingWarnings = [];
  if (groundedPeople.dropped.length) groundingWarnings.push(`Dropped ${groundedPeople.dropped.length} ungrounded people row(s).`);
  if (groundedLeadership.dropped.length) groundingWarnings.push(`Dropped ${groundedLeadership.dropped.length} ungrounded leadership row(s).`);
  return {
    ...result,
    people: groundedPeople.kept,
    companyLeadership: groundedLeadership.kept,
    warnings: [...new Set([...(result.warnings || []), ...groundingWarnings])],
    providerUsed: result.providerUsed || "",
    modelUsed: result.modelUsed || "",
    promptTierUsed: result.promptTierUsed || ""
  };
}

function mergeEmployeeChunkResults(chunks = [], fallbackPeople = []) {
  const allPeople = []; const allLeadership = []; const warnings = []; const evidence = []; const summaries = [];
  for (const chunk of chunks) {
    const result = normalizeEmployeeAnalysisResult(chunk.result || {});
    allPeople.push(...result.people); allLeadership.push(...result.companyLeadership); warnings.push(...result.warnings); evidence.push(...result.evidence);
    if (result.teamSummary) summaries.push("Chunk " + chunk.index + ": " + result.teamSummary);
  }
  console.log("AI people before dedupe:", allPeople);
  console.log("Fallback crawler people before dedupe:", fallbackPeople);
  console.log("After dedupe:", dedupePeople([...allPeople, ...fallbackPeople]));
  
  let people = dedupePeople(allPeople.length ? [...allPeople, ...fallbackPeople] : fallbackPeople);

  // 🚀 NEW: fallback to crawler people if AI failed
  if (people.length < 3 && fallbackPeople.length > 0) {
    people = dedupePeople(fallbackPeople);
  }
  if (!allPeople.length && fallbackPeople.length) warnings.push("AI returned no people across chunks; showing crawler-extracted people instead.");
  if (allPeople.length && fallbackPeople.length && people.length > allPeople.length) warnings.push("Included additional crawler-extracted people that were not returned by the AI.");
  return {
    people, companyLeadership: dedupePeople(allLeadership), warnings: [...new Set(warnings)], evidence: [...new Set(evidence)], teamSummary: summaries.join("\n"),
    employeeChunks: chunks.map((chunk) => {
      const result = normalizeEmployeeAnalysisResult(chunk.result || {});
      return { index: chunk.index, total: chunk.total, pages: chunk.pages, people: result.people, companyLeadership: result.companyLeadership, warnings: result.warnings, teamSummary: result.teamSummary, providerUsed: chunk.providerUsed || chunk.result?.providerUsed || "", modelUsed: chunk.modelUsed || chunk.result?.modelUsed || "", promptTierUsed: chunk.promptTierUsed || chunk.result?.promptTierUsed || "", error: chunk.error || "" };
    })
  };
}

function htmlToText(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPeopleFromText(text = "", url = "") {
  const people = [];
  const seen = new Set();

  const lines = String(text || "")
    .split(/\n|(?=Image:)|(?=\b[A-Z][a-zA-Z'’\-]+\s+[A-Z][a-zA-Z'’\-]+\s+-\s+)/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const nameTitlePattern =
    /\b([A-Z][a-zA-Z'’\-]+(?:\s+[A-Z][a-zA-Z'’\-]+){1,3})\s*(?:-|–|—|,)\s*((?:Chief|Head|Managing|Executive|General|Director|Manager|Officer|Secretary|CEO|CFO|COO|CTO|President|Founder|Partner)[A-Za-z&,\-/ ]{2,120})/gi;

  for (const line of lines) {
    let match;

    while ((match = nameTitlePattern.exec(line)) !== null) {
      const name = match[1].trim();
      const title = match[2].trim();

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      people.push({
        name,
        title,
        email: "",
        phone: "",
        sourceUrl: url,
        confidence: "high"
      });
    }
  }

  return people.slice(0, 30);
}

async function fetchProfilePage(link) {
  try {
    const res = await fetch(link.href, { credentials: "include" });
    if (!res.ok) return null;

    const html = await res.text();
    const text = htmlToText(html);

    return {
      url: link.href,
      title: link.text || "Profile",
      bodyText: truncateText(text, 6000),
      people: extractPeopleFromText(text, link.href),
      extractedEmails: [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])],
      extractedPhones: [],
      teamSnippets: [truncateText(text, 500)],
      structuredData: {},
      headings: [],
      description: ""
    };
  } catch {
    return null;
  }
}

async function fetchProfilePages(pageData = {}) {
  const links = (pageData.profileLinks || [])
    .filter((link) => link?.href)
    .slice(0, 10);

  const pages = await Promise.all(links.map(fetchProfilePage));
  return pages.filter(Boolean);
}

async function analyzeEmployeeDetailsChunked(settings, pageData = {}, signal = null) {
  const profilePages = await fetchProfilePages(pageData);

  const enrichedPageData = {
    ...pageData,
    discoveredPages: [
      ...(pageData.discoveredPages || []),
      ...profilePages
    ]
  };

  const chunks = buildEmployeeChunks(enrichedPageData, 1);
  const analyzedChunks = [];
  for (const chunk of chunks) {
    throwIfAborted(signal);
    try {
      const promptBuilder = (tier = "normal") => buildEmployeePrompt(chunk.pageData, tier, chunk);
      const result = normalizeEmployeeAnalysisResult(await analyzeWithApi(settings, promptBuilder, true, signal));
      analyzedChunks.push({ ...chunk, result, providerUsed: result.providerUsed, modelUsed: result.modelUsed, promptTierUsed: result.promptTierUsed });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      analyzedChunks.push({ ...chunk, result: { people: [], companyLeadership: [], warnings: ["Chunk " + chunk.index + " failed: " + (error.message || error)] }, error: error.message || String(error) });
    }
  }
  const fallbackPeople = [
    ...(Array.isArray(enrichedPageData?.people) ? enrichedPageData.people : []),
    ...(enrichedPageData?.discoveredPages || []).flatMap((page) => page.people || [])
  ];
  return mergeEmployeeChunkResults(analyzedChunks, fallbackPeople);
}
function buildEmployeePrompt(pageData = {}, tier = "normal", chunk = null) {
  const payload = buildEmployeeResearchPayload(pageData, tier);
  const chunkIntro = chunk ? "This is employee analysis chunk " + chunk.index + " of " + chunk.total + ". Only extract people supported by the pages in this chunk.\nPages in this chunk: " + chunk.pages.map((page) => page.url).filter(Boolean).join(" | ") + "\n\n" : "";
  return `${chunkIntro}Analyze employees and team members from this research payload.\n\nRules:\n- Extract only real staff/leadership people for this company.\n- Start from deterministicCandidates first, then enrich from pages/body text.
- Prioritize candidates from sourcePageType=team_profile or about pages.
- Treat testimonial names, reviewer names, marketing taglines, section labels, listing metadata, and property descriptors as NOT employees.
- A valid person should usually have at least one of: (a) role/title, (b) company email, (c) direct phone, (d) profile/team source URL.
- If name looks like a role label, fix mapping by moving role text to title and inferring name from email when clear.
- Prefer names with job titles, bios, profile URLs, emails, phones, or source URLs.\n- Deduplicate the same person across pages.\n- Use confidence values of high, medium, or low.\n- Include sourceUrl for each person whenever possible.\n- Return only valid JSON matching the employee schema. The top-level people array is required; do not use employees as the field name.
- Keep every person object compact. Use an empty string for unknown fields. Keep bio under 140 characters.
- If many people are present, include all supported names first with short titles/source URLs instead of writing long bios.
- Use bio for role descriptions. companyLeadership must be an array of person objects using the same fields as people, not strings.

Do NOT output entries like:
- company slogans/taglines
- property/listing labels
- review/testimonial author names that are not staff
- generic labels such as "Property Management", "Floor Area", "Tell Us What You Need"\n\nResearch payload:\n${JSON.stringify(payload, null, 2)}`;
}


// Simplified orchestration for the example, but maintains core logic
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "open-side-panel") {
    (async () => {
      try {
        await chrome.sidePanel.open({ windowId: message.windowId });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (message.type === "cancel-analysis") {
    sendResponse({ ok: true, cancelled: abortOperation(message.operationId) });
    return true;
  }

  if (message.type === "analyze-page") {
    (async () => {
      const operationId = message.operationId || "";
      const signal = getOperationSignal(operationId);
      try {
        const settings = await getSettings();
        const result = await analyzeBusinessChunked(settings, message.pageData || {}, signal);
        const websiteSignals = String(result.websiteSignals || "").trim() || deriveWebsiteSignalsFromPageData(message.pageData || {});
        const enriched = { ...result, websiteSignals };
        await setLatestResult(enriched);
        sendResponse({ ok: true, result: enriched });
      } catch (e) {
        sendResponse({ ok: false, error: normalizeStopError(e), stopped: e?.name === "AbortError" });
      } finally {
        completeOperation(operationId);
      }
    })();
    return true;
  }

  if (message.type === "analyze-employee-details") {
    (async () => {
      const operationId = message.operationId || "";
      const signal = getOperationSignal(operationId);
      try {
        const settings = await getSettings();
        const result = await analyzeEmployeeDetailsChunked(settings, message.pageData || {}, signal);
        const latest = await getLatestResult();
        const merged = { ...latest, ...result, employeeAnalysisComplete: true };
        await setLatestResult(merged);
        sendResponse({ ok: true, result: merged });
      } catch (e) {
        sendResponse({ ok: false, error: normalizeStopError(e), stopped: e?.name === "AbortError" });
      } finally {
        completeOperation(operationId);
      }
    })();
    return true;
  }

  if (message.type === "analyze-employee-page-chunk") {
    (async () => {
      const operationId = message.operationId || "";
      const signal = getOperationSignal(operationId);
      try {
        const settings = await getSettings();
        const pageData = message.pageData || {};
        const chunkMeta = message.chunkMeta || null;
        const result = await analyzeEmployeePageChunk(settings, pageData, chunkMeta, signal);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: normalizeStopError(e), stopped: e?.name === "AbortError" });
      } finally {
        completeOperation(operationId);
      }
    })();
    return true;
  }
});
