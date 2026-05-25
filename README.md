# GReviewSumm – AI Review Summarizer

A Chrome extension that instantly summarizes Google Maps reviews using AI.
Supports local models via [Ollama](https://ollama.com) (no data leaves your machine)
and cloud providers including OpenAI, Anthropic Claude, Google Gemini, Groq, and xAI Grok.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)

---

## Features

- **Instant place info** — opens to place name, rating, review count, address, and phone with no delay
- **Auto-scroll** — automatically scrolls the reviews panel to collect up to 1,000 reviews (adjustable)
- **AI summary** — returns pros, cons, top themes, overall sentiment, and frequently mentioned staff
- **7 AI providers** — Ollama (local), OpenAI, Anthropic Claude, Google Gemini, Groq, xAI Grok, or any OpenAI-compatible custom endpoint
- **Encrypted key storage** — API keys are encrypted at rest with AES-GCM-256; never exposed in the DOM
- **Cached results** — analysis is cached for 24 hours; history screen lets you browse and re-open past summaries
- **Time-based filtering** — analyze all reviews, the most recent N, or reviews from the last 1/3/6/12 months
- **Wrong-page detection** — friendly prompt when the extension is opened on a non-Maps tab

## Screenshots

> Add screenshots here once the extension is published.

---

## Requirements

- Google Chrome (or any Chromium-based browser)
- **One of the following AI backends:**
  - [Ollama](https://ollama.com) running locally on port `11434` (free, private)
  - An API key for OpenAI, Anthropic, Google Gemini, Groq, or xAI

---

## Installation

### 1. Set up an AI backend

**Ollama (local, recommended):**

```bash
# Pull a model
ollama pull llama3.2

# Start the server (runs on port 11434 by default)
ollama serve
```

**Cloud provider:** obtain an API key from your chosen provider and add it in the extension settings after installation.

### 2. Build the extension

```bash
cd review-lens-source
npm install
npm run build
```

This compiles TypeScript and copies the output to `review-lens-extension/`.

### 3. Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `review-lens-extension/` folder

---

## Usage

1. Navigate to a business page on **Google Maps** (`google.com/maps` or `maps.google.com`)
2. Click the **GReviewSumm** extension icon
3. The popup shows the place name, rating, and total review count
4. Click **Analyze Reviews** — the extension scrolls through reviews automatically, then sends them to your chosen AI
5. View the summary, pros, cons, top themes, and frequently mentioned staff
6. Reopen the popup within 24 hours to load the cached result instantly

### Settings

Click ⚙ in the top-right to configure:

| Setting | Description |
|---|---|
| **AI Provider** | Ollama · OpenAI · Anthropic · Gemini · Groq · xAI Grok · Custom endpoint |
| **Model** | Provider-specific model selector or free-text input |
| **Ollama parameters** | Temperature, top-p, top-k, repeat penalty, context window |
| **Review scope** | All time · Recent (by count) · Last 1/3/6/12 months |
| **Maximum reviews** | How many reviews to collect (10–2000, default 1000) |

### API Key Security

Keys entered in settings are encrypted with AES-GCM-256 before being written to Chrome's local storage. They are never loaded back into the input field — a `✓ Saved` badge confirms a stored key. Use the `✕` button beside a key field to revoke it.

---

## Project Structure

```
google-review-summary/
├── review-lens-source/       # TypeScript source
│   ├── src/
│   │   ├── background.ts     # Service worker — filters reviews, calls AI APIs
│   │   ├── content.ts        # Injected into Maps — scrapes & auto-scrolls reviews
│   │   ├── popup.ts          # Popup UI logic
│   │   ├── crypto.ts         # AES-GCM-256 API key encryption
│   │   ├── config.ts         # Centralised constants and defaults
│   │   └── types.ts          # Shared types & message contracts
│   ├── popup.html            # Popup UI (dark theme)
│   ├── manifest.json         # Extension manifest (MV3)
│   ├── build.js              # Post-compile copy script
│   ├── tsconfig.json
│   └── package.json
└── review-lens-extension/    # Built extension — load this in Chrome
```

---

## Development

```bash
cd review-lens-source

# One-time build
npm run build

# Watch mode (TypeScript only; run build.js manually after)
npm run watch
```

After changing any `.ts` file or `popup.html`, run `npm run build` and then click **↺** on the extension card in `chrome://extensions` to reload.

---

## Contributing

Contributions are welcome, but **require prior approval**. Please open a GitHub Issue to discuss your idea before writing any code. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

Source Available — Contribution by Permission. You may view and study the code, but you may not copy, fork, redistribute, or use it in other projects without permission. See [LICENSE](./LICENSE) for details.
