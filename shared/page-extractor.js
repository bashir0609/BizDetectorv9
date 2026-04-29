(function () {
  // v10: Enhanced team page expansion with scroll, load-more, and pagination support
  async function expandTeamPage() {
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const loadMorePatterns = /^(load more|show more|view more|see more|more agents|more team members|more people|more staff|next page|load more team|load more agents|show all|view all)$/i;
    const nextLinkPatterns = /^(next|›|»|next page|next ›|page \d+)$/i;
    
    let previousCount = 0;
    const maxRounds = 10;
    const employeeCardSelectors = [
      "[class*='team'] article", "[class*='team'] li",
      "[class*='staff'] article", "[class*='staff'] li",
      "[class*='people'] article", "[class*='people'] li",
      "[class*='member'] article", "[class*='member'] li",
      "[class*='card']", "[class*='employee-card']",
      "[class*='agent-card']", "[class*='profile-card']",
      "[class*='person-card']", "[class*='bio-card']",
      "[role='listitem']", "[data-type='person']", "[data-entity='person']"
    ].join(", ");
    
    // Phase 1: Scroll expansion for infinite scroll
    for (let i = 0; i < maxRounds; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1000);
      
      const currentCount = document.querySelectorAll(employeeCardSelectors).length;
      
      if (currentCount <= previousCount && i >= 2) break;
      previousCount = currentCount;
    }
    
    // Phase 2: Click load-more buttons
    previousCount = 0;
    for (let i = 0; i < maxRounds; i++) {
      const buttons = Array.from(document.querySelectorAll("button, a, div[role='button'], span[role='button'], input[type='button']"));
      const loadMoreBtn = buttons.find(btn => loadMorePatterns.test((btn.innerText || btn.textContent || "").trim()));
      
      if (loadMoreBtn) {
        loadMoreBtn.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(600);
        loadMoreBtn.click();
        await sleep(1500);
        
        // After click, also scroll to trigger any lazy loading
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(800);
      }
      
      const currentCount = document.querySelectorAll(employeeCardSelectors).length;
      
      if (currentCount <= previousCount && !loadMoreBtn) break;
      previousCount = currentCount;
    }
    
    // Phase 3: Check for pagination links (next page)
    const paginationLinks = Array.from(document.querySelectorAll("a[href]"))
      .filter(link => nextLinkPatterns.test((link.innerText || link.textContent || "").trim()));
    
    if (paginationLinks.length > 0) {
      // Mark that pagination exists (caller can decide to follow)
      window.__btdHasPagination = true;
      window.__btdPaginationLinks = paginationLinks.slice(0, 5).map(l => l.href);
    }
    
    // Final scroll to ensure all content is loaded
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(1200);
    window.scrollTo(0, 0);
    await sleep(500);
  }

  // v10: Discover profile links from current page
  function discoverProfileLinks() {
    const profilePatterns = [
      /\/agent[s]?\/[^\/]+/i,
      /\/profile[s]?\/[^\/]+/i,
      /\/people\/[^\/]+/i,
      /\/staff\/[^\/]+/i,
      /\/team\/[^\/]+/i,
      /\/member[s]?\/[^\/]+/i,
      /\/bio[s]?\/[^\/]+/i,
      /\/realtor[s]?\/[^\/]+/i,
      /\/broker[s]?\/[^\/]+/i,
      /[?&](agent|profile|person|id)=\w+/i
    ];
    
    const seen = new Set();
    const results = [];
    
    const links = Array.from(document.querySelectorAll("a[href]"));
    for (const link of links) {
      const href = link.href;
      if (!href || seen.has(href)) continue;
      
      const matchesPattern = profilePatterns.some(p => p.test(href));
      if (!matchesPattern) continue;
      
      // Skip non-internal links
      try {
        const parsed = new URL(href);
        if (parsed.origin !== location.origin) continue;
      } catch {
        continue;
      }
      
      seen.add(href);
      results.push({
        href,
        text: (link.innerText || link.textContent || "").trim().slice(0, 100),
        source: location.href
      });
      
      if (results.length >= 100) break;
    }
    
    return results;
  }

  // v10: Coverage scoring for extraction completeness
  function calculateCoverageScore(people, pageData) {
    const score = {
      total: 0,
      factors: {},
      warnings: [],
      recommendations: []
    };
    
    // Factor 1: People found vs expected signals
    const hasTeamSection = /[tT]eam|[sS]taff|[pP]eople|[lL]eadership|[aA]gents|[rR]ealtors/.test(pageData.bodyText || "");
    const hasMultipleProfiles = people.length >= 3;
    const hasContactInfo = people.some(p => p.email || p.phone);
    const hasTitles = people.some(p => p.title);
    const hasLinkedin = people.some(p => p.linkedinUrl);
    
    if (hasTeamSection && people.length === 0) {
      score.warnings.push("Team section detected but no employees extracted");
      score.recommendations.push("Try expanding the page or checking for JavaScript-rendered content");
    }
    
    // Factor 2: Data completeness per person
    const completeProfiles = people.filter(p => {
      const fields = [p.name, p.title, p.email, p.phone].filter(Boolean);
      return fields.length >= 2;
    }).length;
    
    const completenessRatio = people.length > 0 ? completeProfiles / people.length : 0;
    
    // Factor 3: Source diversity
    const uniqueSources = new Set(people.map(p => p.sourceUrl)).size;
    
    // Calculate score (0-100)
    let rawScore = 0;
    
    if (hasTeamSection) rawScore += 20;
    else rawScore += 10; // No team section mentioned, might be OK
    
    if (hasMultipleProfiles) rawScore += 25;
    else if (people.length > 0) rawScore += 15;
    
    if (hasContactInfo) rawScore += 15;
    if (hasTitles) rawScore += 15;
    if (hasLinkedin) rawScore += 10;
    
    rawScore += Math.round(completenessRatio * 15);
    rawScore += Math.min(10, uniqueSources * 2);
    
    score.total = Math.min(100, rawScore);
    
    score.factors = {
      hasTeamSection,
      hasMultipleProfiles,
      hasContactInfo,
      hasTitles,
      hasLinkedin,
      completenessRatio: Math.round(completenessRatio * 100),
      uniqueSources
    };
    
    // Add recommendations based on gaps
    if (!hasContactInfo && people.length > 0) {
      score.recommendations.push("Consider extracting contact info from profile pages");
    }
    if (!hasLinkedin && people.length > 0) {
      score.recommendations.push("LinkedIn profiles not found - may need manual research");
    }
    if (completenessRatio < 0.5 && people.length > 0) {
      score.recommendations.push("Many profiles incomplete - try deeper extraction");
    }
    if (uniqueSources <= 1 && people.length > 5) {
      score.recommendations.push("All profiles from single page - may have missed paginated content");
    }
    
    return score;
  }

  function textValue(node) {
    return node?.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  function collectVisibleText(limit = 25000) {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const chunks = [];
    const seen = new Set();
    let total = 0;
    while (walker.nextNode()) {
      const value = walker.currentNode.nodeValue?.replace(/\s+/g, " ").trim();
      if (!value) continue;
      const parent = walker.currentNode.parentElement;
      if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push(value);
      total += value.length + 1;
      if (total > limit) break;
    }
    return chunks.join(" ");
  }

  function collectVisibleLines(limit = 30000) {
    const text = (document.body || document.documentElement)?.innerText || "";
    const lines = [];
    let total = 0;
    for (const line of text.split(/\r?\n/)) {
      const value = line.replace(/\s+/g, " ").trim();
      if (!value) continue;
      lines.push(value);
      total += value.length + 1;
      if (total > limit) break;
    }
    return lines;
  }

  function collectMetadata() {
    const meta = {};
    for (const element of document.querySelectorAll("meta[name], meta[property]")) {
      const key = element.getAttribute("name") || element.getAttribute("property");
      const value = element.getAttribute("content");
      if (key && value) meta[key] = value;
    }
    return meta;
  }

  function walkJson(value, visitor) {
    if (!value || typeof value !== "object") return;
    visitor(value);
    if (Array.isArray(value)) {
      for (const item of value) walkJson(item, visitor);
      return;
    }
    for (const nested of Object.values(value)) walkJson(nested, visitor);
  }

  function normalizeLinkedinUrl(value) {
    const text = String(value || "").trim();
    return /linkedin\.com/i.test(text) ? text : "";
  }

  function normalizeEmail(value) {
    const match = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0] : "";
  }

  function normalizePhone(value) {
    const text = String(value || "").trim();
    if (/[a-zA-Z]{3,}/.test(text)) return "";
    const digits = text.replace(/[^\d+]/g, "");
    return digits.length >= 7 && digits.length <= 16 ? text : "";
  }

  function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function firstText(...values) {
    for (const value of values.flat(Infinity)) {
      if (typeof value === "string" && value.trim()) return value.trim();
      if (value && typeof value === "object" && typeof value.name === "string" && value.name.trim()) {
        return value.name.trim();
      }
    }
    return "";
  }

  function typeList(node) {
    return asArray(node?.["@type"]).map((type) => String(type || "").toLowerCase());
  }

  function normalizeAddress(address) {
    if (!address) return null;
    if (typeof address === "string") {
      const text = address.trim();
      return text ? { text } : null;
    }
    if (typeof address !== "object") return null;
    const normalized = {
      streetAddress: firstText(address.streetAddress),
      addressLocality: firstText(address.addressLocality),
      addressRegion: firstText(address.addressRegion),
      postalCode: firstText(address.postalCode),
      addressCountry: firstText(address.addressCountry),
      text: firstText(address.name, address.address)
    };
    if (!Object.values(normalized).some(Boolean)) return null;
    return normalized;
  }

  function normalizeSocialLinks(value) {
    return asArray(value)
      .flatMap((item) => typeof item === "string" ? [item] : asArray(item?.url || item?.sameAs))
      .map((url) => String(url || "").trim())
      .filter((url) => /^https?:\/\//i.test(url))
      .slice(0, 20);
  }

  function isLikelyPersonName(name) {
    if (!name || name.length < 4 || name.length > 60) return false;
    const words = name.trim().split(/\s+/);
    if (words.length < 2 || words.length > 5) return false;
    if (!words.every((word) => /^[A-Z]/.test(word))) return false;
    const uiPhrases = /^(contact|home|about|services|our|the|get|learn|read|view|see|click|sign|log|call|email|send|submit|next|back|more|buy|sell|rent|find|search|menu|close|open|toggle|follow|share|book|request|download|upload|register|login|join|apply|explore|discover|navigate|skip|go to|back to|return|continue|cancel|confirm|yes|no|ok|done|save|edit|delete|add|remove|new|all|other|team|staff|people|company|office|phone|fax|address|website|social|media|news|blog|events|gallery|portfolio|careers|faqs?|privacy|terms|copyright|sitemap|policy)/i;
    if (uiPhrases.test(name.trim())) return false;
    if (/^(agent|sales|consultant|manager|director|executive|specialist|officer|coordinator)$/i.test(name.trim())) return false;
    return !/[0-9@#$%^&*()_+=\[\]{};:"<>?\/|]/.test(name);
  }

  function mergePeople(people) {
    const merged = new Map();
    for (const person of people) {
      const name = String(person?.name || "").trim();
      if (!name || !isLikelyPersonName(name)) continue;
      const key = name.toLowerCase();
      const current = merged.get(key) || {
        name,
        title: "",
        email: "",
        phone: "",
        linkedinUrl: "",
        sourceUrl: "",
        sourceTitle: ""
      };
      current.title = current.title || String(person.title || "").trim();
      current.email = current.email || normalizeEmail(person.email);
      current.phone = current.phone || normalizePhone(person.phone);
      current.linkedinUrl = current.linkedinUrl || normalizeLinkedinUrl(person.linkedinUrl);
      current.sourceUrl = current.sourceUrl || String(person.sourceUrl || location.href).trim();
      current.sourceTitle = current.sourceTitle || String(person.sourceTitle || document.title).trim();
      merged.set(key, current);
    }
    return [...merged.values()].slice(0, 80);
  }

  function collectPeopleFromJsonLd() {
    const people = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const payload = JSON.parse(script.textContent || "null");
        walkJson(payload, (node) => {
          const typeValue = node["@type"];
          const types = Array.isArray(typeValue) ? typeValue : [typeValue];
          if (!types.includes("Person")) return;
          const name = String(node.name || "").trim();
          const title = String(node.jobTitle || node.roleName || node.description || "").trim();
          if (!name) return;
          people.push({
            name,
            title,
            email: node.email || "",
            phone: node.telephone || "",
            linkedinUrl: node.sameAs || node.url || "",
            sourceUrl: location.href,
            sourceTitle: document.title
          });
        });
      } catch { }
    }
    return people;
  }

  function collectStructuredDataFromJsonLd() {
    const organizations = [];
    const contacts = [];
    const addresses = [];
    const socialLinks = new Set();
    const organizationTypes = new Set([
      "organization", "localbusiness", "professionalservice", "corporation",
      "realestateagent", "legalservice", "medicalbusiness", "financialservice",
      "store", "restaurant", "lodgingbusiness", "homeandconstructionbusiness"
    ]);

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const payload = JSON.parse(script.textContent || "null");
        walkJson(payload, (node) => {
          if (!node || typeof node !== "object") return;
          const types = typeList(node);
          const isOrganization = types.some((type) => organizationTypes.has(type));
          if (isOrganization) {
            const organization = {
              name: firstText(node.name, node.legalName),
              type: asArray(node["@type"]).map((type) => String(type || "").trim()).filter(Boolean).join(", "),
              url: firstText(node.url),
              description: firstText(node.description),
              telephone: firstText(node.telephone, node.phone),
              email: firstText(node.email),
              address: normalizeAddress(node.address),
              sourceUrl: location.href
            };
            if (Object.values(organization).some(Boolean)) organizations.push(organization);
          }

          for (const contact of asArray(node.contactPoint)) {
            if (!contact || typeof contact !== "object") continue;
            const normalized = {
              contactType: firstText(contact.contactType),
              name: firstText(contact.name),
              telephone: firstText(contact.telephone, contact.phone),
              email: firstText(contact.email),
              areaServed: firstText(contact.areaServed),
              sourceUrl: location.href
            };
            if (Object.values(normalized).some(Boolean)) contacts.push(normalized);
          }

          const address = normalizeAddress(node.address);
          if (address) addresses.push({ ...address, sourceUrl: location.href });

          for (const url of normalizeSocialLinks(node.sameAs || node.url)) {
            socialLinks.add(url);
          }
        });
      } catch { }
    }

    return {
      organizations: dedupeObjects(organizations, (item) => `${item.name}|${item.url}|${item.telephone}`).slice(0, 8),
      contacts: dedupeObjects(contacts, (item) => `${item.contactType}|${item.name}|${item.telephone}|${item.email}`).slice(0, 12),
      addresses: dedupeObjects(addresses, (item) => `${item.streetAddress}|${item.addressLocality}|${item.postalCode}|${item.text}`).slice(0, 8),
      socialLinks: [...socialLinks].slice(0, 20)
    };
  }

  function dedupeObjects(items, keyFn) {
    const seen = new Set();
    const results = [];
    for (const item of items) {
      const key = keyFn(item).toLowerCase();
      if (!key.trim() || seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }
    return results;
  }

  function collectPeopleFromDom() {
    const people = [];
    const containerSelectors = [
      "[class*='team']", "[id*='team']", "[class*='staff']", "[id*='staff']",
      "[class*='people']", "[id*='people']", "[class*='person']", "[id*='person']",
      "[class*='member']", "[id*='member']", "[class*='leader']", "[id*='leader']",
      "[class*='leadership']", "[id*='leadership']", "[class*='executive']", "[id*='executive']",
      "[class*='director']", "[id*='director']", "[class*='founder']", "[id*='founder']",
      "[class*='management']", "[id*='management']", "[class*='advisor']", "[id*='advisor']",
      "[class*='board']", "[id*='board']", "[class*='profile']", "[id*='profile']",
      "[class*='bio']", "[id*='bio']", "[class*='employee']", "[id*='employee']",
      "[class*='about']", "[id*='about']", "[class*='crew']", "[id*='crew']",
      "[class*='partner']", "[id*='partner']"
    ];
    const seen = new Set();
    const teamContainers = Array.from(document.querySelectorAll(containerSelectors.join(","))).slice(0, 40);
    for (const container of teamContainers) {
      const cards = Array.from(container.querySelectorAll("article, li, [class*='card'], [class*='item'], [class*='entry'], div, section")).slice(0, 60);
      for (const card of cards) {
        const cardText = textValue(card);
        if (cardText.length > 600) continue;
        const name = textValue(card.querySelector("h1, h2, h3, h4, h5, h6, strong, b, [class*='name'], [itemprop='name']")) || textValue(card.querySelector("a"));
        if (!isLikelyPersonName(name) || seen.has(name.toLowerCase())) continue;
        const role = textValue(card.querySelector("[class*='title'], [class*='role'], [class*='position'], [class*='designation'], [class*='job'], [itemprop='jobTitle'], p, span, small, em"));
        const emailLink = card.querySelector("a[href^='mailto:']");
        const phoneLink = card.querySelector("a[href^='tel:']");
        const linkedinLink = Array.from(card.querySelectorAll("a[href]")).find((link) => /linkedin\.com/i.test(link.href));
        seen.add(name.toLowerCase());
        people.push({
          name,
          title: role && role !== name ? role.slice(0, 120) : "",
          email: emailLink?.href?.replace(/^mailto:/i, "") || normalizeEmail(cardText),
          phone: phoneLink?.href?.replace(/^tel:/i, "") || normalizePhone(cardText),
          linkedinUrl: linkedinLink?.href || "",
          sourceUrl: location.href,
          sourceTitle: document.title
        });
        if (people.length >= 40) return mergePeople(people);
      }
    }
    return mergePeople(people);
  }

  function collectPeopleFromDirectoryLines(lines) {
    const people = [];
    const roleKeywords = /(principal|licensed|estate agent|property|consultant|associate|assistant|manager|leasing|specialist|accountant|concierge|administration|commercial|sales|director|founder|partner|advisor|officer|coordinator|executive)/i;
    const stopPattern = /^(email|image|get in touch|quick links|what some|buyer|seller|tenant|landlord|google|call|send|contact|address)$/i;
    for (let i = 0; i < lines.length; i += 1) {
      const name = lines[i];
      if (!isLikelyPersonName(name)) continue;
      const windowLines = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 9); j += 1) {
        const line = lines[j];
        if (isLikelyPersonName(line) || stopPattern.test(line)) break;
        windowLines.push(line);
      }
      const hasContactSignal = windowLines.some((line) => /^(m|mobile|p|phone|tel|telephone)\s*[: ]/i.test(line) || normalizePhone(line) || normalizeEmail(line));
      const role = windowLines.find((line) => roleKeywords.test(line) && !/^(m|mobile|p|phone|tel|telephone|email)\s*[: ]/i.test(line)) || "";
      if (!hasContactSignal && !role) continue;
      const mobileLine = windowLines.find((line) => /^(m|mobile)\s*[: ]/i.test(line));
      const phoneLine = mobileLine || windowLines.find((line) => /^(p|phone|tel|telephone)\s*[: ]/i.test(line)) || windowLines.find((line) => normalizePhone(line));
      people.push({
        name,
        title: role.slice(0, 120),
        email: normalizeEmail(windowLines.join(" ")),
        phone: normalizePhone(String(phoneLine || "").replace(/^(m|mobile|p|phone|tel|telephone)\s*[: ]\s*/i, "")),
        linkedinUrl: "",
        sourceUrl: location.href,
        sourceTitle: document.title
      });
    }
    return mergePeople(people);
  }

  function collectPeopleFromText() {
    const lines = collectVisibleLines(30000);
    const directoryPeople = collectPeopleFromDirectoryLines(lines);
    const text = lines.join(" ");
    const matches = [];
    const dashPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z.'\-]+){1,3})\s*[-\u2013\u2014|]\s*([A-Z][A-Za-z/&(),'\-.\s]{2,80})/g;
    const commaPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z.'\-]+){1,3}),\s*([A-Z][A-Za-z/&(),'\-.\s]{4,80})/g;
    const roleKeywords = /(founder|co-founder|ceo|cto|cfo|coo|cmo|director|manager|lead|head|principal|partner|consultant|engineer|designer|advisor|president|chair|vp |vice president|staff|operations|marketing|sales|specialist|officer|associate|analyst|coordinator|executive|secretary|treasurer)/i;
    for (const pattern of [dashPattern, commaPattern]) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1].trim();
        const role = match[2].trim();
        if (!roleKeywords.test(role) || !isLikelyPersonName(name)) continue;
        matches.push({ name, title: role, email: "", phone: "", linkedinUrl: "", sourceUrl: location.href, sourceTitle: document.title });
        if (matches.length >= 30) break;
      }
    }
    return mergePeople([...directoryPeople, ...matches]);
  }

  function collectTeamSnippets() {
    const snippets = [];
    const keywordPattern = /(team|staff|leadership|founder|about us|about|management|employee|our people|who we are)/i;
    for (const node of document.querySelectorAll("section, article, div")) {
      const idClass = `${node.id || ""} ${node.className || ""}`;
      const heading = textValue(node.querySelector("h1, h2, h3, h4"));
      if (!keywordPattern.test(`${idClass} ${heading}`)) continue;
      const text = textValue(node).slice(0, 240);
      if (text) snippets.push(text);
      if (snippets.length >= 6) break;
    }
    return snippets;
  }

  function collectLinks() {
    const seen = new Set();
    const results = [];
    function addLinks(nodes, source) {
      for (const node of nodes) {
        const href = node.href;
        const text = textValue(node);
        if (!href || !text || seen.has(href)) continue;
        seen.add(href);
        results.push({ text, href, source });
      }
    }
    const navSelectors = ["nav", "header nav", "[role='navigation']", "[class*='navbar']", "[class*='nav-bar']", "[class*='navigation']", "[class*='menu']", "[id*='menu']", "[id*='nav']", "header", "[class*='header']"];
    for (const selector of navSelectors) addLinks(document.querySelectorAll(`${selector} a[href]`), "nav");
    const footerSelectors = ["footer", "[role='contentinfo']", "[class*='footer']", "[id*='footer']"];
    for (const selector of footerSelectors) addLinks(document.querySelectorAll(`${selector} a[href]`), "footer");
    const sitemapSelectors = ["[class*='sitemap']", "[id*='sitemap']", "[class*='site-map']", "[id*='site-map']"];
    for (const selector of sitemapSelectors) addLinks(document.querySelectorAll(`${selector} a[href]`), "sitemap");
    const profileSelectors = ["[class*='agent'] a", "[class*='staff'] a", "[class*='team'] a", "[class*='member'] a", "[class*='profile'] a", "[class*='people'] a", "[class*='person'] a", "[class*='consultant'] a", "[class*='advisor'] a"];
    for (const selector of profileSelectors) addLinks(document.querySelectorAll(selector), "profile");
    addLinks(document.querySelectorAll("a[href]"), "body");
    return results.slice(0, 200);
  }

  function extractPageData() {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((node) => textValue(node))
      .filter(Boolean)
      .slice(0, 20);
    const extractedEmails = [...new Set(Array.from(document.querySelectorAll('a[href^="mailto:"]'))
      .map((node) => node.href.replace(/^mailto:/i, "").split("?")[0].trim())
      .filter((value) => value.includes("@")))];
    const extractedPhones = [...new Set(Array.from(document.querySelectorAll('a[href^="tel:"]'))
      .map((node) => node.href.replace(/^tel:/i, "").trim())
      .filter(Boolean))];
    const schemaPeople = collectPeopleFromJsonLd();
    const domPeople = collectPeopleFromDom();
    const textPeople = collectPeopleFromText();
    const people = mergePeople([...schemaPeople, ...domPeople, ...textPeople]);
    const structuredData = collectStructuredDataFromJsonLd();
    
    // v10: Also discover profile links during extraction
    const discoveredProfileLinks = discoverProfileLinks();
    
    return {
      title: document.title,
      url: location.href,
      description: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
      headings,
      links: collectLinks(),
      metadata: collectMetadata(),
      bodyText: collectVisibleText(25000),
      people,
      structuredData,
      extractedEmails,
      extractedPhones,
      teamSnippets: collectTeamSnippets(),
      discoveredProfileLinks, // v10: Include discovered profile links
      extractionStats: {
        peopleFromJsonLd: schemaPeople.length,
        peopleFromDom: domPeople.length,
        peopleFromText: textPeople.length,
        mergedPeople: people.length,
        organizationsFromJsonLd: structuredData.organizations.length,
        contactsFromJsonLd: structuredData.contacts.length,
        addressesFromJsonLd: structuredData.addresses.length
      }
    };
  }

  globalThis.BTDPageExtractor = {
    extractPageData,
    expandTeamPage,
    discoverProfileLinks,
    calculateCoverageScore
  };
})();
