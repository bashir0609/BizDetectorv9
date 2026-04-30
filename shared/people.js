export function normalizePeople(people) {
  return (people || [])
    .map((person) => {
      if (!person || typeof person !== "object") {
        return null;
      }
      const linkedinValue = person.linkedinUrl || person.linkedin || person.linkedIn || person.profileUrl || "";
      const normalized = repairNameTitleFields({
        name: normalizePersonName(person.name),
        title: String(person.title || person.role || "").trim(),
        department: String(person.department || "").trim(),
        email: String(person.email || "").trim(),
        phone: normalizePhoneValue(person.phone),
        linkedinUrl: String(linkedinValue || "").trim(),
        linkedin: String(linkedinValue || "").trim(),
        bio: String(person.bio || person.summary || person.description || "").trim(),
        confidence: String(person.confidence || "").trim(),
        sourceUrl: String(person.sourceUrl || person.url || "").trim(),
        sourceTitle: String(person.sourceTitle || "").trim()
      });
      return isUsablePerson(normalized) ? normalized : null;
    })
    .filter(Boolean);
}

function normalizePhoneValue(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep original text if decode fails.
  }
  text = text
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function normalizePersonName(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();

  if (!text) return "";

  // Convert ALL CAPS names to Title Case
  if (/^[A-Z\s'’.-]+$/.test(text)) {
    return text
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  return text;
}

const ROLE_LIKE_REGEX = /\b(agent|consultant|manager|director|auctioneer|associate|coordinator|administrator|administration|assistant|reception|officer|lead|leader|executive|founder|principal|advisor|specialist|sales|property|finance|operations|marketing|client|onboarding|general manager)\b/i;

function looksLikeRoleText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return ROLE_LIKE_REGEX.test(text);
}

function looksLikePersonName(value) {
  const text = String(value || "").trim();
  if (!text || /\d/.test(text) || /<[^>]+>/.test(text)) return false;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;

  return words.every((word, index) =>
    /^[A-Z][a-zA-Z'’.-]+$/.test(word) ||
    (index > 0 && /^(van|von|de|del|da|di|la|le|du)$/i.test(word))
  );
}

function toTitleCaseWord(word) {
  return word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : "";
}

function deriveNameFromEmail(email) {
  const cleaned = String(email || "").trim().replace(/^mailto:/i, "");
  const local = cleaned.split("@")[0] || "";
  if (!local) return "";
  const parts = local
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => /^[a-z][a-z]+$/i.test(part));
  if (parts.length < 2 || parts.length > 4) return "";
  const candidate = parts.map(toTitleCaseWord).join(" ");
  return looksLikePersonName(candidate) ? candidate : "";
}

function cleanTitle(title = "", name = "") {
  let value = String(title || "").replace(/\s+/g, " ").trim();
  const firstName = String(name || "").split(/\s+/)[0];

  // Stop when bio starts repeating the person's first name.
  if (firstName) {
    value = value.split(new RegExp(`\\b${firstName}\\b`, "i"))[0].trim();
  }

  // Stop at common bio sentence starts.
  value = value.split(/\b(has worked|has over|is an|is a|leads|with more than|in her current role)\b/i)[0].trim();

  return value
    .replace(/[.,;:–—-]+$/g, "")
    .trim()
    .slice(0, 120);
}

function repairNameTitleFields(person) {
  const repaired = { ...person };
  let name = String(repaired.name || "").trim();
  let title = String(repaired.title || "").trim();
  const derivedName = deriveNameFromEmail(repaired.email);

  // Swap when name/title are clearly reversed.
  if (looksLikeRoleText(name) && looksLikePersonName(title)) {
    const temp = name;
    name = title;
    title = temp;
  }

  // Recover missing real name when "name" is actually a role.
  if (looksLikeRoleText(name) && derivedName) {
    if (!title) title = name;
    name = derivedName;
  }

  // If title duplicates name, keep cleaner single source of truth.
  if (title && name && title.toLowerCase() === name.toLowerCase()) {
    title = "";
  }

  title = cleanTitle(title, name);

  repaired.name = name;
  repaired.title = title;
  return repaired;
}

function looksLikeNonPersonLabel(name = "", title = "") {
  const n = String(name || "").trim();
  const t = String(title || "").trim();

  // Browser / CMS / missing-page labels
  if (/\b(page not found|not found|404|error page|access denied|forbidden)\b/i.test(n)) {
    return true;
  }

  // Navigation / action labels
  if (/^(visit|view|read|learn|contact|download|register|explore|discover|about|award|year|privacy|terms|policy|supplier|portal|career|careers|faq)\b/i.test(n)) {
    return true;
  }

  // Page/content labels
  if (/\b(story|history|award|awards|village|villages|manager of the year|policy|portal|supplier|privacy|terms|faq)\b/i.test(n)) {
    return true;
  }

  // Address/location rows
  if (/\b(street|road|rd|avenue|ave|drive|dr|lane|ln|boulevard|blvd|highway|hwy|suite|level|floor|postcode|postal|suburb)\b/i.test(n)) {
    return true;
  }

  // Title is not a job title
  if (/^[A-Z]{2,}$/.test(t)) return true; // VIC, NSW, USA etc.
  if (/^(victoria|new south wales|queensland|tasmania|australia|melbourne|sydney|brisbane|adelaide|perth)$/i.test(t)) {
    return true;
  }

  // Title/email field is actually contact text or a paragraph
  if (/@/.test(t)) return true;
  if (t.length > 140 || /\b(is owned by|click here|learn more|read more|visit|award history|terms and conditions)\b/i.test(t)) {
    return true;
  }

  return false;
}

function isUsablePerson(person) {
  const name = String(person?.name || "").trim();
  const nameWords = name.split(/\s+/).filter(Boolean);

  if (!name) return false;

  if (looksLikeNonPersonLabel(name, person?.title)) {
    return false;
  }

  const email = String(person?.email || "").toLowerCase();
  if (/^(supplier|info|contact|hello|admin|support|sales|enquiries|inquiries)/i.test(email)) {
    return false;
  }

  const hasContext = Boolean(
    person?.title ||
    person?.email ||
    person?.phone ||
    person?.linkedinUrl
  );

  if (nameWords.length < 2 && !hasContext) return false;
  if (nameWords.length > 5) return false;

  if (!nameWords.every((word, index) =>
    /^[A-Z][a-zA-Z'’.-]+$/.test(word) ||
    (index > 0 && /^(van|von|de|del|da|di|la|le|du)$/i.test(word))
  )) {
    return false;
  }

  if (/\b(john doe|jane smith|test user|example|sample)\b/i.test(name)) {
    return false;
  }

  if (/<[^>]+>/.test(name) || /<[^>]+>/.test(String(person?.title || ""))) {
    return false;
  }

  if (/[\$%]/.test(name)) return false;
  if (/\d/.test(name)) return false;

  if (nameWords.length <= 2 && looksLikeRoleText(name) && !person?.title && !person?.email) {
    return false;
  }

  const sourceUrl = String(person?.sourceUrl || "");
  const hasContact = Boolean(person?.email || person?.phone || person?.linkedinUrl);
  const hasTitle = Boolean(person?.title) && looksLikeRoleText(person.title);

  function isExplicitTeamSourceUrl(url = "") {
    const value = String(url || "").toLowerCase();

    return /(team|staff|people|leadership|management|executive|ourstaff|our-staff|profile|bio|meet-our|about-us|about)/i.test(value);
  }

  if (nameWords.length === 1 && !hasContact && !hasTitle && !isExplicitTeamSourceUrl(sourceUrl)) {
    return false;
  }

  if (!hasContact && !hasTitle && !isExplicitTeamSourceUrl(sourceUrl)) {
    return false;
  }

  return true;
}

function mergePerson(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (!merged[key] && value) merged[key] = value;
  }
  return merged;
}

function normalizeEmailKey(value) {
  return String(value || "")
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
}

export function dedupePeople(people) {
  const map = new Map();
  const emailToPrimaryKey = new Map();
  for (const person of normalizePeople(people)) {
    const fallbackKey = person.name.toLowerCase();
    const emailKey = normalizeEmailKey(person.email);

    // 1) Email-first dedupe: same email should always represent the same person record.
    const existingEmailPrimary = emailKey ? emailToPrimaryKey.get(emailKey) : null;
    if (existingEmailPrimary && map.has(existingEmailPrimary)) {
      map.set(existingEmailPrimary, mergePerson(map.get(existingEmailPrimary), person));
      continue;
    }

    // 2) Fallback dedupe when email is missing.
    if (!map.has(fallbackKey)) {
      map.set(fallbackKey, person);
      if (emailKey) emailToPrimaryKey.set(emailKey, fallbackKey);
    } else {
      map.set(fallbackKey, mergePerson(map.get(fallbackKey), person));
      if (emailKey) emailToPrimaryKey.set(emailKey, fallbackKey);
    }
  }
  return [...map.values()];
}
