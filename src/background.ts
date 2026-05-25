import type { MessageType, Review, ReviewSettings, SummaryResult } from './types.js';
import { AI_DEFAULTS } from './config.js';

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
  "overallSentiment": "positive" | "neutral" | "negative" | "mixed",
  "notableStaff": ["FirstName", "..."]
}

Rules:
- pros and cons must be specific, actionable insights drawn from actual review content
- topThemes are 1–3 word topics that appear most often (e.g. "parking", "wait times", "staff")
- overallSentiment reflects the general tone across all reviews
- notableStaff: list only the first names (or full names) of EMPLOYEES or STAFF of "${placeName}" who are praised or mentioned by name in at least 2 different reviews; DO NOT include the names of customers or reviewers (i.e. the people who wrote the reviews), DO NOT include business names, brand names, platforms, or services; if no staff members can be clearly identified return []
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
    notableStaff: parsed.notableStaff ?? [],
  };
}

/** Shared helper: compute avgRating from a filtered review set (or use Google's value). */
function computeAvg(selected: Review[], googleRating?: number): number {
  const rated = selected.filter((r) => r.rating > 0);
  return googleRating ?? (rated.reduce((s, r) => s + r.rating, 0) / (rated.length || 1));
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
  const avgRating = computeAvg(selected, googleRating);

  await checkOllama();

  const model = settings.ollamaModel ?? AI_DEFAULTS.OLLAMA_MODEL;
  const p = settings.ollamaParams ?? {};

  // Build Ollama options only for params that were explicitly set
  const options: Record<string, number> = {};
  if (p.temperature   !== undefined) options.temperature    = p.temperature;
  if (p.topK          !== undefined) options.top_k          = p.topK;
  if (p.topP          !== undefined) options.top_p          = p.topP;
  if (p.numCtx        !== undefined) options.num_ctx        = p.numCtx;
  if (p.repeatPenalty !== undefined) options.repeat_penalty = p.repeatPenalty;

  console.log(`[GReviewSumm] Ollama model: ${model}, reviews: ${selected.length}`, options);

  const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: buildPrompt(selected, placeName, reviews.length),
      stream: false,
      ...(Object.keys(options).length > 0 && { options }),
    }),
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
  const avgRating = computeAvg(selected, googleRating);
  const model = settings.openaiModel ?? AI_DEFAULTS.OPENAI_MODEL;
  console.log(`[GReviewSumm] OpenAI model: ${model}, reviews: ${selected.length}`);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.openaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildPrompt(selected, placeName, reviews.length) }],
      temperature: AI_DEFAULTS.OPENAI_TEMPERATURE,
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

// ─── Anthropic Claude ─────────────────────────────────────────────────────────

async function summarizeWithAnthropic(
  reviews: Review[],
  placeName: string,
  settings: ReviewSettings,
  googleRating?: number,
  googleReviewCount?: number
): Promise<SummaryResult> {
  if (!settings.anthropicApiKey) {
    throw new Error('Anthropic API key is not set. Go to ⚙ Settings and add your key.');
  }

  const selected = filterReviews(reviews, settings);
  const avgRating = computeAvg(selected, googleRating);
  const model = settings.anthropicModel ?? AI_DEFAULTS.ANTHROPIC_MODEL;
  console.log(`[GReviewSumm] Anthropic model: ${model}, reviews: ${selected.length}`);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: buildPrompt(selected, placeName, reviews.length) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const raw: string = data.content?.[0]?.text ?? '';
  return buildResult(
    parseAIResponse(raw),
    placeName,
    avgRating,
    googleReviewCount ?? reviews.length
  );
}

// ─── Google Gemini ────────────────────────────────────────────────────────────

async function summarizeWithGemini(
  reviews: Review[],
  placeName: string,
  settings: ReviewSettings,
  googleRating?: number,
  googleReviewCount?: number
): Promise<SummaryResult> {
  if (!settings.geminiApiKey) {
    throw new Error('Google Gemini API key is not set. Go to ⚙ Settings and add your key.');
  }

  const selected = filterReviews(reviews, settings);
  const avgRating = computeAvg(selected, googleRating);
  const model = settings.geminiModel ?? AI_DEFAULTS.GEMINI_MODEL;
  console.log(`[GReviewSumm] Gemini model: ${model}, reviews: ${selected.length}`);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiApiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(selected, placeName, reviews.length) }] }],
      generationConfig: { temperature: 0.3 },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return buildResult(
    parseAIResponse(raw),
    placeName,
    avgRating,
    googleReviewCount ?? reviews.length
  );
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

async function summarizeWithGroq(
  reviews: Review[],
  placeName: string,
  settings: ReviewSettings,
  googleRating?: number,
  googleReviewCount?: number
): Promise<SummaryResult> {
  if (!settings.groqApiKey) {
    throw new Error('Groq API key is not set. Go to ⚙ Settings and add your key.');
  }

  const selected = filterReviews(reviews, settings);
  const avgRating = computeAvg(selected, googleRating);
  const model = settings.groqModel ?? AI_DEFAULTS.GROQ_MODEL;
  console.log(`[GReviewSumm] Groq model: ${model}, reviews: ${selected.length}`);

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.groqApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildPrompt(selected, placeName, reviews.length) }],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq API error ${response.status}: ${body}`);
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

// ─── xAI (Grok) ──────────────────────────────────────────────────────────────

async function summarizeWithXAI(
  reviews: Review[],
  placeName: string,
  settings: ReviewSettings,
  googleRating?: number,
  googleReviewCount?: number
): Promise<SummaryResult> {
  if (!settings.xaiApiKey) {
    throw new Error('xAI API key is not set. Go to ⚙ Settings and add your key.');
  }

  const selected = filterReviews(reviews, settings);
  const avgRating = computeAvg(selected, googleRating);
  const model = settings.xaiModel ?? AI_DEFAULTS.XAI_MODEL;
  console.log(`[GReviewSumm] xAI/Grok model: ${model}, reviews: ${selected.length}`);

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.xaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildPrompt(selected, placeName, reviews.length) }],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`xAI API error ${response.status}: ${body}`);
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

// ─── Custom OpenAI-compatible endpoint ────────────────────────────────────────

async function summarizeWithCustom(
  reviews: Review[],
  placeName: string,
  settings: ReviewSettings,
  googleRating?: number,
  googleReviewCount?: number
): Promise<SummaryResult> {
  if (!settings.customEndpoint) {
    throw new Error('Custom endpoint URL is not set. Go to ⚙ Settings and add your endpoint URL.');
  }

  const selected = filterReviews(reviews, settings);
  const avgRating = computeAvg(selected, googleRating);
  const model = settings.customModel || 'local-model';
  const baseUrl = settings.customEndpoint.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  console.log(`[GReviewSumm] Custom endpoint: ${url}, model: ${model}, reviews: ${selected.length}`);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.customApiKey) headers['Authorization'] = `Bearer ${settings.customApiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildPrompt(selected, placeName, reviews.length) }],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Custom API error ${response.status}: ${body}`);
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

// ─── Retry helper ─────────────────────────────────────────────────────────────

// Re-runs fn() if it throws a SyntaxError (invalid JSON from the model).
// Any other error (network failure, HTTP error, etc.) propagates immediately.
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = AI_DEFAULTS.MAX_RETRIES): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof SyntaxError) || attempt >= maxAttempts) throw err;
      console.warn(`[GReviewSumm] Invalid JSON on attempt ${attempt}/${maxAttempts}, retrying…`);
    }
  }
}

// ─── Provider routing ─────────────────────────────────────────────────────────

type SummarizeFn = typeof summarizeWithOllama;

const PROVIDER_FN: Record<string, SummarizeFn> = {
  ollama:    summarizeWithOllama,
  openai:    summarizeWithOpenAI,
  anthropic: summarizeWithAnthropic,
  gemini:    summarizeWithGemini,
  groq:      summarizeWithGroq,
  xai:       summarizeWithXAI,
  custom:    summarizeWithCustom,
};

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: MessageType, _sender, sendResponse) => {
  if (message.type === 'SUMMARIZE') {
    const { reviews, placeName, settings, googleRating, googleReviewCount } = message.payload;
    const provider = settings.aiProvider ?? 'ollama';
    console.log(`[GReviewSumm] SUMMARIZE via ${provider} for "${placeName}"`);

    const summarize = PROVIDER_FN[provider] ?? summarizeWithOllama;

    withRetry(() => summarize(reviews, placeName, settings, googleRating, googleReviewCount))
      .then((result) => sendResponse({ type: 'SUMMARY_RESULT', payload: result } satisfies MessageType))
      .catch((err: unknown) => sendResponse({
        type: 'ERROR',
        payload: err instanceof Error ? err.message : String(err),
      } satisfies MessageType));

    return true;
  }
});
