import type { MessageType, SummaryResult } from './types.js';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function $(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

function setScreen(name: 'info' | 'settings' | 'loading' | 'result' | 'error' | 'no-reviews'): void {
  document.querySelectorAll<HTMLElement>('.screen').forEach((el) => {
    el.hidden = el.dataset.screen !== name;
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

interface ReviewSettings {
  reviewMode: 'recent' | 'all' | '1m' | '3m' | '6m' | '1y';
  reviewCount: number;
}

const DEFAULT_SETTINGS: ReviewSettings = {
  reviewMode: 'all',
  reviewCount: 1000,
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

function applySettingsToUI(settings: ReviewSettings): void {
  document.querySelectorAll<HTMLElement>('.scope-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === settings.reviewMode);
  });
  const countInput = document.querySelector<HTMLInputElement>('#review-count-input');
  if (countInput) countInput.value = String(settings.reviewCount);
}

function readSettingsFromUI(): ReviewSettings {
  const activeBtn = document.querySelector<HTMLElement>('.scope-btn.active');
  const countInput = document.querySelector<HTMLInputElement>('#review-count-input');
  return {
    reviewMode: (activeBtn?.dataset.value as ReviewSettings['reviewMode']) ?? DEFAULT_SETTINGS.reviewMode,
    reviewCount: Math.max(10, Number(countInput?.value ?? DEFAULT_SETTINGS.reviewCount)),
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

  if (analyzedAt) {
    analyzedAt.textContent = timestamp ? `Analyzed ${timeAgo(timestamp)}` : '';
  }

  setScreen('result');
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
      const { placeName, googleRating, googleReviewCount } = response.payload;
      const nameEl = $('[data-field="info-place-name"]');
      const starsEl = $('[data-field="info-stars"]');
      const ratingEl = $('[data-field="info-rating"]');
      const countEl = $('[data-field="info-review-count"]');
      if (nameEl) nameEl.textContent = placeName;
      if (starsEl) starsEl.textContent = googleRating ? renderStars(googleRating) : '';
      if (ratingEl) ratingEl.textContent = googleRating ? `${googleRating} / 5` : '';
      if (countEl) countEl.textContent = googleReviewCount ? `${googleReviewCount.toLocaleString()} reviews` : '';
    }
  } catch {
    // Not on a Maps page — show blank info, user can still try
    const nameEl = $('[data-field="info-place-name"]');
    if (nameEl) nameEl.textContent = 'Open a business on Google Maps';
  }

  // Check cache
  const cached = await getCachedResult(currentTabUrl);
  const viewCacheBtn = document.getElementById('view-cache-btn') as HTMLButtonElement | null;
  const cacheNote = document.getElementById('cache-note');
  if (cached) {
    if (viewCacheBtn) viewCacheBtn.hidden = false;
    if (cacheNote) cacheNote.textContent = `Last analyzed ${timeAgo(cached.timestamp)}`;
  } else {
    if (viewCacheBtn) viewCacheBtn.hidden = true;
    if (cacheNote) cacheNote.textContent = '';
  }

  setScreen('info');
}

// ─── Analyze ──────────────────────────────────────────────────────────────────

async function runAnalyze(): Promise<void> {
  setScreen('loading');

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

  let reviewsResponse: MessageType;
  try {
    reviewsResponse = await sendToTab(currentTabId, { type: 'GET_REVIEWS', maxReviews: settings.reviewCount } satisfies MessageType);
  } catch (err) {
    console.error('[Review Lens] Message error:', err);
    showError(`Extension error: ${err}. Make sure you're on Google Maps (google.com/maps) and the page has fully loaded.`);
    return;
  }

  if (reviewsResponse.type === 'NO_REVIEWS') { setScreen('no-reviews'); return; }
  if (reviewsResponse.type === 'ERROR') { showError(reviewsResponse.payload); return; }

  if (reviewsResponse.type === 'REVIEWS_DATA') {
    const { reviews, placeName, googleRating, googleReviewCount } = reviewsResponse.payload;
    console.log(`[Review Lens] Got ${reviews.length} reviews, Google rating: ${googleRating ?? 'n/a'}`);

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

  // Scope button selection
  document.querySelectorAll<HTMLElement>('.scope-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.scope-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Info screen actions
  $('[data-action="analyze"]')?.addEventListener('click', () => runAnalyze());

  $('[data-action="view-cache"]')?.addEventListener('click', async () => {
    const cached = await getCachedResult(currentTabUrl);
    if (cached) renderResult(cached.result, cached.timestamp);
  });

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

  // Error / no-reviews actions
  $('[data-action="retry"]')?.addEventListener('click', () => runAnalyze());
  $('[data-action="back"]')?.addEventListener('click', () => showInfoScreen());

  // Start by showing info
  await showInfoScreen();
});
