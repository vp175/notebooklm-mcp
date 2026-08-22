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
 * 2026-05 Studio UX (verified live in DE/EN locales, pre-Task-6):
 *   - The "Audio Overview" entry is a `<div role="button">` with a Material-
 *     Symbols `audio_magic_eraser` icon. *One click* on it kicks off
 *     generation; there is no separate "Generate" step unless the user
 *     opens the per-card "Anpassen" sub-dialog first.
 *   - While generating, NotebookLM shows a "Audio-Zusammenfassung wird … —
 *     Kommen Sie in ein paar Minuten wieder" tile with a spinner.
 *   - When generation completes, NotebookLM mounts an `artifact-library-item`
 *     tile with a Play button (`button.artifact-action-button`, locale-bound
 *     aria-label "Wiedergeben"/"Play"/…) and a three-dot menu containing
 *     "Download" / "Herunterladen" / "Télécharger" / …. There is *no real*
 *     `<audio>` element in the DOM.
 *
 * Task 6 (2026-08-22) added a tile-scoped icon-anchor selector as the FIRST
 * candidate in `Selectors.studio.audioPlayer`/`audioMoreMenuButton`, ahead
 * of the broad selectors above — see the "HYPOTHESIS, NOT LIVE-VERIFIED"
 * comment on `Selectors.studio.audioTileIconAnchor` in selectors.ts for why
 * (no authenticated account was available to confirm live DOM markup this
 * session) and why it cannot regress current behavior (broad selectors are
 * kept, unmodified, as trailing fallback entries in the same arrays).
 */

import type { Page } from "patchright";
import path from "path";
import { Selectors } from "./selectors.js";
import { safeSleep } from "../browser/watchdog.js";
import {
  registerStudioStrategy,
  generateStudioOutput,
  getStudioOutputStatus,
  downloadStudioOutput,
  clickFirstVisible,
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
  if (opts.customPrompt) {
    await clickFirstVisible(page, Selectors.studio.audioCustomiseButton, "Audio customise button");
    const overlay = page.locator(Selectors.sources.overlayPane).first();
    const promptField = overlay.locator("textarea, input[type='text']").first();
    if (await promptField.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await promptField.fill(opts.customPrompt);
      await safeSleep(page, 200);
    }
    await clickFirstVisible(page, Selectors.studio.generateButton, "Generate button");
  } else {
    await clickFirstVisible(page, Selectors.studio.audioOverviewButton, "Audio overview entry");
  }
}

async function downloadAudio(page: Page, destDir: string): Promise<DownloadAudioResult> {
  await clickFirstVisible(page, Selectors.studio.audioMoreMenuButton, "Audio more-menu button");
  await safeSleep(page, 250);
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await clickFirstVisible(page, Selectors.studio.audioDownloadMenuItem, "Audio download menu item");
  const download = await downloadPromise;
  const suggested = download.suggestedFilename();
  const targetPath = path.join(destDir, suggested || "notebooklm-audio.wav");
  await download.saveAs(targetPath);
  return { success: true, filePath: targetPath };
}

registerStudioStrategy("audio", {
  kind: "file",
  triggerSelectors: Selectors.studio.audioOverviewButton,
  inProgressPhrases: GENERATION_IN_PROGRESS_PHRASES,
  // Fallback chain: tile-scoped icon anchor tried first (Task 6 hypothesis,
  // not live-verified — see selectors.ts), broad pre-Task-6 selectors kept
  // as trailing fallback so nothing that worked before this task can have
  // stopped working. See Selectors.studio.audioPlayer for the full chain.
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
