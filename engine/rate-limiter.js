import { GROQ_MODEL_COOLDOWN_DEFAULT_MS, RATE_LIMIT_EVENT_WINDOW_MS, RATE_LIMIT_EVENT_THRESHOLD } from "../config/settings.js";

const keyModelRateLimitedUntil = new Map(); // "key|model" -> timestamp ms
const recentRateLimitEvents = [];

export function recordRateLimitEvent() {
  const now = Date.now();
  recentRateLimitEvents.push(now);
  while (recentRateLimitEvents.length && (now - recentRateLimitEvents[0]) > RATE_LIMIT_EVENT_WINDOW_MS) {
    recentRateLimitEvents.shift();
  }
}

export function isAutoSafeModeActive() {
  const now = Date.now();
  while (recentRateLimitEvents.length && (now - recentRateLimitEvents[0]) > RATE_LIMIT_EVENT_WINDOW_MS) {
    recentRateLimitEvents.shift();
  }
  return recentRateLimitEvents.length >= RATE_LIMIT_EVENT_THRESHOLD;
}

export function pickAvailableKey(keys, model) {
  const now = Date.now();
  return keys.find(k => (keyModelRateLimitedUntil.get(`${k}|${model}`) || 0) <= now) ?? null;
}

export function markKeyModelRateLimited(key, model, waitMs) {
  keyModelRateLimitedUntil.set(`${key}|${model}`, Date.now() + waitMs);
}

export function msUntilAnyKeyAvailable(keys, model) {
  const now = Date.now();
  const soonest = Math.min(...keys.map(k => keyModelRateLimitedUntil.get(`${k}|${model}`) || 0));
  return Math.max(0, soonest - now);
}

export function resolveRateLimitWaitMs(response, errorText) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) return parseInt(retryAfter, 10) * 1000;
  if (/too many requests|rate limit/i.test(errorText)) return GROQ_MODEL_COOLDOWN_DEFAULT_MS;
  return 0;
}
