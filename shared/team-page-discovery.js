import { ROLE_KEYWORDS, SOURCE_CONTEXT_TERMS, buildWordBoundaryRegex } from "./role-taxonomy.js";

const TEAM_DISCOVERY_TERMS = [
  ...SOURCE_CONTEXT_TERMS,
  "agents",
  "brokers",
  "realtors",
  "advisors",
  "professionals",
  "directors",
  "executives",
  "leaders",
  "locations",
  "office",
  "offices",
  "contact"
];

export const TEAM_PAGE_KEYWORD_REGEX = buildWordBoundaryRegex(TEAM_DISCOVERY_TERMS, "i");
export const EMPLOYEE_PROFILE_LINK_REGEX = /(\/agent[s]?\/[^\/?#]+|\/profile[s]?\/[^\/?#]+|\/people\/[^\/?#]+|\/staff\/[^\/?#]+|\/team\/[^\/?#]+|\/member[s]?\/[^\/?#]+|\/bio[s]?\/[^\/?#]+|\/realtor[s]?\/[^\/?#]+|\/broker[s]?\/[^\/?#]+|[?&](agent|profile|person|id)=\w+)/i;
export const ROLE_KEYWORD_REGEX = buildWordBoundaryRegex(ROLE_KEYWORDS, "i");

const NON_HTML_RESOURCE_EXT = /\.(pdf|png|jpe?g|gif|webp|svg|zip|rar|7z|mp4|mp3|wav|avi|mov|m4a|docx?|xlsx?|pptx?)$/i;

function hasPartialKeyword(text = "") {
  return /(team|management|leadership|staff|people|director|executive)/i.test(text);
}

function isSupportedUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

export function getSiteRoot(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}/`;
}

export function toCanonicalUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

export function toCanonicalPageKey(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname
    .replace(/\/+/g, "/")
    .replace(/\/index\.(html?|php|asp|aspx)$/i, "/");
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return `${parsed.origin}${parsed.pathname}`;
}

export function isCrawlableUrl(url) {
  if (!isSupportedUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return !NON_HTML_RESOURCE_EXT.test(parsed.pathname || "");
  } catch {
    return false;
  }
}

export function isDirectTeamLink(link = {}) {
  const text = String(link.text || "").toLowerCase();
  const href = String(link.href || link.url || "").toLowerCase();
  return TEAM_PAGE_KEYWORD_REGEX.test(text) || TEAM_PAGE_KEYWORD_REGEX.test(href);
}

export function scoreLink(link, origin, focus = "business") {
  try {
    const parsed = new URL(link.href || link.url || "");
    if (parsed.origin !== origin) return -1;
    let score = 0;
    const haystack = `${link.text || ""} ${parsed.pathname}`.toLowerCase();

    if (link.source === "nav") score += 6;
    if (link.source === "menu") score += 6;
    if (link.source === "footer") score += 4;
    if (link.source === "sitemap") score += 5;
    if (link.source === "profile") score += 8;
    if (link.source === "pagination") score += focus === "employee" ? 6 : 0;

    if (focus === "employee") {
      const isHighValue =
        TEAM_PAGE_KEYWORD_REGEX.test(haystack) ||
        ROLE_KEYWORD_REGEX.test(haystack) ||
        hasPartialKeyword(haystack) ||
        /(ourteam|meettheteam|ourpeople|whoweare)/i.test(haystack);
      const isProfile = EMPLOYEE_PROFILE_LINK_REGEX.test(parsed.pathname + parsed.search);
      const isAbout = /\b(about|about-?us|company|our-?story|overview|who-?we-?are)\b/i.test(haystack);
      const isContact = /\b(contact|locations?|offices?)\b/i.test(haystack);
      const isNoise = /\b(blog|news|press|jobs|careers|products|services|pricing|faq|support|category|article)\b/i.test(parsed.pathname);
      const isEmployeeNoise =
        /\b(awards|careers|supplier|portal|code-of-conduct|privacy|terms|faq|villages|property-search|register-your-interest|social-responsibility|modern-slavery)\b/i.test(parsed.pathname);

      if (isProfile) score += 22;
      else if (isHighValue) score += 20;
      else if (isAbout) score += 10;
      else if (isContact) score += 5;

      if (isNoise || isEmployeeNoise) score -= 30;
    } else {
      const isServices = /\b(services?|solutions?|what-?we-?do|capabilities|offerings?|products?|expertise|specialties|practice-?areas)\b/i.test(haystack);
      const isAbout = /\b(about|company|about-?us|our-?story|who-?we-?are|overview)\b/i.test(haystack);
      const isPortfolio = /\b(industries|clients|portfolio|case-?studies|projects|results|work)\b/i.test(haystack);
      const isNoise = /\b(blog|news|press|jobs|careers|faq|support|help|team|people|staff|agents)\b/i.test(parsed.pathname);

      if (isServices) score += 20;
      else if (isAbout) score += 12;
      else if (isPortfolio) score += 8;

      if (isNoise) score -= 10;
    }

    if (parsed.pathname === "/" || parsed.pathname === "") score += focus === "employee" ? 1 : 6;
    if (parsed.hash) score -= 3;
    return score;
  } catch {
    return -1;
  }
}

export function buildCandidateUrls(pageData, maxPages, focus = "business") {
  const origin = new URL(pageData.url).origin;
  const explicitLinks = [
    ...(pageData.links || []),
    ...(pageData.profileLinks || []).map((link) => ({ text: link.text || "Profile", href: link.href, source: "profile" })),
    ...(pageData.paginationLinks || []).map((href) => ({ text: "Next page", href, source: "pagination" }))
  ];
  const rankedLinks = explicitLinks
    .map((link) => ({ ...link, score: scoreLink(link, origin, focus) }))
    .filter((link) => link.score > 0)
    .sort((a, b) => b.score - a.score);
  const seedUrls = focus === "employee" ? [pageData.url] : [pageData.url, getSiteRoot(pageData.url)];
  const urls = [...seedUrls];
  for (const link of rankedLinks) {
    if (!urls.includes(link.href)) urls.push(link.href);
    if (urls.length >= maxPages + 2) break;
  }
  return [...new Set(urls)].slice(0, maxPages);
}

export function buildEmployeeFallbackUrls(siteUrl, links = [], maxPages = 14) {
  const origin = new URL(siteUrl).origin;
  const normalizedLinks = (links || [])
    .map((link) => ({
      text: link.text || "",
      href: link.href || link.url || "",
      source: link.source || "cached"
    }))
    .filter((link) => {
      try {
        return link.href && new URL(link.href).origin === origin;
      } catch {
        return false;
      }
    });

  const rankedLinks = normalizedLinks
    .map((link) => ({ ...link, score: scoreLink(link, origin, "employee") }))
    .filter((link) => link.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((link) => link.href);

  const commonPaths = [
    "/about-us",
    "/about-us/",
    "/about",
    "/about/",
    "/about-us/leadership",
    "/about-us/leadership/",
    "/about-us/management-team",
    "/about-us/management-team/",
    "/about-us/executive-team",
    "/about-us/executive-team/",
    "/about-us/meet-our-team",
    "/about-us/meet-our-team/",
    "/about-us/meet-the-team",
    "/about-us/meet-the-team/",
    "/about-us/our-team",
    "/about-us/team",
    "/about/meet-the-team",
    "/about/meet-the-team/",
    "/about/our-team",
    "/about/our-team/",
    "/about/team",
    "/about/team/",
    "/agents",
    "/agents/",
    "/agent",
    "/agent/",
    "/consultants",
    "/consultants/",
    "/meet-our-team",
    "/meet-our-team/",
    "/meet-the-team",
    "/meet-the-team/",
    "/our-team",
    "/our-team/",
    "/team",
    "/team/",
    "/people",
    "/staff",
    "/team-members",
    "/contact"
  ].map((path) => `${origin}${path}`);

  return [...new Set([...rankedLinks, ...commonPaths])].slice(0, maxPages);
}

export function gatherInternalLinks(pageData, rootOrigin, focus = "employee") {
  const explicitLinks = [
    ...(pageData?.links || []),
    ...(pageData?.profileLinks || []).map((link) => ({ text: link.text || "Profile", href: link.href, source: "profile" })),
    ...(pageData?.paginationLinks || []).map((href) => ({ text: "Next page", href, source: "pagination" }))
  ];
  const ranked = explicitLinks
    .map((link) => {
      const href = link?.href || link?.url || "";
      const text = String(link?.text || "").trim();

      if (focus === "employee") {
        try {
          const parsed = new URL(href);
          if (parsed.origin !== rootOrigin) return { href, score: -1 };
          const haystack = `${parsed.pathname} ${text}`.toLowerCase();
          const isEmployeeProfile = EMPLOYEE_PROFILE_LINK_REGEX.test(parsed.pathname + parsed.search);
          const isPagination = link?.source === "pagination";
          if (
            !TEAM_PAGE_KEYWORD_REGEX.test(haystack) &&
            !hasPartialKeyword(haystack) &&
            !isEmployeeProfile &&
            !isPagination
          ) {
            return { href, score: -1 };
          }
        } catch {
          return { href, score: -1 };
        }
      }

      return {
        href,
        score: scoreLink({ href, text, source: link?.source || "body" }, rootOrigin, focus)
      };
    })
    .filter((link) => link.score > -1 && isCrawlableUrl(link.href))
    .sort((a, b) => b.score - a.score)
    .map((link) => link.href);

  return [...new Set(ranked)];
}

export function filterTeamCandidateUrlsFromHomepage(links, rootOrigin, maxPages = 25) {
  const ranked = (links || [])
    .map((link) => {
      const href = link?.href || link?.url || "";
      const text = String(link?.text || "").trim();
      const source = link?.source || "body";
      try {
        const parsed = new URL(href);
        if (parsed.origin !== rootOrigin) return null;
        if (!isCrawlableUrl(parsed.toString())) return null;
        const haystack = `${parsed.pathname} ${text}`.toLowerCase();
        if (
          !TEAM_PAGE_KEYWORD_REGEX.test(haystack) &&
          !hasPartialKeyword(haystack) &&
          !EMPLOYEE_PROFILE_LINK_REGEX.test(parsed.pathname + parsed.search)
        ) return null;
        return {
          href: toCanonicalUrl(parsed.toString()),
          score: scoreLink({ href, text, source }, rootOrigin, "employee")
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const deduped = [];
  const seen = new Set();
  for (const item of ranked) {
    const key = toCanonicalPageKey(item.href);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item.href);
    if (deduped.length >= maxPages) break;
  }

  return deduped;
}

export function buildTeamDiscoveryPlan(homepage, options = {}) {
  const maxCrawlPages = Math.max(1, Number(options.maxCrawlPages) || 8);
  const homepageLinks = homepage?.links || [];
  const rootOrigin = new URL(homepage.url).origin;
  const directTeamLinks = homepageLinks.filter(isDirectTeamLink);
  const seedUrls = [
    ...filterTeamCandidateUrlsFromHomepage(homepageLinks, rootOrigin, maxCrawlPages),
    ...buildEmployeeFallbackUrls(homepage.url, homepageLinks, maxCrawlPages * 2)
  ];

  if (homepageLinks.length <= 5) {
    return {
      homepageLinks,
      directTeamLinks,
      seedUrls,
      dynamicDepth: 1,
      dynamicMaxPages: Math.max(1, homepageLinks.length),
      status: "Micro-site detected. Starting fast shallow scan..."
    };
  }

  if (directTeamLinks.length > 0) {
    return {
      homepageLinks,
      directTeamLinks,
      seedUrls,
      dynamicDepth: 2,
      dynamicMaxPages: Math.min(maxCrawlPages, directTeamLinks.length + 8),
      status: "Found direct team links. Starting targeted crawl..."
    };
  }

  if (homepageLinks.length > 80) {
    return {
      homepageLinks,
      directTeamLinks,
      seedUrls,
      dynamicDepth: 3,
      dynamicMaxPages: maxCrawlPages,
      status: "Large site structure detected. Starting deep crawl..."
    };
  }

  return {
    homepageLinks,
    directTeamLinks,
    seedUrls,
    dynamicDepth: 2,
    dynamicMaxPages: maxCrawlPages,
    status: "Standard site detected. Starting adaptive crawl..."
  };
}
