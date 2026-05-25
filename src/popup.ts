import type { MessageType, ReviewSettings, SummaryResult } from './types.js';
import { SCROLL_CONFIG, POPUP_CONFIG } from './config.js';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function $(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

function setScreen(name: 'info' | 'history' | 'settings' | 'loading' | 'result' | 'error' | 'no-reviews'): void {
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
  openaiModel: 'gpt-4o-mini',
};

async function getSettings(): Promise<ReviewSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['reviewLensSettings'], (result) => {
      resolve((result.reviewLensSettings as ReviewSettings) ?? DEFAULT_SETTINGS);
    });
  });
}

async function saveSettings(settings: ReviewSettings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ reviewLensSettings: settings }, resolve);
  });
}

function updateCountFieldVisibility(mode: ReviewSettings['reviewMode']): void {
  const wrapper = document.getElementById('count-field-wrapper');
  if (wrapper) wrapper.hidden = mode === 'all';
}

function updateProviderVisibility(provider: ReviewSettings['aiProvider']): void {
  const ollamaEl = document.getElementById('ollama-config');
  const openaiEl = document.getElementById('openai-config');
  if (ollamaEl) ollamaEl.hidden = provider !== 'ollama';
  if (openaiEl) openaiEl.hidden = provider !== 'openai';
}

function applySettingsToUI(settings: ReviewSettings): void {
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

  // Provider-specific fields
  const ollamaModelEl = document.querySelector<HTMLInputElement>('#ollama-model-input');
  if (ollamaModelEl) ollamaModelEl.value = settings.ollamaModel ?? DEFAULT_SETTINGS.ollamaModel ?? '';

  const openaiKeyEl = document.querySelector<HTMLInputElement>('#openai-key-input');
  if (openaiKeyEl) openaiKeyEl.value = settings.openaiApiKey ?? '';

  const openaiModelEl = document.querySelector<HTMLSelectElement>('#openai-model-select');
  if (openaiModelEl) openaiModelEl.value = settings.openaiModel ?? DEFAULT_SETTINGS.openaiModel ?? 'gpt-4o-mini';
}

function readSettingsFromUI(): ReviewSettings {
  const activeScope = document.querySelector<HTMLElement>('#review-mode-group .scope-btn.active');
  const activeProvider = document.querySelector<HTMLElement>('#ai-provider-group .scope-btn.active');
  const countInput = document.querySelector<HTMLInputElement>('#review-count-input');
  const ollamaModelEl = document.querySelector<HTMLInputElement>('#ollama-model-input');
  const openaiKeyEl = document.querySelector<HTMLInputElement>('#openai-key-input');
  const openaiModelEl = document.querySelector<HTMLSelectElement>('#openai-model-select');

  return {
    reviewMode: (activeScope?.dataset.value as ReviewSettings['reviewMode']) ?? DEFAULT_SETTINGS.reviewMode,
    reviewCount: Math.max(10, Number(countInput?.value ?? DEFAULT_SETTINGS.reviewCount)),
    aiProvider: (activeProvider?.dataset.value as ReviewSettings['aiProvider']) ?? 'ollama',
    ollamaModel: ollamaModelEl?.value.trim() || DEFAULT_SETTINGS.ollamaModel,
    openaiApiKey: openaiKeyEl?.value.trim() || undefined,
    openaiModel: openaiModelEl?.value || DEFAULT_SETTINGS.openaiModel,
  };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: SummaryResult;
  timestamp: number;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

async function getCachedResult(url: string): Promise<CacheEntry | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['reviewLensCache'], (data) => {
      const cache = (data.reviewLensCache ?? {}) as Record<string, CacheEntry>;
      const entry = cache[normalizeUrl(url)];
      if (!entry) return resolve(null);
      // Expire after 24 hours
      if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000) return resolve(null);
      resolve(entry);
    });
  });
}

async function setCachedResult(url: string, result: SummaryResult): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['reviewLensCache'], (data) => {
      const cache = (data.reviewLensCache ?? {}) as Record<string, CacheEntry>;
      cache[normalizeUrl(url)] = { result, timestamp: Date.now() };
      chrome.storage.local.set({ reviewLensCache: cache }, resolve);
    });
  });
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
  return new Promise((resolve) => {
    chrome.storage.local.get(['reviewLensCache'], (data) => {
      const cache = (data.reviewLensCache ?? {}) as Record<string, CacheEntry>;
      const entries = Object.entries(cache)
        .map(([key, entry]) => ({ key, entry }))
        .sort((a, b) => b.entry.timestamp - a.entry.timestamp);
      resolve(entries);
    });
  });
}

async function deleteHistoryEntry(key: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['reviewLensCache'], (data) => {
      const cache = (data.reviewLensCache ?? {}) as Record<string, CacheEntry>;
      delete cache[key];
      chrome.storage.local.set({ reviewLensCache: cache }, resolve);
    });
  });
}

async function clearAllHistory(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(['reviewLensCache'], resolve);
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
  neutral: '😐 Neutral',
  mixed: '🤔 Mixed Reviews',
};

const sentimentClass: Record<SummaryResult['overallSentiment'], string> = {
  positive: 'sentiment-positive',
  negative: 'sentiment-negative',
  neutral: 'sentiment-neutral',
  mixed: 'sentiment-mixed',
};

function renderStars(rating: number): string {
  const full = Math.floor(rating);
  const half = rating % 1 >= 0.5;
  const empty = 5 - full - (half ? 1 : 0);
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

function renderResult(data: SummaryResult, timestamp?: number): void {
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

  if (placeName) placeName.textContent = data.placeName;

  if (sentiment) {
    sentiment.textContent = sentimentLabel[data.overallSentiment];
    sentiment.className = `sentiment-badge ${sentimentClass[data.overallSentiment]}`;
  }

  if (starsEl) starsEl.textContent = renderStars(data.averageRating);
  if (ratingEl) ratingEl.textContent = `${data.averageRating} / 5`;
  if (reviewCount) reviewCount.textContent = `${data.totalReviews.toLocaleString()} reviews analyzed`;
  if (summaryEl) summaryEl.textContent = data.summary;

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

// Stop everything and go back to the info screen.
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

// Stop only the data-gathering phase; runAnalyze() will continue to AI
// with whatever reviews have been collected so far.
async function stopGathering(): Promise<void> {
  stopProgressPoll();
  try {
    if (currentTabId) {
      await sendToTab(currentTabId, { type: 'STOP_REVIEWS' } satisfies MessageType);
    }
  } catch { /* tab may have closed */ }
  // runAnalyze() is still awaiting GET_REVIEWS — the content script exits
  // its scroll loop and returns the collected reviews, triggering Step 2.
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
    } catch {
      // tab not ready yet — ignore
    }
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
const stepIntervals: Partial<Record<1 | 2, ReturnType<typeof setInterval>>> = {};

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
  ([1, 2] as const).forEach((s) => {
    if (stepIntervals[s]) stopStepTimer(s);
  });
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
    if (summarizeNowBtn) summarizeNowBtn.hidden = false; // show during gathering
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
    if (summarizeNowBtn) summarizeNowBtn.hidden = true; // hide once gathering is done
    startStepTimer(2);
  }
}

// ─── Info screen ──────────────────────────────────────────────────────────────

let currentTabUrl = '';
let currentTabId = 0;

async function showInfoScreen(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tab.url ?? '';
  currentTabId = tab.id ?? 0;

  if (!currentTabId) {
    showError('Cannot access current tab.');
    return;
  }

  // Fast scrape — no scrolling
  try {
    const response = await sendToTab(currentTabId, { type: 'GET_BASIC_INFO' } satisfies MessageType);
    if (response.type === 'BASIC_INFO') {
      const { placeName, googleRating, googleReviewCount, category, address, phone } = response.payload;

      const nameEl = $('[data-field="info-place-name"]');
      const starsEl = $('[data-field="info-stars"]');
      const ratingEl = $('[data-field="info-rating"]');
      const countEl = $('[data-field="info-review-count"]');
      if (nameEl) nameEl.textContent = placeName;
      if (starsEl) starsEl.textContent = googleRating ? renderStars(googleRating) : '';
      if (ratingEl) ratingEl.textContent = googleRating ? `${googleRating} / 5` : '';
      if (countEl) countEl.textContent = googleReviewCount ? `${googleReviewCount.toLocaleString()} reviews` : '';

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
    // Not on a Maps page — show blank info, user can still try
    const nameEl = $('[data-field="info-place-name"]');
    if (nameEl) nameEl.textContent = 'Open a business on Google Maps';
  }

  // If this place has been analyzed before, show the result immediately
  const cached = await getCachedResult(currentTabUrl);
  if (cached) {
    renderResult(cached.result, cached.timestamp);
    return;
  }

  const viewCacheBtn = document.getElementById('view-cache-btn') as HTMLButtonElement | null;
  if (viewCacheBtn) viewCacheBtn.hidden = true;

  setScreen('info');
}

// ─── Analyze ──────────────────────────────────────────────────────────────────

async function runAnalyze(): Promise<void> {
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

  let reviewsResponse: MessageType;
  try {
    const maxReviews = settings.reviewMode === 'recent' ? settings.reviewCount : 10000;
    reviewsResponse = await sendToTab(currentTabId, {
      type: 'GET_REVIEWS',
      maxReviews,
      scrollConfig: {
        tabOpenWaitMs:    SCROLL_CONFIG.TAB_OPEN_WAIT_MS,
        pollIntervalMs:   SCROLL_CONFIG.POLL_INTERVAL_MS,
        scrollWaitMs:     SCROLL_CONFIG.SCROLL_WAIT_MS,
        moreReviewsWaitMs: SCROLL_CONFIG.MORE_REVIEWS_WAIT_MS,
        maxStableRounds:  SCROLL_CONFIG.MAX_STABLE_ROUNDS,
      },
    } satisfies MessageType);
  } catch (err) {
    stopProgressPoll();
    console.error('[Review Lens] Message error:', err);
    showError(`Extension error: ${err}. Make sure you're on Google Maps (google.com/maps) and the page has fully loaded.`);
    return;
  }

  stopProgressPoll();

  if (analysisCancelled) return;
  if (reviewsResponse.type === 'NO_REVIEWS') { setScreen('no-reviews'); return; }
  if (reviewsResponse.type === 'ERROR') { showError(reviewsResponse.payload); return; }

  if (reviewsResponse.type === 'REVIEWS_DATA') {
    const { reviews, placeName, googleRating, googleReviewCount } = reviewsResponse.payload;
    console.log(`[Review Lens] Got ${reviews.length} reviews, Google rating: ${googleRating ?? 'n/a'}`);
    setLoadingStep(2, `${reviews.length.toLocaleString()} reviews collected`);

    let summaryResponse: MessageType;
    try {
      summaryResponse = await sendRuntimeMessage({
        type: 'SUMMARIZE',
        payload: { reviews, placeName, settings, googleRating, googleReviewCount },
      } satisfies MessageType);
    } catch (err) {
      console.error('[Review Lens] Background error:', err);
      showError(`Failed to summarize: ${err}`);
      return;
    }

    if (analysisCancelled) return;
    if (summaryResponse.type === 'SUMMARY_RESULT') {
      const timestamp = Date.now();
      await setCachedResult(currentTabUrl, summaryResponse.payload);
      renderResult(summaryResponse.payload, timestamp);
    } else if (summaryResponse.type === 'ERROR') {
      showError((summaryResponse as { type: 'ERROR'; payload: string }).payload);
    }
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

  // Info screen actions
  $('[data-action="analyze"]')?.addEventListener('click', () => runAnalyze());

  // Result screen actions
  $('[data-action="re-analyze"]')?.addEventListener('click', () => runAnalyze());
  $('[data-action="open-settings"]')?.addEventListener('click', () => setScreen('settings'));

  // Settings actions
  $('[data-action="save-settings"]')?.addEventListener('click', async () => {
    const newSettings = readSettingsFromUI();
    await saveSettings(newSettings);
    await runAnalyze();
  });

  $('[data-action="cancel-settings"]')?.addEventListener('click', () => showInfoScreen());

  // Loading screen controls
  document.getElementById('summarize-now-btn')?.addEventListener('click', () => stopGathering());
  document.getElementById('cancel-btn')?.addEventListener('click', () => cancelAnalysis());

  // Error / no-reviews actions — multiple buttons share data-action="retry"
  document.querySelectorAll<HTMLElement>('[data-action="retry"]').forEach((btn) => {
    btn.addEventListener('click', () => runAnalyze());
  });
  $('[data-action="back"]')?.addEventListener('click', () => showInfoScreen());

  // Start by showing info
  await showInfoScreen();
});
