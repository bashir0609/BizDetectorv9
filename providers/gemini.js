import { DEFAULT_SETTINGS } from "../config/settings.js";
import { SYSTEM_PROMPTS } from "../config/prompts.js";
import { validateApiKey } from "../engine/utils.js";

export async function fetchGeminiModelResponse(settings, promptText, model, maxTokens, useJsonMode, apiKey, analysisType = "business") {
  const resolvedKey = apiKey || settings.apiKey;
  
  // Validate API key before making request
  const validation = validateApiKey("gemini", resolvedKey);
  if (!validation.valid) {
    throw new Error(`Invalid Gemini API key: ${validation.error}`);
  }
  
  const endpointBase = (settings.geminiApiBaseUrl || DEFAULT_SETTINGS.geminiApiBaseUrl).replace(/\/+$/, "");
  const url = `${endpointBase}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(resolvedKey)}`;

  const isGemma = model.startsWith("gemma-");
  
  // Construct prompt based on model capability
  const selectedPrompt = SYSTEM_PROMPTS[analysisType] || SYSTEM_PROMPTS.business;
  const systemInstruction = selectedPrompt.instructions;
  
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: isGemma ? `${selectedPrompt.persona}\n\n${systemInstruction}\n\n${promptText}` : promptText }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: maxTokens
    }
  };

  if (!isGemma) {
    body.systemInstruction = {
      parts: [{ text: `${selectedPrompt.persona}\n\n${systemInstruction}` }]
    };
  }

  if (useJsonMode && !isGemma) {
    body.generationConfig.responseMimeType = "application/json";
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

export function getGeminiModelCandidates(settings, isEmployeeAnalysis = false) {
  // This would typically call an API, but current impl is hardcoded
  return []; // To be implemented or kept as a list from config
}
