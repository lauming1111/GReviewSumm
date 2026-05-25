import { SCROLL_CONFIG, POPUP_CONFIG, AI_DEFAULTS } from './config.js';
import { encryptApiKey, decryptApiKey } from './crypto.js';
// ─── DOM helpers ──────────────────────────────────────────────────────────────
function $(selector) {
    return document.querySelector(selector);
}
function setScreen(name) {
    document.querySelectorAll('.screen').forEach((el) => {
        el.hidden = el.dataset.screen !== name;
    });
}
// ─── Settings ─────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
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
const ALL_PROVIDERS = ['ollama', 'openai', 'anthropic', 'gemini', 'groq', 'xai', 'custom'];
// Default placeholder text for each provider's key input
const KEY_PLACEHOLDERS = {
    openai: 'sk-…',
    anthropic: 'sk-ant-…',
    gemini: 'AIza…',
    groq: 'gsk_…',
    xai: 'xai-…',
    custom: 'Leave blank if not required',
};
/** Fields in ReviewSettings that contain API keys and must be encrypted at rest. */
const API_KEY_FIELDS = [
    'openaiApiKey', 'anthropicApiKey', 'geminiApiKey',
    'groqApiKey', 'xaiApiKey', 'customApiKey',
];
async function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['gReviewSummSettings'], async (result) => {
            const stored = (result.gReviewSummSettings ?? DEFAULT_SETTINGS);
            const settings = { ...stored };
            for (const field of API_KEY_FIELDS) {
                const val = stored[field];
                if (typeof val === 'string' && val.length > 0) {
                    try {
                        settings[field] = await decryptApiKey(val);
                    }
                    catch {
                        // Salt was reset or blob is corrupt — clear this key so the user re-enters it
                        console.warn(`[GReviewSumm] Could not decrypt ${field} — clearing it.`);
                        settings[field] = undefined;
                    }
                }
            }
            resolve(settings);
        });
    });
}
async function saveSettings(settings) {
    const stored = { ...settings };
    for (const field of API_KEY_FIELDS) {
        const val = settings[field];
        if (typeof val === 'string' && val.length > 0) {
            stored[field] = await encryptApiKey(val);
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
const _clearKeys = new Set();
/** The settings that were loaded when the settings panel was last opened. */
let _loadedSettings = { ...DEFAULT_SETTINGS };
/** Render key-field status for one provider. Never populates the input value. */
function applyKeyStatus(provider, hasKey) {
    const statusEl = document.getElementById(`${provider}-key-status`);
    const clearBtn = document.getElementById(`${provider}-clear-key`);
    const inputEl = document.querySelector(`#${provider}-key-input`);
    const placeholder = KEY_PLACEHOLDERS[provider] ?? 'API key';
    if (statusEl) {
        statusEl.textContent = hasKey ? '✓ Saved' : '';
        statusEl.className = `key-status${hasKey ? ' saved' : ''}`;
    }
    if (clearBtn)
        clearBtn.hidden = !hasKey;
    if (inputEl) {
        inputEl.value = ''; // never expose the key
        inputEl.placeholder = hasKey ? 'Leave blank to keep · or enter a new key' : placeholder;
    }
}
/**
 * Read a provider's key from the UI.
 * - If the user typed something → use it.
 * - If the user explicitly clicked "✕ Clear" → return undefined (removes the key).
 * - Otherwise (input left empty) → preserve the key from storage.
 */
function readKeyFromUI(inputId, provider, existingKey) {
    if (_clearKeys.has(provider))
        return undefined;
    const el = document.querySelector(`#${inputId}`);
    const typed = el?.value.trim();
    return typed || existingKey || undefined;
}
// ─── Provider / count field visibility ───────────────────────────────────────
function updateCountFieldVisibility(mode) {
    const wrapper = document.getElementById('count-field-wrapper');
    if (wrapper)
        wrapper.hidden = mode === 'all';
}
function updateProviderVisibility(provider) {
    ALL_PROVIDERS.forEach((p) => {
        const el = document.getElementById(`${p}-config`);
        if (el)
            el.hidden = p !== provider;
    });
}
// ─── Slider helper ────────────────────────────────────────────────────────────
function setSlider(inputId, valId, value) {
    const input = document.querySelector(`#${inputId}`);
    const label = document.getElementById(valId);
    if (input)
        input.value = String(value);
    if (label)
        label.textContent = String(value);
}
// ─── Apply / read settings ────────────────────────────────────────────────────
function applySettingsToUI(settings) {
    _loadedSettings = { ...settings };
    // Review scope buttons
    document.querySelectorAll('#review-mode-group .scope-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.value === settings.reviewMode);
    });
    const countInput = document.querySelector('#review-count-input');
    if (countInput)
        countInput.value = String(settings.reviewCount);
    updateCountFieldVisibility(settings.reviewMode);
    // Provider buttons
    document.querySelectorAll('#ai-provider-group .scope-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.value === (settings.aiProvider ?? 'ollama'));
    });
    updateProviderVisibility(settings.aiProvider ?? 'ollama');
    // ── Ollama ──────────────────────────────────────────────────────────────────
    const ollamaModelEl = document.querySelector('#ollama-model-input');
    if (ollamaModelEl)
        ollamaModelEl.value = settings.ollamaModel ?? DEFAULT_SETTINGS.ollamaModel ?? '';
    const p = settings.ollamaParams ?? {};
    setSlider('ollama-temp', 'ollama-temp-val', p.temperature ?? AI_DEFAULTS.OLLAMA_TEMPERATURE);
    setSlider('ollama-topp', 'ollama-topp-val', p.topP ?? AI_DEFAULTS.OLLAMA_TOP_P);
    setSlider('ollama-rp', 'ollama-rp-val', p.repeatPenalty ?? AI_DEFAULTS.OLLAMA_REPEAT_PENALTY);
    const topkEl = document.querySelector('#ollama-topk');
    const numctxEl = document.querySelector('#ollama-numctx');
    if (topkEl)
        topkEl.value = String(p.topK ?? AI_DEFAULTS.OLLAMA_TOP_K);
    if (numctxEl)
        numctxEl.value = String(p.numCtx ?? AI_DEFAULTS.OLLAMA_NUM_CTX);
    // ── Model selects / inputs (non-key) ────────────────────────────────────────
    const openaiModelEl = document.querySelector('#openai-model-select');
    if (openaiModelEl)
        openaiModelEl.value = settings.openaiModel ?? DEFAULT_SETTINGS.openaiModel ?? 'gpt-4o-mini';
    const anthropicModelEl = document.querySelector('#anthropic-model-input');
    if (anthropicModelEl)
        anthropicModelEl.value = settings.anthropicModel ?? DEFAULT_SETTINGS.anthropicModel ?? '';
    const geminiModelEl = document.querySelector('#gemini-model-select');
    if (geminiModelEl)
        geminiModelEl.value = settings.geminiModel ?? DEFAULT_SETTINGS.geminiModel ?? 'gemini-2.0-flash';
    const groqModelEl = document.querySelector('#groq-model-select');
    if (groqModelEl)
        groqModelEl.value = settings.groqModel ?? DEFAULT_SETTINGS.groqModel ?? 'llama-3.3-70b-versatile';
    const xaiModelEl = document.querySelector('#xai-model-select');
    if (xaiModelEl)
        xaiModelEl.value = settings.xaiModel ?? DEFAULT_SETTINGS.xaiModel ?? 'grok-3-mini-latest';
    const customEndpointEl = document.querySelector('#custom-endpoint-input');
    if (customEndpointEl)
        customEndpointEl.value = settings.customEndpoint ?? '';
    const customModelEl = document.querySelector('#custom-model-input');
    if (customModelEl)
        customModelEl.value = settings.customModel ?? '';
    // ── API key status (never expose the key itself) ─────────────────────────────
    applyKeyStatus('openai', !!settings.openaiApiKey);
    applyKeyStatus('anthropic', !!settings.anthropicApiKey);
    applyKeyStatus('gemini', !!settings.geminiApiKey);
    applyKeyStatus('groq', !!settings.groqApiKey);
    applyKeyStatus('xai', !!settings.xaiApiKey);
    applyKeyStatus('custom', !!settings.customApiKey);
}
function readSettingsFromUI() {
    const activeScope = document.querySelector('#review-mode-group .scope-btn.active');
    const activeProvider = document.querySelector('#ai-provider-group .scope-btn.active');
    const countInput = document.querySelector('#review-count-input');
    const ollamaModelEl = document.querySelector('#ollama-model-input');
    const ollamaTempEl = document.querySelector('#ollama-temp');
    const ollamaToppEl = document.querySelector('#ollama-topp');
    const ollamaRpEl = document.querySelector('#ollama-rp');
    const ollamaTopkEl = document.querySelector('#ollama-topk');
    const ollamaNumctxEl = document.querySelector('#ollama-numctx');
    const openaiModelEl = document.querySelector('#openai-model-select');
    const anthropicModelEl = document.querySelector('#anthropic-model-input');
    const geminiModelEl = document.querySelector('#gemini-model-select');
    const groqModelEl = document.querySelector('#groq-model-select');
    const xaiModelEl = document.querySelector('#xai-model-select');
    const customEndpointEl = document.querySelector('#custom-endpoint-input');
    const customModelEl = document.querySelector('#custom-model-input');
    return {
        reviewMode: activeScope?.dataset.value ?? DEFAULT_SETTINGS.reviewMode,
        reviewCount: Math.max(10, Number(countInput?.value ?? DEFAULT_SETTINGS.reviewCount)),
        aiProvider: activeProvider?.dataset.value ?? 'ollama',
        ollamaModel: ollamaModelEl?.value.trim() || DEFAULT_SETTINGS.ollamaModel,
        ollamaParams: {
            temperature: ollamaTempEl ? parseFloat(ollamaTempEl.value) : AI_DEFAULTS.OLLAMA_TEMPERATURE,
            topP: ollamaToppEl ? parseFloat(ollamaToppEl.value) : AI_DEFAULTS.OLLAMA_TOP_P,
            repeatPenalty: ollamaRpEl ? parseFloat(ollamaRpEl.value) : AI_DEFAULTS.OLLAMA_REPEAT_PENALTY,
            topK: ollamaTopkEl ? parseInt(ollamaTopkEl.value, 10) : AI_DEFAULTS.OLLAMA_TOP_K,
            numCtx: ollamaNumctxEl ? parseInt(ollamaNumctxEl.value, 10) : AI_DEFAULTS.OLLAMA_NUM_CTX,
        },
        // API keys: blank = keep existing, explicit clear = remove
        openaiApiKey: readKeyFromUI('openai-key-input', 'openai', _loadedSettings.openaiApiKey),
        openaiModel: openaiModelEl?.value || DEFAULT_SETTINGS.openaiModel,
        anthropicApiKey: readKeyFromUI('anthropic-key-input', 'anthropic', _loadedSettings.anthropicApiKey),
        anthropicModel: anthropicModelEl?.value.trim() || DEFAULT_SETTINGS.anthropicModel,
        geminiApiKey: readKeyFromUI('gemini-key-input', 'gemini', _loadedSettings.geminiApiKey),
        geminiModel: geminiModelEl?.value || DEFAULT_SETTINGS.geminiModel,
        groqApiKey: readKeyFromUI('groq-key-input', 'groq', _loadedSettings.groqApiKey),
        groqModel: groqModelEl?.value || DEFAULT_SETTINGS.groqModel,
        xaiApiKey: readKeyFromUI('xai-key-input', 'xai', _loadedSettings.xaiApiKey),
        xaiModel: xaiModelEl?.value || DEFAULT_SETTINGS.xaiModel,
        customEndpoint: customEndpointEl?.value.trim() || undefined,
        customApiKey: readKeyFromUI('custom-key-input', 'custom', _loadedSettings.customApiKey),
        customModel: customModelEl?.value.trim() || undefined,
    };
}
// ─── Open settings ────────────────────────────────────────────────────────────
async function openSettings() {
    _clearKeys.clear(); // reset any pending clears from last session
    const settings = await getSettings();
    applySettingsToUI(settings);
    setScreen('settings');
}
function normalizeUrl(url) {
    try {
        const u = new URL(url);
        return u.origin + u.pathname;
    }
    catch {
        return url;
    }
}
async function getCachedResult(url) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['gReviewSummCache'], (data) => {
            const cache = (data.gReviewSummCache ?? {});
            const entry = cache[normalizeUrl(url)];
            if (!entry)
                return resolve(null);
            if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000)
                return resolve(null);
            resolve(entry);
        });
    });
}
async function setCachedResult(url, result) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['gReviewSummCache'], (data) => {
            const cache = (data.gReviewSummCache ?? {});
            cache[normalizeUrl(url)] = { result, timestamp: Date.now() };
            chrome.storage.local.set({ gReviewSummCache: cache }, resolve);
        });
    });
}
function timeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1)
        return 'just now';
    if (mins < 60)
        return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
async function getAllCacheEntries() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['gReviewSummCache'], (data) => {
            const cache = (data.gReviewSummCache ?? {});
            const entries = Object.entries(cache)
                .map(([key, entry]) => ({ key, entry }))
                .sort((a, b) => b.entry.timestamp - a.entry.timestamp);
            resolve(entries);
        });
    });
}
async function deleteHistoryEntry(key) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['gReviewSummCache'], (data) => {
            const cache = (data.gReviewSummCache ?? {});
            delete cache[key];
            chrome.storage.local.set({ gReviewSummCache: cache }, resolve);
        });
    });
}
async function clearAllHistory() {
    return new Promise((resolve) => {
        chrome.storage.local.remove(['gReviewSummCache'], resolve);
    });
}
async function showHistory() {
    const entries = await getAllCacheEntries();
    const list = document.getElementById('history-list');
    if (!list)
        return;
    if (entries.length === 0) {
        list.innerHTML = '<p class="history-empty">No analyzed places yet.</p>';
        setScreen('history');
        return;
    }
    const sentimentColors = {
        positive: 'sentiment-positive',
        negative: 'sentiment-negative',
        neutral: 'sentiment-neutral',
        mixed: 'sentiment-mixed',
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
function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError.message ?? 'Unknown error');
                return;
            }
            if (!response) {
                reject('No response from content script');
                return;
            }
            resolve(response);
        });
    });
}
async function sendToTab(tabId, message) {
    try {
        return await sendTabMessage(tabId, message);
    }
    catch (err) {
        const msg = String(err);
        if (msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection')) {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
            await new Promise((r) => setTimeout(r, 300));
            return sendTabMessage(tabId, message);
        }
        throw err;
    }
}
function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError.message ?? 'Background error');
                return;
            }
            if (!response) {
                reject('No response from background');
                return;
            }
            resolve(response);
        });
    });
}
// ─── Render result ────────────────────────────────────────────────────────────
const sentimentLabel = {
    positive: '😊 Mostly Positive',
    negative: '😞 Mostly Negative',
    neutral: '😐 Neutral',
    mixed: '🤔 Mixed Reviews',
};
const sentimentClass = {
    positive: 'sentiment-positive',
    negative: 'sentiment-negative',
    neutral: 'sentiment-neutral',
    mixed: 'sentiment-mixed',
};
function renderStars(rating) {
    const full = Math.floor(rating);
    const half = rating % 1 >= 0.5;
    const empty = 5 - full - (half ? 1 : 0);
    return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}
function renderResult(data, timestamp) {
    const placeName = $('[data-field="place-name"]');
    const sentiment = $('[data-field="sentiment"]');
    const starsEl = $('[data-field="stars"]');
    const ratingEl = $('[data-field="rating"]');
    const reviewCount = $('[data-field="review-count"]');
    const summaryEl = $('[data-field="summary"]');
    const prosList = $('[data-field="pros"]');
    const consList = $('[data-field="cons"]');
    const themesList = $('[data-field="themes"]');
    const analyzedAt = document.getElementById('analyzed-at');
    if (placeName)
        placeName.textContent = data.placeName;
    if (sentiment) {
        sentiment.textContent = sentimentLabel[data.overallSentiment];
        sentiment.className = `sentiment-badge ${sentimentClass[data.overallSentiment]}`;
    }
    if (starsEl)
        starsEl.textContent = renderStars(data.averageRating);
    if (ratingEl)
        ratingEl.textContent = `${data.averageRating} / 5`;
    if (reviewCount)
        reviewCount.textContent = `${data.totalReviews.toLocaleString()} reviews analyzed`;
    if (summaryEl)
        summaryEl.textContent = data.summary;
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
    const staffList = $('[data-field="staff"]');
    const staff = data.notableStaff ?? [];
    if (staffSection)
        staffSection.hidden = staff.length === 0;
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
async function cancelAnalysis() {
    analysisCancelled = true;
    stopProgressPoll();
    stopAllStepTimers();
    try {
        if (currentTabId) {
            await sendToTab(currentTabId, { type: 'STOP_REVIEWS' });
        }
    }
    catch { /* tab may have closed */ }
    await showInfoScreen();
}
async function stopGathering() {
    stopProgressPoll();
    try {
        if (currentTabId) {
            await sendToTab(currentTabId, { type: 'STOP_REVIEWS' });
        }
    }
    catch { /* tab may have closed */ }
}
// ─── Progress polling ─────────────────────────────────────────────────────────
let progressPollInterval = null;
function startProgressPoll(tabId) {
    progressPollInterval = setInterval(async () => {
        try {
            const response = await sendTabMessage(tabId, { type: 'GET_PROGRESS' });
            if (response.type === 'PROGRESS') {
                const d1 = document.getElementById('step-1-detail');
                if (d1)
                    d1.textContent = `${response.payload.count.toLocaleString()} reviews found`;
            }
        }
        catch { /* tab not ready yet */ }
    }, POPUP_CONFIG.PROGRESS_POLL_MS);
}
function stopProgressPoll() {
    if (progressPollInterval !== null) {
        clearInterval(progressPollInterval);
        progressPollInterval = null;
    }
}
// ─── Loading steps ────────────────────────────────────────────────────────────
const stepStartTimes = {};
const stepIntervals = {};
function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}
function startStepTimer(step) {
    stepStartTimes[step] = Date.now();
    const el = document.getElementById(`step-${step}-time`);
    if (el)
        el.textContent = '0s';
    stepIntervals[step] = setInterval(() => {
        const elapsed = Date.now() - (stepStartTimes[step] ?? Date.now());
        if (el)
            el.textContent = formatElapsed(elapsed);
    }, 1000);
}
function stopStepTimer(step) {
    clearInterval(stepIntervals[step]);
    delete stepIntervals[step];
    const elapsed = Date.now() - (stepStartTimes[step] ?? Date.now());
    const el = document.getElementById(`step-${step}-time`);
    if (el)
        el.textContent = formatElapsed(elapsed);
}
function stopAllStepTimers() {
    [1, 2].forEach((s) => { if (stepIntervals[s])
        stopStepTimer(s); });
}
function setLoadingStep(step, detail) {
    const s1 = document.getElementById('step-1');
    const s2 = document.getElementById('step-2');
    const d1 = document.getElementById('step-1-detail');
    const d2 = document.getElementById('step-2-detail');
    const summarizeNowBtn = document.getElementById('summarize-now-btn');
    if (step === 1) {
        s1?.classList.replace('step-pending', 'step-active') || s1?.classList.add('step-active');
        s2?.classList.add('step-pending');
        if (d1)
            d1.textContent = detail ?? 'Scrolling through reviews…';
        if (summarizeNowBtn)
            summarizeNowBtn.hidden = false;
        startStepTimer(1);
    }
    else {
        stopStepTimer(1);
        s1?.classList.remove('step-active');
        s1?.classList.add('step-done');
        const dot1 = s1?.querySelector('.step-dot');
        if (dot1)
            dot1.textContent = '✓';
        if (d1 && detail)
            d1.textContent = detail;
        s2?.classList.replace('step-pending', 'step-active') || s2?.classList.add('step-active');
        if (d2)
            d2.textContent = 'Summarizing with AI…';
        if (summarizeNowBtn)
            summarizeNowBtn.hidden = true;
        startStepTimer(2);
    }
}
// ─── Info screen ──────────────────────────────────────────────────────────────
let currentTabUrl = '';
let currentTabId = 0;
async function showInfoScreen() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tab.url ?? '';
    currentTabId = tab.id ?? 0;
    if (!currentTabId) {
        showError('Cannot access current tab.');
        return;
    }
    try {
        const response = await sendToTab(currentTabId, { type: 'GET_BASIC_INFO' });
        if (response.type === 'BASIC_INFO') {
            const { placeName, googleRating, googleReviewCount, category, address, phone } = response.payload;
            const nameEl = $('[data-field="info-place-name"]');
            const starsEl = $('[data-field="info-stars"]');
            const ratingEl = $('[data-field="info-rating"]');
            const countEl = $('[data-field="info-review-count"]');
            if (nameEl)
                nameEl.textContent = placeName;
            if (starsEl)
                starsEl.textContent = googleRating ? renderStars(googleRating) : '';
            if (ratingEl)
                ratingEl.textContent = googleRating ? `${googleRating} / 5` : '';
            if (countEl)
                countEl.textContent = googleReviewCount ? `${googleReviewCount.toLocaleString()} reviews` : '';
            const catEl = $('[data-field="info-category"]');
            if (catEl) {
                catEl.textContent = category ?? '';
                catEl.hidden = !category;
            }
            const addrRow = $('[data-field="info-address"]');
            if (addrRow) {
                const t = addrRow.querySelector('.info-text');
                if (t)
                    t.textContent = address ?? '';
                addrRow.hidden = !address;
            }
            const phoneRow = $('[data-field="info-phone"]');
            if (phoneRow) {
                const t = phoneRow.querySelector('.info-text');
                if (t)
                    t.textContent = phone ?? '';
                phoneRow.hidden = !phone;
            }
        }
    }
    catch {
        const nameEl = $('[data-field="info-place-name"]');
        if (nameEl)
            nameEl.textContent = 'Open a business on Google Maps';
    }
    const cached = await getCachedResult(currentTabUrl);
    if (cached) {
        renderResult(cached.result, cached.timestamp);
        return;
    }
    const viewCacheBtn = document.getElementById('view-cache-btn');
    if (viewCacheBtn)
        viewCacheBtn.hidden = true;
    setScreen('info');
}
// ─── Analyze ──────────────────────────────────────────────────────────────────
async function runAnalyze() {
    analysisCancelled = false;
    setScreen('loading');
    setLoadingStep(1);
    const settings = await getSettings();
    if (!currentTabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        currentTabUrl = tab.url ?? '';
        currentTabId = tab.id ?? 0;
    }
    if (!currentTabId) {
        showError('Cannot access current tab.');
        return;
    }
    startProgressPoll(currentTabId);
    let reviewsResponse;
    try {
        const maxReviews = settings.reviewMode === 'recent' ? settings.reviewCount : 10000;
        reviewsResponse = await sendToTab(currentTabId, {
            type: 'GET_REVIEWS',
            maxReviews,
            scrollConfig: {
                tabOpenWaitMs: SCROLL_CONFIG.TAB_OPEN_WAIT_MS,
                pollIntervalMs: SCROLL_CONFIG.POLL_INTERVAL_MS,
                scrollWaitMs: SCROLL_CONFIG.SCROLL_WAIT_MS,
                moreReviewsWaitMs: SCROLL_CONFIG.MORE_REVIEWS_WAIT_MS,
                maxStableRounds: SCROLL_CONFIG.MAX_STABLE_ROUNDS,
            },
        });
    }
    catch (err) {
        stopProgressPoll();
        console.error('[GReviewSumm] Message error:', err);
        showError(`Extension error: ${err}. Make sure you're on Google Maps (google.com/maps) and the page has fully loaded.`);
        return;
    }
    stopProgressPoll();
    if (analysisCancelled)
        return;
    if (reviewsResponse.type === 'NO_REVIEWS') {
        setScreen('no-reviews');
        return;
    }
    if (reviewsResponse.type === 'ERROR') {
        showError(reviewsResponse.payload);
        return;
    }
    if (reviewsResponse.type === 'REVIEWS_DATA') {
        const { reviews, placeName, googleRating, googleReviewCount } = reviewsResponse.payload;
        console.log(`[GReviewSumm] Got ${reviews.length} reviews, Google rating: ${googleRating ?? 'n/a'}`);
        setLoadingStep(2, `${reviews.length.toLocaleString()} reviews collected`);
        let summaryResponse;
        try {
            summaryResponse = await sendRuntimeMessage({
                type: 'SUMMARIZE',
                payload: { reviews, placeName, settings, googleRating, googleReviewCount },
            });
        }
        catch (err) {
            console.error('[GReviewSumm] Background error:', err);
            showError(`Failed to summarize: ${err}`);
            return;
        }
        if (analysisCancelled)
            return;
        if (summaryResponse.type === 'SUMMARY_RESULT') {
            const timestamp = Date.now();
            await setCachedResult(currentTabUrl, summaryResponse.payload);
            renderResult(summaryResponse.payload, timestamp);
        }
        else if (summaryResponse.type === 'ERROR') {
            showError(summaryResponse.payload);
        }
    }
}
function showError(message) {
    const errEl = $('[data-field="error-message"]');
    if (errEl)
        errEl.textContent = message;
    setScreen('error');
}
// ─── Event listeners ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    const settings = await getSettings();
    applySettingsToUI(settings);
    // Review scope buttons
    document.querySelectorAll('#review-mode-group .scope-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#review-mode-group .scope-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            updateCountFieldVisibility(btn.dataset.value);
        });
    });
    // AI provider buttons
    document.querySelectorAll('#ai-provider-group .scope-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#ai-provider-group .scope-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            updateProviderVisibility(btn.dataset.value);
        });
    });
    // Ollama sliders — live value labels
    ['temp', 'topp', 'rp'].forEach((param) => {
        const slider = document.querySelector(`#ollama-${param}`);
        const valEl = document.getElementById(`ollama-${param}-val`);
        slider?.addEventListener('input', () => { if (valEl)
            valEl.textContent = slider.value; });
    });
    // API key clear buttons — mark key for removal on next save
    document.querySelectorAll('.clear-key-btn').forEach((btn) => {
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
        const target = e.target;
        const deleteBtn = target.closest('.history-delete');
        if (deleteBtn) {
            e.stopPropagation();
            await deleteHistoryEntry(decodeURIComponent(deleteBtn.dataset.key ?? ''));
            showHistory();
            return;
        }
        const item = target.closest('.history-item');
        if (item) {
            const key = decodeURIComponent(item.dataset.key ?? '');
            const entries = await getAllCacheEntries();
            const found = entries.find((e) => e.key === key);
            if (found)
                renderResult(found.entry.result, found.entry.timestamp);
        }
    });
    // Info screen
    $('[data-action="analyze"]')?.addEventListener('click', () => runAnalyze());
    // Result screen
    $('[data-action="re-analyze"]')?.addEventListener('click', () => runAnalyze());
    $('[data-action="open-settings"]')?.addEventListener('click', () => openSettings());
    // Settings
    $('[data-action="save-settings"]')?.addEventListener('click', async () => {
        const newSettings = readSettingsFromUI();
        await saveSettings(newSettings);
        await runAnalyze();
    });
    $('[data-action="cancel-settings"]')?.addEventListener('click', () => showInfoScreen());
    // Loading controls
    document.getElementById('summarize-now-btn')?.addEventListener('click', () => stopGathering());
    document.getElementById('cancel-btn')?.addEventListener('click', () => cancelAnalysis());
    // Error / no-reviews
    document.querySelectorAll('[data-action="retry"]').forEach((btn) => {
        btn.addEventListener('click', () => runAnalyze());
    });
    $('[data-action="back"]')?.addEventListener('click', () => showInfoScreen());
    await showInfoScreen();
});
