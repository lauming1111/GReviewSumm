/**
 * ─── GReviewSumm — Tunable Parameters ────────────────────────────────────────
 *
 * Edit this file to tune the extension's behaviour.
 * All values here flow automatically into the content script (via the
 * GET_REVIEWS message), the popup, and the background service worker.
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

  /** Stop after this many consecutive scroll rounds that yield nothing new */
  MAX_STABLE_ROUNDS: 5,
} as const;

// ─── Popup ────────────────────────────────────────────────────────────────────

export const POPUP_CONFIG = {
  /** How often (ms) the popup polls the tab for the live review count */
  PROGRESS_POLL_MS: 800,
} as const;

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
} as const;
