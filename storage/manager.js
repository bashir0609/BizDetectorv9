import { STORAGE_KEYS, DEFAULT_SETTINGS } from "../config/settings.js";

export async function getSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEYS);
  const sessionStored = await chrome.storage.session.get(STORAGE_KEYS);
  const localStored = await chrome.storage.local.get(STORAGE_KEYS);

  const settings = { ...DEFAULT_SETTINGS };

  // Priority: Session > Local > Sync > Default
  STORAGE_KEYS.forEach(key => {
    const value = sessionStored[key] ?? localStored[key] ?? stored[key] ?? DEFAULT_SETTINGS[key];
    settings[key] = value;
  });

  // Special handling for providerApiKeys as it's an object merged across stores
  const providerApiKeys = {
    ...(stored.providerApiKeys || {}),
    ...(localStored.providerApiKeys || {}),
    ...(sessionStored.providerApiKeys || {})
  };
  settings.providerApiKeys = providerApiKeys;

  return settings;
}

export async function saveSettings(preferences, localSettings) {
  await Promise.all([
    chrome.storage.sync.set(preferences),
    chrome.storage.sync.remove("providerApiKeys").catch(() => {}),
    chrome.storage.local.set(localSettings),
    chrome.storage.session?.set ? chrome.storage.session.set(localSettings) : Promise.resolve()
  ]);
}

export async function setLatestResult(result) {
  await chrome.storage.local.set({ latestAnalysis: result });
}

export async function getLatestResult() {
  const stored = await chrome.storage.local.get(["latestAnalysis"]);
  return stored.latestAnalysis || null;
}
