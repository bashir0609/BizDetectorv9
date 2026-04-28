import { DEFAULT_SETTINGS } from "../config/settings.js";
import { SYSTEM_PROMPTS } from "../config/prompts.js";
import { validateApiKey } from "../engine/utils.js";

export async function fetchGroqModelResponse(settings, promptText, model, maxTokens, useJsonMode, apiKey, analysisType = "business") {
  const resolvedKey = apiKey || settings.apiKey;
  
  // Validate API key before making request
  const validation = validateApiKey("groq", resolvedKey);
  if (!validation.valid) {
    throw new Error(`Invalid Groq API key: ${validation.error}`);
  }
  
  const url = DEFAULT_SETTINGS.groqApiBaseUrl;
  const selectedPrompt = SYSTEM_PROMPTS[analysisType] || SYSTEM_PROMPTS.business;

  const body = {
    model: model,
    messages: [
      {
        role: "system",
        content: `${selectedPrompt.persona}\n\n${selectedPrompt.instructions}`
      },
      {
        role: "user",
        content: promptText
      }
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: useJsonMode ? { type: "json_object" } : undefined
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resolvedKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`API request failed (${response.status}): ${errorText}`);
    error.status = response.status;
    error.responseText = errorText;
    
    // Handle specific model capability errors
    if (errorText.includes("does not support image input")) {
      error.message = "This model does not support image input. Please use a different model or remove images from the prompt.";
    }
    
    throw error;
  }

  return response.json();
}

export async function fetchGroqModelCatalog(apiKey) {
  const url = "https://api.groq.com/openai/v1/models";
  const response = await fetch(url, {
    headers: { "Authorization": `Bearer ${apiKey}` }
  });
  if (!response.ok) throw new Error("Failed to fetch Groq model catalog");
  const payload = await response.json();
  return payload.data.map(m => m.id);
}
