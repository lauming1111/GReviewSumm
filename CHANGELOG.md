# Changelog

All notable changes to GReviewSumm will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

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
