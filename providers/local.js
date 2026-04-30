import { SYSTEM_PROMPTS } from "../config/prompts.js";
import { isLocalOllamaBaseUrl } from "../config/settings.js";
export async function fetchOllamaModelCatalog(ollamaBaseUrl, apiKey = "") {
  const tagsUrl = `${ollamaBaseUrl.replace(/\/+$/, "")}/api/tags`;
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const response = await fetch(tagsUrl, { headers });
  if (!response.ok) {
    throw new Error(`Ollama model list request failed (${response.status})`);
  }
  const payload = await response.json();
  return (payload?.models || []).map((m) => m.name || m.model).filter(Boolean);
}

export async function fetchJanModelCatalog(janBaseUrl) {
  const url = `${janBaseUrl.replace(/\/+$/, "")}/models`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Jan AI model list request failed (${response.status})`);
  }
  const payload = await response.json();
  return (payload?.data || []).map((m) => m.id);
}

export async function fetchLocalModelResponse(settings, promptText, model, maxTokens, analysisType = "business", signal = null) {
  const selectedPrompt = SYSTEM_PROMPTS[analysisType] || SYSTEM_PROMPTS.business;
  const systemContent = `${selectedPrompt.persona}\n\n${selectedPrompt.instructions}`;
  if (settings.provider === "ollama") {
    return fetchOllamaApiResponse(settings, promptText, model, maxTokens, analysisType, signal);
  }

  const baseUrl = settings.provider === "jan"
    ? (settings.janBaseUrl || "http://127.0.0.1:1337/v1")
    : `${(settings.ollamaBaseUrl || "https://ollama.com").replace(/\/+$/, "")}/v1`;
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        {
          role: "system",
          content: systemContent
        },
        {
          role: "user",
          content: promptText
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`Local model request failed (${response.status}): ${errorText}`);
    error.status = response.status;
    error.responseText = errorText;
    throw error;
  }

  return response.json();
}

async function fetchOllamaApiResponse(settings, promptText, model, maxTokens, analysisType = "business", signal = null) {
  const selectedPrompt = SYSTEM_PROMPTS[analysisType] || SYSTEM_PROMPTS.business;
  const systemContent = `${selectedPrompt.persona}\n\n${selectedPrompt.instructions}`;
  const apiKey = String(settings.providerApiKeys?.ollama || settings.apiKey || "").split(/[\r\n,]+/).map((key) => key.trim()).filter(Boolean)[0] || "";
  const baseUrl = (settings.ollamaBaseUrl || "https://ollama.com").replace(/\/+$/, "");
  if (!apiKey && !isLocalOllamaBaseUrl(baseUrl)) {
    throw new Error("Missing API key for Ollama.");
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      options: {
        temperature: 0.2,
        num_predict: maxTokens
      },
      messages: [
        {
          role: "system",
          content: systemContent
        },
        {
          role: "user",
          content: promptText
        }
      ]    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`Ollama API request failed (${response.status}): ${errorText}`);
    error.status = response.status;
    error.responseText = errorText;
    throw error;
  }

  return response.json();
}
