import type { MessageType, Review, ReviewSettings, SummaryResult } from './types.js';

const OLLAMA_BASE = 'http://127.0.0.1:11434';

// ─── Date filtering ───────────────────────────────────────────────────────────

function parseReviewDate(dateStr?: string): Date | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim().toLowerCase();
  const agoMatch = trimmed.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/);
  if (agoMatch) {
    const amount = Number(agoMatch[1]);
    const unit = agoMatch[2];
    const d = new Date();
    switch (unit) {
      case 'minute': d.setMinutes(d.getMinutes() - amount); break;
      case 'hour':   d.setHours(d.getHours() - amount); break;
      case 'day':    d.setDate(d.getDate() - amount); break;
      case 'week':   d.setDate(d.getDate() - amount * 7); break;
      case 'month':  d.setMonth(d.getMonth() - amount); break;
      case 'year':   d.setFullYear(d.getFullYear() - amount); break;
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

function getCutoffDate(mode: ReviewSettings['reviewMode']): Date | null {
  const now = new Date();
  if (mode === 'recent' || mode === 'all') return null;
  const cutoff = new Date(now);
  switch (mode) {
    case '1m': cutoff.setMonth(cutoff.getMonth() - 1); break;
    case '3m': cutoff.setMonth(cutoff.getMonth() - 3); break;
    case '6m': cutoff.setMonth(cutoff.getMonth() - 6); break;
    case '1y': cutoff.setFullYear(cutoff.getFullYear() - 1); break;
  }
  return cutoff;
}

function filterReviews(reviews: Review[], settings: ReviewSettings): Review[] {
  if (settings.reviewMode === 'all') return reviews;
  if (settings.reviewMode === 'recent') return reviews.slice(0, settings.reviewCount);
  const cutoff = getCutoffDate(settings.reviewMode);
  if (!cutoff) return reviews.slice(0, settings.reviewCount);
  return reviews
    .filter((r) => { const d = parseReviewDate(r.date); return d ? d >= cutoff : false; })
    .slice(0, settings.reviewCount);
}

// ─── Shared prompt + result builder ──────────────────────────────────────────

function buildPrompt(reviews: Review[], placeName: string, totalCollected: number): string {
  const reviewsText = reviews
    .map((r, i) => `[Review ${i + 1}] ⭐${r.rating}/5 — ${r.text}`)
    .join('\n\n');

  return `You are analyzing customer reviews for "${placeName}".

Here are ${reviews.length} reviews (out of ${totalCollected} total):

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
}

function parseAIResponse(raw: string): ReturnType<typeof JSON.parse> {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  return JSON.parse(cleaned);
}

function buildResult(
  parsed: ReturnType<typeof JSON.parse>,
  placeName: string,
  avgRating: number,
  totalReviews: number
): SummaryResult {
  return {
    placeName,
    overallSentiment: parsed.overallSentiment ?? 'mixed',
    averageRating: Math.round(avgRating * 10) / 10,
    totalReviews,
    pros: parsed.pros ?? [],
    cons: parsed.cons ?? [],
    summary: parsed.summary ?? '',
    topThemes: parsed.topThemes ?? [],
  };
}

// ─── Ollama ───────────────────────────────────────────────────────────────────

async function checkOllama(): Promise<void> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch {
    throw new Error(
      'Cannot reach Ollama at localhost:11434. Make sure Ollama is running (`ollama serve`) and try again.'
    );
  }
}

async function summarizeWithOllama(
  reviews: Review[],
  placeName: string,
  settings: ReviewSettings,
  googleRating?: number,
  googleReviewCount?: number
): Promise<SummaryResult> {
  const selected = filterReviews(reviews, settings);
  const computed = selected.reduce((s, r) => s + (r.rating || 0), 0) /
    (selected.filter((r) => r.rating > 0).length || 1);
  const avgRating = googleRating ?? computed;

  await checkOllama();

  const model = settings.ollamaModel ?? 'gpt-oss:latest';
  console.log(`[Review Lens] Ollama model: ${model}, reviews: ${selected.length}`);

  const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: buildPrompt(selected, placeName, reviews.length), stream: false }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return buildResult(
    parseAIResponse(data.response ?? ''),
    placeName,
    avgRating,
    googleReviewCount ?? reviews.length
  );
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

async function summarizeWithOpenAI(
  reviews: Review[],
  placeName: string,
  settings: ReviewSettings,
  googleRating?: number,
  googleReviewCount?: number
): Promise<SummaryResult> {
  if (!settings.openaiApiKey) {
    throw new Error('OpenAI API key is not set. Go to ⚙ Settings and add your key.');
  }

  const selected = filterReviews(reviews, settings);
  const computed = selected.reduce((s, r) => s + (r.rating || 0), 0) /
    (selected.filter((r) => r.rating > 0).length || 1);
  const avgRating = googleRating ?? computed;

  const model = settings.openaiModel ?? 'gpt-4o-mini';
  console.log(`[Review Lens] OpenAI model: ${model}, reviews: ${selected.length}`);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.openaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildPrompt(selected, placeName, reviews.length) }],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const raw: string = data.choices?.[0]?.message?.content ?? '';
  return buildResult(
    parseAIResponse(raw),
    placeName,
    avgRating,
    googleReviewCount ?? reviews.length
  );
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: MessageType, _sender, sendResponse) => {
  if (message.type === 'SUMMARIZE') {
    const { reviews, placeName, settings, googleRating, googleReviewCount } = message.payload;
    console.log(`[Review Lens] SUMMARIZE via ${settings.aiProvider ?? 'ollama'} for "${placeName}"`);

    const summarize = settings.aiProvider === 'openai' ? summarizeWithOpenAI : summarizeWithOllama;

    summarize(reviews, placeName, settings, googleRating, googleReviewCount)
      .then((result) => sendResponse({ type: 'SUMMARY_RESULT', payload: result } satisfies MessageType))
      .catch((err: unknown) => sendResponse({
        type: 'ERROR',
        payload: err instanceof Error ? err.message : String(err),
      } satisfies MessageType));

    return true;
  }
});
