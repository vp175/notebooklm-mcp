/**
 * Quiz strategy, registered into the Studio-output engine
 * (studio-outputs.ts). Structured-kind — no file download; content is
 * extracted via `extractContent()`.
 *
 * TRIGGER FLOW — live-confirmed 2026-08-23: clicking the `quiz` trigger
 * tile opens a "Customize Quiz" dialog (Sources, a topic-prompt field,
 * Number-of-questions and Level-of-Difficulty fields) with a working
 * "Generate" button. Uses the shared `triggerViaDialog` helper
 * (studio-outputs.ts), which leaves those fields at their defaults.
 *
 * VIEWER — live-confirmed 2026-08-23 against a real, freshly-generated
 * Quiz artifact (10 questions): renders inside the same cross-origin
 * sandboxed iframe pattern as Mind Map/Flashcards. One question is shown
 * per page: `div.question-counter span` holds the "N / total" position
 * counter, `h1.question-text` the question, and each option is a
 * `button.answer-btn` whose `aria-label` is "<Letter>. <option text>" —
 * read directly rather than clicking, since clicking would record an
 * answer server-side (a side effect this extraction has no business
 * causing). "Next"/`button.next-btn` advances; "Previous"/`button.back-btn`
 * only exists once past question 1 (absent on the first question, so it's
 * used defensively rather than assumed present).
 */

import type { Page, Frame } from "patchright";
import { Selectors } from "./selectors.js";
import {
  registerStudioStrategy,
  triggerViaDialog,
  openStructuredViewer,
  getSandboxFrame,
} from "./studio-outputs.js";
import type { StudioTriggerOptions, StudioTriggerOutcome } from "./studio-outputs.js";

const TRIGGER_SELECTORS = Selectors.studio.quizButton;
const READY_SELECTORS = Selectors.studio.quizTile;

// `opts` must be declared and forwarded: the engine calls
// `strategy.trigger(page, { customPrompt })`, and a trigger that takes only
// `page` silently discards it — generation then runs over the whole
// notebook while the tool reports success.
async function triggerQuiz(page: Page, opts: StudioTriggerOptions): Promise<StudioTriggerOutcome> {
  return triggerViaDialog(page, TRIGGER_SELECTORS, "Quiz entry", {
    customPrompt: opts.customPrompt,
  });
}

export interface QuizQuestion {
  question: string;
  options: string[];
}

export interface QuizResult {
  questions: QuizQuestion[];
  /** Positions (1-indexed) that were never captured, e.g. if a "Next"
   * click advanced by more than one position — an honest signal of a
   * partial read, never silently dropped or duplicated in their place. */
  missingPositions?: number[];
}

const COUNTER_SELECTOR = "div.question-counter span";

async function readCounter(frame: Frame): Promise<{ current: number; total: number } | null> {
  const text = await frame.locator(COUNTER_SELECTOR).first().textContent();
  const m = text?.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
}

async function readCurrentQuestion(frame: Frame): Promise<QuizQuestion> {
  const question =
    (await frame
      .locator("h1.question-text")
      .first()
      .textContent()
      .catch(() => "")) || "";
  const options = await frame
    .locator("button.answer-btn")
    .evaluateAll((buttons) =>
      buttons.map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim())
    );
  return { question: question.trim(), options };
}

async function extractQuiz(page: Page): Promise<QuizResult> {
  await openStructuredViewer(page, READY_SELECTORS);
  const frame = await getSandboxFrame(page);
  // "attached" rather than "visible" — one page per question, no carousel
  // preloading (unlike Flashcards/Mind Map, see their modules), but kept
  // consistent with the rest of this codebase's structured-kind viewers.
  await frame.locator(COUNTER_SELECTOR).first().waitFor({ state: "attached", timeout: 15_000 });

  const initial = await readCounter(frame);
  if (!initial) {
    // The counter element is confirmed attached above, so its text not
    // matching "N / total" would be a genuinely unexpected state — throw
    // rather than return an empty-but-valid result indistinguishable from
    // "this quiz genuinely has zero questions."
    throw new Error(
      'Quiz counter element was attached but its text didn\'t match the expected "N / total" format.'
    );
  }

  // Back up to question 1 first, in case the viewer opened mid-quiz from a
  // prior session — bounded by `total` so a stuck "Previous" can't loop
  // forever.
  const prevBtn = frame.locator("button.back-btn").first();
  for (let i = 0; i < initial.total; i++) {
    const pos = await readCounter(frame);
    if (!pos || pos.current <= 1) break;
    await prevBtn.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }

  // Capture keyed by the OBSERVED counter position rather than an assumed
  // loop index — defends against a "Next" click ever advancing by more
  // than one position; see the equivalent (live-confirmed) comment in
  // flashcards.ts for why this matters even when nothing has gone wrong
  // yet: a skip just leaves an honest `missingPositions` gap instead of
  // silently duplicating neighboring content into it.
  const total = initial.total;
  const byPosition = new Map<number, QuizQuestion>();
  const nextBtn = frame.locator("button.next-btn").first();
  for (let guard = 0; guard < total * 2 && byPosition.size < total; guard++) {
    const pos = await readCounter(frame);
    if (!pos) break;
    if (!byPosition.has(pos.current)) byPosition.set(pos.current, await readCurrentQuestion(frame));
    if (pos.current >= total) break;
    await nextBtn.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }

  const questions: QuizQuestion[] = [];
  const missingPositions: number[] = [];
  for (let p = 1; p <= total; p++) {
    const q = byPosition.get(p);
    if (q) questions.push(q);
    else missingPositions.push(p);
  }
  return missingPositions.length > 0 ? { questions, missingPositions } : { questions };
}

// Kind ("structured") comes from STRUCTURED_KIND_TYPES via `studioKindOf`
// in the engine, not from this object — see studio-outputs.ts.
registerStudioStrategy("quiz", {
  triggerSelectors: TRIGGER_SELECTORS,
  // No in-progress DOM/text was observed live this session (mirrors the
  // same empty-array convention used by video-overview.ts/slides.ts). An
  // empty list means the engine has no DOM signal for this type at all —
  // repeat-call protection comes from its in-flight record instead.
  inProgressPhrases: [],
  readySelectors: READY_SELECTORS,
  trigger: triggerQuiz,
  extractContent: extractQuiz,
});
