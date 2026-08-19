# Changelog

All notable changes to GReviewSumm will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- **Scraped reviews are cached** for 24 h alongside the summary, so Re-analyze and provider switches skip the scroll phase entirely — a new **⟳ Fresh** button forces a re-scrape
- **Save** button in settings, separate from **Save & Analyze** — changing a model or pasting a key no longer forces a full analysis
- Result header now reports the sample size (e.g. "113 of 1,043 reviews analyzed") instead of implying every review was read
- Request timeout on all AI calls, so a hung Ollama server surfaces an error instead of spinning forever
- `optional_host_permissions` plus a save-time permission request, so custom OpenAI-compatible endpoints on non-localhost hosts work

### Fixed
- **Wrong business summary on Google Search pages** — the cache key kept only origin + pathname, so every `google.com/search` knowledge panel collapsed onto one key and served the previously analyzed business's summary
- Cache key now includes provider, model, and review scope — switching provider previously returned the old result unchanged
- `config.ts` values never reached the scroll loop; the content script dropped the `scrollConfig` it was sent and always used its own hardcoded copy
- Reviews with an unparseable date are kept rather than silently dropped, which could empty every time-window result set
- Rating-only reviews no longer feed card UI chrome ("Like", "Share", "Local Guide") to the model as review prose
- `reviewCount` is now honoured in **All** scope, and its input is no longer hidden there — previously there was no way to cap a very large place
- Expired cache entries are evicted on read and both caches are capped at 50 entries
- Anthropic output cap raised to 2048 tokens; a truncated response produced invalid JSON that then burned every retry

### Changed
- **Prompt is now bounded.** Reviews sent to the model are capped and sampled — all 1–2★ reviews are kept, the rest stride-sampled across the full time range, with a hard character budget. A 1000-review place previously produced a ~68k-token prompt against a 4096-token context window, so the model silently read a fraction of it at full latency. Ollama `num_ctx` default raised to 16384
- **Scraper no longer re-parses collected reviews.** Cards are tracked in a `WeakSet` and parsed exactly once; polling now collects as it goes rather than parsing the whole list to answer a boolean and discarding the result
- `MAX_STABLE_ROUNDS` reduced from 5 to 2, plus an early exit once Google's reported review count is reached — removing up to ~20 s of waiting after the last review was already collected
- Cancel is now checked mid-wait instead of only between rounds (was up to ~4 s to register)
- Scroll targets the resolved review panel directly, replacing a per-round sentinel insert, ancestor scroll-walk, and an `offsetParent` scan over every button and link on the page
- Retry now wraps only the model call and its parse — prompt construction and the Ollama health check no longer repeat on every attempt — and backs off between attempts
- `author` is dropped and `date` omitted for non-time-window scopes before crossing the popup → background message boundary

---

## [1.2.0] — 2026-05-25

### Added
- **Multi-provider AI support** — OpenAI, Anthropic Claude, Google Gemini, Groq, xAI Grok, and any OpenAI-compatible custom endpoint alongside the existing Ollama integration
- **Ollama advanced parameters** — tune temperature, top-p, top-k, repeat penalty, and context window (`num_ctx`) directly from the settings panel
- **API key protection** — keys are never loaded into DOM inputs; a `✓ Saved` badge confirms a stored key and an explicit `✕` button is required to revoke it
- **API key encryption** — keys are encrypted at rest using AES-GCM-256 with PBKDF2-SHA-256 key derivation (100 000 iterations); legacy plaintext keys are migrated transparently on next save
- **Wrong-page screen** — when the extension is opened on a non-Google Maps tab it now shows a clear prompt with an "Open Google Maps" button instead of silently failing

### Fixed
- Staff section no longer picks up customer names (reviewers) or platform/brand names — the AI prompt now explicitly restricts `notableStaff` to business employees only

### Changed
- Renamed from *Review Lens* to **GReviewSumm** across all storage keys, console output, and UI copy

---

## [1.1.0] — 2026-05-24

### Added
- **Frequently mentioned staff** — a dedicated section surfaces employee first names that appear in at least two separate reviews
- **⚡ Summarize Now** — lets you cut review gathering short and summarize whatever has been collected so far, without cancelling the whole run
- **Centralized config** — a single `config.ts` module owns all tunable constants (scroll timing, AI defaults, popup behaviour) so they are easy to find and change
- **Rich place info panel** — the info screen now shows category, address, and phone number scraped from the Maps sidebar

### Fixed
- Complete rewrite of the review scraper — more reliable across Maps layouts and edge cases
- Aggregate star rating now uses Google's official rating instead of recalculating from visible review cards, which was producing wrong values
- Retry button now wired correctly on all error and no-reviews screens

---

## [1.0.0] — 2026-05-23

### Added
- Initial release — summarize Google Maps reviews with a local Ollama model
- Review scope filters: all-time, most-recent N, or a time window (1 month, 3 months, 6 months, 1 year)
- 24-hour result cache keyed by page URL, with a full history screen to browse and re-open past summaries
- Two-step loading indicator with per-step elapsed timers
- Cancel button to abort an in-progress analysis and return to the info screen
- Pinned footer on the result screen (Settings / Re-analyze always visible without scrolling)
