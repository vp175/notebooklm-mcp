/**
 * Infographic strategy, registered into the Studio-output engine
 * (studio-outputs.ts). Same shape as video-overview.ts — see that file's
 * header for the shared reasoning (tile-scoping, `inProgressPhrases`,
 * `downloadViaSingleMenuItem`'s popup-page download fix).
 *
 * VERIFIED live 2026-08-23, against two real, already-completed
 * Infographic artifacts in a test notebook):
 *   - Completed tile: `.artifact-item-button` carrying the trigger's
 *     `stacked_bar_chart` ligature.
 *   - Three-dot menu offers exactly one download-shaped item: `save_alt`
 *     icon + "Download" text — identical shape to Video Overview's menu.
 *
 * TRIGGER FLOW — live-confirmed 2026-08-23 (separately from the completed-
 * artifact check above): clicking the `stacked_bar_chart` trigger tile
 * opens a "Customize Infographic" dialog (Language/Orientation/Visual
 * style fields) with a working "Generate" button — directly observed by
 * triggering it live and dumping the dialog text, then closed cleanly via
 * its close button. Uses the shared `triggerViaDialog` helper
 * (studio-outputs.ts).
 */

import type { Page } from "patchright";
import { Selectors } from "./selectors.js";
import {
  registerStudioStrategy,
  triggerViaDialog,
  downloadViaSingleMenuItem,
} from "./studio-outputs.js";
import type { StudioTriggerOptions, StudioTriggerOutcome } from "./studio-outputs.js";
import type { DownloadAudioResult } from "./audio.js";

const TRIGGER_SELECTORS = Selectors.studio.infographicButton;
const READY_SELECTORS = Selectors.studio.infographicTile;
const MORE_MENU_SELECTORS = Selectors.studio.infographicMoreMenuButton;
const DOWNLOAD_MENU_ITEM_SELECTORS = Selectors.studio.singleDownloadMenuItem;

// `opts` must be declared and forwarded — see video-overview.ts's trigger
// for why (a `page`-only trigger silently drops the caller's custom_prompt).
async function triggerInfographic(
  page: Page,
  opts: StudioTriggerOptions
): Promise<StudioTriggerOutcome> {
  return triggerViaDialog(page, TRIGGER_SELECTORS, "Infographic entry", {
    customPrompt: opts.customPrompt,
  });
}

async function downloadInfographic(page: Page, destDir: string): Promise<DownloadAudioResult> {
  return downloadViaSingleMenuItem(
    page,
    MORE_MENU_SELECTORS,
    DOWNLOAD_MENU_ITEM_SELECTORS,
    destDir,
    "notebooklm-infographic.png"
  );
}

// Kind ("file") comes from FILE_KIND_TYPES via `studioKindOf` in the
// engine, not from this object — see studio-outputs.ts.
registerStudioStrategy("infographic", {
  triggerSelectors: TRIGGER_SELECTORS,
  inProgressPhrases: [],
  readySelectors: READY_SELECTORS,
  trigger: triggerInfographic,
  download: downloadInfographic,
});
