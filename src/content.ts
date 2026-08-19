import type { Review, MessageType, ScrollConfig } from './types.js';

const REVIEW_CARD_SELECTOR = '[data-review-id]';

/** Minimum characters for a review body to be considered meaningful content. */
const MIN_REVIEW_TEXT_LEN = 15;

/** Fallback ceiling when the popup does not supply one (mirrors SCROLL_CONFIG.MAX_REVIEWS_ALL). */
const DEFAULT_MAX_REVIEWS = 10000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only return top-level review cards — skip elements nested inside another [data-review-id].
function getReviewCards(): Element[] {
  return Array.from(document.querySelectorAll(REVIEW_CARD_SELECTOR)).filter(
    (el) => !el.parentElement?.closest(REVIEW_CARD_SELECTOR)
  );
}

// If reviews tab isn't open yet, find and click it
async function ensureReviewsTabOpen(tabOpenWaitMs: number): Promise<void> {
  if (getReviewCards().length > 0) return;

  const allButtons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="tab"]'));
  const reviewsBtn = allButtons.find((btn) => {
    const text = btn.textContent?.trim().toLowerCase() ?? '';
    return text === 'reviews' || text.startsWith('reviews ');
  });

  if (reviewsBtn) {
    reviewsBtn.click();
    console.log('[GReviewSumm] Clicked Reviews tab, waiting for cards…');
    await sleep(tabOpenWaitMs);
  }
}

// ─── Scroll container ─────────────────────────────────────────────────────────

// Find the scrollable ancestor that holds the review list. Resolved once and
// cached — scrolling it directly avoids the sentinel-insert + ancestor-walk
// reflow storm the previous implementation performed on every round.
function findScrollContainer(from: Element): HTMLElement | null {
  let node: HTMLElement | null = from.parentElement;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 4) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

// Scroll past the last card to trigger Google Maps lazy-loading.
function scrollReviewsPanel(lastCard: Element, panel: HTMLElement | null): void {
  // Fast path — one property write, no DOM mutation, no forced layout loop.
  if (panel) {
    panel.scrollTop = panel.scrollHeight;
    return;
  }

  // Fallback 1: insert a 1px sentinel after the last card and scroll to it.
  // scrollIntoView on an already-visible card does nothing; the sentinel is
  // always just below it, so the panel must scroll down to show it.
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'height:1px;width:1px;pointer-events:none;';
  lastCard.after(sentinel);
  sentinel.scrollIntoView({ behavior: 'instant', block: 'end' });
  sentinel.remove();

  // Fallback 2: walk ancestors setting scrollTop = scrollHeight.
  let node: Element | null = lastCard.parentElement;
  while (node && node !== document.documentElement) {
    const prev = node.scrollTop;
    node.scrollTop = node.scrollHeight;
    if (node.scrollTop !== prev) return; // something scrolled — done
    node = node.parentElement;
  }

  // Fallback 3: window scroll for mobile/responsive layouts where the page scrolls.
  window.scrollTo(0, document.documentElement.scrollHeight);
}

// Click a "More reviews" / "See more" button if one is visible, return true if clicked.
// Scoped to the reviews panel when known, and the cheap regex test runs before any
// layout-forcing visibility check.
function clickMoreReviewsButton(panel: HTMLElement | null): boolean {
  const keywords = /more review|see more review|load more|show more review/i;
  const root: ParentNode = panel ?? document;
  const candidates = root.querySelectorAll<HTMLElement>('button, [role="button"], a');

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (!keywords.test(el.textContent?.trim() ?? '') &&
        !keywords.test(el.getAttribute('aria-label') ?? '')) {
      continue;
    }
    if (el.hidden || el.getClientRects().length === 0) continue;
    console.log(`[GReviewSumm] Clicking "More reviews" button: "${el.textContent?.trim()}"`);
    el.click();
    return true;
  }
  return false;
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

// Returns the number of DOM-tree edges between two elements (via their LCA).
// Used to find the rating element nearest to the place-name h1.
function domDistance(from: Element, to: Element): number {
  const distFromAncestors = new Map<Element, number>();
  let node: Element | null = from;
  let d = 0;
  while (node) { distFromAncestors.set(node, d++); node = node.parentElement; }
  node = to; d = 0;
  while (node) {
    if (distFromAncestors.has(node)) return (distFromAncestors.get(node) as number) + d;
    node = node.parentElement; d++;
  }
  return Infinity;
}

function scrapeGoogleAggregateRating(): { googleRating: number | null; googleReviewCount: number | null } {
  function tryParseEl(el: Element): { googleRating: number; googleReviewCount: number | null } | null {
    if (el.closest(REVIEW_CARD_SELECTOR)) return null;
    const label = el.getAttribute('aria-label') ?? '';
    // Match X.X before "stars", "out of 5", after "rated", or "X/5" format
    const ratingMatch =
      label.match(/(\d+(?:\.\d+)?)\s*(?:stars?\s*(?:out\s*of)?|out\s*of)/i) ??
      label.match(/rated?\s+(\d+(?:\.\d+)?)/i) ??
      label.match(/(\d+(?:\.\d+)?)\s*\/\s*5/i);
    if (!ratingMatch) return null;
    const rating = parseFloat(ratingMatch[1]);
    if (rating < 1 || rating > 5) return null;
    const countMatch = label.match(/([\d,]+)\s*reviews?/i);
    return {
      googleRating: rating,
      googleReviewCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null,
    };
  }

  // The Google Maps page has many star elements:
  //  • search-results sidebar entries  — rendered BEFORE the place-detail h1
  //  • the current place's rating chip — rendered just AFTER the h1
  //  • "Reviews from the web" section  — rendered later, after the rating chip
  //  • review histogram bars           — inside the reviews section
  //
  // Strategy:
  //  1. Find all candidates page-wide.
  //  2. Prefer elements that appear AFTER h1 in document order (sidebar is before h1).
  //  3. Among those, take the one with the smallest DOM distance to h1
  //     (rating chip is 3–8 edges; web-reviews section is much further).

  const h1 = document.querySelector('h1.DUwDvf, h1[class*="fontHeadlineLarge"], h1');

  const allCandidates = Array.from(document.querySelectorAll(
    '[role="img"][aria-label],[aria-label*="star"],[aria-label*="out of 5"],[aria-label*="rated "],[aria-label*="/5"]'
  ));

  const allValid: Array<{ result: { googleRating: number; googleReviewCount: number | null }; el: Element }> = [];
  for (const el of allCandidates) {
    const result = tryParseEl(el);
    if (result) allValid.push({ result, el });
  }

  if (allValid.length === 0) return { googleRating: null, googleReviewCount: null };
  if (!h1) return allValid[0].result; // no anchor — fall back to first found

  // Keep only elements that follow h1 in document order; fall back to all if none.
  const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
  const afterH1 = allValid.filter(({ el }) => !!(h1.compareDocumentPosition(el) & FOLLOWING));
  const pool = afterH1.length > 0 ? afterH1 : allValid;

  // Precompute each candidate's distance once — computing it inside the comparator
  // re-walked the ancestor chain on every O(n log n) comparison.
  const withDistance = pool.map((c) => ({ ...c, dist: domDistance(h1, c.el) }));
  withDistance.sort((a, b) => a.dist - b.dist);

  return withDistance[0].result;
}

function extractStarRating(el: Element): number {
  const ariaLabel = el.getAttribute('aria-label') ?? '';
  const match = ariaLabel.match(/(\d+(?:\.\d+)?)\s*(?:star|out of)/i);
  if (match) return parseFloat(match[1]);
  return 0;
}

function extractReviewFromCard(card: Element): Review | null {
  // NOTE: no `?? card` fallback. Falling back to the card itself yielded the
  // whole card's textContent — author name, date, "Like", "Share", local-guide
  // badge — which was then sent to the model as if it were review prose.
  const textEl =
    card.querySelector('.wiI7pd') ??
    card.querySelector('.MyEned') ??
    card.querySelector('[class*="review-full-text"]') ??
    card.querySelector('span[jslog]');

  if (!textEl) return null;

  const ratingEl =
    card.querySelector('span[role="img"][aria-label*="star"]') ??
    card.querySelector('[aria-label*="star"]') ??
    card.querySelector('[aria-label*="Star"]');

  const authorEl =
    card.querySelector('.d4r55') ??
    card.querySelector('.TSUbDb') ??
    card.querySelector('button[class*="fontBodyMedium"]');

  const dateEl = card.querySelector('.rsqaWe, .dehysf, [class*="date"]');

  let text = textEl.textContent?.trim() ?? '';
  if (text.length > 2000) {
    text = text.split('\n').filter((l) => l.trim().length > 10).slice(0, 3).join(' ').substring(0, 500);
  }
  if (text.length < MIN_REVIEW_TEXT_LEN) return null;

  return {
    author: authorEl?.textContent?.trim() ?? 'Anonymous',
    rating: ratingEl ? extractStarRating(ratingEl) : 0,
    text,
    date: dateEl?.textContent?.trim(),
  };
}

function scrapeContactInfo(): { category?: string; address?: string; phone?: string } {
  // Category — button with category jsaction, or first short text block after h1
  let category: string | undefined;
  const catEl = document.querySelector<HTMLElement>('button[jsaction*="category"]') ??
    document.querySelector<HTMLElement>('[class*="DkEaL"]');
  if (catEl?.textContent?.trim()) category = catEl.textContent.trim();

  // Address — aria-label is most reliable; strip leading "Address: " prefix
  let address: string | undefined;
  const addressBtn = document.querySelector('[data-item-id="address"]');
  if (addressBtn) {
    const label = addressBtn.getAttribute('aria-label');
    address = label
      ? label.replace(/^address:\s*/i, '').trim()
      : addressBtn.textContent?.trim();
  }

  // Phone — data-item-id starts with "phone:tel:"
  let phone: string | undefined;
  const phoneBtn = document.querySelector('[data-item-id^="phone:tel:"]');
  if (phoneBtn) {
    const label = phoneBtn.getAttribute('aria-label');
    phone = label
      ? label.replace(/^phone:\s*/i, '').trim()
      : phoneBtn.textContent?.trim();
  }

  return { category, address, phone };
}

async function scrapeBasicInfo(): Promise<{ placeName: string; googleRating?: number; googleReviewCount?: number; category?: string; address?: string; phone?: string }> {
  let { googleRating, googleReviewCount } = scrapeGoogleAggregateRating();

  const placeNameEl =
    document.querySelector('h1.DUwDvf') ??
    document.querySelector('h1[class*="fontHeadlineLarge"]') ??
    document.querySelector('h1');

  let { category, address, phone } = scrapeContactInfo();

  // If contact info is missing we may be on the Reviews tab (Overview content not rendered).
  // Temporarily switch to Overview, re-scrape, then switch back — invisible to the user.
  if (!address && !phone && !category) {
    const allTabs = Array.from(document.querySelectorAll<HTMLElement>('button[role="tab"], [role="tab"]'));
    const overviewBtn = allTabs.find((btn) => {
      const t = btn.textContent?.trim().toLowerCase() ?? '';
      return t === 'overview' || t === 'info';
    });
    const reviewsBtn = allTabs.find((btn) => {
      const t = btn.textContent?.trim().toLowerCase() ?? '';
      return t === 'reviews' || t.startsWith('reviews ');
    });

    if (overviewBtn) {
      overviewBtn.click();
      await sleep(700); // wait for Overview panel to render
      ({ category, address, phone } = scrapeContactInfo());
      // Also re-scrape rating — might be more accurate on Overview
      const overviewRating = scrapeGoogleAggregateRating();
      if (overviewRating.googleRating !== null) googleRating = overviewRating.googleRating;
      if (overviewRating.googleReviewCount !== null) googleReviewCount = overviewRating.googleReviewCount;
      if (reviewsBtn) reviewsBtn.click(); // restore Reviews tab
    }
  }

  return {
    placeName: placeNameEl?.textContent?.trim() ?? document.title ?? 'This Place',
    ...(googleRating !== null && { googleRating }),
    ...(googleReviewCount !== null && { googleReviewCount }),
    ...(category && { category }),
    ...(address && { address }),
    ...(phone && { phone }),
  };
}

// ─── Incremental scroll + scrape ──────────────────────────────────────────────

// Updated by scrollAndScrapeReviews so GET_PROGRESS can report live count.
let progressCount = 0;
let shouldStop = false;

const DEFAULT_SCROLL_CONFIG: ScrollConfig = {
  tabOpenWaitMs: 1500,
  pollIntervalMs: 300,
  scrollWaitMs: 2000,
  moreReviewsWaitMs: 2000,
  maxStableRounds: 2,
};

async function scrollAndScrapeReviews(
  maxReviews: number,
  cfg: ScrollConfig = DEFAULT_SCROLL_CONFIG
): Promise<{ reviews: Review[]; placeName: string; googleRating?: number; googleReviewCount?: number }> {
  await ensureReviewsTabOpen(cfg.tabOpenWaitMs);

  const initialCards = getReviewCards();
  if (initialCards.length === 0) {
    console.log('[GReviewSumm] No review cards found after tab open attempt');
    return { reviews: [], placeName: document.title };
  }

  // Resolve the scrollable review panel once and reuse it every round.
  const panel = findScrollContainer(initialCards[0]);
  console.log(`[GReviewSumm] Scroll container: ${panel ? panel.className || '<unnamed>' : 'not found — using fallback'}`);

  // Scrape the aggregate rating up front so the loop knows its target count.
  const aggregate = scrapeGoogleAggregateRating();
  const targetCount = aggregate.googleReviewCount;

  // Cards already parsed. A WeakSet keyed on the element means each card is
  // parsed exactly once, no matter how many times it is re-queried — this is
  // what removes the quadratic re-parse the previous implementation had.
  const seenCards = new WeakSet<Element>();
  const seenKeys = new Set<string>();
  const allReviews: Review[] = [];
  let lastCard: Element | null = null;

  function collectNew(): number {
    let added = 0;
    const cards = document.querySelectorAll(REVIEW_CARD_SELECTOR);
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (seenCards.has(card)) continue;
      seenCards.add(card);
      if (card.parentElement?.closest(REVIEW_CARD_SELECTOR)) continue; // nested duplicate
      const review = extractReviewFromCard(card);
      if (!review) continue;
      const key = `${review.author}|${review.text.slice(0, 60)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      allReviews.push(review);
      added++;
    }
    // Last element in document order — no extra scan needed for the scroll target.
    lastCard = cards.length > 0 ? cards[cards.length - 1] : lastCard;
    progressCount = allReviews.length;
    return added;
  }

  // Poll until new reviews appear or the timeout elapses, COLLECTING as it goes.
  // Checks before sleeping so a fast page does not pay a full poll interval,
  // and honours shouldStop mid-wait so Cancel is responsive.
  async function pollForNewReviews(timeoutMs: number, pollMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const added = collectNew();
      if (added > 0) return added;
      if (shouldStop) return 0;
      if (Date.now() >= deadline) return 0;
      await sleep(pollMs);
    }
  }

  // Grab the first visible batch before scrolling
  collectNew();

  let stableRounds = 0;

  while (stableRounds < cfg.maxStableRounds && allReviews.length < maxReviews && !shouldStop) {
    // Stop early once we have as many reviews as Google says exist.
    if (targetCount !== null && allReviews.length >= targetCount) {
      console.log(`[GReviewSumm] Reached Google's reported count (${targetCount}) — stopping early`);
      break;
    }

    if (lastCard) scrollReviewsPanel(lastCard, panel);

    const added = await pollForNewReviews(cfg.scrollWaitMs, cfg.pollIntervalMs);
    console.log(`[GReviewSumm] Scroll: ${allReviews.length} unique reviews (${added} new this round)`);

    if (added === 0) {
      if (shouldStop) break;
      const clicked = clickMoreReviewsButton(panel);
      if (clicked) {
        const addedAfterClick = await pollForNewReviews(cfg.moreReviewsWaitMs, cfg.pollIntervalMs);
        if (addedAfterClick > 0) {
          stableRounds = 0;
          continue;
        }
      }
      stableRounds++;
    } else {
      stableRounds = 0;
    }
  }

  console.log(`[GReviewSumm] Done: ${allReviews.length} unique reviews`);

  // Reuse the pre-loop aggregate; only re-scrape if it came back empty.
  const { googleRating, googleReviewCount } =
    aggregate.googleRating !== null ? aggregate : scrapeGoogleAggregateRating();

  const placeNameEl =
    document.querySelector('h1.DUwDvf') ??
    document.querySelector('h1[class*="fontHeadlineLarge"]') ??
    document.querySelector('h1');

  return {
    reviews: allReviews.slice(0, maxReviews),
    placeName: placeNameEl?.textContent?.trim() ?? document.title ?? 'This Place',
    ...(googleRating !== null && { googleRating }),
    ...(googleReviewCount !== null && { googleReviewCount }),
  };
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: MessageType, _sender, sendResponse) => {
  if (message.type === 'STOP_REVIEWS') {
    shouldStop = true;
    sendResponse({ type: 'NO_REVIEWS' } satisfies MessageType);
    return true;
  }

  if (message.type === 'GET_PROGRESS') {
    sendResponse({ type: 'PROGRESS', payload: { count: progressCount } } satisfies MessageType);
    return true;
  }

  if (message.type === 'GET_BASIC_INFO') {
    (async () => {
      try {
        sendResponse({ type: 'BASIC_INFO', payload: await scrapeBasicInfo() } satisfies MessageType);
      } catch (err) {
        sendResponse({ type: 'ERROR', payload: String(err) } satisfies MessageType);
      }
    })();
    return true;
  }

  if (message.type === 'GET_REVIEWS') {
    (async () => {
      try {
        progressCount = 0;
        shouldStop = false;
        const result = await scrollAndScrapeReviews(
          message.maxReviews ?? DEFAULT_MAX_REVIEWS,
          message.scrollConfig ?? DEFAULT_SCROLL_CONFIG,
        );
        if (result.reviews.length === 0) {
          sendResponse({ type: 'NO_REVIEWS' } satisfies MessageType);
        } else {
          sendResponse({ type: 'REVIEWS_DATA', payload: result } satisfies MessageType);
        }
      } catch (err) {
        sendResponse({ type: 'ERROR', payload: String(err) } satisfies MessageType);
      }
    })();
    return true;
  }
});
