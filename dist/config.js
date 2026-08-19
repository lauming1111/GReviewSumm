/**
 * ─── GReviewSumm — Tunable Parameters ────────────────────────────────────────
 *
 * Edit this file to tune the extension's behaviour.
 *
 * SCROLL_CONFIG reaches the content script over the GET_REVIEWS message (the
 * content script cannot import this module — build.js strips ES exports so the
 * script can run as a classic content script). content.ts keeps a matching
 * DEFAULT_SCROLL_CONFIG used only when no config arrives on the message.
 */
// ─── Scroll / data-gathering ─────────────────────────────────────────────────
export const SCROLL_CONFIG = {
    /** ms to wait after clicking the Reviews tab before the first scrape */
    TAB_OPEN_WAIT_MS: 1500,
    /** How often (ms) to poll for new reviews after each scroll */
    POLL_INTERVAL_MS: 300,
    /** Maximum ms to wait per scroll round before giving up and moving on */
    SCROLL_WAIT_MS: 2000,
    /** Maximum ms to wait after clicking a "More reviews" button */
    MORE_REVIEWS_WAIT_MS: 2000,
    /**
     * Stop after this many consecutive scroll rounds that yield nothing new.
     * Each stalled round can cost SCROLL_WAIT_MS + MORE_REVIEWS_WAIT_MS, so this
     * value is the dominant term in the "waiting after the last review" tail.
     */
    MAX_STABLE_ROUNDS: 2,
    /** Scrape ceiling for non-"recent" review modes (content.ts mirrors this). */
    MAX_REVIEWS_ALL: 10000,
};
// ─── Popup ────────────────────────────────────────────────────────────────────
export const POPUP_CONFIG = {
    /** How often (ms) the popup polls the tab for the live review count */
    PROGRESS_POLL_MS: 800,
};
// ─── Cache ────────────────────────────────────────────────────────────────────
export const CACHE_CONFIG = {
    /** How long a cached summary or review set stays valid */
    TTL_MS: 24 * 60 * 60 * 1000,
    /** Maximum entries kept per cache before the oldest are evicted */
    MAX_ENTRIES: 50,
};
// ─── AI defaults ─────────────────────────────────────────────────────────────
export const AI_DEFAULTS = {
    /** Default Ollama model (must be pulled locally via `ollama pull <model>`) */
    OLLAMA_MODEL: 'llama3.2:latest',
    /** Default OpenAI model */
    OPENAI_MODEL: 'gpt-4o-mini',
    /** OpenAI temperature (0 = deterministic, 1 = creative) */
    OPENAI_TEMPERATURE: 0.3,
    /** How many times to retry the AI call when it returns invalid JSON */
    MAX_RETRIES: 3,
    /** Delay (ms) before the first retry; doubles on each subsequent attempt */
    RETRY_BACKOFF_MS: 500,
    /** Abort an AI request that has not responded within this many ms */
    REQUEST_TIMEOUT_MS: 120000,
    /** Upper bound on generated tokens — must fit the full JSON result object */
    MAX_OUTPUT_TOKENS: 2048,
    /**
     * Hard cap on how many reviews are serialized into a single prompt.
     * Without this a 1000-review place produced a ~68k-token prompt that no
     * local model could read, while still paying full prompt-processing cost.
     */
    MAX_REVIEWS_TO_AI: 250,
    /** Per-review character cap inside the prompt */
    MAX_REVIEW_CHARS: 400,
    /**
     * Hard ceiling on the characters spent on review text in one prompt.
     * MAX_REVIEWS_TO_AI alone does NOT bound prompt size — 250 verbose reviews
     * still reach ~25k tokens, well past OLLAMA_NUM_CTX. ~48k chars ≈ 12k tokens,
     * which leaves room for the static template and MAX_OUTPUT_TOKENS inside a
     * 16k context window.
     */
    MAX_PROMPT_CHARS: 48000,
    /** Default Anthropic model */
    ANTHROPIC_MODEL: 'claude-3-5-haiku-20241022',
    /** Default Google Gemini model */
    GEMINI_MODEL: 'gemini-2.0-flash',
    /** Default Groq model */
    GROQ_MODEL: 'llama-3.3-70b-versatile',
    /** Default xAI (Grok) model */
    XAI_MODEL: 'grok-3-mini-latest',
    // ─── Ollama local model parameters ──────────────────────────────────────────
    /** Sampling temperature — lower = more focused, higher = more creative */
    OLLAMA_TEMPERATURE: 0.7,
    /** Top-K sampling — number of tokens to consider at each step */
    OLLAMA_TOP_K: 40,
    /** Top-P (nucleus) sampling */
    OLLAMA_TOP_P: 0.9,
    /** Context window in tokens — must fit MAX_PROMPT_CHARS plus MAX_OUTPUT_TOKENS */
    OLLAMA_NUM_CTX: 16384,
    /** Repeat penalty — discourages repetition (1.0 = off) */
    OLLAMA_REPEAT_PENALTY: 1.1,
};
