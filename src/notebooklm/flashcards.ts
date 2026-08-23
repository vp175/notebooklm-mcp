/**
 * Flashcards strategy, registered into the Studio-output engine
 * (studio-outputs.ts). Structured-kind — no file download; content is
 * extracted via `extractContent()`.
 *
 * TRIGGER FLOW — live-confirmed 2026-08-23: clicking the `cards_star`
 * trigger tile opens a "Customize Flashcards" dialog (Sources, a
 * topic-prompt field, Number-of-cards and Level-of-Difficulty fields) with
 * a working "Generate" button. Uses the shared `triggerViaDialog` helper
 * (studio-outputs.ts), which leaves those fields at their defaults.
 *
 * VIEWER — live-confirmed 2026-08-23 against a real, freshly-generated
 * Flashcards artifact (50 cards): renders inside the same cross-origin
 * sandboxed iframe pattern as Mind Map/Quiz (see `getSandboxFrame`'s doc
 * comment in studio-outputs.ts). UNLIKE Mind Map, no interaction is needed
 * to reveal content — both the front (`.card-front-text p`) and back
 * (`.card-back-text p`) text are already present in the DOM simultaneously
 * for the current AND a preloaded neighboring card, confirmed by reading
 * them WITHOUT ever clicking "See answer". A "See answer" button does
 * exist but is purely a visual flip; clicking it was live-confirmed to be
 * flaky (actionability timeouts) and is unnecessary, so it's not used.
 * `div.card-index-indicator span` holds the "N / total" position counter.
 *
 * **The carousel keeps two of everything mounted, and `.first()` is NOT
 * reliably the visible one** — live-confirmed by dumping both matches'
 * `offsetParent`/bounding-rect with the deck sitting at true position
 * 1/50: the FIRST-in-DOM-order `card-index-indicator`/`card-front-text`/
 * `card-back-text` was the PRELOADED NEXT card (position 2) with
 * `offsetParent === null` (not in layout flow), while the true visible
 * position-1 content was the SECOND match. This produced a very specific,
 * initially confusing bug: every capture's counter and content were
 * self-consistently shifted by the same one-position bias (so 49 of 50
 * cards still came out correct — the "next" card gets pre-read once while
 * position N-1 is current, then that same real data is skipped when
 * position N is later reached for real, since it was already captured),
 * but the TRUE FIRST card (position 1, which has no earlier position to
 * be pre-read from) was always the one silently missed. And walking off
 * the LAST card produced a duplicate for the same reason in reverse: at
 * true position 49, the preloaded "next" (position 50) got captured
 * early, so the later real visit to true position 50 re-read the same
 * content the walk had already recorded — reading like the deck was
 * generated with a genuine duplicate, until this was found. The fix
 * (`readCounter`/`readCurrentCard` below): pick the element whose
 * `offsetParent !== null` (in layout, i.e. actually visible), not `.first()`.
 */

import type { Page, Frame } from "patchright";
import { Selectors } from "./selectors.js";
import {
  registerStudioStrategy,
  triggerViaDialog,
  openStructuredViewer,
  getSandboxFrame,
} from "./studio-outputs.js";

const TRIGGER_SELECTORS = Selectors.studio.flashcardsButton;
const READY_SELECTORS = Selectors.studio.flashcardsTile;

async function triggerFlashcards(page: Page): Promise<void> {
  await triggerViaDialog(page, TRIGGER_SELECTORS, "Flashcards entry");
}

export interface Flashcard {
  front: string;
  back: string;
}

export interface FlashcardsResult {
  cards: Flashcard[];
  /** Positions (1-indexed) that were never captured, e.g. if a "Next"
   * click advanced by more than one position — an honest signal of a
   * partial read, never silently dropped or duplicated in their place. */
  missingPositions?: number[];
}

const COUNTER_SELECTOR = "div.card-index-indicator span";

/**
 * Reads the text of whichever matching element is actually laid out
 * (`offsetParent !== null`), not simply the first in DOM order — the
 * carousel keeps a preloaded neighboring card's elements mounted
 * alongside the visible one (see module header). Falls back to the first
 * match if none report as laid out (shouldn't happen once attached, but
 * safer than returning nothing).
 */
async function readVisibleText(frame: Frame, selector: string): Promise<string> {
  return frame.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll(sel));
    const visible = els.find((el) => (el as HTMLElement).offsetParent !== null);
    return (visible ?? els[0])?.textContent?.trim() ?? "";
  }, selector);
}

async function readCounter(frame: Frame): Promise<{ current: number; total: number } | null> {
  const text = await readVisibleText(frame, COUNTER_SELECTOR);
  const m = text.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
}

async function readCurrentCard(frame: Frame): Promise<Flashcard> {
  const front = await readVisibleText(frame, ".card-front-text p");
  const back = await readVisibleText(frame, ".card-back-text p");
  return { front, back };
}

async function extractFlashcards(page: Page): Promise<FlashcardsResult> {
  await openStructuredViewer(page, READY_SELECTORS);
  const frame = await getSandboxFrame(page);
  // `state: "visible"` on `.first()` was live-confirmed to time out
  // deterministically, not flakily — `.first()` picks the preloaded
  // neighbor's (hidden) counter, per the module header, which by
  // definition never becomes visible. `"attached"` here only needs to
  // confirm the widget rendered at all; `readCounter` (used below) is what
  // correctly picks the visible one.
  await frame.locator(COUNTER_SELECTOR).first().waitFor({ state: "attached", timeout: 15_000 });

  const initial = await readCounter(frame);
  if (!initial) {
    // The counter element is confirmed attached above, so its text not
    // matching "N / total" would be a genuinely unexpected state — throw
    // rather than return an empty-but-valid result indistinguishable from
    // "this deck genuinely has zero cards."
    throw new Error(
      'Flashcards counter element was attached but its text didn\'t match the expected "N / total" format.'
    );
  }

  // The viewer can open on whatever card was last viewed (persists across
  // opens), not necessarily card 1 — back up to card 1 first so the walk
  // below is a clean, complete pass, bounded by `total` so a stuck
  // "Previous card" can't loop forever.
  //
  // Selected by `aria-label` rather than a class (unlike Quiz's
  // `button.next-btn`/`button.back-btn`) — confirmed live: Flashcards'
  // Previous/Next buttons only carry generic Material Design classes, no
  // stable semantic one, so `aria-label` is the only reliable selector
  // available for this particular widget. In a non-English locale this
  // would fail the walk almost entirely, but honestly — every position
  // would come back in `missingPositions`, not silently wrong.
  const prevBtn = frame.locator('button[aria-label="Previous card"]').first();
  for (let i = 0; i < initial.total; i++) {
    const pos = await readCounter(frame);
    if (!pos || pos.current <= 1) break;
    await prevBtn.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }

  // Capture keyed by the OBSERVED counter position rather than an assumed
  // loop index — defends against a "Next" click ever advancing by more
  // than one position (not observed, but cheap to make robust against)
  // and against the specific preloaded-neighbor bug documented in the
  // module header: even after the `readVisibleText` fix, keying by
  // position rather than trusting loop-index bookkeeping means any future
  // one-off misread just leaves an honest gap in `missingPositions`
  // instead of silently duplicating neighboring content into it.
  const total = initial.total;
  const byPosition = new Map<number, Flashcard>();
  const nextBtn = frame.locator('button[aria-label="Next card"]').first();
  for (let guard = 0; guard < total * 2 && byPosition.size < total; guard++) {
    const pos = await readCounter(frame);
    if (!pos) break;
    if (!byPosition.has(pos.current)) byPosition.set(pos.current, await readCurrentCard(frame));
    if (pos.current >= total) break;
    await nextBtn.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }

  const cards: Flashcard[] = [];
  const missingPositions: number[] = [];
  for (let p = 1; p <= total; p++) {
    const c = byPosition.get(p);
    if (c) cards.push(c);
    else missingPositions.push(p);
  }
  return missingPositions.length > 0 ? { cards, missingPositions } : { cards };
}

registerStudioStrategy("flashcards", {
  kind: "structured",
  triggerSelectors: TRIGGER_SELECTORS,
  // No in-progress DOM/text was observed live this session (mirrors the
  // same empty-array convention used by video-overview.ts/slides.ts).
  inProgressPhrases: [],
  readySelectors: READY_SELECTORS,
  trigger: triggerFlashcards,
  extractContent: extractFlashcards,
});
