import type { Review, MessageType } from './types.js';

const REVIEW_CARD_SELECTOR = '[data-review-id]';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait until new review cards appear, or timeout
function waitForNewReviews(previousCount: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(document.querySelectorAll(REVIEW_CARD_SELECTOR).length);
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const current = document.querySelectorAll(REVIEW_CARD_SELECTOR).length;
      if (current > previousCount) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(current);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// If reviews tab isn't open yet, find and click it
async function ensureReviewsTabOpen(): Promise<void> {
  if (document.querySelectorAll(REVIEW_CARD_SELECTOR).length > 0) return;

  const allButtons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="tab"]'));
  const reviewsBtn = allButtons.find((btn) => {
    const text = btn.textContent?.trim().toLowerCase() ?? '';
    return text === 'reviews' || text.startsWith('reviews ');
  });

  if (reviewsBtn) {
    reviewsBtn.click();
    console.log('[Review Lens] Clicked Reviews tab, waiting for cards…');
    await waitForNewReviews(0, 3000);
  }
}

// Click a "More reviews" / "See more" button if one is visible, return true if clicked
function clickMoreReviewsButton(): boolean {
  const keywords = /more review|see more review|load more|show more review/i;
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, [role="button"], a')
  );
  const btn = candidates.find((el) => {
    if (!el.offsetParent) return false; // hidden
    return keywords.test(el.textContent?.trim() ?? '') ||
           keywords.test(el.getAttribute('aria-label') ?? '');
  });
  if (btn) {
    console.log(`[Review Lens] Clicking "More reviews" button: "${btn.textContent?.trim()}"`);
    btn.click();
    return true;
  }
  return false;
}

// Scroll the last card into view — the browser finds the right container automatically.
// When scrolling stalls, try clicking a "More reviews" button before giving up.
async function scrollToLoadReviews(maxReviews: number): Promise<void> {
  await ensureReviewsTabOpen();

  if (document.querySelectorAll(REVIEW_CARD_SELECTOR).length === 0) {
    console.log('[Review Lens] No review cards found after tab open attempt');
    return;
  }

  let stableRounds = 0;
  const MAX_STABLE = 3;

  while (stableRounds < MAX_STABLE) {
    const cards = document.querySelectorAll(REVIEW_CARD_SELECTOR);
    if (cards.length >= maxReviews) break;

    const countBefore = cards.length;
    const lastCard = cards[cards.length - 1] as HTMLElement | undefined;
    lastCard?.scrollIntoView({ behavior: 'instant', block: 'end' });

    const countAfter = await waitForNewReviews(countBefore, 2000);
    console.log(`[Review Lens] Scroll: ${countAfter} reviews in DOM`);

    if (countAfter === countBefore) {
      // Scrolling didn't load more — try a "More reviews" button
      const clicked = clickMoreReviewsButton();
      if (clicked) {
        const countAfterClick = await waitForNewReviews(countBefore, 3000);
        if (countAfterClick > countBefore) {
          stableRounds = 0;
          continue;
        }
      }
      stableRounds++;
    } else {
      stableRounds = 0;
    }
  }

  console.log(
    `[Review Lens] Done: ${document.querySelectorAll(REVIEW_CARD_SELECTOR).length} reviews collected`
  );
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

// Scrape Google's own aggregate rating and total review count from the page header.
// Skips individual review-card stars to avoid false matches.
function scrapeGoogleAggregateRating(): { googleRating: number | null; googleReviewCount: number | null } {
  const candidates = Array.from(document.querySelectorAll('[aria-label*=" star"]'));
  for (const el of candidates) {
    if (el.closest(REVIEW_CARD_SELECTOR)) continue; // skip per-review stars
    const label = el.getAttribute('aria-label') ?? '';
    const ratingMatch = label.match(/(\d+(?:\.\d+)?)\s*stars?/i);
    if (!ratingMatch) continue;
    const countMatch = label.match(/([\d,]+)\s*reviews?/i);
    return {
      googleRating: parseFloat(ratingMatch[1]),
      googleReviewCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null,
    };
  }
  return { googleRating: null, googleReviewCount: null };
}

function extractStarRating(el: Element): number {
  const ariaLabel = el.getAttribute('aria-label') ?? '';
  const match = ariaLabel.match(/(\d+(?:\.\d+)?)\s*(?:star|out of)/i);
  if (match) return parseFloat(match[1]);
  return 0;
}

function scrapeMapReviews(): { reviews: Review[]; placeName: string; googleRating?: number; googleReviewCount?: number } {
  const reviews: Review[] = [];
  const { googleRating, googleReviewCount } = scrapeGoogleAggregateRating();

  document.querySelectorAll(REVIEW_CARD_SELECTOR).forEach((card) => {
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
    if (!text || text.length < 5) return;

    reviews.push({
      author: authorEl?.textContent?.trim() ?? 'Anonymous',
      rating: ratingEl ? extractStarRating(ratingEl) : 0,
      text,
      date: dateEl?.textContent?.trim(),
    });
  });

  const placeNameEl =
    document.querySelector('h1.DUwDvf') ??
    document.querySelector('h1[class*="fontHeadlineLarge"]') ??
    document.querySelector('h1');

  return {
    reviews,
    placeName: placeNameEl?.textContent?.trim() ?? document.title ?? 'This Place',
    ...(googleRating !== null && { googleRating }),
    ...(googleReviewCount !== null && { googleReviewCount }),
  };
}

function scrapeSearchReviews(): { reviews: Review[]; placeName: string } {
  const reviews: Review[] = [];

  document.querySelectorAll('.gws-localreviews__google-review').forEach((card) => {
    const text = card.querySelector('.Jtu6Td')?.textContent?.trim() ?? '';
    if (!text) return;
    const ratingEl = card.querySelector('[aria-label*="Rated"]');
    reviews.push({
      author: card.querySelector('.TSUbDb')?.textContent?.trim() ?? 'Anonymous',
      rating: ratingEl ? extractStarRating(ratingEl) : 0,
      text,
    });
  });

  const placeNameEl =
    document.querySelector('.qrShPb') ?? document.querySelector('[data-attrid="title"] span');

  return {
    reviews,
    placeName: placeNameEl?.textContent?.trim() ?? document.title ?? 'This Place',
  };
}

function collectReviews(): { reviews: Review[]; placeName: string } {
  const url = window.location.href;
  if (url.includes('maps.google.com') || url.includes('google.com/maps')) {
    return scrapeMapReviews();
  }
  const mapsResult = scrapeMapReviews();
  return mapsResult.reviews.length > 0 ? mapsResult : scrapeSearchReviews();
}

function scrapeBasicInfo(): { placeName: string; googleRating?: number; googleReviewCount?: number } {
  const { googleRating, googleReviewCount } = scrapeGoogleAggregateRating();
  const placeNameEl =
    document.querySelector('h1.DUwDvf') ??
    document.querySelector('h1[class*="fontHeadlineLarge"]') ??
    document.querySelector('h1');
  return {
    placeName: placeNameEl?.textContent?.trim() ?? document.title ?? 'This Place',
    ...(googleRating !== null && { googleRating }),
    ...(googleReviewCount !== null && { googleReviewCount }),
  };
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: MessageType, _sender, sendResponse) => {
  if (message.type === 'GET_BASIC_INFO') {
    try {
      sendResponse({ type: 'BASIC_INFO', payload: scrapeBasicInfo() } satisfies MessageType);
    } catch (err) {
      sendResponse({ type: 'ERROR', payload: String(err) } satisfies MessageType);
    }
    return true;
  }

  if (message.type === 'GET_REVIEWS') {
    (async () => {
      try {
        await scrollToLoadReviews(message.maxReviews ?? 1000);
        const { reviews, placeName } = collectReviews();
        if (reviews.length === 0) {
          sendResponse({ type: 'NO_REVIEWS' } satisfies MessageType);
        } else {
          sendResponse({ type: 'REVIEWS_DATA', payload: { reviews, placeName } } satisfies MessageType);
        }
      } catch (err) {
        sendResponse({ type: 'ERROR', payload: String(err) } satisfies MessageType);
      }
    })();
    return true;
  }
});
