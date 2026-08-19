import type { MessageType, Review, ReviewSettings, SummaryResult } from './types.js';
import { SCROLL_CONFIG, POPUP_CONFIG, AI_DEFAULTS, CACHE_CONFIG } from './config.js';
import { encryptApiKey, decryptApiKey } from './crypto.js';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function $(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

function setScreen(name: 'info' | 'history' | 'settings' | 'loading' | 'result' | 'error' | 'no-reviews' | 'wrong-page'): void {
  document.querySelectorAll<HTMLElement>('.screen').forEach((el) => {
    el.hidden = el.dataset.screen !== name;
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: ReviewSettings = {
  reviewMode: 'all',
  reviewCount: 1000,
  aiProvider: 'ollama',
  ollamaModel: 'llama3.2:latest',
  ollamaParams: {},
  openaiModel: 'gpt-4o-mini',
  anthropicModel: AI_DEFAULTS.ANTHROPIC_MODEL,
  geminiModel: AI_DEFAULTS.GEMINI_MODEL,
  groqModel: AI_DEFAULTS.GROQ_MODEL,
  xaiModel: AI_DEFAULTS.XAI_MODEL,
};

const ALL_PROVIDERS = ['ollama', 'openai', 'anthropic', 'gemini', 'groq', 'xai', 'custom'] as const;

// Default placeholder text for each provider's key input
const KEY_PLACEHOLDERS: Record<string, string> = {
  openai:    'sk-…',
  anthropic: 'sk-ant-…',
  gemini:    'AIza…',
  groq:      'gsk_…',
  xai:       'xai-…',
  custom:    'Leave blank if not required',
};

/** Fields in ReviewSettings that contain API keys and must be encrypted at rest. */
const API_KEY_FIELDS = [
  'openaiApiKey', 'anthropicApiKey', 'geminiApiKey',
  'groqApiKey', 'xaiApiKey', 'customApiKey',
] as const satisfies ReadonlyArray<keyof ReviewSettings>;

async function getSettings(): Promise<ReviewSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['gReviewSummSettings'], async (result) => {
      const stored = (result.gReviewSummSettings ?? DEFAULT_SETTINGS) as ReviewSettings;
      const settings: ReviewSettings = { ...stored };

      for (const field of API_KEY_FIELDS) {
        const val = stored[field];
        if (typeof val === 'string' && val.length > 0) {
          try {
            (settings as unknown as Record<string, unknown>)[field] = await decryptApiKey(val);
          } catch {
            // Salt was reset or blob is corrupt — clear this key so the user re-enters it
            console.warn(`[GReviewSumm] Could not decrypt ${field} — clearing it.`);
            (settings as unknown as Record<string, unknown>)[field] = undefined;
          }
        }
      }

      resolve(settings);
    });
  });
}

async function saveSettings(settings: ReviewSettings): Promise<void> {
  const stored: ReviewSettings = { ...settings };

  for (const field of API_KEY_FIELDS) {
    const val = settings[field];
    if (typeof val === 'string' && val.length > 0) {
      (stored as unknown as Record<string, unknown>)[field] = await encryptApiKey(val);
    }
  }

  return new Promise((resolve) => {
    chrome.storage.local.set({ gReviewSummSettings: stored }, resolve);
  });
}

// ─── Key protection ───────────────────────────────────────────────────────────
//
// API keys are NEVER loaded into input.value — they stay in chrome.storage only.
// The UI shows a "✓ Saved" badge and a "✕" clear button when a key is stored.
// Leaving the input blank on save preserves the existing key; clicking "✕" removes it.

/** Providers whose keys the user explicitly cleared in this settings session. */
const _clearKeys = new Set<string>();

/** The settings that were loaded when the settings panel was last opened. */
let _loadedSettings: ReviewSettings = { ...DEFAULT_SETTINGS };

/** Render key-field status for one provider. Never populates the input value. */
function applyKeyStatus(provider: string, hasKey: boolean): void {
  const statusEl  = document.getElementById(`${provider}-key-status`);
  const clearBtn  = document.getElementById(`${provider}-clear-key`) as HTMLButtonElement | null;
  const inputEl   = document.querySelector<HTMLInputElement>(`#${provider}-key-input`);
  const placeholder = KEY_PLACEHOLDERS[provider] ?? 'API key';

  if (statusEl) {
    statusEl.textContent = hasKey ? '✓ Saved' : '';
    statusEl.className   = `key-status${hasKey ? ' saved' : ''}`;
  }
  if (clearBtn)  clearBtn.hidden = !hasKey;
  if (inputEl) {
    inputEl.value       = '';                                                    // never expose the key
    inputEl.placeholder = hasKey ? 'Leave blank to keep · or enter a new key' : placeholder;
  }
}

/**
 * Read a provider's key from the UI.
 * - If the user typed something → use it.
 * - If the user explicitly clicked "✕ Clear" → return undefined (removes the key).
 * - Otherwise (input left empty) → preserve the key from storage.
 */
function readKeyFromUI(inputId: string, provider: string, existingKey?: string): string | undefined {
  if (_clearKeys.has(provider)) return undefined;
  const el    = document.querySelector<HTMLInputElement>(`#${inputId}`);
  const typed = el?.value.trim();
  return typed || existingKey || undefined;
}

// ─── Provider / count field visibility ───────────────────────────────────────

// The cap is honoured in every mode now, including 'all', so the field is
// always shown — previously 'all' ignored reviewCount AND hid the input,
// leaving no way to limit a very large place.
function updateCountFieldVisibility(_mode: ReviewSettings['reviewMode']): void {
  const wrapper = document.getElementById('count-field-wrapper');
  if (wrapper) wrapper.hidden = false;
}

function updateProviderVisibility(provider: ReviewSettings['aiProvider']): void {
  ALL_PROVIDERS.forEach((p) => {
    const el = document.getElementById(`${p}-config`);
    if (el) el.hidden = p !== provider;
  });
}

// ─── Slider helper ────────────────────────────────────────────────────────────

function setSlider(inputId: string, valId: string, value: number): void {
  const input = document.querySelector<HTMLInputElement>(`#${inputId}`);
  const label = document.getElementById(valId);
  if (input) input.value = String(value);
  if (label) label.textContent = String(value);
}

// ─── Apply / read settings ────────────────────────────────────────────────────

function applySettingsToUI(settings: ReviewSettings): void {
  _loadedSettings = { ...settings };

  // Review scope buttons
  document.querySelectorAll<HTMLElement>('#review-mode-group .scope-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === settings.reviewMode);
  });
  const countInput = document.querySelector<HTMLInputElement>('#review-count-input');
  if (countInput) countInput.value = String(settings.reviewCount);
  updateCountFieldVisibility(settings.reviewMode);

  // Provider buttons
  document.querySelectorAll<HTMLElement>('#ai-provider-group .scope-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === (settings.aiProvider ?? 'ollama'));
  });
  updateProviderVisibility(settings.aiProvider ?? 'ollama');

  // ── Ollama ──────────────────────────────────────────────────────────────────
  const ollamaModelEl = document.querySelector<HTMLInputElement>('#ollama-model-input');
  if (ollamaModelEl) ollamaModelEl.value = settings.ollamaModel ?? DEFAULT_SETTINGS.ollamaModel ?? '';

  const p = settings.ollamaParams ?? {};
  setSlider('ollama-temp', 'ollama-temp-val', p.temperature   ?? AI_DEFAULTS.OLLAMA_TEMPERATURE);
  setSlider('ollama-topp', 'ollama-topp-val', p.topP          ?? AI_DEFAULTS.OLLAMA_TOP_P);
  setSlider('ollama-rp',   'ollama-rp-val',   p.repeatPenalty ?? AI_DEFAULTS.OLLAMA_REPEAT_PENALTY);
  const topkEl   = document.querySelector<HTMLInputElement>('#ollama-topk');
  const numctxEl = document.querySelector<HTMLInputElement>('#ollama-numctx');
  if (topkEl)   topkEl.value   = String(p.topK   ?? AI_DEFAULTS.OLLAMA_TOP_K);
  if (numctxEl) numctxEl.value = String(p.numCtx ?? AI_DEFAULTS.OLLAMA_NUM_CTX);

  // ── Model selects / inputs (non-key) ────────────────────────────────────────
  const openaiModelEl = document.querySelector<HTMLSelectElement>('#openai-model-select');
  if (openaiModelEl) openaiModelEl.value = settings.openaiModel ?? DEFAULT_SETTINGS.openaiModel ?? 'gpt-4o-mini';

  const anthropicModelEl = document.querySelector<HTMLInputElement>('#anthropic-model-input');
  if (anthropicModelEl) anthropicModelEl.value = settings.anthropicModel ?? DEFAULT_SETTINGS.anthropicModel ?? '';

  const geminiModelEl = document.querySelector<HTMLSelectElement>('#gemini-model-select');
  if (geminiModelEl) geminiModelEl.value = settings.geminiModel ?? DEFAULT_SETTINGS.geminiModel ?? 'gemini-2.0-flash';

  const groqModelEl = document.querySelector<HTMLSelectElement>('#groq-model-select');
  if (groqModelEl) groqModelEl.value = settings.groqModel ?? DEFAULT_SETTINGS.groqModel ?? 'llama-3.3-70b-versatile';

  const xaiModelEl = document.querySelector<HTMLSelectElement>('#xai-model-select');
  if (xaiModelEl) xaiModelEl.value = settings.xaiModel ?? DEFAULT_SETTINGS.xaiModel ?? 'grok-3-mini-latest';

  const customEndpointEl = document.querySelector<HTMLInputElement>('#custom-endpoint-input');
  if (customEndpointEl) customEndpointEl.value = settings.customEndpoint ?? '';
  const customModelEl = document.querySelector<HTMLInputElement>('#custom-model-input');
  if (customModelEl) customModelEl.value = settings.customModel ?? '';

  // ── API key status (never expose the key itself) ─────────────────────────────
  applyKeyStatus('openai',    !!settings.openaiApiKey);
  applyKeyStatus('anthropic', !!settings.anthropicApiKey);
  applyKeyStatus('gemini',    !!settings.geminiApiKey);
  applyKeyStatus('groq',      !!settings.groqApiKey);
  applyKeyStatus('xai',       !!settings.xaiApiKey);
  applyKeyStatus('custom',    !!settings.customApiKey);
}

function readSettingsFromUI(): ReviewSettings {
  const activeScope    = document.querySelector<HTMLElement>('#review-mode-group .scope-btn.active');
  const activeProvider = document.querySelector<HTMLElement>('#ai-provider-group .scope-btn.active');
  const countInput     = document.querySelector<HTMLInputElement>('#review-count-input');

  const ollamaModelEl  = document.querySelector<HTMLInputElement>('#ollama-model-input');
  const ollamaTempEl   = document.querySelector<HTMLInputElement>('#ollama-temp');
  const ollamaToppEl   = document.querySelector<HTMLInputElement>('#ollama-topp');
  const ollamaRpEl     = document.querySelector<HTMLInputElement>('#ollama-rp');
  const ollamaTopkEl   = document.querySelector<HTMLInputElement>('#ollama-topk');
  const ollamaNumctxEl = document.querySelector<HTMLInputElement>('#ollama-numctx');

  const openaiModelEl    = document.querySelector<HTMLSelectElement>('#openai-model-select');
  const anthropicModelEl = document.querySelector<HTMLInputElement>('#anthropic-model-input');
  const geminiModelEl    = document.querySelector<HTMLSelectElement>('#gemini-model-select');
  const groqModelEl      = document.querySelector<HTMLSelectElement>('#groq-model-select');
  const xaiModelEl       = document.querySelector<HTMLSelectElement>('#xai-model-select');
  const customEndpointEl = document.querySelector<HTMLInputElement>('#custom-endpoint-input');
  const customModelEl    = document.querySelector<HTMLInputElement>('#custom-model-input');

  return {
    reviewMode:  (activeScope?.dataset.value    as ReviewSettings['reviewMode'])   ?? DEFAULT_SETTINGS.reviewMode,
    reviewCount: Math.max(10, Number(countInput?.value ?? DEFAULT_SETTINGS.reviewCount)),
    aiProvider:  (activeProvider?.dataset.value as ReviewSettings['aiProvider'])   ?? 'ollama',

    ollamaModel: ollamaModelEl?.value.trim() || DEFAULT_SETTINGS.ollamaModel,
    ollamaParams: {
      temperature:   ollamaTempEl   ? parseFloat(ollamaTempEl.value)     : AI_DEFAULTS.OLLAMA_TEMPERATURE,
      topP:          ollamaToppEl   ? parseFloat(ollamaToppEl.value)     : AI_DEFAULTS.OLLAMA_TOP_P,
      repeatPenalty: ollamaRpEl     ? parseFloat(ollamaRpEl.value)       : AI_DEFAULTS.OLLAMA_REPEAT_PENALTY,
      topK:          ollamaTopkEl   ? parseInt(ollamaTopkEl.value, 10)   : AI_DEFAULTS.OLLAMA_TOP_K,
      numCtx:        ollamaNumctxEl ? parseInt(ollamaNumctxEl.value, 10) : AI_DEFAULTS.OLLAMA_NUM_CTX,
    },

    // API keys: blank = keep existing, explicit clear = remove
    openaiApiKey:    readKeyFromUI('openai-key-input',    'openai',    _loadedSettings.openaiApiKey),
    openaiModel:     openaiModelEl?.value    || DEFAULT_SETTINGS.openaiModel,

    anthropicApiKey: readKeyFromUI('anthropic-key-input', 'anthropic', _loadedSettings.anthropicApiKey),
    anthropicModel:  anthropicModelEl?.value.trim() || DEFAULT_SETTINGS.anthropicModel,

    geminiApiKey:    readKeyFromUI('gemini-key-input',    'gemini',    _loadedSettings.geminiApiKey),
    geminiModel:     geminiModelEl?.value    || DEFAULT_SETTINGS.geminiModel,

    groqApiKey:      readKeyFromUI('groq-key-input',      'groq',      _loadedSettings.groqApiKey),
    groqModel:       groqModelEl?.value      || DEFAULT_SETTINGS.groqModel,

    xaiApiKey:       readKeyFromUI('xai-key-input',       'xai',       _loadedSettings.xaiApiKey),
    xaiModel:        xaiModelEl?.value       || DEFAULT_SETTINGS.xaiModel,

    customEndpoint:  customEndpointEl?.value.trim() || undefined,
    customApiKey:    readKeyFromUI('custom-key-input', 'custom', _loadedSettings.customApiKey),
    customModel:     customModelEl?.value.trim() || undefined,
  };
}

/**
 * A custom OpenAI-compatible endpoint can live on any host, which the narrow
 * install-time host_permissions do not cover. Request it at save time instead.
 *
 * Must be the FIRST await in a click handler — chrome.permissions.request needs
 * the user gesture still to be active. It resolves true without prompting when
 * the permission is already granted, so no contains() pre-check.
 */
async function ensureCustomEndpointPermission(settings: ReviewSettings): Promise<void> {
  if (settings.aiProvider !== 'custom' || !settings.customEndpoint) return;
  try {
    const { origin, hostname } = new URL(settings.customEndpoint);
    if (hostname === 'localhost' || hostname === '127.0.0.1') return;
    await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    // Malformed URL, or the user declined — the summarize call surfaces a clear error.
  }
}

// ─── Open settings ────────────────────────────────────────────────────────────

async function openSettings(): Promise<void> {
  _clearKeys.clear();                          // reset any pending clears from last session
  const settings = await getSettings();
  applySettingsToUI(settings);
  setScreen('settings');
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: SummaryResult;
  timestamp: number;
}

interface ReviewCacheEntry {
  reviews: Review[];
  placeName: string;
  googleRating?: number;
  googleReviewCount?: number;
  /** Ceiling this set was scraped under — a larger request must re-scrape. */
  maxReviews: number;
  timestamp: number;
}

const SUMMARY_CACHE_KEY = 'gReviewSummCache';
const REVIEW_CACHE_KEY  = 'gReviewSummReviewCache';

/**
 * Stable identifier for the place shown in the current tab.
 *
 * Using only origin + pathname collapsed EVERY google.com/search knowledge
 * panel onto the single key "https://www.google.com/search", so the second
 * business analyzed was served the first business's summary.
 */
function placeKey(url: string, placeName?: string): string {
  try {
    const u = new URL(url);
    // Maps URLs carry the place in the pathname (/maps/place/<name>/@lat,lng…).
    if (u.pathname.startsWith('/maps')) return `${u.origin}${u.pathname}`;
    const q = u.searchParams.get('q');
    if (q) return `${u.origin}${u.pathname}?q=${q}`;
    return placeName ? `${u.origin}${u.pathname}#${placeName}` : `${u.origin}${u.pathname}`;
  } catch {
    return placeName ? `${url}#${placeName}` : url;
  }
}

/** The model actually in use for the selected provider. */
function activeModel(s: ReviewSettings): string {
  switch (s.aiProvider) {
    case 'openai':    return s.openaiModel    ?? AI_DEFAULTS.OPENAI_MODEL;
    case 'anthropic': return s.anthropicModel ?? AI_DEFAULTS.ANTHROPIC_MODEL;
    case 'gemini':    return s.geminiModel    ?? AI_DEFAULTS.GEMINI_MODEL;
    case 'groq':      return s.groqModel      ?? AI_DEFAULTS.GROQ_MODEL;
    case 'xai':       return s.xaiModel       ?? AI_DEFAULTS.XAI_MODEL;
    case 'custom':    return s.customModel    ?? 'local-model';
    default:          return s.ollamaModel    ?? AI_DEFAULTS.OLLAMA_MODEL;
  }
}

/**
 * Summary cache key. Includes provider, model, and scope — without them a
 * summary produced by Ollama was still returned after switching to Anthropic
 * or changing the review scope.
 */
function summaryKey(url: string, s: ReviewSettings, placeName?: string): string {
  return `${placeKey(url, placeName)}::${s.aiProvider ?? 'ollama'}::${activeModel(s)}::${s.reviewMode}`;
}

function readStore<T>(storeKey: string): Promise<Record<string, T>> {
  return new Promise((resolve) => {
    chrome.storage.local.get([storeKey], (data) => {
      resolve(((data as Record<string, unknown>)[storeKey] ?? {}) as Record<string, T>);
    });
  });
}

function writeStore<T>(storeKey: string, map: Record<string, T>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [storeKey]: map }, resolve);
  });
}

/** Drop expired entries and cap the map, newest first. */
function prune<T extends { timestamp: number }>(map: Record<string, T>): Record<string, T> {
  const now = Date.now();
  const live = Object.entries(map)
    .filter(([, e]) => now - e.timestamp <= CACHE_CONFIG.TTL_MS)
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, CACHE_CONFIG.MAX_ENTRIES);
  return Object.fromEntries(live) as Record<string, T>;
}

async function getCachedResult(url: string, settings: ReviewSettings, placeName?: string): Promise<CacheEntry | null> {
  const cache = await readStore<CacheEntry>(SUMMARY_CACHE_KEY);
  const pruned = prune(cache);
  // Evict expired entries on read — they used to linger forever.
  if (Object.keys(pruned).length !== Object.keys(cache).length) {
    await writeStore(SUMMARY_CACHE_KEY, pruned);
  }
  return pruned[summaryKey(url, settings, placeName)] ?? null;
}

async function setCachedResult(url: string, settings: ReviewSettings, result: SummaryResult): Promise<void> {
  const cache = await readStore<CacheEntry>(SUMMARY_CACHE_KEY);
  cache[summaryKey(url, settings, result.placeName)] = { result, timestamp: Date.now() };
  await writeStore(SUMMARY_CACHE_KEY, prune(cache));
}

async function getCachedReviews(url: string, maxReviews: number, placeName?: string): Promise<ReviewCacheEntry | null> {
  const cache = await readStore<ReviewCacheEntry>(REVIEW_CACHE_KEY);
  const entry = prune(cache)[placeKey(url, placeName)];
  if (!entry) return null;
  // A larger request than the cached set was scraped under must re-scrape.
  if (entry.maxReviews < maxReviews && entry.reviews.length >= entry.maxReviews) return null;
  return entry;
}

async function setCachedReviews(url: string, entry: ReviewCacheEntry): Promise<void> {
  const cache = await readStore<ReviewCacheEntry>(REVIEW_CACHE_KEY);
  cache[placeKey(url, entry.placeName)] = entry;
  await writeStore(REVIEW_CACHE_KEY, prune(cache));
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function getAllCacheEntries(): Promise<Array<{ key: string; entry: CacheEntry }>> {
  const cache = await readStore<CacheEntry>(SUMMARY_CACHE_KEY);
  return Object.entries(prune(cache))
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => b.entry.timestamp - a.entry.timestamp);
}

async function deleteHistoryEntry(key: string): Promise<void> {
  const cache = await readStore<CacheEntry>(SUMMARY_CACHE_KEY);
  delete cache[key];
  await writeStore(SUMMARY_CACHE_KEY, cache);
}

async function clearAllHistory(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove([SUMMARY_CACHE_KEY, REVIEW_CACHE_KEY], () => resolve());
  });
}

async function showHistory(): Promise<void> {
  const entries = await getAllCacheEntries();
  const list = document.getElementById('history-list');
  if (!list) return;

  if (entries.length === 0) {
    list.innerHTML = '<p class="history-empty">No analyzed places yet.</p>';
    setScreen('history');
    return;
  }

  const sentimentColors: Record<SummaryResult['overallSentiment'], string> = {
    positive: 'sentiment-positive',
    negative: 'sentiment-negative',
    neutral:  'sentiment-neutral',
    mixed:    'sentiment-mixed',
  };

  list.innerHTML = entries.map(({ key, entry }) => {
    const r = entry.result;
    const stars = '★'.repeat(Math.floor(r.averageRating)) + (r.averageRating % 1 >= 0.5 ? '½' : '');
    const cls = sentimentColors[r.overallSentiment] ?? '';
    return `
      <div class="history-item ${cls}" data-key="${encodeURIComponent(key)}">
        <div style="min-width:0">
          <div class="history-item-name">${r.placeName}</div>
          <div class="history-item-meta">
            <span class="history-stars">${stars}</span>
            <span>${r.averageRating}</span>
            <span>·</span>
            <span>${r.totalReviews.toLocaleString()} reviews</span>
            <span>·</span>
            <span>${timeAgo(entry.timestamp)}</span>
          </div>
        </div>
        <button class="history-delete" data-key="${encodeURIComponent(key)}" title="Remove">✕</button>
      </div>`;
  }).join('');

  setScreen('history');
}

// ─── Messaging ────────────────────────────────────────────────────────────────

function sendTabMessage(tabId: number, message: MessageType): Promise<MessageType> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message ?? 'Unknown error');
        return;
      }
      if (!response) { reject('No response from content script'); return; }
      resolve(response as MessageType);
    });
  });
}

async function sendToTab(tabId: number, message: MessageType): Promise<MessageType> {
  try {
    return await sendTabMessage(tabId, message);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection')) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await new Promise<void>((r) => setTimeout(r, 300));
      return sendTabMessage(tabId, message);
    }
    throw err;
  }
}

function sendRuntimeMessage(message: MessageType): Promise<MessageType> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: MessageType | undefined) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message ?? 'Background error');
        return;
      }
      if (!response) { reject('No response from background'); return; }
      resolve(response);
    });
  });
}

// ─── Render result ────────────────────────────────────────────────────────────

const sentimentLabel: Record<SummaryResult['overallSentiment'], string> = {
  positive: '😊 Mostly Positive',
  negative: '😞 Mostly Negative',
  neutral:  '😐 Neutral',
  mixed:    '🤔 Mixed Reviews',
};

const sentimentClass: Record<SummaryResult['overallSentiment'], string> = {
  positive: 'sentiment-positive',
  negative: 'sentiment-negative',
  neutral:  'sentiment-neutral',
  mixed:    'sentiment-mixed',
};

function renderStars(rating: number): string {
  const full  = Math.floor(rating);
  const half  = rating % 1 >= 0.5;
  const empty = 5 - full - (half ? 1 : 0);
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

function renderResult(data: SummaryResult, timestamp?: number): void {
  const placeName  = $('[data-field="place-name"]');
  const sentiment  = $('[data-field="sentiment"]');
  const starsEl    = $('[data-field="stars"]');
  const ratingEl   = $('[data-field="rating"]');
  const reviewCount = $('[data-field="review-count"]');
  const summaryEl  = $('[data-field="summary"]');
  const prosList   = $('[data-field="pros"]');
  const consList   = $('[data-field="cons"]');
  const themesList = $('[data-field="themes"]');
  const analyzedAt = document.getElementById('analyzed-at');

  if (placeName) placeName.textContent = data.placeName;

  if (sentiment) {
    sentiment.textContent = sentimentLabel[data.overallSentiment];
    sentiment.className   = `sentiment-badge ${sentimentClass[data.overallSentiment]}`;
  }

  if (starsEl)    starsEl.textContent    = renderStars(data.averageRating);
  if (ratingEl)   ratingEl.textContent   = `${data.averageRating} / 5`;
  if (reviewCount) {
    const { analyzedCount: a, collectedCount: c } = data;
    reviewCount.textContent =
      a !== undefined && c !== undefined && a < c
        ? `${a.toLocaleString()} of ${c.toLocaleString()} reviews analyzed`
        : `${(c ?? data.totalReviews).toLocaleString()} reviews analyzed`;
  }
  if (summaryEl)  summaryEl.textContent  = data.summary;

  if (prosList) {
    prosList.innerHTML = data.pros
      .map((p) => `<li><span class="bullet pro-bullet">✓</span>${p}</li>`)
      .join('');
  }

  if (consList) {
    consList.innerHTML = data.cons
      .map((c) => `<li><span class="bullet con-bullet">✗</span>${c}</li>`)
      .join('');
  }

  if (themesList) {
    themesList.innerHTML = data.topThemes
      .map((t) => `<span class="theme-chip">${t}</span>`)
      .join('');
  }

  const staffSection = document.getElementById('staff-section');
  const staffList    = $('[data-field="staff"]');
  const staff        = data.notableStaff ?? [];
  if (staffSection) staffSection.hidden = staff.length === 0;
  if (staffList) {
    staffList.innerHTML = staff
      .map((name) => `<span class="staff-chip">★ ${name}</span>`)
      .join('');
  }

  if (analyzedAt) {
    analyzedAt.textContent = timestamp ? `Analyzed ${timeAgo(timestamp)}` : '';
  }

  stopAllStepTimers();
  setScreen('result');
}

// ─── Cancellation ────────────────────────────────────────────────────────────

let analysisCancelled = false;

async function cancelAnalysis(): Promise<void> {
  analysisCancelled = true;
  stopProgressPoll();
  stopAllStepTimers();
  try {
    if (currentTabId) {
      await sendToTab(currentTabId, { type: 'STOP_REVIEWS' } satisfies MessageType);
    }
  } catch { /* tab may have closed */ }
  await showInfoScreen();
}

async function stopGathering(): Promise<void> {
  stopProgressPoll();
  try {
    if (currentTabId) {
      await sendToTab(currentTabId, { type: 'STOP_REVIEWS' } satisfies MessageType);
    }
  } catch { /* tab may have closed */ }
}

// ─── Progress polling ─────────────────────────────────────────────────────────

let progressPollInterval: ReturnType<typeof setInterval> | null = null;

function startProgressPoll(tabId: number): void {
  progressPollInterval = setInterval(async () => {
    try {
      const response = await sendTabMessage(tabId, { type: 'GET_PROGRESS' } satisfies MessageType);
      if (response.type === 'PROGRESS') {
        const d1 = document.getElementById('step-1-detail');
        if (d1) d1.textContent = `${response.payload.count.toLocaleString()} reviews found`;
      }
    } catch { /* tab not ready yet */ }
  }, POPUP_CONFIG.PROGRESS_POLL_MS);
}

function stopProgressPoll(): void {
  if (progressPollInterval !== null) {
    clearInterval(progressPollInterval);
    progressPollInterval = null;
  }
}

// ─── Loading steps ────────────────────────────────────────────────────────────

const stepStartTimes: Partial<Record<1 | 2, number>> = {};
const stepIntervals:  Partial<Record<1 | 2, ReturnType<typeof setInterval>>> = {};

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function startStepTimer(step: 1 | 2): void {
  stepStartTimes[step] = Date.now();
  const el = document.getElementById(`step-${step}-time`);
  if (el) el.textContent = '0s';
  stepIntervals[step] = setInterval(() => {
    const elapsed = Date.now() - (stepStartTimes[step] ?? Date.now());
    if (el) el.textContent = formatElapsed(elapsed);
  }, 1000);
}

function stopStepTimer(step: 1 | 2): void {
  clearInterval(stepIntervals[step]);
  delete stepIntervals[step];
  const elapsed = Date.now() - (stepStartTimes[step] ?? Date.now());
  const el = document.getElementById(`step-${step}-time`);
  if (el) el.textContent = formatElapsed(elapsed);
}

function stopAllStepTimers(): void {
  ([1, 2] as const).forEach((s) => { if (stepIntervals[s]) stopStepTimer(s); });
}

function setLoadingStep(step: 1 | 2, detail?: string): void {
  const s1 = document.getElementById('step-1');
  const s2 = document.getElementById('step-2');
  const d1 = document.getElementById('step-1-detail');
  const d2 = document.getElementById('step-2-detail');
  const summarizeNowBtn = document.getElementById('summarize-now-btn') as HTMLButtonElement | null;

  if (step === 1) {
    s1?.classList.replace('step-pending', 'step-active') || s1?.classList.add('step-active');
    s2?.classList.add('step-pending');
    if (d1) d1.textContent = detail ?? 'Scrolling through reviews…';
    if (summarizeNowBtn) summarizeNowBtn.hidden = false;
    startStepTimer(1);
  } else {
    stopStepTimer(1);
    s1?.classList.remove('step-active');
    s1?.classList.add('step-done');
    const dot1 = s1?.querySelector('.step-dot');
    if (dot1) dot1.textContent = '✓';
    if (d1 && detail) d1.textContent = detail;
    s2?.classList.replace('step-pending', 'step-active') || s2?.classList.add('step-active');
    if (d2) d2.textContent = 'Summarizing with AI…';
    if (summarizeNowBtn) summarizeNowBtn.hidden = true;
    startStepTimer(2);
  }
}

// ─── Info screen ──────────────────────────────────────────────────────────────

let currentTabUrl = '';
let currentTabId  = 0;
let currentPlaceName: string | undefined;

/** Returns true when the active tab is a supported Google Maps / Search page. */
function isSupportedPage(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return (
      hostname === 'maps.google.com' ||
      (hostname === 'www.google.com' && (
        pathname.startsWith('/maps') ||
        pathname.startsWith('/search')
      ))
    );
  } catch {
    return false;
  }
}

async function showInfoScreen(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tab.url ?? '';
  currentTabId  = tab.id ?? 0;

  if (!isSupportedPage(currentTabUrl)) { setScreen('wrong-page'); return; }

  if (!currentTabId) { showError('Cannot access current tab.'); return; }

  try {
    const response = await sendToTab(currentTabId, { type: 'GET_BASIC_INFO' } satisfies MessageType);
    if (response.type === 'BASIC_INFO') {
      const { placeName, googleRating, googleReviewCount, category, address, phone } = response.payload;

      const nameEl  = $('[data-field="info-place-name"]');
      const starsEl = $('[data-field="info-stars"]');
      const ratingEl = $('[data-field="info-rating"]');
      const countEl = $('[data-field="info-review-count"]');
      currentPlaceName = placeName;
      if (nameEl)   nameEl.textContent   = placeName;
      if (starsEl)  starsEl.textContent  = googleRating ? renderStars(googleRating) : '';
      if (ratingEl) ratingEl.textContent = googleRating ? `${googleRating} / 5` : '';
      if (countEl)  countEl.textContent  = googleReviewCount ? `${googleReviewCount.toLocaleString()} reviews` : '';

      const catEl = $('[data-field="info-category"]');
      if (catEl) { catEl.textContent = category ?? ''; catEl.hidden = !category; }

      const addrRow = $('[data-field="info-address"]');
      if (addrRow) {
        const t = addrRow.querySelector<HTMLElement>('.info-text');
        if (t) t.textContent = address ?? '';
        addrRow.hidden = !address;
      }

      const phoneRow = $('[data-field="info-phone"]');
      if (phoneRow) {
        const t = phoneRow.querySelector<HTMLElement>('.info-text');
        if (t) t.textContent = phone ?? '';
        phoneRow.hidden = !phone;
      }
    }
  } catch {
    const nameEl = $('[data-field="info-place-name"]');
    if (nameEl) nameEl.textContent = 'Open a business on Google Maps';
  }

  const settings = await getSettings();
  const cached = await getCachedResult(currentTabUrl, settings, currentPlaceName);
  if (cached) { renderResult(cached.result, cached.timestamp); return; }

  setScreen('info');
}

// ─── Analyze ──────────────────────────────────────────────────────────────────

async function runAnalyze(forceFresh = false): Promise<void> {
  analysisCancelled = false;
  setScreen('loading');
  setLoadingStep(1);
  const settings = await getSettings();

  if (!currentTabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tab.url ?? '';
    currentTabId  = tab.id ?? 0;
  }

  if (!currentTabId) { showError('Cannot access current tab.'); return; }

  // reviewCount is now the scrape ceiling in every mode, capped by MAX_REVIEWS_ALL.
  const maxReviews = Math.min(settings.reviewCount, SCROLL_CONFIG.MAX_REVIEWS_ALL);

  let reviews: Review[];
  let placeName: string;
  let googleRating: number | undefined;
  let googleReviewCount: number | undefined;

  // Scrolling is the expensive half. Reuse a cached review set when one exists
  // so re-analyze and provider switches only pay for the AI call.
  const cachedReviews = forceFresh
    ? null
    : await getCachedReviews(currentTabUrl, maxReviews, currentPlaceName);

  if (cachedReviews) {
    console.log(`[GReviewSumm] Reusing ${cachedReviews.reviews.length} cached reviews — skipping scrape`);
    ({ reviews, placeName, googleRating, googleReviewCount } = cachedReviews);
    setLoadingStep(2, `${reviews.length.toLocaleString()} reviews (cached)`);
  } else {
    startProgressPoll(currentTabId);

    let reviewsResponse: MessageType;
    try {
      reviewsResponse = await sendToTab(currentTabId, {
        type: 'GET_REVIEWS',
        maxReviews,
        scrollConfig: {
          tabOpenWaitMs:     SCROLL_CONFIG.TAB_OPEN_WAIT_MS,
          pollIntervalMs:    SCROLL_CONFIG.POLL_INTERVAL_MS,
          scrollWaitMs:      SCROLL_CONFIG.SCROLL_WAIT_MS,
          moreReviewsWaitMs: SCROLL_CONFIG.MORE_REVIEWS_WAIT_MS,
          maxStableRounds:   SCROLL_CONFIG.MAX_STABLE_ROUNDS,
        },
      } satisfies MessageType);
    } catch (err) {
      stopProgressPoll();
      console.error('[GReviewSumm] Message error:', err);
      showError(`Extension error: ${err}. Make sure you're on Google Maps (google.com/maps) and the page has fully loaded.`);
      return;
    }

    stopProgressPoll();

    if (analysisCancelled) return;
    if (reviewsResponse.type === 'NO_REVIEWS') { setScreen('no-reviews'); return; }
    if (reviewsResponse.type === 'ERROR')      { showError(reviewsResponse.payload); return; }
    if (reviewsResponse.type !== 'REVIEWS_DATA') {
      showError('Unexpected response while gathering reviews.');
      return;
    }

    ({ reviews, placeName, googleRating, googleReviewCount } = reviewsResponse.payload);
    console.log(`[GReviewSumm] Got ${reviews.length} reviews, Google rating: ${googleRating ?? 'n/a'}`);
    setLoadingStep(2, `${reviews.length.toLocaleString()} reviews collected`);

    await setCachedReviews(currentTabUrl, {
      reviews, placeName, googleRating, googleReviewCount, maxReviews, timestamp: Date.now(),
    });
  }

  currentPlaceName = placeName;

  // Only rating and text ever reach the model. author is used solely for
  // scrape-time dedup and date only by the time-window scopes, so both are
  // dropped before crossing the message boundary.
  const needsDate = settings.reviewMode !== 'all' && settings.reviewMode !== 'recent';
  const payloadReviews: Review[] = reviews.map((r) => ({
    author: '',
    rating: r.rating,
    text: r.text,
    ...(needsDate && r.date !== undefined ? { date: r.date } : {}),
  }));

  let summaryResponse: MessageType;
  try {
    summaryResponse = await sendRuntimeMessage({
      type: 'SUMMARIZE',
      payload: { reviews: payloadReviews, placeName, settings, googleRating, googleReviewCount },
    } satisfies MessageType);
  } catch (err) {
    console.error('[GReviewSumm] Background error:', err);
    showError(`Failed to summarize: ${err}`);
    return;
  }

  if (analysisCancelled) return;
  if (summaryResponse.type === 'SUMMARY_RESULT') {
    const timestamp = Date.now();
    await setCachedResult(currentTabUrl, settings, summaryResponse.payload);
    renderResult(summaryResponse.payload, timestamp);
  } else if (summaryResponse.type === 'ERROR') {
    showError(summaryResponse.payload);
  }
}

function showError(message: string): void {
  const errEl = $('[data-field="error-message"]');
  if (errEl) errEl.textContent = message;
  setScreen('error');
}

// ─── Event listeners ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await getSettings();
  applySettingsToUI(settings);

  // Review scope buttons
  document.querySelectorAll<HTMLElement>('#review-mode-group .scope-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#review-mode-group .scope-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      updateCountFieldVisibility(btn.dataset.value as ReviewSettings['reviewMode']);
    });
  });

  // AI provider buttons
  document.querySelectorAll<HTMLElement>('#ai-provider-group .scope-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ai-provider-group .scope-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      updateProviderVisibility(btn.dataset.value as ReviewSettings['aiProvider']);
    });
  });

  // Ollama sliders — live value labels
  (['temp', 'topp', 'rp'] as const).forEach((param) => {
    const slider = document.querySelector<HTMLInputElement>(`#ollama-${param}`);
    const valEl  = document.getElementById(`ollama-${param}-val`);
    slider?.addEventListener('input', () => { if (valEl) valEl.textContent = slider.value; });
  });

  // API key clear buttons — mark key for removal on next save
  document.querySelectorAll<HTMLElement>('.clear-key-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider ?? '';
      _clearKeys.add(provider);
      applyKeyStatus(provider, false);
    });
  });

  // History screen
  $('[data-action="open-history"]')?.addEventListener('click', () => showHistory());
  $('[data-action="back-from-history"]')?.addEventListener('click', () => showInfoScreen());

  document.getElementById('clear-history-btn')?.addEventListener('click', async () => {
    await clearAllHistory();
    showHistory();
  });

  document.getElementById('history-list')?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const deleteBtn = target.closest<HTMLElement>('.history-delete');
    if (deleteBtn) {
      e.stopPropagation();
      await deleteHistoryEntry(decodeURIComponent(deleteBtn.dataset.key ?? ''));
      showHistory();
      return;
    }
    const item = target.closest<HTMLElement>('.history-item');
    if (item) {
      const key = decodeURIComponent(item.dataset.key ?? '');
      const entries = await getAllCacheEntries();
      const found = entries.find((e) => e.key === key);
      if (found) renderResult(found.entry.result, found.entry.timestamp);
    }
  });

  // Info screen
  $('[data-action="analyze"]')?.addEventListener('click', () => runAnalyze());

  // Result screen
  $('[data-action="re-analyze"]')?.addEventListener('click', () => runAnalyze());
  $('[data-action="fresh-scrape"]')?.addEventListener('click', () => runAnalyze(true));
  $('[data-action="open-settings"]')?.addEventListener('click', () => openSettings());

  // Settings
  $('[data-action="save-settings"]')?.addEventListener('click', async () => {
    const newSettings = readSettingsFromUI();
    await ensureCustomEndpointPermission(newSettings);
    await saveSettings(newSettings);
    await runAnalyze();
  });
  // Persist without kicking off a full scrape — changing a model or pasting a
  // key should not force a 30-60s analysis.
  $('[data-action="save-settings-only"]')?.addEventListener('click', async () => {
    const newSettings = readSettingsFromUI();
    await ensureCustomEndpointPermission(newSettings);
    await saveSettings(newSettings);
    await showInfoScreen();
  });
  $('[data-action="cancel-settings"]')?.addEventListener('click', () => showInfoScreen());

  // Loading controls
  document.getElementById('summarize-now-btn')?.addEventListener('click', () => stopGathering());
  document.getElementById('cancel-btn')?.addEventListener('click', () => cancelAnalysis());

  // Wrong-page screen
  $('[data-action="open-maps"]')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://maps.google.com' });
  });

  // Error / no-reviews
  document.querySelectorAll<HTMLElement>('[data-action="retry"]').forEach((btn) => {
    btn.addEventListener('click', () => runAnalyze());
  });
  $('[data-action="back"]')?.addEventListener('click', () => showInfoScreen());

  await showInfoScreen();
});
