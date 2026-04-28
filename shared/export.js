import { normalizePeople } from "./people.js";

export const CSV_HEADER = [
  "analyzedAt",
  "title",
  "url",
  "businessType",
  "industry",
  "confidence",
  "services",
  "people",
  "employeeNames",
  "employeeTitles",
  "employeeDepartments",
  "employeeEmails",
  "employeePhones",
  "employeeLinkedInUrls",
  "employeeSourceUrls",
  "employeeConfidence",
  "employeeBios",
  "companyLeadership",
  "employeeChunks",
  "warnings",
  "teamSummary",
  "summary",
  "evidence",
  "websiteSignals"
];

export function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function joinPeopleField(people, field) {
  return normalizePeople(people).map((person) => person[field]).filter(Boolean).join(" | ");
}

function formatChunks(chunks) {
  return (chunks || []).map((chunk) => {
    const pages = (chunk.pages || []).map((page) => page.url).filter(Boolean).join(" + ");
    const people = formatPeople(chunk.people || []);
    return "Chunk " + (chunk.index || "?") + "/" + (chunk.total || "?") + " [" + pages + "]: " + people;
  }).join(" | ");
}

function formatPeople(people) {
  return normalizePeople(people).map((person) => [
    person.name,
    person.title,
    person.department,
    person.email,
    person.phone,
    person.linkedinUrl,
    person.sourceUrl,
    person.confidence,
    person.bio
  ].filter(Boolean).join(" - ")).join(" | ");
}

export function buildCsvRow(entry, options = {}) {
  const summaryFields = options.summaryBeforeTeam
    ? [entry.summary, entry.teamSummary]
    : [entry.teamSummary, entry.summary];
  const people = normalizePeople(entry.people);
  const leadership = normalizePeople(entry.companyLeadership || []);

  return [
    entry.analyzedAt,
    entry.title,
    entry.url,
    entry.businessType,
    entry.industry,
    entry.confidence,
    (entry.services || []).join(" | "),
    formatPeople(people),
    joinPeopleField(people, "name"),
    joinPeopleField(people, "title"),
    joinPeopleField(people, "department"),
    joinPeopleField(people, "email"),
    joinPeopleField(people, "phone"),
    joinPeopleField(people, "linkedinUrl"),
    joinPeopleField(people, "sourceUrl"),
    joinPeopleField(people, "confidence"),
    joinPeopleField(people, "bio"),
    formatPeople(leadership),
    formatChunks(entry.employeeChunks || []),
    (entry.warnings || entry.employeeWarnings || []).join(" | "),
    ...summaryFields,
    (entry.evidence || []).join(" | "),
    entry.websiteSignals
  ].map(csvEscape).join(",");
}

export function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
