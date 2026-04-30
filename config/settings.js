export const DEFAULT_SETTINGS = {
  provider: "groq",
  groqApiBaseUrl: "https://api.groq.com/openai/v1/chat/completions",
  geminiApiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
  ollamaBaseUrl: "https://ollama.com",
  model: "llama-3.3-70b-versatile",
  rateLimitSafeMode: false
};

export function isLocalOllamaBaseUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export const STORAGE_KEYS = ["providerApiKeys", "provider", "ollamaBaseUrl", "janBaseUrl", "janModel", "debugLogsEnabled", "rateLimitSafeMode"];

export const PROVIDER_LABELS = {
  groq: "Groq",
  gemini: "Gemini",
  ollama: "Ollama",
  jan: "Jan AI"
};

export const GEMINI_DEFAULT_MODELS = [
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite"
];

export const GEMINI_EMPLOYEE_MODEL_ORDER = [
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite"
];

export const GEMINI_BUSINESS_MODEL_ORDER = [
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite"
];

export const OLLAMA_CLOUD_MODEL_ORDER = [
  "deepseek-v4-flash",
  "kimi-k2.6",
  "glm-5.1",
  "qwen3.5",
  "qwen3-coder-next",
  "gpt-oss:20b",
  "gemma4",
  "rnj-1:8b",
  "ministral-3:14b",
  "qwen3-next:80b",
  "minimax-m2.7",
  "deepseek-v4-pro",
  "gpt-oss:120b",
  "nemotron-3-super:120b",
  "glm-5",
  "devstral-2:123b",
  "devstral-small-2:24b",
  "mistral-large-3",
  "deepseek-v3.2",
  "kimi-k2-thinking",
  "qwen3-coder:480b",
  "qwen3-coder:30b",
  "kimi-k2",
  "gemma3:27b",
  "ministral-3:14b",
  "rnj-1:8b"
];

export const MODEL_CAPABILITIES = {
  // Models that support image input
  "image-capable": [
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite"
  ],
  // Text-only models
  "text-only": [
    "llama-3.3-70b-versatile",
    "llama3-70b-8192",
    "llama3-8b-8192"
  ]
};

export const GROQ_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
export const GROQ_MODEL_COOLDOWN_DEFAULT_MS = 60 * 1000;
export const GROQ_MODEL_MAX_CANDIDATES = 4;
export const GROQ_MODEL_MAX_CANDIDATES_EXTENDED = 8;
export const RATE_LIMIT_EVENT_WINDOW_MS = 2 * 60 * 1000;
export const RATE_LIMIT_EVENT_THRESHOLD = 4;
export const COMPOUND_MODEL_BODY_CHAR_CAP = 2200;
export const COMPOUND_MODEL_MAX_TOKENS_CAP = 900;
export const BUSINESS_ANALYSIS_CHUNK_CHAR_BUDGET = 15000;
export const EMPLOYEE_ANALYSIS_CHUNK_CHAR_BUDGET = 20000;
