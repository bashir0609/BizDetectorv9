# Business Type Detector

Business Type Detector is a Chrome extension that automatically classifies a website's business type and services using Large Language Models (LLMs).

## Features

- **Business Classification**: Detects the business type, industry, and services offered by the current website.
- **AI-Powered Analysis**: Uses LLM APIs to provide high-quality summaries, confidence scores, and evidence-based classifications.
- **Data Extraction**:
  - Extracts emails and phone numbers from the page.
  - Identifies key website signals and industry markers.
  - Finds links to "About" or "Team" pages.
- **Flexible Provider Support**:
  - **Groq**: High-speed cloud inference.
  - **Gemini**: Google AI Studio integration.
  - **Ollama**: Local LLM support for privacy and offline use.
- **Results Management**:
  - **Popup UI**: Quick analysis and result viewing.
  - **Side Panel**: Persistent view of the latest results and API key management.
  - **Dashboard**: A dedicated page to manage and review analyzed sites.
  - **Export**: Export results as JSON or CSV.

## How it Works

1. **Data Collection**: The extension extracts visible text, meta tags, headings, and contact information from the active tab.
2. **LLM Processing**: The collected data is sent to the configured LLM provider (Groq, Gemini, or Ollama) with a specialized prompt to classify the business.
3. **Result Display**: The AI's response is parsed and displayed in the popup, side panel, or dashboard.

## Setup

1. Load the extension in Chrome via `chrome://extensions` using "Load unpacked".
2. Open the extension popup and go to "Provider & API Key".
3. Select your preferred provider and enter the required API key or URL.
4. Click "Analyze Current Tab" to start.
