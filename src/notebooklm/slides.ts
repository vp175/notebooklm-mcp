/**
 * Slide Deck strategy, registered into the Studio-output engine
 * (studio-outputs.ts). Same shape as video-overview.ts/infographic.ts, with
 * one difference: Slide Deck's three-dot menu offers TWO download formats
 * (confirmed live 2026-08-23, real artifact in a test notebook:
 * "Download PDF Document (.pdf)" and "Download
 * PowerPoint (.pptx)", plus Share/Rename/"Start slideshow"/Revise/"View
 * prompt and sources"/Delete). `download()` here defaults to the PDF item
 * — a deliberate, documented choice, not an oversight — since the
 * `download_studio_output` tool schema has no per-type format parameter
 * today. Add one (and a `pptx` variant here) if a user actually needs the
 * PowerPoint file; not built speculatively.
 *
 * `inProgressPhrases` starts empty for the same reason as
 * video-overview.ts: no in-progress DOM/text was observed live this
 * session (only already-completed artifacts existed to inspect).
 *
 * TRIGGER FLOW — live-confirmed 2026-08-23: clicking the `tablet` trigger
 * tile opens a "Customize Slide Deck" dialog (Format: Detailed Deck/
 * Presenter Slides, Language, Length) with a working "Generate" button —
 * directly observed and closed cleanly, not inferred. Uses the shared
 * `triggerViaDialog` helper (studio-outputs.ts).
 *
 * DOWNLOAD FLOW — `downloadViaSingleMenuItem` (used here for the PDF item)
 * had a real bug, fixed 2026-08-23: it listened for the browser `download`
 * event on the wrong page (clicking a download menu item opens a NEW popup
 * page; the event fires there, not on the original page). Fixed and
 * verified end-to-end against Audio Overview (real 46MB file downloaded);
 * this type's own download has not been individually re-run since the fix.
 */

import type { Page } from "patchright";
import { Selectors } from "./selectors.js";
import {
  registerStudioStrategy,
  triggerViaDialog,
  downloadViaSingleMenuItem,
} from "./studio-outputs.js";
import type { DownloadAudioResult } from "./audio.js";

const TRIGGER_SELECTORS = Selectors.studio.slidesButton;
const READY_SELECTORS = Selectors.studio.slidesTile;
const MORE_MENU_SELECTORS = Selectors.studio.slidesMoreMenuButton;
const DOWNLOAD_PDF_MENU_ITEM_SELECTORS = Selectors.studio.slidesDownloadPdfMenuItem;

async function triggerSlides(page: Page): Promise<void> {
  await triggerViaDialog(page, TRIGGER_SELECTORS, "Slide Deck entry");
}

async function downloadSlides(page: Page, destDir: string): Promise<DownloadAudioResult> {
  return downloadViaSingleMenuItem(
    page,
    MORE_MENU_SELECTORS,
    DOWNLOAD_PDF_MENU_ITEM_SELECTORS,
    destDir,
    "notebooklm-slide-deck.pdf"
  );
}

registerStudioStrategy("slides", {
  kind: "file",
  triggerSelectors: TRIGGER_SELECTORS,
  inProgressPhrases: [],
  readySelectors: READY_SELECTORS,
  trigger: triggerSlides,
  download: downloadSlides,
});
