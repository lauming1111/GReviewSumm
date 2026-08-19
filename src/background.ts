import type { MessageType, Review, ReviewSettings, SummaryResult } from './types.js';
import { AI_DEFAULTS } from './config.js';

const OLLAMA_BASE = 'http://127.0.0.1:11434';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  if (settings.reviewMode === 'all') return reviews.slice(0, settings.reviewCount);
  if (settings.reviewMode === 'recent') return reviews.slice(0, settings.reviewCount);

  const cutoff = getCutoffDate(settings.reviewMode);
  if (!cutoff) return reviews.slice(0, settings.reviewCount);

  // Reviews whose date string cannot be parsed are KEPT, not dropped. Dropping
  // them meant a single Google layout or locale change silently emptied every
  // time-window result set.
  let unparseable = 0;
  const kept = reviews.filter((r) => {
    const d = parseReviewDate(r.date);
    if (!d) { unparseable++; return true; }
    return d >= cutoff;
  });
  if (unparseable > 0) {
    console.warn(`[GReviewSumm] ${unparseable} review(s) had an unparseable date — kept rather than dropped.`);
  }
  return kept.slice(0, settings.reviewCount);
}

// ─── Prompt sampling ──────────────────────────────────────────────────────────

function truncateReview(r: Review): Review {
  if (r.text.length <= AI_DEFAULTS.MAX_REVIEW_CHARS) return r;
  return { ...r, text: `${r.text.slice(0, AI_DEFAULTS.MAX_REVIEW_CHARS)}…` };
}

function isComplaint(r: Review): boolean {
  return r.rating > 0 && r.rating <= 2;
}

/**
 * Pick at most MAX_REVIEWS_TO_AI reviews to serialize into the prompt.
 *
 * Sending everything produced a ~68k-token prompt for a 1000-review place —
 * far beyond any local model's context, so the model silently read a fraction
 * of it while the user paid full prompt-processing latency.
 *
 * Strategy: keep every 1–2★ review (complaints are the scarcest, highest-signal
 * input and are what "cons" is built from), then stride-sample the remainder so
 * the selection spans the full time range rather than only the newest reviews.
 */
function selectReviewsForPrompt(reviews: Review[]): Review[] {
  const cap = AI_DEFAULTS.MAX_REVIEWS_TO_AI;
  if (reviews.length <= cap) return enforceCharBudget(reviews.map(truncateReview));

  const complaints = reviews.filter(isComplaint);
  const rest = reviews.filter((r) => !isComplaint(r));

  const kept: Review[] = complaints.slice(0, cap);
  const chosen = new Set<Review>(kept);

  if (kept.length < cap && rest.length > 0) {
    const budget = cap - kept.length;
    const stride = Math.max(1, Math.floor(rest.length / budget));
    for (let i = 0; i < rest.length && kept.length < cap; i += stride) {
      kept.push(rest[i]);
      chosen.add(rest[i]);
    }
    // Stride rounding can leave room — top up with anything not yet chosen.
    for (let i = 0; i < rest.length && kept.length < cap; i++) {
      if (!chosen.has(rest[i])) { kept.push(rest[i]); chosen.add(rest[i]); }
    }
  }

  return enforceCharBudget(kept.map(truncateReview));
}

/**
 * Trim the selection so the serialized review text fits MAX_PROMPT_CHARS.
 * The count cap alone is not enough: 250 reviews at MAX_REVIEW_CHARS each
 * would still overflow the context window. Complaints sort first in `kept`,
 * so they survive trimming.
 */
function enforceCharBudget(reviews: Review[]): Review[] {
  const PER_REVIEW_OVERHEAD = 24; // "[Review 999] ⭐4/5 — " plus the "\n\n" join
  let used = 0;
  const out: Review[] = [];
  for (const r of reviews) {
    const cost = r.text.length + PER_REVIEW_OVERHEAD;
    if (used + cost > AI_DEFAULTS.MAX_PROMPT_CHARS) break;
    out.push(r);
    used += cost;
  }
  return out;
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

/** Parses the MODEL's JSON output. A SyntaxError here is retryable. */
function parseAIResponse(raw: string): ReturnType<typeof JSON.parse> {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Parses an HTTP response body. A non-JSON body here means the provider is
 * misbehaving, not the model — so this throws a plain Error rather than a
 * SyntaxError, keeping it out of the retry path.
 */
async function readJsonBody(response: Response, provider: string): Promise<ReturnType<typeof JSON.parse>> {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${provider} returned a non-JSON response: ${body.slice(0, 200)}`);
  }
}

function buildResult(
  parsed: ReturnType<typeof JSON.parse>,
  placeName: string,
  avgRating: number,
  totalReviews: number,
  analyzedCount: number,
  collectedCount: number
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
    analyzedCount,
    collectedCount,
  };
}

/** Shared helper: compute avgRating from a filtered review set (or use Google's value). */
function computeAvg(selected: Review[], googleRating?: number): number {
  const rated = selected.filter((r) => r.rating > 0);
  return googleRating ?? (rated.reduce((s, r) => s + r.rating, 0) / (rated.length || 1));
}

// ─── fetch with timeout ───────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_DEFAULTS.REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        `Request timed out after ${Math.round(AI_DEFAULTS.REQUEST_TIMEOUT_MS / 1000)}s. ` +
        'The model may be too slow for this many reviews — try a smaller review scope or a faster model.'
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Shared OpenAI-compatible chat completion call. */
async function callOpenAICompatible(
  label: string,
  url: string,
  apiKey: string | undefined,
  model: string,
  prompt: string
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: AI_DEFAULTS.OPENAI_TEMPERATURE,
      max_tokens: AI_DEFAULTS.MAX_OUTPUT_TOKENS,
    }),
  });

  if (!response.ok) {
    throw new Error(`${label} API error ${response.status}: ${await response.text()}`);
  }

  const data = await readJsonBody(response, label);
  return data.choices?.[0]?.message?.content ?? '';
}

// ─── Providers — each returns the model's raw text ───────────────────────────

type ProviderCall = (prompt: string, settings: ReviewSettings) => Promise<string>;

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

const callOllama: ProviderCall = async (prompt, settings) => {
  const model = settings.ollamaModel ?? AI_DEFAULTS.OLLAMA_MODEL;
  const p = settings.ollamaParams ?? {};

  const options: Record<string, number> = { num_predict: AI_DEFAULTS.MAX_OUTPUT_TOKENS };
  if (p.temperature   !== undefined) options.temperature    = p.temperature;
  if (p.topK          !== undefined) options.top_k          = p.topK;
  if (p.topP          !== undefined) options.top_p          = p.topP;
  if (p.numCtx        !== undefined) options.num_ctx        = p.numCtx;
  if (p.repeatPenalty !== undefined) options.repeat_penalty = p.repeatPenalty;

  const response = await fetchWithTimeout(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
  }

  const data = await readJsonBody(response, 'Ollama');
  return data.response ?? '';
};

const callOpenAI: ProviderCall = (prompt, settings) => {
  if (!settings.openaiApiKey) {
    throw new Error('OpenAI API key is not set. Go to ⚙ Settings and add your key.');
  }
  return callOpenAICompatible(
    'OpenAI',
    'https://api.openai.com/v1/chat/completions',
    settings.openaiApiKey,
    settings.openaiModel ?? AI_DEFAULTS.OPENAI_MODEL,
    prompt
  );
};

const callGroq: ProviderCall = (prompt, settings) => {
  if (!settings.groqApiKey) {
    throw new Error('Groq API key is not set. Go to ⚙ Settings and add your key.');
  }
  return callOpenAICompatible(
    'Groq',
    'https://api.groq.com/openai/v1/chat/completions',
    settings.groqApiKey,
    settings.groqModel ?? AI_DEFAULTS.GROQ_MODEL,
    prompt
  );
};

const callXAI: ProviderCall = (prompt, settings) => {
  if (!settings.xaiApiKey) {
    throw new Error('xAI API key is not set. Go to ⚙ Settings and add your key.');
  }
  return callOpenAICompatible(
    'xAI',
    'https://api.x.ai/v1/chat/completions',
    settings.xaiApiKey,
    settings.xaiModel ?? AI_DEFAULTS.XAI_MODEL,
    prompt
  );
};

const callAnthropic: ProviderCall = async (prompt, settings) => {
  if (!settings.anthropicApiKey) {
    throw new Error('Anthropic API key is not set. Go to ⚙ Settings and add your key.');
  }
  const model = settings.anthropicModel ?? AI_DEFAULTS.ANTHROPIC_MODEL;

  const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: AI_DEFAULTS.MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
  }

  const data = await readJsonBody(response, 'Anthropic');
  return data.content?.[0]?.text ?? '';
};

const callGemini: ProviderCall = async (prompt, settings) => {
  if (!settings.geminiApiKey) {
    throw new Error('Google Gemini API key is not set. Go to ⚙ Settings and add your key.');
  }
  const model = settings.geminiModel ?? AI_DEFAULTS.GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiApiKey}`;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: AI_DEFAULTS.OPENAI_TEMPERATURE,
        maxOutputTokens: AI_DEFAULTS.MAX_OUTPUT_TOKENS,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini API error ${response.status}: ${await response.text()}`);
  }

  const data = await readJsonBody(response, 'Gemini');
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
};

const callCustom: ProviderCall = async (prompt, settings) => {
  if (!settings.customEndpoint) {
    throw new Error('Custom endpoint URL is not set. Go to ⚙ Settings and add your endpoint URL.');
  }
  const baseUrl = settings.customEndpoint.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  try {
    return await callOpenAICompatible(
      'Custom endpoint',
      url,
      settings.customApiKey,
      settings.customModel || 'local-model',
      prompt
    );
  } catch (err) {
    // A bare TypeError from fetch on a non-localhost host almost always means
    // the extension lacks host permission for it.
    if (err instanceof TypeError) {
      throw new Error(
        `Could not reach ${baseUrl}. If this is not a localhost address, the extension needs ` +
        'permission for that host — re-save the endpoint in ⚙ Settings and accept the permission prompt.'
      );
    }
    throw err;
  }
};

const PROVIDER_CALL: Record<string, ProviderCall> = {
  ollama:    callOllama,
  openai:    callOpenAI,
  anthropic: callAnthropic,
  gemini:    callGemini,
  groq:      callGroq,
  xai:       callXAI,
  custom:    callCustom,
};

// ─── Retry helper ─────────────────────────────────────────────────────────────

/**
 * Re-runs fn() only when the MODEL returned malformed JSON (SyntaxError from
 * parseAIResponse). HTTP errors, timeouts, missing keys, and non-JSON provider
 * responses all propagate immediately — retrying those just burns time.
 *
 * The caller passes a closure containing only the network call and the parse;
 * prompt construction stays outside so it is not repeated on every attempt.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = AI_DEFAULTS.MAX_RETRIES): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof SyntaxError) || attempt >= maxAttempts) throw err;
      const delay = AI_DEFAULTS.RETRY_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(`[GReviewSumm] Invalid JSON on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms…`);
      await sleep(delay);
    }
  }
}

// ─── Orchestration ────────────────────────────────────────────────────────────

async function summarize(
  reviews: Review[],
  placeName: string,
  settings: ReviewSettings,
  googleRating?: number,
  googleReviewCount?: number
): Promise<SummaryResult> {
  const provider = settings.aiProvider ?? 'ollama';
  const call = PROVIDER_CALL[provider] ?? callOllama;

  const filtered = filterReviews(reviews, settings);
  if (filtered.length === 0) {
    throw new Error('No reviews matched the selected time range. Try widening the review scope in ⚙ Settings.');
  }

  // Everything below is computed ONCE — the retry closure covers only the
  // model call and the parse of its output.
  const selected  = selectReviewsForPrompt(filtered);
  const avgRating = computeAvg(filtered, googleRating);
  const prompt    = buildPrompt(selected, placeName, filtered.length);

  if (provider === 'ollama') await checkOllama();

  console.log(
    `[GReviewSumm] ${provider}: ${selected.length} of ${filtered.length} reviews in prompt ` +
    `(~${Math.round(prompt.length / 4).toLocaleString()} tokens)`
  );

  const parsed = await withRetry(async () => parseAIResponse(await call(prompt, settings)));

  return buildResult(
    parsed,
    placeName,
    avgRating,
    googleReviewCount ?? reviews.length,
    selected.length,
    filtered.length
  );
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: MessageType, _sender, sendResponse) => {
  if (message.type === 'SUMMARIZE') {
    const { reviews, placeName, settings, googleRating, googleReviewCount } = message.payload;
    console.log(`[GReviewSumm] SUMMARIZE via ${settings.aiProvider ?? 'ollama'} for "${placeName}"`);

    summarize(reviews, placeName, settings, googleRating, googleReviewCount)
      .then((result) => sendResponse({ type: 'SUMMARY_RESULT', payload: result } satisfies MessageType))
      .catch((err: unknown) => sendResponse({
        type: 'ERROR',
        payload: err instanceof Error ? err.message : String(err),
      } satisfies MessageType));

    return true;
  }
});
