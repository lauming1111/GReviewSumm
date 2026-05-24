const REVIEW_CARD_SELECTOR = '[data-review-id]';
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// Only return top-level review cards — skip elements nested inside another [data-review-id].
function getReviewCards() {
    return Array.from(document.querySelectorAll(REVIEW_CARD_SELECTOR)).filter((el) => !el.parentElement?.closest(REVIEW_CARD_SELECTOR));
}
// If reviews tab isn't open yet, find and click it
async function ensureReviewsTabOpen() {
    if (getReviewCards().length > 0)
        return;
    const allButtons = Array.from(document.querySelectorAll('button, [role="tab"]'));
    const reviewsBtn = allButtons.find((btn) => {
        const text = btn.textContent?.trim().toLowerCase() ?? '';
        return text === 'reviews' || text.startsWith('reviews ');
    });
    if (reviewsBtn) {
        reviewsBtn.click();
        console.log('[Review Lens] Clicked Reviews tab, waiting for cards…');
        await sleep(2500);
    }
}
// Click a "More reviews" / "See more" button if one is visible, return true if clicked
function clickMoreReviewsButton() {
    const keywords = /more review|see more review|load more|show more review/i;
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
    const btn = candidates.find((el) => {
        if (!el.offsetParent)
            return false;
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
// Scroll past the last card to trigger Google Maps lazy-loading.
function scrollReviewsPanel(lastCard) {
    // 1. Insert a 1px sentinel immediately after the last card and scroll to it.
    //    scrollIntoView on an already-visible card does nothing; the sentinel is
    //    always just below it, so the panel must scroll down to show it.
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'height:1px;width:1px;pointer-events:none;';
    lastCard.after(sentinel);
    sentinel.scrollIntoView({ behavior: 'instant', block: 'end' });
    sentinel.remove();
    // 2. Also walk ancestors setting scrollTop = scrollHeight (catches fixed panels).
    let node = lastCard.parentElement;
    while (node && node !== document.documentElement) {
        const prev = node.scrollTop;
        node.scrollTop = node.scrollHeight;
        if (node.scrollTop !== prev)
            break; // stop at first element that actually scrolled
        node = node.parentElement;
    }
    // 3. Window scroll for mobile/responsive layouts where the page itself scrolls.
    window.scrollTo(0, document.documentElement.scrollHeight);
}
// ─── Scraping ─────────────────────────────────────────────────────────────────
function scrapeGoogleAggregateRating() {
    const candidates = Array.from(document.querySelectorAll('[aria-label*=" star"]'));
    for (const el of candidates) {
        if (el.closest(REVIEW_CARD_SELECTOR))
            continue;
        const label = el.getAttribute('aria-label') ?? '';
        const ratingMatch = label.match(/(\d+(?:\.\d+)?)\s*stars?/i);
        if (!ratingMatch)
            continue;
        const countMatch = label.match(/([\d,]+)\s*reviews?/i);
        return {
            googleRating: parseFloat(ratingMatch[1]),
            googleReviewCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null,
        };
    }
    return { googleRating: null, googleReviewCount: null };
}
function extractStarRating(el) {
    const ariaLabel = el.getAttribute('aria-label') ?? '';
    const match = ariaLabel.match(/(\d+(?:\.\d+)?)\s*(?:star|out of)/i);
    if (match)
        return parseFloat(match[1]);
    return 0;
}
function extractReviewFromCard(card) {
    const textEl = card.querySelector('.wiI7pd') ??
        card.querySelector('[class*="review-full-text"]') ??
        card.querySelector('span[jslog]') ??
        card;
    const ratingEl = card.querySelector('span[role="img"][aria-label*="star"]') ??
        card.querySelector('[aria-label*="star"]') ??
        card.querySelector('[aria-label*="Star"]');
    const authorEl = card.querySelector('.d4r55') ??
        card.querySelector('.TSUbDb') ??
        card.querySelector('button[class*="fontBodyMedium"]');
    const dateEl = card.querySelector('.rsqaWe, .dehysf, [class*="date"]');
    let text = textEl?.textContent?.trim() ?? '';
    if (text.length > 2000) {
        text = text.split('\n').filter((l) => l.trim().length > 10).slice(0, 3).join(' ').substring(0, 500);
    }
    if (!text || text.length < 5)
        return null;
    return {
        author: authorEl?.textContent?.trim() ?? 'Anonymous',
        rating: ratingEl ? extractStarRating(ratingEl) : 0,
        text,
        date: dateEl?.textContent?.trim(),
    };
}
function scrapeBasicInfo() {
    const { googleRating, googleReviewCount } = scrapeGoogleAggregateRating();
    const placeNameEl = document.querySelector('h1.DUwDvf') ??
        document.querySelector('h1[class*="fontHeadlineLarge"]') ??
        document.querySelector('h1');
    return {
        placeName: placeNameEl?.textContent?.trim() ?? document.title ?? 'This Place',
        ...(googleRating !== null && { googleRating }),
        ...(googleReviewCount !== null && { googleReviewCount }),
    };
}
// ─── Incremental scroll + scrape ──────────────────────────────────────────────
// Updated by scrollAndScrapeReviews so GET_PROGRESS can report live count.
let progressCount = 0;
async function scrollAndScrapeReviews(maxReviews) {
    await ensureReviewsTabOpen();
    if (getReviewCards().length === 0) {
        console.log('[Review Lens] No review cards found after tab open attempt');
        return { reviews: [], placeName: document.title };
    }
    const seenKeys = new Set();
    const allReviews = [];
    function collectVisible() {
        let added = 0;
        for (const card of getReviewCards()) {
            const review = extractReviewFromCard(card);
            if (!review)
                continue;
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
    const MAX_STABLE = 5;
    while (stableRounds < MAX_STABLE && allReviews.length < maxReviews) {
        const lastCard = getReviewCards().slice(-1)[0];
        if (lastCard)
            scrollReviewsPanel(lastCard);
        await sleep(2500);
        const added = collectVisible();
        console.log(`[Review Lens] Scroll: ${allReviews.length} unique reviews (${added} new this round)`);
        if (added === 0) {
            const clicked = clickMoreReviewsButton();
            if (clicked) {
                await sleep(2500);
                const addedAfterClick = collectVisible();
                if (addedAfterClick > 0) {
                    stableRounds = 0;
                    continue;
                }
            }
            stableRounds++;
        }
        else {
            stableRounds = 0;
        }
    }
    console.log(`[Review Lens] Done: ${allReviews.length} unique reviews`);
    const { googleRating, googleReviewCount } = scrapeGoogleAggregateRating();
    const placeNameEl = document.querySelector('h1.DUwDvf') ??
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
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_PROGRESS') {
        sendResponse({ type: 'PROGRESS', payload: { count: progressCount || getReviewCards().length } });
        return true;
    }
    if (message.type === 'GET_BASIC_INFO') {
        try {
            sendResponse({ type: 'BASIC_INFO', payload: scrapeBasicInfo() });
        }
        catch (err) {
            sendResponse({ type: 'ERROR', payload: String(err) });
        }
        return true;
    }
    if (message.type === 'GET_REVIEWS') {
        (async () => {
            try {
                progressCount = 0;
                const result = await scrollAndScrapeReviews(message.maxReviews ?? 1000);
                if (result.reviews.length === 0) {
                    sendResponse({ type: 'NO_REVIEWS' });
                }
                else {
                    sendResponse({ type: 'REVIEWS_DATA', payload: result });
                }
            }
            catch (err) {
                sendResponse({ type: 'ERROR', payload: String(err) });
            }
        })();
        return true;
    }
});
