/**
 * Notebook discovery — scrape the NotebookLM (Gemini Notebook) dashboard
 * for the account's existing notebooks, so notebooks the user created
 * directly in the web UI (never registered via add_notebook) can be found
 * and synced into the local library.
 *
 * Selector verified live 2026-08-23 against notebook.google.com: each row
 * in "My notebooks" renders as `a.project-table-title`, with
 * href="https://notebook.google.com/notebook/<uuid>" and innerText
 * "<emoji icon>\n<title>". No fallback selector is included — per this
 * repo's own convention (see docs/superpowers/plans, Tasks 8/9), a guessed
 * selector that was never checked against a live page is worse than a
 * clear failure. If Google changes the dashboard layout, this needs a
 * fresh live check, not a speculative patch.
 */

import type { BrowserContext } from "patchright";
import { log } from "../utils/logger.js";
import { extractNotebookId } from "../library/notebook-library.js";

export interface DiscoveredNotebook {
  id: string; // notebook UUID parsed from the tile's href
  url: string;
  title: string;
}

export interface DiscoveryResult {
  notebooks: DiscoveredNotebook[];
  /**
   * Set only when zero tiles were found, to disambiguate "this account
   * genuinely has no notebooks" from "the dashboard selector may have
   * rotted" — both currently return an empty list, but callers (and the
   * user) should see the difference rather than a silent empty success.
   */
  note?: string;
}

const DASHBOARD_URL = "https://notebook.google.com/";
const NOTEBOOK_TILE_SELECTOR = "a.project-table-title";

/**
 * Navigate a fresh tab in the given (already-authenticated) shared context
 * to the dashboard and extract every notebook tile. Opens and closes its
 * own page — does not disturb any existing per-notebook session.
 */
export async function discoverNotebooks(context: BrowserContext): Promise<DiscoveryResult> {
  const page = await context.newPage();
  try {
    log.info(`🔍 [discover_notebooks] Loading dashboard: ${DASHBOARD_URL}`);
    await page.goto(DASHBOARD_URL, { waitUntil: "networkidle", timeout: 30000 });

    // Angular Material grid renders after the initial navigation settles.
    const found = await page
      .waitForSelector(NOTEBOOK_TILE_SELECTOR, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    if (!found) {
      const note =
        `No notebook tiles found (selector: ${NOTEBOOK_TILE_SELECTOR}). Either the account ` +
        `genuinely has 0 notebooks, or the dashboard layout has changed since this selector ` +
        `was last verified (2026-08-23) — worth a manual check if you expected notebooks here.`;
      log.warning(`  ⚠️  ${note}`);
      return { notebooks: [], note };
    }

    const tiles = await page.evaluate((selector: string) => {
      return Array.from(document.querySelectorAll(selector)).map((el) => ({
        href: (el as HTMLAnchorElement).href,
        text: (el as HTMLElement).innerText || "",
      }));
    }, NOTEBOOK_TILE_SELECTOR);

    const notebooks: DiscoveredNotebook[] = [];
    for (const tile of tiles) {
      const id = extractNotebookId(tile.href);
      if (!id) continue;

      // Tile text is "<emoji icon>\n<title>" — the icon is its own line;
      // drop it and keep the rest as the title.
      const lines = tile.text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const title = lines.length > 1 ? lines.slice(1).join(" ") : lines[0] || "Untitled notebook";

      notebooks.push({ id, url: tile.href, title });
    }

    log.success(`✅ [discover_notebooks] Found ${notebooks.length} notebook(s) on the dashboard`);
    return { notebooks };
  } finally {
    try {
      await page.close();
    } catch (error) {
      log.warning(`  ⚠️  Error closing discovery page: ${error}`);
    }
  }
}
