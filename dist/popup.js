// ─── DOM helpers ──────────────────────────────────────────────────────────────
function $(selector) {
    return document.querySelector(selector);
}
function setScreen(name) {
    document.querySelectorAll('.screen').forEach((el) => {
        el.hidden = el.dataset.screen !== name;
    });
}
const DEFAULT_SETTINGS = {
    reviewMode: 'all',
    reviewCount: 1000,
};
async function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['reviewLensSettings'], (result) => {
            resolve(result.reviewLensSettings ?? DEFAULT_SETTINGS);
        });
    });
}
async function saveSettings(settings) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ reviewLensSettings: settings }, resolve);
    });
}
function updateCountFieldVisibility(mode) {
    const wrapper = document.getElementById('count-field-wrapper');
    if (wrapper)
        wrapper.hidden = mode === 'all';
}
function applySettingsToUI(settings) {
    document.querySelectorAll('.scope-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.value === settings.reviewMode);
    });
    const countInput = document.querySelector('#review-count-input');
    if (countInput)
        countInput.value = String(settings.reviewCount);
    updateCountFieldVisibility(settings.reviewMode);
}
function readSettingsFromUI() {
    const activeBtn = document.querySelector('.scope-btn.active');
    const countInput = document.querySelector('#review-count-input');
    return {
        reviewMode: activeBtn?.dataset.value ?? DEFAULT_SETTINGS.reviewMode,
        reviewCount: Math.max(10, Number(countInput?.value ?? DEFAULT_SETTINGS.reviewCount)),
    };
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
        chrome.storage.local.get(['reviewLensCache'], (data) => {
            const cache = (data.reviewLensCache ?? {});
            const entry = cache[normalizeUrl(url)];
            if (!entry)
                return resolve(null);
            // Expire after 24 hours
            if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000)
                return resolve(null);
            resolve(entry);
        });
    });
}
async function setCachedResult(url, result) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['reviewLensCache'], (data) => {
            const cache = (data.reviewLensCache ?? {});
            cache[normalizeUrl(url)] = { result, timestamp: Date.now() };
            chrome.storage.local.set({ reviewLensCache: cache }, resolve);
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
        chrome.storage.local.get(['reviewLensCache'], (data) => {
            const cache = (data.reviewLensCache ?? {});
            const entries = Object.entries(cache)
                .map(([key, entry]) => ({ key, entry }))
                .sort((a, b) => b.entry.timestamp - a.entry.timestamp);
            resolve(entries);
        });
    });
}
async function deleteHistoryEntry(key) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['reviewLensCache'], (data) => {
            const cache = (data.reviewLensCache ?? {});
            delete cache[key];
            chrome.storage.local.set({ reviewLensCache: cache }, resolve);
        });
    });
}
async function clearAllHistory() {
    return new Promise((resolve) => {
        chrome.storage.local.remove(['reviewLensCache'], resolve);
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
    if (analyzedAt) {
        analyzedAt.textContent = timestamp ? `Analyzed ${timeAgo(timestamp)}` : '';
    }
    stopAllStepTimers();
    setScreen('result');
}
// ─── Cancellation ────────────────────────────────────────────────────────────
let analysisCancelled = false;
async function stopAnalysis() {
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
        catch {
            // tab not ready yet — ignore
        }
    }, 800);
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
    [1, 2].forEach((s) => {
        if (stepIntervals[s])
            stopStepTimer(s);
    });
}
function setLoadingStep(step, detail) {
    const s1 = document.getElementById('step-1');
    const s2 = document.getElementById('step-2');
    const d1 = document.getElementById('step-1-detail');
    const d2 = document.getElementById('step-2-detail');
    if (step === 1) {
        s1?.classList.replace('step-pending', 'step-active') || s1?.classList.add('step-active');
        s2?.classList.add('step-pending');
        if (d1)
            d1.textContent = detail ?? 'Scrolling through reviews…';
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
    // Fast scrape — no scrolling
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
        // Not on a Maps page — show blank info, user can still try
        const nameEl = $('[data-field="info-place-name"]');
        if (nameEl)
            nameEl.textContent = 'Open a business on Google Maps';
    }
    // If this place has been analyzed before, show the result immediately
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
        reviewsResponse = await sendToTab(currentTabId, { type: 'GET_REVIEWS', maxReviews });
    }
    catch (err) {
        stopProgressPoll();
        console.error('[Review Lens] Message error:', err);
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
        console.log(`[Review Lens] Got ${reviews.length} reviews, Google rating: ${googleRating ?? 'n/a'}`);
        setLoadingStep(2, `${reviews.length.toLocaleString()} reviews collected`);
        let summaryResponse;
        try {
            summaryResponse = await sendRuntimeMessage({
                type: 'SUMMARIZE',
                payload: { reviews, placeName, settings, googleRating, googleReviewCount },
            });
        }
        catch (err) {
            console.error('[Review Lens] Background error:', err);
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
    // Scope button selection
    document.querySelectorAll('.scope-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.scope-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            updateCountFieldVisibility(btn.dataset.value);
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
    // Stop button
    document.getElementById('stop-btn')?.addEventListener('click', () => stopAnalysis());
    // Error / no-reviews actions
    $('[data-action="retry"]')?.addEventListener('click', () => runAnalyze());
    $('[data-action="back"]')?.addEventListener('click', () => showInfoScreen());
    // Start by showing info
    await showInfoScreen();
});
