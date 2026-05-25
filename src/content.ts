import type { Review, MessageType, ScrollConfig } from './types.js';

const REVIEW_CARD_SELECTOR = '[data-review-id]';

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

// Poll every pollMs until a new unique review is visible, or timeoutMs elapses.
// Exits early as soon as new content appears — much faster than a fixed sleep.
async function waitForNewContent(
  seenKeys: Set<string>,
  pollMs: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    for (const card of getReviewCards()) {
      const review = extractReviewFromCard(card);
      if (!review) continue;
      const key = `${review.author}|${review.text.slice(0, 60)}`;
      if (!seenKeys.has(key)) return; // new content spotted — exit immediately
    }
  }
}

// Click a "More reviews" / "See more" button if one is visible, return true if clicked
function clickMoreReviewsButton(): boolean {
  const keywords = /more review|see more review|load more|show more review/i;
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, [role="button"], a')
  );
  const btn = candidates.find((el) => {
    if (!el.offsetParent) return false;
    return keywords.test(el.textContent?.trim() ?? '') ||
           keywords.test(el.getAttribute('aria-label') ?? '');
  });
  if (btn) {
    console.log(`[GReviewSumm] Clicking "More reviews" button: "${btn.textContent?.trim()}"`);
    btn.click();
    return true;
  }
  return false;
}

// Scroll past the last card to trigger Google Maps lazy-loading.
function scrollReviewsPanel(lastCard: Element): void {
  // 1. Insert a 1px sentinel immediately after the last card and scroll to it.
  //    scrollIntoView on an already-visible card does nothing; the sentinel is
  //    always just below it, so the panel must scroll down to show it.
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'height:1px;width:1px;pointer-events:none;';
  lastCard.after(sentinel);
  sentinel.scrollIntoView({ behavior: 'instant', block: 'end' });
  sentinel.remove();

  // 2. Also walk ancestors setting scrollTop = scrollHeight (catches fixed panels).
  let node: Element | null = lastCard.parentElement;
  while (node && node !== document.documentElement) {
    const prev = node.scrollTop;
    node.scrollTop = node.scrollHeight;
    if (node.scrollTop !== prev) break; // stop at first element that actually scrolled
    node = node.parentElement;
  }

  // 3. Window scroll for mobile/responsive layouts where the page itself scrolls.
  window.scrollTo(0, document.documentElement.scrollHeight);
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

  // Pick the candidate with the smallest DOM-tree distance to h1.
  pool.sort((a, b) => domDistance(h1, a.el) - domDistance(h1, b.el));

  return pool[0].result;
}

function extractStarRating(el: Element): number {
  const ariaLabel = el.getAttribute('aria-label') ?? '';
  const match = ariaLabel.match(/(\d+(?:\.\d+)?)\s*(?:star|out of)/i);
  if (match) return parseFloat(match[1]);
  return 0;
}

function extractReviewFromCard(card: Element): Review | null {
  const textEl =
    card.querySelector('.wiI7pd') ??
    card.querySelector('[class*="review-full-text"]') ??
    card.querySelector('span[jslog]') ??
    card;

  const ratingEl =
    card.querySelector('span[role="img"][aria-label*="star"]') ??
    card.querySelector('[aria-label*="star"]') ??
    card.querySelector('[aria-label*="Star"]');

  const authorEl =
    card.querySelector('.d4r55') ??
    card.querySelector('.TSUbDb') ??
    card.querySelector('button[class*="fontBodyMedium"]');

  const dateEl = card.querySelector('.rsqaWe, .dehysf, [class*="date"]');

  let text = textEl?.textContent?.trim() ?? '';
  if (text.length > 2000) {
    text = text.split('\n').filter((l) => l.trim().length > 10).slice(0, 3).join(' ').substring(0, 500);
  }
  if (!text || text.length < 5) return null;

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
  maxStableRounds: 5,
};

async function scrollAndScrapeReviews(
  maxReviews: number,
  cfg: ScrollConfig = DEFAULT_SCROLL_CONFIG
): Promise<{ reviews: Review[]; placeName: string; googleRating?: number; googleReviewCount?: number }> {
  await ensureReviewsTabOpen(cfg.tabOpenWaitMs);

  if (getReviewCards().length === 0) {
    console.log('[GReviewSumm] No review cards found after tab open attempt');
    return { reviews: [], placeName: document.title };
  }

  const seenKeys = new Set<string>();
  const allReviews: Review[] = [];

  function collectVisible(): number {
    let added = 0;
    for (const card of getReviewCards()) {
      const review = extractReviewFromCard(card);
      if (!review) continue;
      const key = `${review.author}|${review.text.slice(0, 60)}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allReviews.push(review);
        added++;
      }
    }
    progressCount = allReviews.length;
    return added;
  }

  // Grab the first visible batch before scrolling
  collectVisible();

  let stableRounds = 0;

  while (stableRounds < cfg.maxStableRounds && allReviews.length < maxReviews && !shouldStop) {
    const lastCard = getReviewCards().slice(-1)[0];
    if (lastCard) scrollReviewsPanel(lastCard);

    // Smart wait: exit as soon as new reviews appear (poll) or timeout
    await waitForNewContent(seenKeys, cfg.pollIntervalMs, cfg.scrollWaitMs);

    const added = collectVisible();
    console.log(`[GReviewSumm] Scroll: ${allReviews.length} unique reviews (${added} new this round)`);

    if (added === 0) {
      const clicked = clickMoreReviewsButton();
      if (clicked) {
        await waitForNewContent(seenKeys, cfg.pollIntervalMs, cfg.moreReviewsWaitMs);
        const addedAfterClick = collectVisible();
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

  const { googleRating, googleReviewCount } = scrapeGoogleAggregateRating();
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
    sendResponse({ type: 'PROGRESS', payload: { count: progressCount || getReviewCards().length } } satisfies MessageType);
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
        const result = await scrollAndScrapeReviews(message.maxReviews ?? 1000);
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
