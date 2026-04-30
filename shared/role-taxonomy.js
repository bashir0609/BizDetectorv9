export const PERSON_NAME_BLOCKLIST_TERMS = [
  "run",
  "extraction",
  "scraping",
  "crawler",
  "pipeline",
  "consultation",
  "inquiries",
  "service",
  "services",
  "solution",
  "solutions",
  "pricing",
  "project",
  "projects",
  "case studies",
  "monitoring",
  "maps",
  "directory",
  "directories",
  "engine",
  "intelligence",
  "platform",
  "managed",
  "data cleaning",
  "lead enrichment",
  "technical",
  "support",
  "why us",
  "about us",
  "meet our",
  "our team",
  "team details",
  "global",
  "large-scale",
  "static web"
];

export const TITLE_BLOCKLIST_TERMS = [
  ...PERSON_NAME_BLOCKLIST_TERMS,
  "anti-bot bypass",
  "web scraping",
  "google maps",
  "local data"
];

export const SOURCE_CONTEXT_TERMS = [
  "team",
  "people",
  "staff",
  "leadership",
  "management",
  "executive",
  "founder",
  "director",
  "advisor",
  "about",
  "who-we-are",
  "our-team",
  "meet-the-team",
  "bio",
  "profile",
  "member",
  "contact"
];

export const ROLE_KEYWORDS = [
  // Executive & leadership
  "ceo", "cfo", "coo", "cto", "cmo", "cio", "chro", "cpo", "cco", "cdo",
  "vp", "avp", "svp", "chief executive officer", "founder", "co-founder",
  "president", "managing director", "director", "manager", "agent", "partner", "principal", "chairman", "board member",
  // Technology & IT
  "developer", "programmer", "coder", "qa tester", "it support", "technician",
  "architect", "engineering manager", "devops", "product owner",
  // Finance & banking
  "analyst", "clerk", "teller", "bookkeeper", "auditor", "associate",
  "controller", "fund manager", "portfolio manager", "actuary",
  // Healthcare
  "nurse", "caregiver", "medical assistant", "lpn", "cna", "phlebotomist",
  "physician", "surgeon", "hospital administrator", "clinic manager",
  // Construction
  "laborer", "carpenter", "electrician", "plumber", "welder", "mason",
  "foreman", "site supervisor", "project manager", "estimator",
  // Education
  "teacher", "tutor", "instructor", "teaching assistant", "adjunct",
  "dean", "professor", "superintendent", "registrar",
  // Hospitality & retail
  "server", "host", "bartender", "barista", "concierge", "housekeeper",
  "executive chef", "event manager", "hotel manager", "sommelier",
  "cashier", "representative", "bdr", "sdr", "merchant",
  "store manager", "area manager", "merchandiser", "account executive",
  // Support & administrative
  "administrative assistant", "receptionist", "secretary", "office manager",
  "data entry", "office clerk", "file clerk", "recruiter", "hr generalist",
  "people ops", "talent acquisition", "benefits manager", "support specialist",
  "customer success manager", "help desk", "client service coordinator",
  // Modern / creative / agile
  "growth hacker", "evangelist", "strategist", "storyteller", "demand gen manager",
  "art director", "ux/ui designer", "ui/ux designer", "multimedia animator",
  "content creator", "brand ambassador", "scrum master", "agile coach",
  "product lead", "delivery manager"
];

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toWordBoundaryAlternation(terms) {
  return terms
    .map((term) => String(term || "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
}

export function buildWordBoundaryRegex(terms, flags = "i") {
  return new RegExp(`\\b(${toWordBoundaryAlternation(terms)})\\b`, flags);
}
