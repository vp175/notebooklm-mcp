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
 * Task 6 (2026-08-22) added a tile-scoped icon-anchor selector as the FIRST
 * candidate in `Selectors.studio.audioPlayer`/`audioMoreMenuButton` — see the
 * "HYPOTHESIS, NOT LIVE-VERIFIED" comment on `Selectors.studio.
 * audioTileIconAnchor` in selectors.ts for why (no authenticated account was
 * available to confirm live DOM markup this session) and why it cannot
 * regress current behavior (broad selectors are kept, unmodified, as
 * trailing fallback entries in the same arrays).
 *
 * CORRECTED (Task 6 review, 2026-08-22): "ahead of" only means something for
 * `audioMoreMenuButton`, which `clickFirstVisible` reads as an ordered loop.
 * `audioPlayer` is consumed as `readySelectors` — a single comma-joined CSS
 * OR (`joinAlt` + `.first()` in studio-outputs.ts) — where array position
 * confers no priority at all. See `Selectors.studio.audioTileIconAnchor` in
 * selectors.ts for the full correction; the short version: the broad
 * `readySelectors` entries must be REMOVED, not just out-ordered, before a
 * second Studio output type can be safely discriminated. The
 * `inProgressPhrases` story is likewise not tile-scoped in practice —
 * `isInProgress` (studio-outputs.ts) reads the whole `.studio-panel`
 * textContent, so any type-agnostic phrase in `GENERATION_IN_PROGRESS_
 * PHRASES` below matches regardless of which output type is actually
 * generating.
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
}

export interface DownloadAudioResult {
  success: boolean;
  filePath?: string;
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

async function triggerAudio(page: Page, opts: { customPrompt?: string }): Promise<void> {
  await triggerViaDialog(page, Selectors.studio.audioOverviewButton, "Audio overview entry", {
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

registerStudioStrategy("audio", {
  kind: "file",
  triggerSelectors: Selectors.studio.audioOverviewButton,
  // NOT tile-scoped in practice: `isInProgress` (studio-outputs.ts) reads
  // the ENTIRE `.studio-panel` textContent, not this type's own tile/card,
  // so any type-agnostic phrase here (e.g. "check back in a few minutes")
  // matches regardless of which output type is actually generating. Once a
  // second Studio output type is registered (Phase 2), a generating output
  // of that other type would also make `get_studio_output_status(page,
  // "audio")` report `in_progress`. Real per-tile scoping needs to be added
  // to `isInProgress` before that can be trusted.
  inProgressPhrases: GENERATION_IN_PROGRESS_PHRASES,
  // Fallback chain: tile-scoped icon anchor listed first (Task 6
  // hypothesis, not live-verified — see selectors.ts), broad pre-Task-6
  // selectors kept as trailing fallback so nothing that worked before this
  // task can have stopped working. IMPORTANT: `readySelectors` is consumed
  // as a single comma-joined CSS OR (`joinAlt` + `.first()`), NOT an
  // ordered loop — listing the anchor first here does NOT give it priority
  // over the broad entries below it. See Selectors.studio.audioPlayer /
  // Selectors.studio.audioTileIconAnchor in selectors.ts for the full
  // correction and what must change before a second output type registers.
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
