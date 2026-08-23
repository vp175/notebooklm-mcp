/**
 * Data Table strategy, registered into the Studio-output engine
 * (studio-outputs.ts). Structured-kind — no file download; content is
 * extracted via `extractContent()`.
 *
 * TRIGGER FLOW — live-confirmed 2026-08-23: clicking the `table_view`
 * trigger tile opens a "Customize Data Table" dialog (Language, Sources,
 * a topic-prompt field) with a working "Generate" button. Uses the shared
 * `triggerViaDialog` helper (studio-outputs.ts).
 *
 * VIEWER — live-confirmed 2026-08-23 against a real, freshly-generated
 * Data Table artifact ("Classification and Accounting Principles for
 * Joint Arrangements under Ind AS 111", 7 columns x 8 rows): UNLIKE Mind
 * Map/Flashcards/Quiz, Data Table's viewer renders as a plain `<table>`
 * directly in the MAIN frame — no cross-origin sandboxed iframe involved.
 * Confirmed by checking `page.frames()` after opening the viewer: only the
 * standard notebook/account frames were present, no
 * `*.scf.usercontent.goog` frame.
 *
 * Three-dot menu offers "Export to Sheets", not a direct file download —
 * deliberately NOT used here. Exporting would create a new Google Sheet in
 * the user's Drive, a materially different and more invasive action than
 * reading the table's own DOM content, which this server has no business
 * doing without being asked.
 */

import type { Page } from "patchright";
import { Selectors } from "./selectors.js";
import {
  registerStudioStrategy,
  triggerViaDialog,
  openStructuredViewer,
} from "./studio-outputs.js";

const TRIGGER_SELECTORS = Selectors.studio.dataTableButton;
const READY_SELECTORS = Selectors.studio.dataTableTile;

async function triggerDataTable(page: Page): Promise<void> {
  await triggerViaDialog(page, TRIGGER_SELECTORS, "Data Table entry");
}

export interface DataTableContent {
  headers: string[];
  rows: string[][];
}

async function extractDataTable(page: Page): Promise<DataTableContent> {
  await openStructuredViewer(page, READY_SELECTORS);
  const table = page.locator("table").first();
  await table.waitFor({ state: "visible", timeout: 15_000 });

  // Data Table renders in the main frame (not a sandboxed iframe like the
  // other structured types — see module header), so there's no natural
  // isolation from an unrelated `<table>` elsewhere on the page — e.g. a
  // stale, unclosed viewer left open by an earlier call in the same
  // reused session. `page.locator("table").first()` above would silently
  // pick whichever one happens to come first in DOM order; refuse rather
  // than guess if more than one is present.
  const tableCount = await page.locator("table").count();
  if (tableCount > 1) {
    throw new Error(
      `Found ${tableCount} <table> elements on the page — cannot reliably identify the Data Table viewer's own table. A stale viewer from an earlier call may still be open.`
    );
  }

  return page.evaluate(() => {
    const t = document.querySelector("table");
    if (!t) throw new Error("Data Table viewer's <table> disappeared before it could be read.");
    const trs = Array.from(t.querySelectorAll("tr"));
    const headers = Array.from(trs[0]?.children || []).map((c) => c.textContent?.trim() || "");
    const rows = trs
      .slice(1)
      .map((r) => Array.from(r.children).map((c) => c.textContent?.trim() || ""));
    return { headers, rows };
  });
}

registerStudioStrategy("datatable", {
  kind: "structured",
  triggerSelectors: TRIGGER_SELECTORS,
  // No in-progress DOM/text was observed live this session (mirrors the
  // same empty-array convention used by video-overview.ts/slides.ts).
  inProgressPhrases: [],
  readySelectors: READY_SELECTORS,
  trigger: triggerDataTable,
  extractContent: extractDataTable,
});
