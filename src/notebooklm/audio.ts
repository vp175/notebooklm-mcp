/**
 * Audio Overview strategy, registered into the Studio-output engine
 * (studio-outputs.ts). Public functions below are thin wrappers kept for
 * backward compatibility with existing callers (browser-session.ts,
 * handlers.ts) — the actual trigger/poll/download logic now lives in the
 * shared engine, with this file supplying only Audio's own selectors and
 * DOM interactions.
 *
 * This file remains the source of truth for the shared result/option types
 * (`AudioStatus`, `GenerateAudioOptions`, `AudioGenerationResult`,
 * `DownloadAudioResult`) — `studio-outputs.ts` imports them as `import
 * type` (erased at compile time, so there is no runtime circular-import
 * concern even though `studio-outputs.ts` is itself imported here for the
 * engine's functions).
 *
 * CORRECTED 2026-08-23 (live-verified against the current Gemini Notebook
 * UI, real account): the 2026-05 "one click, no dialog" claim below is
 * WRONG for today's UI. Clicking the `audio_magic_eraser` trigger tile
 * ALWAYS opens a "Customize Audio Overview" `mat-dialog-container`
 * (Format/Language/Length/Sources/focus-prompt fields) behind a
 * `cdk-overlay-backdrop`; generation only starts once that dialog's
 * "Generate" button is clicked. `triggerAudio` now goes through
 * `triggerViaDialog` (studio-outputs.ts) to do exactly that — confirmed
 * live: dialog opens, Generate closes it (backdrop detaches), and
 * generation genuinely starts server-side. Before this fix, the bare click
 * this file used to make opened the dialog and stopped there — Audio
 * generation had likely never actually started via this server, which is
 * consistent with no completed Audio Overview artifact existing anywhere
 * in the test account despite the tool reporting `status: "started"`.
 *
 * 2026-05 Studio UX (verified live in DE/EN locales, pre-Task-6; the "one
 * click" and `artifact-library-item` claims are superseded — see above and
 * selectors.ts's `audioTileIconAnchor` note — rest still holds directionally):
 *   - While generating, NotebookLM shows a spinner/placeholder tile (exact
 *     current-UI markup not yet captured — this session's live generation
 *     never registered a match on any of the standard Material spinner
 *     selectors tried, so the real spinner class remains unknown; status
 *     checks degrade to `not_started` during generation rather than
 *     `in_progress`, which is wrong-but-safe, not a crash).
 *   - When generation completes, the real completed tile is
 *     `.artifact-item-button` (not `artifact-library-item`, which does not
 *     exist in the current DOM) with a three-dot menu containing a
 *     `save_alt`-icon "Download" item.
 *
 * DOWNLOAD FLOW — fixed 2026-08-23, `downloadAudio` now delegates to the
 * shared `downloadViaSingleMenuItem` (studio-outputs.ts), which itself had
 * a real, live-confirmed bug: clicking "Download" opens a NEW popup page,
 * and the browser `download` event fires there — not on the original page.
 * The old code (both here and the shared helper) listened on the wrong
 * page and always timed out after 60s even though the click succeeded.
 * Verified end-to-end against a freshly-generated Audio Overview: trigger
 * → dialog → Generate → ~7 min real generation → ready tile → download
 * produced a real 46MB `.m4a` file.
 *
 * SELECTOR SCOPING — corrected 2026-08-23, and the stale version of this
 * note (which described "broad selectors kept as trailing fallback entries
 * in the same arrays") no longer described the code: there are no broad
 * fallback entries left. `Selectors.studio.audioPlayer` and
 * `audioMoreMenuButton` are now built by `studioReadyTileSelectors`/
 * `studioMoreMenuSelectors` (selectors.ts) and each contain exactly ONE
 * candidate — a real CSS AND (`:has()` on the `audio_magic_eraser`
 * ligature) scoping the match to Audio's own tile. Removing the broad
 * entries, rather than merely ordering them last, is what made registering
 * the other seven Studio output types safe: `readySelectors` is consumed as
 * a single comma-joined CSS OR (`joinAlt` + `.first()`), where array
 * position confers no priority at all, so a broad entry anywhere in the
 * list would still be free to match another type's tile.
 *
 * `inProgressPhrases` is likewise not tile-scoped: `domSuggestsInProgress`
 * (studio-outputs.ts) reads the whole `.studio-panel` textContent, so any
 * type-agnostic phrase in `GENERATION_IN_PROGRESS_PHRASES` below matches
 * regardless of which output type is actually generating. That check is
 * best-effort only; repeat-call protection comes from the engine's own
 * in-flight record (see `detectInProgress` in studio-outputs.ts).
 */

import type { Page } from "patchright";
import { Selectors } from "./selectors.js";
import {
  registerStudioStrategy,
  generateStudioOutput,
  getStudioOutputStatus,
  downloadStudioOutput,
  triggerViaDialog,
  downloadViaSingleMenuItem,
} from "./studio-outputs.js";
import type { StudioTriggerOptions, StudioTriggerOutcome } from "./studio-outputs.js";

export type AudioStatus = "ready" | "in_progress" | "not_started";

export interface GenerateAudioOptions {
  /** Optional focus prompt fed into the customise dialog before generation. */
  customPrompt?: string;
  /**
   * If `true`, block until the audio tile is ready (legacy behaviour). If
   * `false` (default), return immediately after triggering generation —
   * callers poll via `get_audio_status`.
   */
  waitForCompletion?: boolean;
  /** How long to wait when `waitForCompletion=true`. Default 10 min. */
  timeoutMs?: number;
}

export interface AudioGenerationResult {
  status: AudioStatus | "started" | "error";
  /** True when an Audio Overview already existed before this call. */
  alreadyExisted?: boolean;
  message?: string;
  /**
   * Non-fatal problems the caller should see rather than have silently
   * swallowed — e.g. a supplied `difficulty` that this server does not wire
   * into the Customize dialog, a `custom_prompt` the dialog had no field
   * for, or a Customize dialog that would not close. Optional and additive:
   * the tool layer passes result objects straight through.
   */
  warnings?: string[];
}

export interface DownloadAudioResult {
  success: boolean;
  /** Absolute path actually written — may differ from the suggested name
   * when an existing file forced a ` (2)`-style non-clashing name. */
  filePath?: string;
  /** Size on disk of the written file, in bytes. */
  bytes?: number;
  message?: string;
}

/**
 * Detect a generation-in-progress tile. NotebookLM renders a tile with a
 * spinner and a localised "come back in a few minutes" message while it
 * works. Coverage spans EN, DE, FR, ES, IT, PT, NL, JA.
 */
const GENERATION_IN_PROGRESS_PHRASES = [
  // English
  "check back in a few minutes",
  "come back in a few minutes",
  "audio overview is being generated",
  "generating your audio",
  // German
  "kommen sie in ein paar minuten wieder",
  "audio-zusammenfassung wird erstellt",
  "audio-zusammenfassung wird gener",
  // French
  "revenez dans quelques minutes",
  "génération de l'aperçu audio",
  // Spanish
  "vuelve en unos minutos",
  "generando el resumen de audio",
  // Italian
  "torna tra qualche minuto",
  "generazione della panoramica audio",
  // Portuguese
  "volte em alguns minutos",
  "gerando a visão geral de áudio",
  // Dutch
  "kom over een paar minuten terug",
  "audio-overzicht wordt gegenereerd",
  // Japanese
  "数分後にもう一度ご確認ください",
  "音声の概要を生成しています",
];

async function triggerAudio(page: Page, opts: StudioTriggerOptions): Promise<StudioTriggerOutcome> {
  return triggerViaDialog(page, Selectors.studio.audioOverviewButton, "Audio overview entry", {
    customPrompt: opts.customPrompt,
  });
}

async function downloadAudio(page: Page, destDir: string): Promise<DownloadAudioResult> {
  return downloadViaSingleMenuItem(
    page,
    Selectors.studio.audioMoreMenuButton,
    Selectors.studio.singleDownloadMenuItem,
    destDir,
    "notebooklm-audio.wav"
  );
}

// Kind ("file") is NOT declared here: the engine derives it from
// FILE_KIND_TYPES/STRUCTURED_KIND_TYPES via `studioKindOf`, so the two
// cannot drift apart (they previously could, and did — `report` was
// misclassified as a file kind).
registerStudioStrategy("audio", {
  triggerSelectors: Selectors.studio.audioOverviewButton,
  // NOT tile-scoped in practice: `domSuggestsInProgress` (studio-outputs.ts)
  // reads the ENTIRE `.studio-panel` textContent, not this type's own
  // tile/card, so any type-agnostic phrase here (e.g. "check back in a few
  // minutes") matches regardless of which output type is actually
  // generating. It is treated as a best-effort hint for that reason; the
  // engine's own in-flight record is what actually prevents duplicate
  // generations.
  inProgressPhrases: GENERATION_IN_PROGRESS_PHRASES,
  // Exactly one, genuinely tile-scoped candidate (`:has()` on the
  // `audio_magic_eraser` ligature) — see this module's header for why the
  // broad pre-Task-6 entries had to be REMOVED rather than merely ordered
  // last (`readySelectors` is consumed as an unordered CSS OR).
  readySelectors: Selectors.studio.audioPlayer,
  trigger: triggerAudio,
  download: downloadAudio,
});

export async function generateAudioOverview(
  page: Page,
  options: GenerateAudioOptions = {}
): Promise<AudioGenerationResult> {
  return generateStudioOutput(page, "audio", options);
}

export async function getAudioStatusOnPage(page: Page): Promise<AudioGenerationResult> {
  return getStudioOutputStatus(page, "audio");
}

export async function downloadAudioOverview(
  page: Page,
  destinationDir: string
): Promise<DownloadAudioResult> {
  return downloadStudioOutput(page, "audio", destinationDir);
}
