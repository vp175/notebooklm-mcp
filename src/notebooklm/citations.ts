/**
 * Citation extraction for NotebookLM answers (issue #20).
 *
 * NotebookLM renders citation markers like `[1]`, `[2]` inside the answer and
 * — in a separate panel — the cited passage from the source document. v1
 * required the LLM to spell those out manually, which wasted tokens and was
 * unreliable. v2 reads the citations directly from the DOM after the answer
 * settles.
 *
 * Approach:
 *   1. Poll for the citation-marker buttons inside the *latest* answer
 *      container (so previous answers in the same session don't bleed in).
 *      Markers mount a beat AFTER the answer text settles, so a single read
 *      taken the moment the text stabilises finds nothing and the tool
 *      silently reports "no sources" for an answer that plainly has them.
 *   2. For each marker, click it to open the source panel, wait until the
 *      highlighted passage is demonstrably *this* citation's (a freshly
 *      rendered highlight, or text that differs from the one just read),
 *      then press Escape so the chat input stays usable for follow-ups.
 *   3. Return structured `Citation[]` and a formatted variant of the answer
 *      according to the requested `SourceFormat`.
 *
 * All NotebookLM-facing CSS lives in the central selector registry, so a
 * single UI change cannot break both this module and chat extraction.
 *
 * Everything here is bounded — this runs against a live remote UI and must
 * never stall the answer pipeline — and nothing throws out of
 * `extractCitations`: a citation failure degrades to "no excerpt", never to a
 * failed question.
 */

import type { Page } from "patchright";
import { Selectors } from "./selectors.js";
import { safeSleep } from "../browser/watchdog.js";

/**
 * Selector registry lookups.
 *
 * WHY: `button.citation-marker`, the answer container and `.highlighted` used
 * to be string literals embedded in the `page.evaluate` templates while the
 * registry already held them — a UI change then had to be fixed in two
 * places. The marker list is read defensively under both the historical
 * (`citations.button`) and the newer (`citations.markers`) registry key, so a
 * rename inside selectors.ts (owned elsewhere) cannot silently break citation
 * extraction or fail the build.
 */
const citationRegistry = Selectors.citations as unknown as {
  button?: readonly string[];
  markers?: readonly string[];
  label?: string;
  highlight?: string;
  paragraph?: string;
};

const MARKER_SELECTORS: readonly string[] = citationRegistry.markers ??
  citationRegistry.button ?? ["button.citation-marker"];
const ANSWER_SCOPE_SELECTOR: string = Selectors.chat.answerText;
const LABEL_SELECTOR: string = citationRegistry.label ?? "span[aria-label]";
const HIGHLIGHT_SELECTOR: string = citationRegistry.highlight ?? ".highlighted";
const PARAGRAPH_SELECTOR: string = citationRegistry.paragraph ?? ".paragraph";

/** Marker mount can lag the answer text; poll cadence and total ceiling. */
const MARKER_POLL_MS = 250;
const MARKER_WAIT_MS = 4_000;
/** Per-citation excerpt cap, and the batch ceiling across all citations. */
const EXCERPT_POLL_MS = 150;
const EXCERPT_TIMEOUT_MS = 1_800;
const EXCERPT_TOTAL_BUDGET_MS = 15_000;
/** Hard ceiling on any single `page.evaluate`, so a wedged renderer can't hang us. */
const EVAL_BUDGET_MS = 2_000;

/**
 * Attribute stamped on every `.highlighted` node visible at click time. A node
 * that still carries it is the *previous* citation's passage; an untagged node
 * is a fresh render. Purely advisory markup — it changes nothing the page
 * renders — and it is what makes "this excerpt belongs to this citation"
 * decidable without trusting a timer.
 */
const STALE_ATTR = "data-nlm-stale";

export type SourceFormat = "none" | "inline" | "footnotes" | "json";

export interface Citation {
  marker: string; // e.g. "[1]"
  number: number;
  sourceName: string;
  sourceText: string; // best-effort excerpt; falls back to sourceName
}

export interface ExtractCitationsResult {
  citations: Citation[];
  formattedAnswer: string;
  /**
   * Set when citations were requested but none could be found, so the caller
   * can tell "this answer had no citations" apart from "extraction silently
   * dropped them". Absent whenever citations were found or not requested.
   */
  note?: string;
}

export async function extractCitations(
  page: Page,
  answerText: string,
  format: SourceFormat = "none"
): Promise<ExtractCitationsResult> {
  if (format === "none") {
    return { citations: [], formattedAnswer: answerText };
  }

  // Citation markers are rendered a beat AFTER the answer text settles, so
  // the original single read reported "no sources" for answers that had
  // dozens (live-verified: 93 markers present seconds after a read returned
  // zero). Poll, bounded, until the count is non-zero and has stopped growing.
  const rawCitations = await readCitationStubsWithWait(page);
  if (rawCitations.length === 0) {
    return {
      citations: [],
      formattedAnswer: answerText,
      note: "no citation markers were present in this answer",
    };
  }

  // Excerpt extraction must run sequentially: each click opens the source
  // panel for the *currently active* citation; doing them in parallel races
  // the same DOM region.
  //
  // Seed the "previously seen" passage from whatever the panel is showing
  // right now — a panel left open by an earlier turn would otherwise be read
  // as citation #1's excerpt, which is the very misattribution being fixed.
  let previousExcerpt = await readHighlightText(page, false);
  const batchDeadline = Date.now() + EXCERPT_TOTAL_BUDGET_MS;

  const citations: Citation[] = [];
  for (const stub of rawCitations) {
    // Batch ceiling: with dozens of markers, per-citation caps alone could
    // add minutes to a question. Past the budget we keep the citation but
    // skip its excerpt (sourceName still goes through).
    const sourceText =
      Date.now() < batchDeadline ? await extractExcerpt(page, stub.number, previousExcerpt) : "";
    if (sourceText) previousExcerpt = sourceText;
    citations.push({
      marker: `[${stub.number}]`,
      number: stub.number,
      sourceName: stub.sourceName,
      sourceText: sourceText || stub.sourceName,
    });
  }

  // Best-effort: dismiss any source panel still open and refocus the chat
  // input so the next question can be typed without an extra click.
  await page.keyboard.press("Escape").catch(() => undefined);
  await safeSleep(page, 100);

  return {
    citations,
    formattedAnswer: formatAnswer(answerText, citations, format),
  };
}

interface CitationStub {
  number: number;
  sourceName: string;
}

/**
 * JS prelude shared by the marker-reading and marker-clicking evaluates:
 * resolves the latest answer container, then the marker buttons inside it by
 * trying each registry candidate in order — first candidate with a match
 * wins. Candidates that aren't valid CSS in the browser (a Playwright-only
 * pseudo-class, say) are skipped rather than aborting the read.
 */
const MARKER_LOOKUP_JS = `
  const answerScope = (() => {
    const containers = document.querySelectorAll(${JSON.stringify(ANSWER_SCOPE_SELECTOR)});
    return containers.length > 0 ? containers[containers.length - 1] : document;
  })();
  const markerButtons = (() => {
    const candidates = ${JSON.stringify(MARKER_SELECTORS)};
    for (const sel of candidates) {
      try {
        const found = answerScope.querySelectorAll(sel);
        if (found.length > 0) return Array.from(found);
      } catch (err) {
        /* candidate isn't valid CSS here — try the next one */
      }
    }
    return [];
  })();
`;

/**
 * Poll for citation markers until the count is greater than zero and has
 * stopped growing across two consecutive reads, or the ceiling expires.
 * An answer genuinely without citations pays the full wait — that is the
 * price of not reporting "no sources" for an answer that has them.
 */
async function readCitationStubsWithWait(page: Page): Promise<CitationStub[]> {
  const deadline = Date.now() + MARKER_WAIT_MS;
  let best: CitationStub[] = [];
  let previousCount = -1;

  while (Date.now() < deadline) {
    const stubs = await readCitationStubs(page);
    if (stubs.length > 0) {
      best = stubs;
      if (stubs.length === previousCount) return best;
    }
    previousCount = stubs.length;
    await safeSleep(page, MARKER_POLL_MS);
  }

  return best;
}

async function readCitationStubs(page: Page): Promise<CitationStub[]> {
  const stubs = await evaluateBounded<CitationStub[]>(
    page,
    `
      (() => {
        ${MARKER_LOOKUP_JS}
        const seen = new Set();
        const out = [];
        markerButtons.forEach((btn) => {
          const text = btn.textContent || '';
          const match = text.match(/(\\d+)/);
          if (!match) return;
          const num = parseInt(match[1], 10);
          if (seen.has(num)) return;
          seen.add(num);
          const span = btn.querySelector(${JSON.stringify(LABEL_SELECTOR)});
          let sourceName = '';
          if (span) {
            const label = span.getAttribute('aria-label') || '';
            const colon = label.indexOf(': ');
            sourceName = colon > 0 ? label.slice(colon + 2).trim() : label.trim();
          }
          out.push({ number: num, sourceName });
        });
        return out.sort((a, b) => a.number - b.number);
      })()
    `,
    EVAL_BUDGET_MS,
    []
  );
  return Array.isArray(stubs) ? stubs : [];
}

interface HighlightRead {
  text: string;
  fresh: boolean;
}

/**
 * Read the currently highlighted passage.
 *
 * `preferFresh` restricts the read to highlight nodes that were NOT on screen
 * when the marker was clicked; when nothing fresh exists it falls back to all
 * highlights and reports `fresh: false`, leaving the caller to decide via a
 * text comparison whether the panel has actually switched.
 */
async function readHighlightText(page: Page, preferFresh: boolean): Promise<string> {
  const read = await readHighlight(page, preferFresh);
  return read.text;
}

async function readHighlight(page: Page, preferFresh: boolean): Promise<HighlightRead> {
  const empty: HighlightRead = { text: "", fresh: false };
  const result = await evaluateBounded<HighlightRead>(
    page,
    `
      (() => {
        const all = Array.from(document.querySelectorAll(${JSON.stringify(HIGHLIGHT_SELECTOR)}));
        if (all.length === 0) return { text: '', fresh: false };
        const fresh = all.filter((el) => !el.hasAttribute(${JSON.stringify(STALE_ATTR)}));
        const use = ${preferFresh ? "(fresh.length > 0 ? fresh : all)" : "all"};
        const texts = use
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean);
        if (texts.length === 0) return { text: '', fresh: false };
        const parent =
          use[0].closest(${JSON.stringify(PARAGRAPH_SELECTOR)}) || use[0].parentElement;
        const pText = (parent && parent.innerText ? parent.innerText : '').trim();
        const hText = texts.join(' ');
        return {
          text: pText.length > hText.length ? pText : hText,
          fresh: ${preferFresh ? "fresh.length > 0" : "false"},
        };
      })()
    `,
    EVAL_BUDGET_MS,
    empty
  );
  return result && typeof result.text === "string" ? result : empty;
}

/**
 * Click one citation marker and read *its* excerpt.
 *
 * WHY the wait: the old code clicked, then immediately read a global
 * `.highlighted`, so a panel still showing the PREVIOUS citation was returned
 * as this one's excerpt. We now tag the highlights visible at click time, and
 * accept a read only once it is demonstrably this citation's — a freshly
 * rendered (untagged) highlight, or text that differs from the passage just
 * read. On timeout we return "" rather than a stale value; the caller falls
 * back to the source name.
 */
async function extractExcerpt(
  page: Page,
  number: number,
  previousExcerpt: string
): Promise<string> {
  try {
    const clicked = await evaluateBounded<boolean>(
      page,
      `
      (() => {
        ${MARKER_LOOKUP_JS}
        // Stamp what the panel is showing *now*, so a panel that never
        // switches is recognisable as stale instead of read as this
        // citation's passage.
        document
          .querySelectorAll(${JSON.stringify(HIGHLIGHT_SELECTOR)})
          .forEach((el) => el.setAttribute(${JSON.stringify(STALE_ATTR)}, '1'));
        for (const btn of markerButtons) {
          const text = btn.textContent || '';
          const match = text.match(/(\\d+)/);
          if (match && parseInt(match[1], 10) === ${number}) {
            btn.scrollIntoView({ block: 'center' });
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `,
      EVAL_BUDGET_MS,
      false
    );
    if (!clicked) return "";

    // Tight cap: a slow source panel must not stall the answer pipeline. The
    // remaining slow cases just lose the excerpt (sourceName still goes
    // through) — never a wrong excerpt.
    const deadline = Date.now() + EXCERPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const read = await readHighlight(page, true);
      if (read.text && (read.fresh || read.text !== previousExcerpt)) {
        await page.keyboard.press("Escape").catch(() => undefined);
        return read.text;
      }
      await safeSleep(page, EXCERPT_POLL_MS);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    return "";
  } catch {
    return "";
  }
}

/**
 * `page.evaluate` has no timeout of its own and can hang forever on a wedged
 * renderer. Race every evaluate against a hard budget and fall back to a
 * caller-supplied value, so no loop in this module can outlive its deadline.
 */
async function evaluateBounded<T>(
  page: Page,
  script: string,
  budgetMs: number,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const evaluation = Promise.resolve(page.evaluate(script)).catch(() => undefined);
    const guard = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), budgetMs);
    });
    const result = await Promise.race([evaluation, guard]);
    return result === undefined || result === null ? fallback : (result as T);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatAnswer(answer: string, citations: Citation[], format: SourceFormat): string {
  if (format === "none" || citations.length === 0) return answer;

  switch (format) {
    case "json": {
      // Caller usually returns the structured `citations` field; the answer
      // string itself is left untouched here.
      return answer;
    }
    case "inline": {
      let out = answer;
      for (const c of citations) {
        const replacement = c.sourceText
          ? `${c.marker} (${c.sourceName}: "${truncate(c.sourceText, 200)}")`
          : `${c.marker} (${c.sourceName})`;
        out = out.split(c.marker).join(replacement);
      }
      return out;
    }
    case "footnotes":
    default: {
      const footnotes = citations
        .map(
          (c) =>
            `${c.marker} ${c.sourceName}${c.sourceText && c.sourceText !== c.sourceName ? ` — "${truncate(c.sourceText, 240)}"` : ""}`
        )
        .join("\n");
      return `${answer}\n\nSources:\n${footnotes}`;
    }
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
