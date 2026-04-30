import { normalizePeople } from "./people.js";

export function trimText(value, limit = 1000) {
  const maxLength = Math.max(0, Number(limit) || 0);
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function cleanTextForAi(value, maxChars = 1000) {
  const maxLength = Math.max(0, Number(maxChars) || 0);
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
  return deduped.join("\n").slice(0, maxLength);
}

export function compactStructuredData(data, limits = {}) {
  const source = data || {};
  return {
    organizations: (source.organizations || []).slice(0, limits.organizations ?? 4),
    contacts: (source.contacts || []).slice(0, limits.contacts ?? 6),
    addresses: (source.addresses || []).slice(0, limits.addresses ?? 4),
    socialLinks: (source.socialLinks || []).slice(0, limits.socialLinks ?? 8)
  };
}

export function compactPageData(page = {}, options = {}) {
  const bodyLimit = options.employeeBodyChars ?? 2400;
  const textCleaner = options.cleanBodyText ? cleanTextForAi : trimText;
  return {
    title: page.title,
    url: page.url,
    description: trimText(page.description, 160),
    headings: (page.headings || []).slice(0, 6),
    people: normalizePeople(page.people).slice(0, 200),
    profileLinks: (page.profileLinks || []).slice(0, 100),
    paginationLinks: (page.paginationLinks || []).slice(0, 20),
    structuredData: compactStructuredData(page.structuredData),
    extractedEmails: (page.extractedEmails || []).slice(0, 20),
    extractedPhones: (page.extractedPhones || []).slice(0, 20),
    extractionStats: page.extractionStats || null,
    teamSnippets: (page.teamSnippets || []).slice(0, 8).map((item) => textCleaner(item, 260)),
    bodyText: textCleaner(page.bodyText, bodyLimit)
  };
}

export function compactResearchPayload(pageData = {}, options = {}) {
  const isEmployee = Boolean(options.isEmployee);
  const maxPages = options.maxPages ?? 8;
  const employeeBodyChars = options.employeeBodyChars ?? 2400;
  const summaryBodyChars = options.summaryBodyChars ?? 1000;
  const discoveredPages = (pageData.discoveredPages || [])
    .slice(0, maxPages)
    .map((page) => compactPageData(page, { employeeBodyChars, cleanBodyText: options.cleanBodyText }));

  return {
    title: pageData.title,
    url: pageData.url,
    description: trimText(pageData.description, 180),
    headings: (pageData.headings || []).slice(0, 8),
    metadata: Object.fromEntries(Object.entries(pageData.metadata || {}).slice(0, 8)),
    bodyText: trimText(pageData.bodyText, isEmployee ? employeeBodyChars : summaryBodyChars),
    people: normalizePeople(pageData.people || []).slice(0, isEmployee ? 200 : 100),
    profileLinks: (pageData.profileLinks || []).slice(0, 100),
    paginationLinks: (pageData.paginationLinks || []).slice(0, 20),
    structuredData: compactStructuredData(pageData.structuredData),
    extractedEmails: (pageData.extractedEmails || []).slice(0, 30),
    extractedPhones: (pageData.extractedPhones || []).slice(0, 30),
    extractionStats: pageData.extractionStats || null,
    teamSnippets: (pageData.teamSnippets || []).slice(0, 4).map((item) => trimText(item, 120)),
    discoveredPages
  };
}
