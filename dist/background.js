const OLLAMA_BASE = 'http://127.0.0.1:11434';
async function checkOllama() {
    try {
        const res = await fetch(`${OLLAMA_BASE}/api/tags`);
        if (!res.ok)
            throw new Error(`status ${res.status}`);
    }
    catch {
        throw new Error('Cannot reach Ollama at localhost:11434. Make sure Ollama is running (`ollama serve`) and try again.');
    }
}
function parseReviewDate(dateStr) {
    if (!dateStr)
        return null;
    const trimmed = dateStr.trim().toLowerCase();
    const agoMatch = trimmed.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/);
    if (agoMatch) {
        const amount = Number(agoMatch[1]);
        const unit = agoMatch[2];
        const d = new Date();
        switch (unit) {
            case 'minute':
                d.setMinutes(d.getMinutes() - amount);
                break;
            case 'hour':
                d.setHours(d.getHours() - amount);
                break;
            case 'day':
                d.setDate(d.getDate() - amount);
                break;
            case 'week':
                d.setDate(d.getDate() - amount * 7);
                break;
            case 'month':
                d.setMonth(d.getMonth() - amount);
                break;
            case 'year':
                d.setFullYear(d.getFullYear() - amount);
                break;
        }
        return d;
    }
    if (trimmed === 'yesterday') {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return d;
    }
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : parsed;
}
function getCutoffDate(mode) {
    const now = new Date();
    if (mode === 'recent' || mode === 'all')
        return null;
    const cutoff = new Date(now);
    switch (mode) {
        case '1m':
            cutoff.setMonth(cutoff.getMonth() - 1);
            break;
        case '3m':
            cutoff.setMonth(cutoff.getMonth() - 3);
            break;
        case '6m':
            cutoff.setMonth(cutoff.getMonth() - 6);
            break;
        case '1y':
            cutoff.setFullYear(cutoff.getFullYear() - 1);
            break;
    }
    return cutoff;
}
function filterReviews(reviews, settings) {
    if (settings.reviewMode === 'all') {
        return reviews;
    }
    if (settings.reviewMode === 'recent') {
        return reviews.slice(0, settings.reviewCount);
    }
    const cutoff = getCutoffDate(settings.reviewMode);
    if (!cutoff)
        return reviews.slice(0, settings.reviewCount);
    const filtered = reviews.filter((review) => {
        const reviewDate = parseReviewDate(review.date);
        return reviewDate ? reviewDate >= cutoff : false;
    });
    return filtered.slice(0, settings.reviewCount);
}
async function summarizeWithOllama(reviews, placeName, settings, googleRating, googleReviewCount) {
    const selectedReviews = filterReviews(reviews, settings);
    // Prefer Google's displayed rating; fall back to computing from scraped reviews
    const computedRating = selectedReviews.reduce((sum, r) => sum + (r.rating || 0), 0) /
        (selectedReviews.filter((r) => r.rating > 0).length || 1);
    const avgRating = googleRating ?? computedRating;
    const reviewsText = selectedReviews
        .map((r, i) => `[Review ${i + 1}] ⭐${r.rating}/5 — ${r.text}`)
        .join('\n\n');
    await checkOllama();
    console.log(`[Review Lens Background] Starting summarization for "${placeName}"`);
    console.log(`[Review Lens Background] Selected ${selectedReviews.length} reviews (${settings.reviewMode})`);
    const prompt = `You are analyzing customer reviews for "${placeName}".

Here are ${selectedReviews.length} reviews (out of ${reviews.length} total):

${reviewsText}

Respond ONLY with a valid JSON object (no markdown, no preamble) in this exact shape:
{
  "summary": "2–3 sentence overall summary",
  "pros": ["specific positive point 1", "specific positive point 2", "...up to 6"],
  "cons": ["specific negative point 1", "specific negative point 2", "...up to 6"],
  "topThemes": ["theme1", "theme2", "theme3"],
  "overallSentiment": "positive" | "neutral" | "negative" | "mixed"
}

Rules:
- pros and cons must be specific, actionable insights drawn from actual review content
- topThemes are 1–3 word topics that appear most often (e.g. "parking", "wait times", "staff")
- overallSentiment reflects the general tone across all reviews
- Be concise but informative`;
    const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-oss:latest', prompt, stream: false }),
    });
    console.log(`[Review Lens Background] Ollama response status: ${response.status}`);
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[Review Lens Background] Ollama error response:`, errorBody);
        throw new Error(`Ollama API error ${response.status}: ${errorBody}`);
    }
    const data = await response.json();
    console.log(`[Review Lens Background] Ollama response received`, data);
    const rawText = data.response ?? '';
    // Strip markdown fences if present
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
        placeName,
        overallSentiment: parsed.overallSentiment ?? 'mixed',
        averageRating: Math.round(avgRating * 10) / 10,
        totalReviews: googleReviewCount ?? reviews.length,
        pros: parsed.pros ?? [],
        cons: parsed.cons ?? [],
        summary: parsed.summary ?? '',
        topThemes: parsed.topThemes ?? [],
    };
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SUMMARIZE') {
        const { reviews, placeName } = message.payload;
        console.log(`[Review Lens Background] Received SUMMARIZE request for "${placeName}" with ${reviews.length} reviews`);
        summarizeWithOllama(reviews, placeName, message.payload.settings, message.payload.googleRating, message.payload.googleReviewCount)
            .then((result) => {
            console.log(`[Review Lens Background] Summarization successful`);
            sendResponse({
                type: 'SUMMARY_RESULT',
                payload: result,
            });
        })
            .catch((err) => {
            console.error(`[Review Lens Background] Summarization error:`, err);
            sendResponse({
                type: 'ERROR',
                payload: err instanceof Error ? err.message : String(err),
            });
        });
        return true; // keep channel open for async response
    }
});
