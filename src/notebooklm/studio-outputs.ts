/**
 * Generic Studio-output engine (trigger / poll / download-or-extract) driving
 * a strategy registry, one entry per NotebookLM Studio output type. Built to
 * replace what would otherwise be 9 near-duplicate modules of the shape
 * `audio.ts` already has. Every strategy's tile lookups must be scoped to
 * that specific output type — never "the first/any artifact tile" — because
 * multiple output types can coexist in the same notebook once more than one
 * is wrapped.
 *
 * 8 of the 9 `StudioOutputType` values are registered today (audio, video,
 * infographic, slides as file kinds; mindmap, datatable, quiz, flashcards as
 * structured kinds). `report` is deliberately unregistered — its Studio menu
 * offers "Export to Docs"/"Export to Sheets" rather than a file download or
 * an in-page viewer, so it fits neither kind; `getStrategy()` throws a clear
 * "not yet implemented" error for it rather than failing confusingly deeper
 * in the DOM layer.
 *
 * SESSION HYGIENE (added 2026-08-23 after a live failure cascade): a
 * structured-content viewer left open by an earlier call poisons every
 * later Studio call in the same session — it covers the Studio panel, so
 * ready-tile lookups fail ("No completed <type> output found"), status
 * probes degrade to `not_started`, `generate_studio_output` can no longer
 * find its own trigger tile, and Data Table's extraction aborts on "Found 2
 * <table> elements". Every public entry point below therefore starts with
 * `preflightCloseViewer`, and `getStudioOutputContent` closes the viewer in
 * a `finally` so the error path cannot leak one either.
 */
import type { Page, Locator, Frame } from "patchright";
import path from "path";
import fs from "fs/promises";
import { safeSleep, isRecoverable } from "../browser/watchdog.js";
import { log } from "../utils/logger.js";
import { joinAlt, Selectors } from "./selectors.js";
import type {
  AudioStatus,
  AudioGenerationResult,
  DownloadAudioResult,
  GenerateAudioOptions,
} from "./audio.js";

export type StudioOutputType =
  | "audio"
  | "video"
  | "report"
  | "slides"
  | "infographic"
  | "mindmap"
  | "datatable"
  | "quiz"
  | "flashcards";

/**
 * Every Studio output type the schema accepts, in a stable order.
 *
 * Exported so the tool definitions can advertise exactly this list instead of
 * hand-rolling their own copy — the two drifted apart before, leaving the
 * published enum out of step with what the engine could actually serve.
 */
export const ALL_STUDIO_TYPES: readonly StudioOutputType[] = [
  "audio",
  "video",
  "report",
  "slides",
  "infographic",
  "mindmap",
  "datatable",
  "quiz",
  "flashcards",
];

/**
 * Output types whose completed artifact is downloaded as a file via
 * `download_studio_output` / `downloadViaSingleMenuItem`.
 *
 * CORRECTED 2026-08-23: `report` was previously listed here and is not a
 * file kind — its three-dot menu offers "Export to Docs"/"Export to Sheets"
 * (creating a Google Doc/Sheet in the user's Drive), with no browser
 * download event at all. It is intentionally absent from BOTH lists below;
 * `studioKindOf("report")` returns `"unsupported"`, which is the honest
 * answer until a real export flow is built for it.
 *
 * These two constants are the single source of truth for kind: the engine
 * derives every kind decision from them via `studioKindOf` (strategies no
 * longer declare their own `kind`, so the two cannot drift apart).
 */
export const FILE_KIND_TYPES: readonly StudioOutputType[] = [
  "audio",
  "video",
  "slides",
  "infographic",
];
/** Output types read in-page as JSON via `get_studio_output_content`. */
export const STRUCTURED_KIND_TYPES: readonly StudioOutputType[] = [
  "mindmap",
  "datatable",
  "quiz",
  "flashcards",
];

export type StudioArtifactKind = "file" | "structured";

/**
 * Authoritative kind lookup, backed by the two exported constants above.
 * Returns `"unsupported"` for a type that belongs to neither list (today:
 * `report` only) so callers can say so plainly instead of guessing.
 */
export function studioKindOf(type: StudioOutputType): StudioArtifactKind | "unsupported" {
  if (FILE_KIND_TYPES.includes(type)) return "file";
  if (STRUCTURED_KIND_TYPES.includes(type)) return "structured";
  return "unsupported";
}

/** Default wait when a caller asks to block until an output is ready. */
export const DEFAULT_STUDIO_TIMEOUT_MS = 600_000;
/**
 * Hard ceiling for any caller-supplied timeout reaching this engine. Real
 * generations run ~7 minutes (live-measured for Audio); 30 minutes is
 * generous. Without this, `timeout_ms: 0` was passed straight into
 * `locator.waitFor({ timeout: 0 })`, which Playwright interprets as "no
 * timeout at all" — pinning the session forever.
 */
export const MAX_STUDIO_TIMEOUT_MS = 1_800_000;
/** Default ceiling for saving a single download to disk once it starts. */
export const DEFAULT_DOWNLOAD_SAVE_TIMEOUT_MS = 180_000;

/**
 * Normalises any caller-supplied timeout. `0`, negatives, `NaN`, `Infinity`
 * and non-numbers all mean "use the default" (0 in particular must NOT be
 * forwarded — Playwright reads it as "wait forever"); anything above `max`
 * is clamped down to it.
 */
export function clampTimeoutMs(
  raw: unknown,
  fallback: number = DEFAULT_STUDIO_TIMEOUT_MS,
  max: number = MAX_STUDIO_TIMEOUT_MS
): number {
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, max);
  return Math.min(n, max);
}

/**
 * Races `op` against a bounded timer WITHOUT ever leaving an unhandled
 * rejection behind: `op` is converted to a never-rejecting settled promise
 * first. This matters because index.ts installs a process-wide handler that
 * treats any unhandled rejection as fatal — a late-rejecting `saveAs` or
 * `click` must not be able to kill every other live session.
 */
async function withTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  const settled = op.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<{ ok: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: "timeout" }), ms);
  });
  try {
    const winner = await Promise.race([settled, guard]);
    if (winner.ok === "timeout") throw new Error(`${label} timed out after ${ms}ms`);
    if (winner.ok === false) throw winner.error;
    return winner.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `locator.isVisible({ timeout })` does NOT poll despite the option name —
 * it samples the current state and returns. This wrapper is the genuinely
 * waiting equivalent, returning a boolean instead of throwing.
 */
export async function waitForVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  return locator
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

/** Bounded wait for a locator to become hidden or detached. Never throws. */
async function waitForHidden(locator: Locator, timeoutMs: number): Promise<boolean> {
  return locator
    .waitFor({ state: "hidden", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

/** Options accepted by a strategy's `trigger`. */
export interface StudioTriggerOptions {
  /** Focus prompt typed into the Customize dialog before Generate. */
  customPrompt?: string;
  /**
   * NOTE — `difficulty` is deliberately ABSENT from this type. It is
   * accepted by the tool schema and by `generateStudioOutput`'s options,
   * but stops there (see the single ignore point in
   * `generateStudioOutput`): no verified selector exists in this codebase
   * for the Level-of-Difficulty control in the Flashcards/Quiz Customize
   * dialogs, and inventing one is not allowed. Keeping it out of this type
   * means no strategy can look plumbed for it when it is not.
   */
}

/** What a trigger reports back beyond "it ran". */
export interface StudioTriggerOutcome {
  /** Non-fatal problems worth surfacing to the caller (never thrown). */
  warnings?: string[];
}

export interface StudioOutputStrategy {
  /** Entry-button selector(s) in the Studio panel, following the Selectors.studio.* convention. */
  triggerSelectors: readonly string[];
  /**
   * Multilingual "generation in progress" phrase list. NOT scoped to this
   * type's tile/card in practice — `domSuggestsInProgress` below reads the
   * ENTIRE `.studio-panel` textContent, not a per-tile subset, so a
   * type-agnostic phrase here (e.g. "check back in a few minutes") matches
   * regardless of which output type is actually generating. See
   * `detectInProgress` for what this list can and cannot be trusted for.
   */
  inProgressPhrases: readonly string[];
  /**
   * Selector(s) identifying this type's completed tile. NOTE: array
   * position does NOT confer priority here. `isReady`/`waitUntilReady`
   * below consume this as a single comma-joined CSS OR selector
   * (`joinAlt(strategy.readySelectors)` + `.first()`) — `.first()` returns
   * whichever candidate matches first in DOM order, irrespective of which
   * array entry produced that match. Every registered type therefore
   * supplies ONLY genuinely tile-scoped candidates (`:has()` on its own
   * icon ligature, via `studioReadyTileSelectors` in selectors.ts); a
   * broad, type-agnostic entry added here would silently defeat tile
   * discrimination rather than merely rank below the narrow ones.
   * (Contrast with selector lists consumed via `clickFirstVisible` below,
   * which IS an ordered loop where position does matter.)
   */
  readySelectors: readonly string[];
  trigger(page: Page, opts: StudioTriggerOptions): Promise<void | StudioTriggerOutcome>;
  download?(page: Page, destDir: string): Promise<DownloadAudioResult>;
  extractContent?(page: Page): Promise<unknown>;
}

const STRATEGIES = new Map<StudioOutputType, StudioOutputStrategy>();

export function registerStudioStrategy(
  type: StudioOutputType,
  strategy: StudioOutputStrategy
): void {
  // Kind now comes from FILE_KIND_TYPES/STRUCTURED_KIND_TYPES, not from the
  // strategy object, so the two cannot drift. A registration for a type in
  // neither list would be unreachable through both `download_studio_output`
  // and `get_studio_output_content`; warn rather than throw, because
  // strategies register at module import and a throw here would take the
  // whole server down at startup.
  if (studioKindOf(type) === "unsupported") {
    log.warning(
      `Studio strategy "${type}" registered but is in neither FILE_KIND_TYPES nor ` +
        `STRUCTURED_KIND_TYPES — it will be unreachable from both tools until it is classified.`
    );
  }
  STRATEGIES.set(type, strategy);
}

function getStrategy(type: StudioOutputType): StudioOutputStrategy {
  const s = STRATEGIES.get(type);
  if (!s) {
    throw new Error(
      `Studio output type "${type}" is not yet implemented by this server. ` +
        `Implemented types: ${[...STRATEGIES.keys()].join(", ")}.`
    );
  }
  return s;
}

/**
 * Registry-membership check that does NOT need a `Page`. Lets callers (tool
 * handlers) reject an unimplemented `output_type` up front — before
 * `resolveNotebookUrl`/`getOrCreateSession` launch a browser — instead of
 * only discovering it via `getStrategy()` throwing deep inside a live
 * session. Without this, an unauthenticated/no-notebook call fails on
 * "Notebook URL is required" for EVERY type, implemented or not, making the
 * documented "not yet implemented" error unreachable in practice.
 */
export function isStudioTypeImplemented(type: StudioOutputType): boolean {
  return STRATEGIES.has(type);
}

/** Currently-registered Studio output types, for building the same error message pre-session. */
export function implementedStudioTypes(): StudioOutputType[] {
  return [...STRATEGIES.keys()];
}

/**
 * Ordered "first visible candidate wins" click. Position IS priority here.
 *
 * Two-phase on purpose: an instant ordered scan first (the overwhelmingly
 * common case — the primary selector is already there), then ONE bounded
 * combined wait on the OR-joined list for elements still animating in,
 * followed by a re-scan that restores ordered priority. Giving every
 * candidate its own polling wait would turn a 14-candidate miss into a
 * ~20s stall on the error path; this keeps the whole miss bounded by
 * `waitMs`.
 */
export async function clickFirstVisible(
  page: Page,
  selectors: readonly string[],
  label: string,
  waitMs = 3_000
): Promise<void> {
  const pickVisible = async (): Promise<Locator | null> => {
    for (const sel of selectors) {
      const candidate = page.locator(sel).first();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return null;
  };

  let target = await pickVisible();
  if (!target) {
    await waitForVisible(page.locator(joinAlt(selectors)).first(), waitMs);
    // Re-scan in declared order: the combined wait says SOMETHING appeared,
    // not which candidate, and priority must still follow this list's order.
    target = await pickVisible();
  }
  if (!target) {
    throw new Error(
      `Could not find ${label} — selectors: ${selectors.join(" | ")}. NotebookLM Studio UI may have changed.`
    );
  }
  await target.click();
  await safeSleep(page, 300);
}

/**
 * Closes a "Customize <Type>" dialog that is still open after the trigger
 * flow finished (success OR failure). Returns a warning string when the
 * dialog could not be closed, `null` when there was nothing to close or the
 * close succeeded. Never throws — this runs in a `finally`.
 *
 * Escape first: Material overlays close on Escape by default, and it is the
 * only locale-independent, selector-free option (no close-button selector
 * for this dialog has ever been live-verified in this repo). The
 * dialog-scoped `aria-label*="close"` button is the second attempt, scoped
 * inside `mat-dialog-container` so it cannot hit an unrelated close button
 * elsewhere on the page.
 */
async function closeLingeringDialog(page: Page, label: string): Promise<string | null> {
  try {
    const dialog = page.locator("mat-dialog-container").first();
    // Instant check — on the happy path Generate already closed it and we
    // must not add a poll to every successful trigger.
    if (!(await dialog.isVisible().catch(() => false))) return null;

    await withTimeout(page.keyboard.press("Escape"), 3_000, "dialog Escape").catch(() => undefined);
    if (await waitForHidden(dialog, 2_000)) return null;

    const closeBtn = page.locator('mat-dialog-container button[aria-label*="close" i]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await withTimeout(closeBtn.click({ timeout: 3_000 }), 5_000, "dialog close click").catch(
        () => undefined
      );
      if (await waitForHidden(dialog, 2_000)) return null;
    }
    return (
      `The "${label}" Customize dialog is still open after the trigger flow — its ` +
      `cdk-overlay backdrop will intercept clicks on the next Studio call in this session.`
    );
  } catch (err) {
    return `Could not verify that the "${label}" Customize dialog closed: ${err}`;
  }
}

/**
 * Shared trigger flow for Studio output types whose entry tile opens a
 * "Customize <Type>" confirm dialog rather than starting generation on the
 * bare click. CONFIRMED live 2026-08-23 for Audio Overview: clicking the
 * `audio_magic_eraser` tile opens a `mat-dialog-container` ("Customize
 * Audio Overview" — Format/Language/Length/Sources/focus-prompt fields)
 * behind a `cdk-overlay-backdrop`; clicking that dialog's "Generate" button
 * closes it (backdrop detaches) and starts real generation. This is the
 * root cause of an earlier same-session bug where triggering a second type
 * right after Audio failed — Audio's dialog was still open, and its
 * backdrop intercepted the next tile's click. The `finally` below now
 * closes a lingering dialog on the FAILURE path too, which is where that
 * bug could still be reintroduced (a failed "Generate" click left the
 * dialog open with nothing to clean it up).
 *
 * CONFIRMED live 2026-08-23 for Video Overview, Infographic, Slide Deck and
 * all four structured kinds too: each type's trigger tile opens its own
 * "Customize <Type>" dialog (different fields per type) with a working
 * "Generate" button. Only Report has not been individually checked —
 * deferred, since its export flow needs its own live observation anyway.
 *
 * If a future live check finds a type whose tile does NOT open a dialog
 * (bare click truly is enough), this helper still handles that correctly
 * — the `dialogVisible` check below no-ops when no dialog appears — but a
 * type whose dialog has a different confirm-button label needs that label
 * added to `Selectors.studio.generateButton`.
 */
export async function triggerViaDialog(
  page: Page,
  triggerSelectors: readonly string[],
  label: string,
  opts: StudioTriggerOptions = {}
): Promise<StudioTriggerOutcome> {
  const warnings: string[] = [];
  await clickFirstVisible(page, triggerSelectors, label);
  const dialog = page.locator("mat-dialog-container").first();
  // A Material dialog's mount + open animation can exceed the ~300ms gap
  // since the trigger click; `waitFor` performs a genuine, actively-polled
  // wait (unlike `isVisible({timeout})`, which does not poll at all).
  const dialogVisible = await waitForVisible(dialog, 5_000);
  if (!dialogVisible) return { warnings };

  try {
    if (opts.customPrompt) {
      const promptField = dialog.locator("textarea, input[type='text']").first();
      // Genuine wait, not `isVisible({timeout})`: the field can render a
      // beat after the dialog itself, and silently skipping the fill would
      // run generation over the whole notebook while reporting success.
      if (await waitForVisible(promptField, 1_500)) {
        await promptField.fill(opts.customPrompt);
        await safeSleep(page, 200);
      } else {
        warnings.push(
          `The "${label}" Customize dialog exposed no text field — custom_prompt was NOT applied; ` +
            `generation ran against the whole notebook.`
        );
      }
    }

    await clickFirstVisible(page, Selectors.studio.generateButton, "Generate button");
    await page
      .waitForSelector(".cdk-overlay-backdrop-showing", { state: "detached", timeout: 15_000 })
      .catch(() => undefined);
  } finally {
    // Close on EVERY path. A dialog left open (previously the outcome of
    // any failure here, and unverified on success) blocks every subsequent
    // Studio interaction in the session behind its backdrop.
    const closeWarning = await closeLingeringDialog(page, label);
    if (closeWarning) {
      log.warning(`  ⚠️  ${closeWarning}`);
      warnings.push(closeWarning);
    }
  }
  return { warnings };
}

/* ------------------------------------------------------------------ *
 * Structured-viewer lifecycle
 * ------------------------------------------------------------------ */

/**
 * Instant (non-polling on purpose — it runs at the top of every Studio
 * operation, and a leaked viewer is already fully rendered) test for "a
 * structured-content viewer is currently open".
 */
export async function viewerIsOpen(page: Page): Promise<boolean> {
  for (const sel of Selectors.studio.viewerOpenIndicator) {
    if (
      await page
        .locator(sel)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return true;
    }
  }
  return false;
}

/** Bounded poll until no viewer indicator is visible. Never throws. */
async function waitForViewerClosed(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await viewerIsOpen(page).catch(() => false))) return true;
    // `safeSleep`, not `page.waitForTimeout`: the latter returns instantly
    // on a zombie page and would busy-spin this loop (see watchdog.ts).
    await safeSleep(page, 200);
  }
  return !(await viewerIsOpen(page).catch(() => false));
}

/**
 * Closes an open structured-content viewer. Returns `true` when nothing was
 * open or the viewer verifiably went away, `false` otherwise. NEVER throws —
 * every caller runs it as cleanup, on paths that are already handling an
 * error of their own.
 *
 * Candidate order comes from `Selectors.studio.viewerCloseButton` (live DOM
 * recon 2026-08-23: exact `aria-label="Close web page viewer"`, then the
 * locale-independent `collapse_content` ligature, then a generic
 * `aria-label*="close"`), each attempt verified by re-checking that the
 * viewer indicators are gone, with `Escape` as the final selector-free
 * fallback.
 */
export async function closeStructuredViewer(page: Page): Promise<boolean> {
  try {
    if (!(await viewerIsOpen(page))) return true;

    for (const sel of Selectors.studio.viewerCloseButton) {
      const btn = page.locator(sel).first();
      if (!(await btn.isVisible().catch(() => false))) continue;
      await withTimeout(btn.click({ timeout: 3_000 }), 5_000, `viewer close click (${sel})`).catch(
        () => undefined
      );
      if (await waitForViewerClosed(page, 3_000)) return true;
    }

    await withTimeout(page.keyboard.press("Escape"), 3_000, "viewer Escape").catch(() => undefined);
    if (await waitForViewerClosed(page, 3_000)) return true;

    log.warning(
      "  ⚠️  A Studio content viewer still appears open after every close attempt " +
        "(close button candidates + Escape) — later Studio calls in this session may fail " +
        "with 'No completed output found' until the page is reloaded."
    );
    return false;
  } catch (err) {
    log.warning(`  ⚠️  Studio viewer cleanup failed (continuing anyway): ${err}`);
    return false;
  }
}

/**
 * Start-of-operation guard: a viewer leaked by an earlier crashed call
 * (before this engine closed viewers at all, or after a cleanup that could
 * not verify) must not be allowed to poison this one. Never throws.
 */
async function preflightCloseViewer(page: Page, operation: string): Promise<void> {
  try {
    if (!(await viewerIsOpen(page))) return;
    log.warning(
      `  ⚠️  A Studio content viewer was still open at the start of ${operation} — closing it first.`
    );
    await closeStructuredViewer(page);
  } catch {
    /* cleanup never throws into the caller */
  }
}

/* ------------------------------------------------------------------ *
 * Studio panel state
 * ------------------------------------------------------------------ */

export async function ensureStudioPanelExpanded(
  page: Page,
  anyTriggerSelectors: readonly string[]
): Promise<void> {
  // Genuine wait, not `isVisible({timeout})`: the Studio panel re-renders
  // its tiles asynchronously after navigation, and a non-polling check here
  // makes this function click "expand" on an already-expanded panel
  // (collapsing it) purely because the tiles had not painted yet.
  const cardVisible = await waitForVisible(page.locator(joinAlt(anyTriggerSelectors)).first(), 500);
  if (cardVisible) return;
  const expandSelectors = [
    'button:has(mat-icon:text-is("dock_to_left"))',
    'button[aria-label*="erweitern" i][aria-label*="studio" i]',
    'button[aria-label*="expand" i][aria-label*="studio" i]',
    'button[aria-label*="ouvrir" i][aria-label*="studio" i]',
    'button[aria-label*="abrir" i][aria-label*="studio" i]',
    'button[aria-label*="aprire" i][aria-label*="studio" i]',
  ];
  for (const sel of expandSelectors) {
    const btn = page.locator(sel).first();
    if (await waitForVisible(btn, 500)) {
      await btn.click().catch(() => undefined);
      await safeSleep(page, 400);
      return;
    }
  }
}

/**
 * Default budget for a repeat readiness poll — the page is already warm.
 */
const READY_POLL_MS = 500;

/**
 * Budget for the FIRST look on a page that may have just loaded.
 *
 * A session created for this very call finishes `init()` as soon as the chat
 * input exists, but the Studio panel paints its tiles later. Checking with the
 * poll-sized budget then reports `not_started` for an output that is plainly
 * there — live-observed: a mindmap read failed with "No completed mindmap
 * output found" 4 s after the session was created, and the identical call on
 * the same (now warm) session succeeded.
 */
const READY_COLD_MS = 8_000;

async function isReady(
  page: Page,
  strategy: StudioOutputStrategy,
  timeoutMs: number = READY_POLL_MS
): Promise<boolean> {
  // Genuine wait: the completed tile can still be painting when a status
  // poll lands, and a non-polling check reports `not_started` for a tile
  // that is milliseconds away from being there.
  return waitForVisible(page.locator(joinAlt(strategy.readySelectors)).first(), timeoutMs);
}

/**
 * Get the Studio panel into a state where its tiles can be seen, then take the
 * first readiness look with the cold-page budget. Every entry point that
 * decides "is there a completed output?" must go through this — reading the
 * panel without expanding it was why a status/content call on a fresh session
 * could answer `not_started` for an output that existed.
 */
async function readyOnColdPage(page: Page, strategy: StudioOutputStrategy): Promise<boolean> {
  await ensureStudioPanelExpanded(page, strategy.triggerSelectors);
  return isReady(page, strategy, READY_COLD_MS);
}

/* ------------------------------------------------------------------ *
 * In-flight generation tracking
 * ------------------------------------------------------------------ */

interface InFlightRecord {
  startedAt: number;
  /** Notebook URL at trigger time — a session's page can navigate. */
  notebookUrl: string;
}

/**
 * Generations THIS process triggered, per page. Keyed weakly so a closed
 * session's record is collected with its page.
 *
 * WHY this exists: the DOM-based in-progress check below is not reliable
 * (see `domSuggestsInProgress`), which made the in-progress guard in
 * `generateStudioOutput` structurally unreachable — a second
 * `generate_studio_output` call for a type already generating re-opened its
 * dialog and clicked Generate again, starting a genuine duplicate
 * generation. This record makes that specific, observed failure impossible.
 * Its limits, stated plainly: it only knows about generations started by
 * this server process on this page, so a generation started in the web UI,
 * in another process, or before a restart is invisible to it.
 */
const IN_FLIGHT = new WeakMap<Page, Map<StudioOutputType, InFlightRecord>>();
/** After this long with no ready tile, stop claiming a generation is in flight. */
const IN_FLIGHT_TTL_MS = 30 * 60_000;

function currentUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function noteTriggered(page: Page, type: StudioOutputType): void {
  let perType = IN_FLIGHT.get(page);
  if (!perType) {
    perType = new Map();
    IN_FLIGHT.set(page, perType);
  }
  perType.set(type, { startedAt: Date.now(), notebookUrl: currentUrl(page) });
}

function clearInFlight(page: Page, type: StudioOutputType): void {
  IN_FLIGHT.get(page)?.delete(type);
}

/** Elapsed ms since this process triggered `type` on this page, else null. */
function inFlightAgeMs(page: Page, type: StudioOutputType): number | null {
  const rec = IN_FLIGHT.get(page)?.get(type);
  if (!rec) return null;
  const age = Date.now() - rec.startedAt;
  if (age > IN_FLIGHT_TTL_MS) {
    clearInFlight(page, type);
    return null;
  }
  // The page may have been pointed at a different notebook since; a
  // generation running in notebook A says nothing about notebook B.
  if (rec.notebookUrl && rec.notebookUrl !== currentUrl(page)) return null;
  return age;
}

/**
 * Best-effort DOM signal that SOMETHING in the Studio panel is generating.
 *
 * HONEST LIMITS, live-observed 2026-08-23 and unchanged since:
 *   - During a real ~7-minute Audio Overview generation, a poll every 15s
 *     matched NONE of the `inProgressPhrases` (all locale lists were
 *     written against the 2026-05 UI) and none of the standard Material
 *     spinner selectors. So this function returning `false` is NOT evidence
 *     that nothing is generating.
 *   - It is also not type-scoped: the phrase match reads the whole
 *     `.studio-panel` text, so any type's in-progress text would match for
 *     every type.
 * Kept because a match is still meaningful (it can only be a false negative,
 * never a false positive that invents a generation), but the reliable signal
 * for repeat-call protection is `inFlightAgeMs` above.
 */
async function domSuggestsInProgress(page: Page, strategy: StudioOutputStrategy): Promise<boolean> {
  try {
    if (strategy.inProgressPhrases.length > 0) {
      const studioText = await page
        .locator(".studio-panel")
        .first()
        .textContent({ timeout: 500 })
        .catch(() => null);
      if (studioText) {
        const lower = studioText.toLowerCase();
        if (strategy.inProgressPhrases.some((p) => lower.includes(p))) return true;
      }
    }
    // ARIA/Material progress affordances inside the Studio panel. `[role=
    // "progressbar"]` is a standard ARIA role rather than a guessed
    // Google-specific class; the Material ones mirror it. Scoped to
    // `.studio-panel` so a chat-side spinner cannot trigger it. This
    // matched zero elements throughout the one observed live generation —
    // it is a cheap extra chance, not a dependable signal.
    const spinner = page
      .locator(
        '.studio-panel [role="progressbar"], .studio-panel mat-progress-bar, ' +
          ".studio-panel mat-spinner, .studio-panel .mat-mdc-progress-spinner"
      )
      .first();
    return await spinner.isVisible().catch(() => false);
  } catch {
    return false;
  }
}

interface InProgressVerdict {
  inProgress: boolean;
  reason?: string;
}

/**
 * Bounded in-flight check combining the reliable signal (a generation this
 * process started, still without a ready tile) with the best-effort DOM
 * signal. Never throws.
 */
async function detectInProgress(
  page: Page,
  strategy: StudioOutputStrategy,
  type: StudioOutputType
): Promise<InProgressVerdict> {
  const age = inFlightAgeMs(page, type);
  if (age !== null) {
    return {
      inProgress: true,
      reason: `this server triggered it ${Math.round(age / 1000)}s ago and no completed tile has appeared yet`,
    };
  }
  if (await domSuggestsInProgress(page, strategy)) {
    return {
      inProgress: true,
      reason: "the Studio panel is showing a generation-in-progress indicator",
    };
  }
  return { inProgress: false };
}

/* ------------------------------------------------------------------ *
 * Public engine API
 * ------------------------------------------------------------------ */

function withWarnings(
  result: AudioGenerationResult,
  warnings: string[]
): AudioGenerationResult & { warnings?: string[] } {
  return warnings.length > 0 ? { ...result, warnings } : result;
}

export async function generateStudioOutput(
  page: Page,
  type: StudioOutputType,
  options: GenerateAudioOptions & { difficulty?: string } = {}
): Promise<AudioGenerationResult> {
  const strategy = getStrategy(type);
  const { waitForCompletion = false } = options;
  // `timeout_ms: 0` previously reached `waitFor({timeout: 0})`, which
  // Playwright reads as "no timeout" — an unbounded wait pinning the
  // session forever. Every caller-supplied timeout is clamped here.
  const timeoutMs = clampTimeoutMs(options.timeoutMs);
  const warnings: string[] = [];

  // ── THE ONE PLACE `difficulty` IS HANDLED ────────────────────────────
  // It is accepted by the tool schema and by this function's options (both
  // owned by other files) but is NOT wired into NotebookLM's Customize
  // dialog: no selector for the Level-of-Difficulty control in the
  // Flashcards/Quiz dialogs has ever been live-verified in this repo, and
  // inventing one is not allowed. Rather than let it look plumbed, it stops
  // here — and says so in the result instead of being silently dropped.
  if (options.difficulty !== undefined) {
    warnings.push(
      "`difficulty` is accepted but NOT wired into the Customize dialog — generation used the " +
        "dialog's default difficulty. (No verified selector exists for that control.)"
    );
  }

  try {
    await preflightCloseViewer(page, `generate_studio_output("${type}")`);
    if (await readyOnColdPage(page, strategy)) {
      clearInFlight(page, type);
      log.info(`  ✅ Studio output "${type}" already generated, skipping trigger`);
      return withWarnings({ status: "ready", alreadyExisted: true }, warnings);
    }
    const progress = await detectInProgress(page, strategy, type);
    if (progress.inProgress) {
      log.info(`  ⏳ Studio output "${type}" generation already running (${progress.reason})`);
      if (waitForCompletion) {
        return withWarnings(await waitUntilReady(page, strategy, type, timeoutMs), warnings);
      }
      return withWarnings(
        {
          status: "in_progress",
          message:
            `Generation for "${type}" is already running (${progress.reason}) — not triggering a ` +
            `second one. Poll get_studio_output_status.`,
        },
        warnings
      );
    }
    await ensureStudioPanelExpanded(page, strategy.triggerSelectors);
    // `difficulty` deliberately not forwarded — see the ignore point above.
    const outcome = await strategy.trigger(page, { customPrompt: options.customPrompt });
    // Record only AFTER the trigger resolves: a trigger that threw did not
    // start anything, and claiming otherwise would block a legitimate retry.
    noteTriggered(page, type);
    if (outcome && outcome.warnings) warnings.push(...outcome.warnings);
    log.info(`  🎬 Studio output "${type}" generation triggered`);
    if (!waitForCompletion) {
      return withWarnings(
        {
          status: "started",
          message: `Generation for "${type}" started. Poll get_studio_output_status, then download_studio_output or get_studio_output_content.`,
        },
        warnings
      );
    }
    return withWarnings(await waitUntilReady(page, strategy, type, timeoutMs), warnings);
  } catch (err) {
    if (isRecoverable(err)) throw err;
    log.warning(`  ⚠️  Studio output "${type}" generation failed: ${err}`);
    return withWarnings(
      { status: "error", message: err instanceof Error ? err.message : String(err) },
      warnings
    );
  }
}

async function waitUntilReady(
  page: Page,
  strategy: StudioOutputStrategy,
  type: StudioOutputType,
  timeoutMs: number
): Promise<AudioGenerationResult> {
  const tile = page.locator(joinAlt(strategy.readySelectors)).first();
  await tile.waitFor({ state: "visible", timeout: clampTimeoutMs(timeoutMs) });
  clearInFlight(page, type);
  return { status: "ready" };
}

export async function getStudioOutputStatus(
  page: Page,
  type: StudioOutputType
): Promise<AudioGenerationResult> {
  const strategy = getStrategy(type);
  try {
    // A viewer left open by an earlier call hides the Studio panel, which
    // is exactly how a ready Audio Overview was observed reporting
    // `not_started` live.
    await preflightCloseViewer(page, `get_studio_output_status("${type}")`);
    if (await readyOnColdPage(page, strategy)) {
      clearInFlight(page, type);
      return { status: "ready" };
    }
    const progress = await detectInProgress(page, strategy, type);
    if (progress.inProgress) {
      return {
        status: "in_progress",
        message: `Studio output "${type}" is still being generated (${progress.reason}).`,
      };
    }
    return {
      status: "not_started",
      message:
        `No "${type}" output exists yet for this notebook. NOTE: mid-generation detection is ` +
        `unreliable for generations this server did not start — a running generation can also ` +
        `look like this.`,
    };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Validates and prepares a download destination. The tool description
 * promises "absolute path, created if missing"; before this, neither half
 * was enforced — a relative path silently landed next to the MCP server
 * process, and a path pointing at an existing FILE failed later with an
 * opaque error from deep inside `saveAs`.
 */
async function resolveDestinationDir(destDir: string): Promise<string> {
  if (typeof destDir !== "string" || destDir.trim() === "") {
    throw new Error("destination_dir is required and must be a non-empty absolute directory path.");
  }
  if (!path.isAbsolute(destDir)) {
    throw new Error(
      `destination_dir must be an ABSOLUTE directory path — got "${destDir}". A relative path ` +
        `would be resolved against the MCP server process's working directory, not yours.`
    );
  }
  const dir = path.normalize(destDir);
  const stat = await fs.stat(dir).catch(() => null);
  if (stat && !stat.isDirectory()) {
    throw new Error(`destination_dir "${dir}" exists but is not a directory.`);
  }
  if (!stat) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new Error(
        `destination_dir "${dir}" does not exist and could not be created: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }
  return dir;
}

export async function downloadStudioOutput(
  page: Page,
  type: StudioOutputType,
  destDir: string
): Promise<DownloadAudioResult> {
  const strategy = getStrategy(type);
  const kind = studioKindOf(type);
  if (kind !== "file" || !strategy.download) {
    return {
      success: false,
      message:
        kind === "structured"
          ? `"${type}" is a structured-content output, not a file download. Use get_studio_output_content instead.`
          : `"${type}" has no file-download flow in this server (file kinds: ${FILE_KIND_TYPES.join(", ")}).`,
    };
  }
  let resolvedDir: string;
  try {
    resolvedDir = await resolveDestinationDir(destDir);
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
  try {
    await preflightCloseViewer(page, `download_studio_output("${type}")`);
    if (!(await readyOnColdPage(page, strategy))) {
      return {
        success: false,
        message: `No completed "${type}" output found. Call generate_studio_output first and wait for get_studio_output_status to report "ready".`,
      };
    }
    return await strategy.download(page, resolvedDir);
  } catch (err) {
    if (isRecoverable(err)) throw err;
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function getStudioOutputContent(
  page: Page,
  type: StudioOutputType
): Promise<{ success: boolean; content?: unknown; message?: string }> {
  const strategy = getStrategy(type);
  const kind = studioKindOf(type);
  if (kind !== "structured" || !strategy.extractContent) {
    return {
      success: false,
      message:
        kind === "file"
          ? `"${type}" is a file-download output, not structured content. Use download_studio_output instead.`
          : `"${type}" has no structured-content flow in this server (structured kinds: ${STRUCTURED_KIND_TYPES.join(", ")}).`,
    };
  }
  try {
    await preflightCloseViewer(page, `get_studio_output_content("${type}")`);
    if (!(await readyOnColdPage(page, strategy))) {
      return {
        success: false,
        message: `No completed "${type}" output found. Call generate_studio_output first and wait for get_studio_output_status to report "ready".`,
      };
    }
    try {
      const content = await strategy.extractContent(page);
      return { success: true, content };
    } finally {
      // Extraction OPENS a viewer; if it is not closed here every later
      // Studio call in this session breaks (live-observed cascade: mindmap
      // OK → flashcards "No completed output found" → mindmap now failing
      // too → audio status wrongly `not_started`). `finally`, so the error
      // path cleans up as well.
      await closeStructuredViewer(page);
    }
  } catch (err) {
    if (isRecoverable(err)) throw err;
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ *
 * File-kind download plumbing
 * ------------------------------------------------------------------ */

/**
 * Picks a path inside `dir` that does not already exist, appending
 * ` (2)`, ` (3)`, … before the extension. Previously the target was passed
 * straight to `saveAs`, which OVERWRITES silently — a second download of the
 * same artifact destroyed the first and still reported a fresh success.
 * `path.basename` also strips any directory component a hostile/odd
 * `suggestedFilename()` might carry.
 */
async function uniqueTargetPath(dir: string, filename: string): Promise<string> {
  const safe = path.basename(filename) || "notebooklm-download";
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = path.join(dir, safe);
  for (let n = 2; n <= 999; n++) {
    const exists = await fs
      .stat(candidate)
      .then(() => true)
      .catch(() => false);
    if (!exists) return candidate;
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  // 999 collisions: still never overwrite — fall back to a unique suffix.
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

/**
 * Shared download flow for Studio output types whose completed tile exposes
 * exactly one, unambiguous download menu item behind the three-dot menu —
 * confirmed live 2026-08-23 for Video Overview and Infographic (both show a
 * single `save_alt`-icon "Download" item, no format choice). Types with
 * multiple download formats (Slide Deck: PDF vs PPTX) pass their own
 * menu-item selectors; a non-file export flow (Reports: "Export to
 * Docs"/"Export to Sheets", no browser download event at all) needs its own
 * implementation entirely.
 *
 * CORRECTED 2026-08-23 (live-verified against a real, freshly-generated
 * Audio Overview artifact): clicking the download menu item opens a NEW
 * popup page/tab, and the browser `download` event fires on THAT popup —
 * not on `page`. The original code listened on `page` and always timed out
 * after 60s even though the click itself succeeded (confirmed: a manual
 * `context.waitForEvent("page")` + listening on the resulting popup page
 * caught the event and saved a real 46MB `.m4a` file within seconds).
 */
export async function downloadViaSingleMenuItem(
  page: Page,
  moreMenuSelectors: readonly string[],
  menuItemSelectors: readonly string[],
  destDir: string,
  fallbackFilename: string,
  opts: { saveTimeoutMs?: number } = {}
): Promise<DownloadAudioResult> {
  await clickFirstVisible(page, moreMenuSelectors, "artifact more-menu button");
  await safeSleep(page, 250);

  // `page.waitForEvent("popup")`, NOT `page.context().waitForEvent("page")`.
  // Every session in this server shares ONE browser context, so the context-
  // level event fires for a page opened by ANY session: a session being
  // created while this download is in flight would be captured here as "the
  // popup". The download then waits on the wrong page until it times out, and
  // the `finally` below CLOSES that other session's page, failing it with
  // "Target closed". The popup event is scoped to pages this page opened.
  const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
  // Attach a handler immediately: if `clickFirstVisible` below throws before
  // this promise is read, an eventual timeout rejection here would
  // otherwise become an UNHANDLED rejection. index.ts installs a
  // process-wide handler that treats any unhandled rejection as fatal and
  // shuts the whole server down — a single failed download must not be
  // able to kill every other active session minutes later. `finally`
  // below also always reads this promise before the function settles, so
  // this is defense-in-depth, not the only thing preventing the crash.
  popupPromise.catch(() => undefined);

  let popup: Page | undefined;
  try {
    await clickFirstVisible(page, menuItemSelectors, "download menu item");
    popup = await popupPromise;
    const download = await popup.waitForEvent("download", { timeout: 60_000 });
    const targetPath = await uniqueTargetPath(
      destDir,
      download.suggestedFilename() || fallbackFilename
    );
    const saveTimeoutMs = clampTimeoutMs(
      opts.saveTimeoutMs,
      DEFAULT_DOWNLOAD_SAVE_TIMEOUT_MS,
      MAX_STUDIO_TIMEOUT_MS
    );
    try {
      // `saveAs` has no timeout of its own: a stalled transfer hung the
      // whole tool (and its session) indefinitely.
      await withTimeout(download.saveAs(targetPath), saveTimeoutMs, `saving "${targetPath}"`);
    } catch (err) {
      await download.cancel().catch(() => undefined);
      await fs.rm(targetPath, { force: true }).catch(() => undefined);
      return {
        success: false,
        message:
          `Download did not complete within ${saveTimeoutMs}ms and was cancelled; any partial ` +
          `file was removed. (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    const bytes = (await fs.stat(targetPath).catch(() => null))?.size;
    if (bytes === 0) {
      await fs.rm(targetPath, { force: true }).catch(() => undefined);
      return {
        success: false,
        message: `Download produced a 0-byte file at "${targetPath}" — removed it rather than report an empty artifact as a success.`,
      };
    }
    return { success: true, filePath: targetPath, bytes };
  } finally {
    // The menu-item click can throw AFTER already spawning the popup as a
    // side effect (e.g. the element detaches mid-click) — `popup` above is
    // then never assigned, but the popup still exists and must not leak.
    if (!popup) popup = await popupPromise.catch(() => undefined);
    await popup?.close().catch(() => undefined);
  }
}

/**
 * Opens a completed structured-kind tile's content viewer by clicking its
 * full-tile-covering `button.artifact-stretched-button` — confirmed live
 * 2026-08-23 as the real click target (clicking the outer
 * `.artifact-item-button` container itself, or its inner
 * `.artifact-primary-content` description div, does NOT reliably open the
 * viewer; earlier attempts this session silently landed on the unchanged
 * default notebook view and were misread as "viewer didn't open" for a
 * different reason — see `getSandboxFrame` below for what that reason
 * actually was).
 *
 * Callers reach this only through `getStudioOutputContent`, which closes
 * any already-open viewer before extraction and closes THIS one in a
 * `finally` afterwards.
 */
export async function openStructuredViewer(
  page: Page,
  readySelectors: readonly string[]
): Promise<void> {
  const tile = page.locator(joinAlt(readySelectors)).first();
  const stretchedBtn = tile.locator("button.artifact-stretched-button").first();
  await stretchedBtn.click({ timeout: 10_000 });
}

/**
 * Locates the cross-origin sandboxed iframe NotebookLM renders structured-
 * content viewers into (Mind Map, Flashcards, Quiz — confirmed live
 * 2026-08-23 for all three; Data Table is the one exception, rendering a
 * plain `<table>` directly in the main frame instead). URL shape:
 * `blob:https://<id>-h966586903.scf.usercontent.goog/<uuid>`. This is WHY
 * `page.evaluate`/`document.querySelector` from the main frame always came
 * back empty against a genuinely-open viewer earlier this session — the
 * content lives in a different frame's document entirely, invisible to
 * main-frame DOM queries no matter how the click itself was fixed. Callers
 * must use `frame.evaluate`/`frame.locator`, not `page.evaluate`, to read
 * viewer content.
 *
 * STALE-FRAME RISK, largely mitigated 2026-08-23: this picks whichever
 * matching frame appears FIRST in `page.frames()`, with no check that it
 * belongs to the viewer THIS call just opened. That was a real
 * silent-wrong-content risk while viewers were never closed. Now
 * `getStudioOutputContent` closes the viewer in a `finally` after every
 * extraction AND closes any leaked viewer before starting, so a second
 * viewer's frame should not coexist with a first. It remains unverified
 * whether NotebookLM's SPA detaches the iframe promptly on close, so this
 * is "much less likely" rather than "impossible".
 */
export async function getSandboxFrame(page: Page, timeoutMs = 10_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page
      .frames()
      .find((f) => f.url().startsWith("blob:") && f.url().includes("usercontent.goog"));
    if (frame) return frame;
    await page.waitForTimeout(300);
  }
  throw new Error(
    "Sandboxed content frame (*.scf.usercontent.goog) did not appear — the viewer may not have opened."
  );
}

export type {
  AudioStatus,
  AudioGenerationResult,
  DownloadAudioResult,
  GenerateAudioOptions,
  Locator,
};
