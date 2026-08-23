/**
 * Generic Studio-output engine (trigger / poll / download-or-extract) driving
 * a strategy registry, one entry per NotebookLM Studio output type. Built to
 * replace what would otherwise be 9 near-duplicate modules of the shape
 * `audio.ts` already has. Every strategy's tile lookups must be scoped to
 * that specific output type — never "the first/any artifact tile" — because
 * multiple output types can coexist in the same notebook once more than one
 * is wrapped.
 *
 * Phase 1 (Task 6) registers exactly one strategy — "audio", via
 * `audio.ts` — retrofitted onto this engine. The other 8 `StudioOutputType`
 * values are declared for the eventual tool schema but intentionally
 * unregistered; `getStrategy()` below throws a clear "not yet implemented"
 * error for them rather than allowing a call to fail confusingly deeper in
 * the DOM layer.
 */
import type { Page, Locator } from "patchright";
import path from "path";
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

export const FILE_KIND_TYPES: readonly StudioOutputType[] = [
  "audio",
  "video",
  "report",
  "slides",
  "infographic",
];
export const STRUCTURED_KIND_TYPES: readonly StudioOutputType[] = [
  "mindmap",
  "datatable",
  "quiz",
  "flashcards",
];

export type StudioArtifactKind = "file" | "structured";

export interface StudioOutputStrategy {
  kind: StudioArtifactKind;
  /** Entry-button selector(s) in the Studio panel, following the Selectors.studio.* convention. */
  triggerSelectors: readonly string[];
  /**
   * Multilingual "generation in progress" phrase list. NOT scoped to this
   * type's tile/card in practice — `isInProgress` below reads the ENTIRE
   * `.studio-panel` textContent, not a per-tile subset, so a type-agnostic
   * phrase here (e.g. "check back in a few minutes") matches regardless of
   * which output type is actually generating. Once a second Studio output
   * type is registered, a generating output of that other type will also
   * make `getStudioOutputStatus`/`generateStudioOutput` report
   * `in_progress` for THIS type. Real per-tile scoping needs to be added to
   * `isInProgress` before a second concurrent generation can be safely
   * distinguished — this field alone does not provide that guarantee.
   */
  inProgressPhrases: readonly string[];
  /**
   * Selector(s) identifying this type's completed tile. NOTE: array
   * position does NOT confer priority here. `isReady`/`waitUntilReady`
   * below consume this as a single comma-joined CSS OR selector
   * (`joinAlt(strategy.readySelectors)` + `.first()`) — `.first()` returns
   * whichever candidate matches first in DOM order, irrespective of which
   * array entry produced that match. A narrow, type-specific selector
   * listed before a broad, type-agnostic one is NOT thereby preferred; the
   * broad entry can still be what actually matches. To make this list
   * genuinely discriminate between output types, the broad/type-agnostic
   * entries must be REMOVED once a second type is registered — not merely
   * placed after a narrower one — or tile discrimination silently fails.
   * (Contrast with selector lists consumed via `clickFirstVisible` below,
   * which IS an ordered loop where position does matter.)
   */
  readySelectors: readonly string[];
  trigger(page: Page, opts: { customPrompt?: string; difficulty?: string }): Promise<void>;
  download?(page: Page, destDir: string): Promise<DownloadAudioResult>;
  extractContent?(page: Page): Promise<unknown>;
}

const STRATEGIES = new Map<StudioOutputType, StudioOutputStrategy>();

export function registerStudioStrategy(
  type: StudioOutputType,
  strategy: StudioOutputStrategy
): void {
  STRATEGIES.set(type, strategy);
}

function getStrategy(type: StudioOutputType): StudioOutputStrategy {
  const s = STRATEGIES.get(type);
  if (!s) {
    throw new Error(
      `Studio output type "${type}" is not yet implemented by this server (Phase 2). ` +
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
 * documented "not yet implemented (Phase 2)" error unreachable in practice.
 */
export function isStudioTypeImplemented(type: StudioOutputType): boolean {
  return STRATEGIES.has(type);
}

/** Currently-registered Studio output types, for building the same error message pre-session. */
export function implementedStudioTypes(): StudioOutputType[] {
  return [...STRATEGIES.keys()];
}

export async function clickFirstVisible(
  page: Page,
  selectors: readonly string[],
  label: string
): Promise<void> {
  for (const sel of selectors) {
    const candidate = page.locator(sel).first();
    if (await candidate.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await candidate.click();
      await safeSleep(page, 300);
      return;
    }
  }
  throw new Error(
    `Could not find ${label} — selectors: ${selectors.join(" | ")}. NotebookLM Studio UI may have changed.`
  );
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
 * backdrop intercepted the next tile's click.
 *
 * CONFIRMED live 2026-08-23 for Video Overview, Infographic, and Slide
 * Deck too: each type's trigger tile opens its own "Customize <Type>"
 * dialog (different fields per type — e.g. Cinematic/Explainer for Video,
 * visual-style choices for Infographic, Detailed Deck/Presenter Slides for
 * Slide Deck) with a working "Generate" button, directly observed by
 * triggering each and dumping the dialog, then closing cleanly. Only
 * Report has not been individually checked yet (deferred — its actual
 * export flow needs its own live observation regardless).
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
  opts: { customPrompt?: string } = {}
): Promise<void> {
  await clickFirstVisible(page, triggerSelectors, label);
  const dialog = page.locator("mat-dialog-container").first();
  // `.isVisible({ timeout })` does NOT poll/wait despite the option name —
  // it checks state immediately. A Material dialog's mount + open
  // animation can exceed the ~300ms gap since the trigger click, which
  // would make this falsely report "no dialog" and silently skip Generate
  // — reintroducing the exact bug this helper exists to fix, intermittently.
  // `waitFor` performs a genuine, actively-polled wait.
  const dialogVisible = await dialog
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!dialogVisible) return;

  if (opts.customPrompt) {
    const promptField = dialog.locator("textarea, input[type='text']").first();
    if (await promptField.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await promptField.fill(opts.customPrompt);
      await safeSleep(page, 200);
    }
  }

  await clickFirstVisible(page, Selectors.studio.generateButton, "Generate button");
  await page
    .waitForSelector(".cdk-overlay-backdrop-showing", { state: "detached", timeout: 15_000 })
    .catch(() => undefined);
}

export async function ensureStudioPanelExpanded(
  page: Page,
  anyTriggerSelectors: readonly string[]
): Promise<void> {
  const cardVisible = await page
    .locator(joinAlt(anyTriggerSelectors))
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
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
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click().catch(() => undefined);
      await safeSleep(page, 400);
      return;
    }
  }
}

async function isReady(page: Page, strategy: StudioOutputStrategy): Promise<boolean> {
  return page
    .locator(joinAlt(strategy.readySelectors))
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
}

/**
 * KNOWN BROKEN against the current UI, confirmed live 2026-08-23, not yet
 * fixed: during a real ~7-minute Audio Overview generation, a script
 * polling `get_studio_output_status` every 15s reported `not_started` for
 * the entire run — `inProgressPhrases` (all locale phrase lists, written
 * against the 2026-05 UI) matched nothing, because the current UI's actual
 * in-progress DOM/text is still unobserved (a companion spinner-selector
 * guess also matched zero elements throughout the same run). Practical
 * consequence: `generateStudioOutput`'s in-progress guard never fires, so
 * calling `generate_studio_output` a second time for a type that is
 * already generating will re-open its dialog and click Generate again —
 * a real duplicate-generation risk, not just a status-reporting cosmetic
 * issue. Status still correctly resolves to `ready` once generation
 * completes (`isReady` is unaffected); only the mid-generation window
 * misreports. Needs a live capture of the real in-progress DOM before this
 * can be fixed correctly instead of guessed again.
 */
async function isInProgress(page: Page, strategy: StudioOutputStrategy): Promise<boolean> {
  try {
    const studioText = await page
      .locator(".studio-panel")
      .first()
      .textContent({ timeout: 500 })
      .catch(() => null);
    if (!studioText) return false;
    const lower = studioText.toLowerCase();
    return strategy.inProgressPhrases.some((p) => lower.includes(p));
  } catch {
    return false;
  }
}

export async function generateStudioOutput(
  page: Page,
  type: StudioOutputType,
  options: GenerateAudioOptions & { difficulty?: string } = {}
): Promise<AudioGenerationResult> {
  const strategy = getStrategy(type);
  const { waitForCompletion = false, timeoutMs = 600_000 } = options;
  try {
    if (await isReady(page, strategy)) {
      log.info(`  ✅ Studio output "${type}" already generated, skipping trigger`);
      return { status: "ready", alreadyExisted: true };
    }
    if (await isInProgress(page, strategy)) {
      log.info(`  ⏳ Studio output "${type}" generation already running`);
      if (waitForCompletion) return await waitUntilReady(page, strategy, timeoutMs);
      return {
        status: "in_progress",
        message: `Generation for "${type}" is already running. Poll get_studio_output_status.`,
      };
    }
    await ensureStudioPanelExpanded(page, strategy.triggerSelectors);
    await strategy.trigger(page, {
      customPrompt: options.customPrompt,
      difficulty: options.difficulty,
    });
    log.info(`  🎬 Studio output "${type}" generation triggered`);
    if (!waitForCompletion) {
      return {
        status: "started",
        message: `Generation for "${type}" started. Poll get_studio_output_status, then download_studio_output or get_studio_output_content.`,
      };
    }
    return await waitUntilReady(page, strategy, timeoutMs);
  } catch (err) {
    if (isRecoverable(err)) throw err;
    log.warning(`  ⚠️  Studio output "${type}" generation failed: ${err}`);
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

async function waitUntilReady(
  page: Page,
  strategy: StudioOutputStrategy,
  timeoutMs: number
): Promise<AudioGenerationResult> {
  const tile = page.locator(joinAlt(strategy.readySelectors)).first();
  await tile.waitFor({ state: "visible", timeout: timeoutMs });
  return { status: "ready" };
}

export async function getStudioOutputStatus(
  page: Page,
  type: StudioOutputType
): Promise<AudioGenerationResult> {
  const strategy = getStrategy(type);
  try {
    if (await isReady(page, strategy)) return { status: "ready" };
    if (await isInProgress(page, strategy)) {
      return {
        status: "in_progress",
        message: `Studio output "${type}" is still being generated.`,
      };
    }
    return { status: "not_started", message: `No "${type}" output exists yet for this notebook.` };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function downloadStudioOutput(
  page: Page,
  type: StudioOutputType,
  destDir: string
): Promise<DownloadAudioResult> {
  const strategy = getStrategy(type);
  if (strategy.kind !== "file" || !strategy.download) {
    return {
      success: false,
      message: `"${type}" is a structured-content output, not a file download. Use get_studio_output_content instead.`,
    };
  }
  if (!(await isReady(page, strategy))) {
    return {
      success: false,
      message: `No completed "${type}" output found. Call generate_studio_output first and wait for get_studio_output_status to report "ready".`,
    };
  }
  try {
    return await strategy.download(page, destDir);
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
  if (strategy.kind !== "structured" || !strategy.extractContent) {
    return {
      success: false,
      message: `"${type}" is a file-download output, not structured content. Use download_studio_output instead.`,
    };
  }
  if (!(await isReady(page, strategy))) {
    return {
      success: false,
      message: `No completed "${type}" output found. Call generate_studio_output first and wait for get_studio_output_status to report "ready".`,
    };
  }
  try {
    const content = await strategy.extractContent(page);
    return { success: true, content };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Shared download flow for Studio output types whose completed tile exposes
 * exactly one, unambiguous download menu item behind the three-dot menu —
 * confirmed live 2026-08-23 for Video Overview and Infographic (both show a
 * single `save_alt`-icon "Download" item, no format choice). Types with
 * multiple download formats (Slide Deck: PDF vs PPTX) or a non-file export
 * flow (Reports: "Export to Docs"/"Export to Sheets", no browser download
 * event at all) need their own `download()` instead of this helper.
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
  fallbackFilename: string
): Promise<DownloadAudioResult> {
  await clickFirstVisible(page, moreMenuSelectors, "artifact more-menu button");
  await safeSleep(page, 250);

  const popupPromise = page.context().waitForEvent("page", { timeout: 15_000 });
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
    const suggested = download.suggestedFilename();
    const targetPath = path.join(destDir, suggested || fallbackFilename);
    await download.saveAs(targetPath);
    return { success: true, filePath: targetPath };
  } finally {
    // The menu-item click can throw AFTER already spawning the popup as a
    // side effect (e.g. the element detaches mid-click) — `popup` above is
    // then never assigned, but the popup still exists and must not leak.
    if (!popup) popup = await popupPromise.catch(() => undefined);
    await popup?.close().catch(() => undefined);
  }
}

export type {
  AudioStatus,
  AudioGenerationResult,
  DownloadAudioResult,
  GenerateAudioOptions,
  Locator,
};
