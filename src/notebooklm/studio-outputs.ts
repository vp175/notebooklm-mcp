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
import { safeSleep, isRecoverable } from "../browser/watchdog.js";
import { log } from "../utils/logger.js";
import { joinAlt } from "./selectors.js";
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
  /** Multilingual "generation in progress" phrase list, scoped to this type's tile/card only. */
  inProgressPhrases: readonly string[];
  /** Selector(s) identifying this type's completed tile specifically (not any artifact tile). */
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

export type {
  AudioStatus,
  AudioGenerationResult,
  DownloadAudioResult,
  GenerateAudioOptions,
  Locator,
};
