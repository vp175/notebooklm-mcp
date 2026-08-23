/**
 * Video Overview strategy, registered into the Studio-output engine
 * (studio-outputs.ts). Same shape as audio.ts's Audio Overview strategy,
 * now that studio-outputs.ts's ready/more-menu selectors are genuinely
 * tile-scoped (see selectors.ts's `studioReadyTileSelectors`/
 * `studioMoreMenuSelectors`).
 *
 * VERIFIED live 2026-08-23, against a real, already-completed Video
 * Overview artifact in a test notebook):
 *   - Completed tile: `.artifact-item-button` re-displaying the trigger's
 *     `subscriptions` ligature.
 *   - Three-dot menu on that tile offers exactly one download-shaped item:
 *     `save_alt` icon + "Download" text (no format choice, unlike Slide
 *     Deck's PDF/PPTX pair).
 *
 * DOWNLOAD FLOW — the shared `downloadViaSingleMenuItem` helper this file
 * uses had a real bug, fixed 2026-08-23: it listened for the browser
 * `download` event on the wrong page (clicking "Download" opens a NEW
 * popup page; the event fires there). Fixed and verified end-to-end
 * against Audio Overview (real 46MB file downloaded); this type's own
 * download has NOT been individually re-run since the fix, but shares the
 * exact same helper so the same fix applies.
 *
 * TRIGGER FLOW — fixed AND live-confirmed 2026-08-23. Clicking the
 * `subscriptions` trigger tile opens a "Customize Video Overview"
 * `mat-dialog-container` (Format: Cinematic/Explainer + other fields) with
 * a working "Generate" button, same shape as Audio's dialog — confirmed
 * directly (not inferred) by triggering it live and dumping the dialog
 * text, then closing it cleanly via its close button. `triggerVideoOverview`
 * uses the shared `triggerViaDialog` helper to click through this.
 *
 * NOT YET VERIFIED: an actual full generation cycle for THIS type (Audio
 * is the only type with a live-confirmed trigger→ready→download run this
 * session) — the in-progress tile/text is unknown, so `inProgressPhrases`
 * stays empty; and whether a completed tile generated fresh by this server
 * matches the `subscriptions`-ligature assumption (the sample tile used to
 * verify `readySelectors` predates this session by 121 days).
 */

import type { Page } from "patchright";
import { Selectors } from "./selectors.js";
import {
  registerStudioStrategy,
  triggerViaDialog,
  downloadViaSingleMenuItem,
} from "./studio-outputs.js";
import type { DownloadAudioResult } from "./audio.js";

const TRIGGER_SELECTORS = Selectors.studio.videoOverviewButton;
const READY_SELECTORS = Selectors.studio.videoOverviewTile;
const MORE_MENU_SELECTORS = Selectors.studio.videoOverviewMoreMenuButton;
const DOWNLOAD_MENU_ITEM_SELECTORS = Selectors.studio.singleDownloadMenuItem;

async function triggerVideoOverview(page: Page): Promise<void> {
  await triggerViaDialog(page, TRIGGER_SELECTORS, "Video Overview entry");
}

async function downloadVideoOverview(page: Page, destDir: string): Promise<DownloadAudioResult> {
  return downloadViaSingleMenuItem(
    page,
    MORE_MENU_SELECTORS,
    DOWNLOAD_MENU_ITEM_SELECTORS,
    destDir,
    "notebooklm-video-overview.mp4"
  );
}

registerStudioStrategy("video", {
  kind: "file",
  triggerSelectors: TRIGGER_SELECTORS,
  inProgressPhrases: [],
  readySelectors: READY_SELECTORS,
  trigger: triggerVideoOverview,
  download: downloadVideoOverview,
});
