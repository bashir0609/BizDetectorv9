import { MODEL_CAPABILITIES } from "../config/settings.js";

export function normalizeApiKeysInput(value) {
  return String(value || "")
    .split(/\r?\n|,/)
    .map((key) => key.trim())
    .filter(Boolean)
    .join("\n");
}

export function stripThinkingTags(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .trim();
}

export function getJsonFromText(text) {
  const stripped = stripThinkingTags(text);
  const fencedMatch = stripped.match(/```json\s*([\s\S]*?)```/i);
  let candidate = fencedMatch ? fencedMatch[1] : stripped;
  candidate = String(candidate || "").trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    candidate = candidate.slice(start, end + 1);
  }

  return JSON.parse(candidate.trim());
}

export function safeParseModelJson(text) {
  try {
    return getJsonFromText(text);
  } catch (e) {
    throw new Error(`Model returned invalid JSON: ${e.message}`);
  }
}

export function normalizeApiKey(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

export function parseProviderApiKeys(raw) {
  const items = Array.isArray(raw) ? raw : String(raw || "").split(/[\r\n,]+/);
  return items.map(k => normalizeApiKey(k)).filter(k => k.length > 0);
}

export function validateApiKey(provider, key) {
  const normalized = normalizeApiKey(key);
  if (!normalized) return { valid: false, error: "API key cannot be empty." };
  
  if (provider === "groq" && !normalized.startsWith("gsk_")) {
    return { valid: false, error: "Groq keys should start with 'gsk_'." };
  }
  if (provider === "gemini" && !normalized.startsWith("AIza")) {
    return { valid: false, error: "Gemini keys should start with 'AIza'." };
  }
  
  return { valid: true };
}

export function validateProviderApiKeys(provider, rawInput) {
  const keys = parseProviderApiKeys(rawInput);
  if (keys.length === 0) {
    return { valid: false, error: `${provider.charAt(0).toUpperCase() + provider.slice(1)} API key cannot be empty.` };
  }
  
  for (const key of keys) {
    const validation = validateApiKey(provider, key);
    if (!validation.valid) {
      return { valid: false, error: validation.error };
    }
  }
  
  return { valid: true };
}

export function getModelCapabilities(model) {
  if (MODEL_CAPABILITIES["image-capable"].includes(model)) {
    return { supportsImages: true, supportsText: true };
  }
  if (MODEL_CAPABILITIES["text-only"].includes(model)) {
    return { supportsImages: false, supportsText: true };
  }
  // Default assumption for unknown models
  return { supportsImages: true, supportsText: true };
}
