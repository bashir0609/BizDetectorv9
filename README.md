# Business Type Detector

Business Type Detector is a Chrome extension that analyzes websites with Large Language Models (LLMs) to classify a company's business type, services, industry, and team structure. It combines page crawling, deterministic extraction, and AI-assisted analysis to produce business and employee intelligence from public website content.

## Features

### Business Classification

- Detects the website's business type, industry, and customer-facing services.
- Produces a concise company overview, confidence score, and evidence-backed classification.
- Identifies useful website signals such as service focus, market positioning, contact intent, and local or industry-specific language.

### Employee and Team Extraction

- Runs a dedicated **Analyze Employees** workflow after business analysis.
- Finds and crawls likely team, staff, leadership, management, executive, profile, bio, and about pages.
- Extracts people from multiple sources:
  - visible DOM team/profile cards
  - page text patterns such as `Name - Title`
  - JSON-LD structured data
  - profile links and team-related internal pages
- Supports team members without public contact details when a real name and title are found on a team, leadership, management, executive, about, or profile page.
- Deduplicates people by name and merges stronger records when the same person appears across multiple pages.
- Cleans long title/bio text so entries such as `Chief Executive Officer Nathan has worked...` become `Chief Executive Officer`.
- Filters obvious non-person rows such as navigation labels, policy pages, 404 pages, address rows, generic contact rows, and placeholder names.
- Prevents hallucinated contact data by requiring email, phone, and LinkedIn fields to appear in the source payload before keeping them.

### AI-Powered Analysis

- Uses LLMs to normalize and summarize extracted website data.
- Grounds employee extraction in source content rather than guessing missing contact details.
- Produces team summaries, company leadership lists, warnings, evidence, and chunk-level extraction details.
- Supports multiple prompt tiers to handle large pages and rate-limited providers.

### Crawling and Discovery

- Performs targeted internal crawling for business pages and employee/team pages.
- Scores links based on business relevance or employee/team relevance.
- Supports adaptive crawl depth and page limits.
- Expands team pages by scrolling, clicking load-more buttons, and detecting pagination links.
- Crawls profile links when team pages expose individual profile URLs.

### Results Management

- **Popup UI**: quick website analysis and result viewing.
- **Side Panel**: persistent view of the latest result.
- **Dashboard**: dedicated page for provider settings, keyword triggers, analysis progress, people tables, raw JSON, and exports.
- **Export**: export analyzed results as JSON or CSV.

### Provider Support

- **Groq**: high-speed cloud inference.
- **Gemini**: Google AI Studio integration.
- **Ollama**: hosted Ollama Cloud with an API key, or local Ollama at `http://localhost:11434` without an API key.
- **Jan**: local Jan AI model support when configured.

## How It Works

1. **Homepage Extraction**  
   The extension reads visible text, headings, metadata, links, emails, phones, structured data, and initial people signals from the current website.

2. **Business Page Discovery**  
   It selects a small set of likely business-related pages, such as services, solutions, products, about, company, industry, or portfolio pages.

3. **Business Classification**  
   The collected business payload is sent to the selected LLM provider. The model returns business type, industry, services, summary, confidence, evidence, and website signals.

4. **Employee Page Discovery**  
   When **Analyze Employees** runs, the extension finds likely team-related pages using team, staff, people, leadership, management, executive, profile, bio, and about-page signals.

5. **People Extraction**  
   The extension extracts deterministic candidate people from DOM cards, visible text, JSON-LD, contact links, and profile pages.

6. **AI Employee Analysis**  
   The LLM receives the extracted candidates and page content, then returns normalized people, leadership, team summary, evidence, and warnings.

7. **Grounding and Cleanup**  
   The extension removes unsupported fake fields, merges duplicate people, cleans titles, drops non-person rows, and preserves real team members even when no public email or phone is available.

## Output Data

Typical analysis results include:

- business type
- industry
- services
- confidence score
- company overview
- evidence
- website signals
- team summary
- people/team table
- company leadership
- employee warnings
- crawl coverage
- raw JSON result

People records may include:

```json
{
  "name": "Nathan Cockerill",
  "title": "Chief Executive Officer",
  "department": "",
  "email": "",
  "phone": "",
  "linkedinUrl": "",
  "sourceUrl": "https://example.com/about-us/management-team",
  "confidence": "high",
  "bio": ""
}
```

## Setup

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the extension folder.
4. Open the extension popup or dashboard.
5. Choose a provider and configure the required API key or local model URL:
   - Groq API key
   - Gemini API key
   - Ollama Cloud API key or local Ollama URL
   - Jan local model URL/model name
6. Click **Analyze Current Tab** or enter a target URL in the dashboard.
7. After business analysis completes, click **Analyze Employees** to extract people and team details.

## Recommended Usage

- Start with **Analyze Current Tab** on the company homepage.
- Use **Analyze Employees** after the business profile is available.
- Review employee warnings when a site has limited public staff information or only generic contact details.
- Treat email, phone, and LinkedIn values as source-grounded only when the extension keeps them in the final table.
- Use exported CSV/JSON for downstream lead research, CRM enrichment, or manual review.

## Notes and Limitations

- Some websites hide team data behind JavaScript, protected APIs, image-only cards, or third-party widgets. The extension attempts scroll/load-more expansion but may still miss content that is not exposed to the page.
- The extension should not invent missing contact details. Empty email, phone, or LinkedIn fields usually mean the source content did not expose those values.
- Generic contact numbers or company emails may be detected but should not be treated as direct employee contact details unless clearly tied to an individual.
- AI analysis improves normalization and summarization, but deterministic extraction and grounding rules are used to reduce hallucinated people and fake contact data.

## Development Tips

- Reload the extension from `chrome://extensions` after editing source files.
- Open the extension dashboard DevTools to inspect dashboard logs.
- Open the service worker DevTools from `chrome://extensions` to inspect background/service-worker logs.
- Open the website tab DevTools to inspect page-extractor behavior.
- If employee extraction looks wrong, check the raw JSON, employee warnings, and chunk-level results first.

## Project Goal

The goal is to provide a universal website intelligence scraper that can classify a business and extract public team information across many site structures, while keeping results grounded in visible source content.
