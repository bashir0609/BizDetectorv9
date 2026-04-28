import { fetchGeminiModelResponse } from "../providers/gemini.js";
import { fetchGroqModelResponse, fetchGroqModelCatalog } from "../providers/groq.js";
import { fetchOllamaModelCatalog, fetchJanModelCatalog, fetchLocalModelResponse } from "../providers/local.js";
import { 
  GEMINI_DEFAULT_MODELS, 
  GEMINI_EMPLOYEE_MODEL_ORDER, 
  GEMINI_BUSINESS_MODEL_ORDER,
  OLLAMA_CLOUD_MODEL_ORDER,
  GROQ_MODEL_MAX_CANDIDATES 
} from "../config/settings.js";
import { 
  pickAvailableKey, 
  markKeyModelRateLimited, 
  isAutoSafeModeActive, 
  resolveRateLimitWaitMs 
} from "./rate-limiter.js";
import { parseProviderApiKeys } from "./utils.js";

export function modelMatchesProvider(provider, model) {
  if (provider === "gemini") return isLikelyGeminiTextModel(model);
  if (provider === "groq") return isLikelyGroqChatModel(model);
  return true;
}

function isLikelyGeminiTextModel(model) {
  const id = String(model || "").toLowerCase();
  if (!id.startsWith("gemini-")) return false;
  if (/image|tts|audio|live|veo|imagen|embedding|robotics/.test(id)) return false;
  return true;
}

function isLikelyGroqChatModel(model) {
  const id = String(model || "").toLowerCase();
  if (!id || id.startsWith("gemini-")) return false;
  if (/whisper|distil-whisper|tts|speech|audio|transcrib|guard|embedding|moderation|playai|image|vision/.test(id)) {
    return false;
  }
  return /(llama|llama3|llama-3|llama-4|gemma|mixtral|mistral|qwen|deepseek|compound|allam|gpt-oss)/.test(id);
}

export async function getModelCandidates(settings, isEmployeeAnalysis = false) {
  const provider = settings.provider;
  if (provider === "ollama") {
    try {
      const [apiKey] = parseProviderApiKeys(settings.providerApiKeys?.ollama || settings.apiKey);
      const models = await fetchOllamaModelCatalog(settings.ollamaBaseUrl || "https://ollama.com", apiKey);
      return models.length ? rankOllamaCloudModels(models) : OLLAMA_CLOUD_MODEL_ORDER;
    } catch {
      return OLLAMA_CLOUD_MODEL_ORDER;
    }
  }
  if (provider === "jan") {
    try {
      const selectedModel = settings.janModel || "deepseek/deepseek-r1:free";
      const models = await fetchJanModelCatalog(settings.janBaseUrl || "http://127.0.0.1:1337/v1");
      return [selectedModel, ...models.filter(m => m !== selectedModel)];
    } catch {
      return [settings.janModel || "deepseek/deepseek-r1:free"];
    }
  }
  if (provider === "gemini") {
    return isEmployeeAnalysis ? GEMINI_EMPLOYEE_MODEL_ORDER : GEMINI_BUSINESS_MODEL_ORDER;
  }
  if (provider === "groq") {
    try {
      const [apiKey] = parseProviderApiKeys(settings.providerApiKeys?.groq || settings.apiKey);
      return (await fetchGroqModelCatalog(apiKey)).filter(isLikelyGroqChatModel);
    } catch {
      return ["llama-3.3-70b-versatile", "llama3-70b-8192"];
    }
  }
  return [];
}

function rankOllamaCloudModels(models) {
  const available = new Set(models);
  const preferred = OLLAMA_CLOUD_MODEL_ORDER.filter((model) => available.has(model));
  const remaining = models.filter((model) => !preferred.includes(model));
  return [...preferred, ...remaining];
}

export async function fetchModelResponse(settings, promptText, model, maxTokens, useJsonMode, apiKey, analysisType = "business") {
  if (settings.provider === "gemini") {
    return fetchGeminiModelResponse(settings, promptText, model, maxTokens, useJsonMode, apiKey, analysisType);
  }
  if (settings.provider === "groq") {
    return fetchGroqModelResponse(settings, promptText, model, maxTokens, useJsonMode, apiKey, analysisType);
  }
  if (settings.provider === "ollama" || settings.provider === "jan") {
    return fetchLocalModelResponse(settings, promptText, model, maxTokens, analysisType);
  }
  // Local providers aren't handled via this generic fetchModelResponse usually, 
  // but we can add them if needed. For now, we follow the existing structure.
  throw new Error(`Unsupported provider: ${settings.provider}`);
}

export async function requestModel(settings, promptText, model, maxTokens = 1200, apiKey, analysisType = "business") {
  let payload;
  try {
    payload = await fetchModelResponse(settings, promptText, model, maxTokens, true, apiKey, analysisType);
  } catch (error) {
    // In a real app, we'd check if it's a JSON validation error and retry without JSON mode
    throw error;
  }

  const content = settings.provider === "gemini"
    ? payload?.candidates?.[0]?.content?.parts?.map((part) => part?.text || "").join("\n")
    : settings.provider === "ollama"
      ? payload?.message?.content
      : payload?.choices?.[0]?.message?.content;

  if (!content) throw new Error("The API response did not include a model message.");

  return {
    content,
    modelUsed: model,
    rawResponse: payload
  };
}
