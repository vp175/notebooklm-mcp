/**
 * Mind Map strategy, registered into the Studio-output engine
 * (studio-outputs.ts). Structured-kind — no file download via the shared
 * `download_studio_output` path; content is extracted via
 * `extractContent()`. (NotebookLM's own viewer does offer a "Download
 * mindmap as image" button inside the sandboxed frame — confirmed live
 * 2026-08-23 via its `aria-label` — but that produces a rendered image,
 * not the structured tree data this server's `extractContent()` is for;
 * not wired up, since the tool schema has no route to it and building one
 * wasn't requested.)
 *
 * TRIGGER FLOW — live-confirmed 2026-08-23: clicking the `flowchart`
 * trigger tile opens a "Customize Mind Map" dialog (just Sources + a
 * topic-prompt field, no Format/Language options) with a working
 * "Generate" button. Uses the shared `triggerViaDialog` helper
 * (studio-outputs.ts).
 *
 * VIEWER — live-confirmed 2026-08-23 against a real, freshly-generated
 * Mind Map artifact ("Accounting Map"): the viewer renders inside a
 * cross-origin SANDBOXED IFRAME (`blob:https://<id>-h966586903.
 * scf.usercontent.goog/<uuid>`), not the main frame — this is why earlier
 * same-session attempts to read its content via `page.evaluate` always
 * came back empty despite the click genuinely working (see
 * `getSandboxFrame`'s doc comment in studio-outputs.ts for the full
 * story). Inside that frame, the tree is real, accessible ARIA markup:
 * `[role="treeitem"]` elements each carrying `aria-level` (depth) and
 * `aria-label` (the node's text) — confirmed by extracting real node
 * labels ("Evolution and Need", "Benefits of Global Standards", etc.)
 * matching what a screenshot of the same click showed visually.
 *
 * EXPANSION — CORRECTED 2026-08-23, several times (kept here as history —
 * several superficially-plausible theories turned out wrong, and it's easy
 * to retake the same wrong turns without this):
 *   1. The toolbar's "Expand all nodes" button (ligature `expand_all`)
 *      does NOT actually expand anything — live-confirmed by counting
 *      `[role="treeitem"]` elements before/after clicking it (unchanged
 *      even after a further 3s wait).
 *   2. A plain `.click()` on a collapsed node ALSO does not work, despite
 *      Playwright reporting the click as successful. The correct
 *      interaction, matching the tree's own ARIA description ("Press
 *      Enter to expand or collapse"): `locator.focus()` (no click/pointer
 *      event) followed by `page.keyboard.press("Enter")`.
 *   3. An "accordion" theory (expanding one branch collapses a previously
 *      expanded sibling) looked right from a noisy multi-run diagnostic but
 *      was WRONG — that diagnostic reused the same persistent Chrome
 *      profile/page across several earlier test scripts, so its "before"
 *      state already had leftover expansion baked in.
 *   4. On open, the tree briefly flash-renders a much larger item burst
 *      before settling to its true initial collapsed state within well
 *      under a second — reading too early (right after
 *      `waitFor({state:"attached"})`, which only confirms SOMETHING is
 *      present) can grab a mid-transition element as "root". Worse, the
 *      widget doesn't reliably put the true root first in DOM order even
 *      once settled — it can auto-focus a different branch on open.
 *      `aria-level="1"` is the reliable way to find the true root; a
 *      count-stability wait (`waitForTreeSettled`) is required before
 *      reading anything, both on open and after every expand action.
 *   5. **A newly-revealed child does NOT reliably land at the tail of the
 *      flat `[role="treeitem"]` list.** It was live-confirmed to sometimes
 *      append there and sometimes insert earlier — e.g. a node nested
 *      under an EARLIER sibling's subtree can insert its children ahead of
 *      where a not-yet-touched LATER sibling's own children will later
 *      land, shifting everything after them. A positional
 *      `slice(beforeCount)` diff silently grabbed the wrong span once this
 *      happened, deterministically under-capturing every subsequent
 *      sibling — reproduced byte-for-byte identically across five
 *      different wait/scroll/retry fixes before the actual cause (a
 *      positional assumption, not a timing race) was found. The working
 *      fix (`expandAndCaptureNode` below): snapshot every label present
 *      BEFORE expanding a node, and after expanding, take whatever labels
 *      are present now that weren't before (a set difference, not a
 *      positional slice) as its children — correct regardless of where in
 *      the DOM they land. Root's own children are the one exception: they
 *      arrive pre-rendered on load (no expansion needed, so no "before"
 *      set to diff against) and are read directly by `aria-level`.
 *   6. **Completeness is proven only by the declared child count** (the
 *      ", N children" aria-label suffix) matching what was captured.
 *      CORRECTED 2026-08-23: a mismatch was flagged as `incomplete`, but the
 *      suffix failing to PARSE (non-English locale, reformatted label) and
 *      the expand keypress never taking effect both fell through the same
 *      gate and returned a truncated tree as if it were complete. Every
 *      unverifiable outcome is now flagged with its own `reason`, and
 *      `MindMapResult` carries a top-level `incomplete`/`incompleteNodes`
 *      summary so a flag buried deep in the tree cannot be missed.
 */

import type { Page, Frame, Locator } from "patchright";
import { Selectors } from "./selectors.js";
import {
  registerStudioStrategy,
  triggerViaDialog,
  openStructuredViewer,
  getSandboxFrame,
} from "./studio-outputs.js";
import type { StudioTriggerOptions, StudioTriggerOutcome } from "./studio-outputs.js";

const TRIGGER_SELECTORS = Selectors.studio.mindmapButton;
const READY_SELECTORS = Selectors.studio.mindmapTile;

// `opts` must be declared and forwarded: the engine calls
// `strategy.trigger(page, { customPrompt })`, and a trigger that takes only
// `page` silently discards it — generation then runs over the whole
// notebook while the tool reports success.
async function triggerMindMap(
  page: Page,
  opts: StudioTriggerOptions
): Promise<StudioTriggerOutcome> {
  return triggerViaDialog(page, TRIGGER_SELECTORS, "Mind Map entry", {
    customPrompt: opts.customPrompt,
  });
}

export interface MindMapNode {
  label: string;
  children: MindMapNode[];
  /**
   * Present whenever this node's children could NOT be verified complete —
   * an honest signal of a partial read, never silently dropped.
   *
   * CORRECTED 2026-08-23: this used to be set ONLY when a parsed
   * `", N children"` suffix disagreed with what was captured, which meant
   * the two ways a read most plausibly goes wrong — the suffix not parsing
   * at all, and the expand keypress never taking effect — returned a
   * truncated tree that looked complete. Now the parsed count is treated as
   * the ONLY positive proof of completeness: when it is absent, the node is
   * flagged with the most specific reason available.
   *
   * `reason`:
   *   - `child-count-mismatch`   — suffix parsed, captured a different number.
   *   - `expansion-unverified`   — `aria-expanded` never turned `"true"`
   *                                within the timeout, so whatever was
   *                                captured may be a fraction of the subtree.
   *   - `no-children-captured`   — the node advertises children
   *                                (`aria-expanded` present) but none were
   *                                seen after expanding.
   *   - `child-count-unverifiable` — expansion looked fine and children were
   *                                captured, but the English-only
   *                                `", N children"` suffix could not be
   *                                parsed, so completeness is unprovable.
   *                                In a non-English locale EVERY parent node
   *                                carries this; that is deliberate — it is
   *                                the truth, not a defect.
   */
  incomplete?: {
    reason:
      | "child-count-mismatch"
      | "expansion-unverified"
      | "no-children-captured"
      | "child-count-unverifiable";
    /** Declared count from the aria-label suffix; absent when unparseable. */
    expectedChildren?: number;
    capturedChildren: number;
  };
}

export interface MindMapResult {
  root: MindMapNode;
  /** Present only when at least one node carries `incomplete` — a
   * top-level summary so a caller cannot miss a partial read buried deep in
   * the tree. */
  incomplete?: true;
  /** How many nodes carry an `incomplete` flag (present with `incomplete`). */
  incompleteNodes?: number;
}

const CHILD_COUNT_SUFFIX = /,\s*(\d+)\s+children?$/i;

function parseDeclaredChildCount(rawLabel: string): number | null {
  const m = rawLabel.match(CHILD_COUNT_SUFFIX);
  return m ? Number(m[1]) : null;
}

function cleanLabel(rawLabel: string): string {
  return rawLabel.replace(CHILD_COUNT_SUFFIX, "");
}

/**
 * Polls (rather than a fixed sleep) until `itemLocator`'s own
 * `aria-expanded` attribute actually reads `"true"`. A fixed 250ms wait
 * was previously used here and was marginal — `aria-expanded` was
 * confirmed live to sometimes take longer than that to commit, and
 * proceeding before it does risks the loop re-focusing the SAME node and
 * pressing Enter again, which toggles it back closed.
 */
async function waitForExpanded(
  itemLocator: Locator,
  page: Page,
  timeoutMs = 5_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await itemLocator.getAttribute("aria-expanded").catch(() => null)) === "true") return true;
    await page.waitForTimeout(100);
  }
  return false;
}

interface FlatTreeItem {
  level: number;
  label: string;
}

async function readFlatTreeItems(frame: Frame): Promise<FlatTreeItem[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll('[role="treeitem"]')).map((el) => ({
      level: Number(el.getAttribute("aria-level") || "1"),
      label: el.getAttribute("aria-label") || el.textContent?.trim() || "",
    }))
  );
}

/**
 * Depth-first, capture-as-you-go extraction of one tree node and its
 * subtree. See the module header (point 5) for why children must be
 * identified by a before/after label-set difference around the expand
 * action rather than by DOM adjacency/position.
 *
 * `itemLocator` must resolve to exactly this node's own element for the
 * entire call.
 */
async function expandAndCaptureNode(
  frame: Frame,
  page: Page,
  itemLocator: Locator
): Promise<MindMapNode> {
  const rawLabel =
    (await itemLocator.getAttribute("aria-label")) || (await itemLocator.textContent()) || "";
  const label = cleanLabel(rawLabel);
  const declaredChildren = parseDeclaredChildCount(rawLabel);
  const level = Number((await itemLocator.getAttribute("aria-level").catch(() => "1")) || "1");
  const ariaExpanded = await itemLocator.getAttribute("aria-expanded").catch(() => null);

  // `aria-expanded` is `null` only on genuine childless leaves (confirmed
  // live) and locale-independent, unlike parsing the English-only
  // ", N children" aria-label suffix (`declaredChildren`, used below only
  // for the optional honesty check). Gating on the parsed count instead
  // would silently treat a real non-English (or reformatted) parent as a
  // leaf, dropping its whole subtree with no `incomplete` signal at all —
  // exactly the failure this field exists to prevent.
  if (ariaExpanded === null) return { label, children: [] };

  let newItems: FlatTreeItem[];
  // The root arrives already expanded, so there is nothing to verify there;
  // every other node's expansion is only "verified" if `aria-expanded`
  // actually committed to `"true"` within the timeout.
  let expansionVerified = true;
  if (ariaExpanded === "true") {
    // Only the root arrives already expanded, with its direct children
    // pre-rendered on load rather than appended dynamically — there is no
    // "before" state to diff against, so read them directly by level.
    newItems = (await readFlatTreeItems(frame)).filter((it) => it.level === level + 1);
  } else {
    const before = await readFlatTreeItems(frame);
    const beforeLabels = new Set(before.map((it) => it.label));
    await itemLocator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
    await itemLocator.focus({ timeout: 5_000 }).catch(() => undefined);
    await page.keyboard.press("Enter");
    expansionVerified = await waitForExpanded(itemLocator, page);
    await waitForTreeSettled(frame, page);
    const after = await readFlatTreeItems(frame);
    // A newly-revealed child does NOT reliably land at the tail of the
    // flat list — live-confirmed: expanding a node nested under an
    // EARLIER sibling's subtree can insert its children ahead of where a
    // not-yet-touched LATER top-level sibling's own children later land,
    // shifting everything after them. A positional `slice(beforeCount)`
    // silently grabbed the wrong span once this happened, deterministically
    // under-capturing every subsequent sibling — reproduced identically
    // across five different wait/scroll/retry strategies before this was
    // found, none of which could have fixed a position-based bug. Set
    // difference by label is immune to wherever in the array new items land.
    newItems = after.filter((it) => it.level === level + 1 && !beforeLabels.has(it.label));
  }

  const children: MindMapNode[] = [];
  const seenCount = new Map<string, number>();
  for (const item of newItems) {
    const occurrence = seenCount.get(item.label) ?? 0;
    seenCount.set(item.label, occurrence + 1);
    // `getByRole` matches by accessible name and re-resolves fresh on
    // every action, so it stays correct even as recursing into earlier
    // children appends more items elsewhere in the DOM. It matches
    // frame-WIDE though, not scoped to this node's own subtree (the tree
    // is flat siblings in the DOM, not nested — see module header point
    // 5 — so there's no ancestor to scope a descendant search to).
    // Intersecting with the expected `aria-level` narrows a same-label
    // collision to same-label-AND-same-depth, which is not a full
    // guarantee against a duplicate elsewhere in an already-expanded
    // sibling branch at the identical depth, but meaningfully reduces it
    // for the common case (not observed live in either verified tree).
    const childLocator = frame
      .getByRole("treeitem", { name: item.label, exact: true })
      .and(frame.locator(`[aria-level="${level + 1}"]`))
      .nth(occurrence);
    children.push(await expandAndCaptureNode(frame, page, childLocator));
  }

  const node: MindMapNode = { label, children };
  // A parsed `", N children"` suffix that matches what was captured is the
  // ONLY positive proof this node's subtree is complete. Every other outcome
  // is flagged — previously the `declaredChildren !== null &&` gate meant an
  // unparseable suffix (or a keypress that never expanded anything) returned
  // a truncated tree that looked complete, bypassing this module's own
  // partial-read convention.
  if (declaredChildren !== null) {
    if (children.length !== declaredChildren) {
      node.incomplete = {
        reason: "child-count-mismatch",
        expectedChildren: declaredChildren,
        capturedChildren: children.length,
      };
    }
  } else if (!expansionVerified) {
    node.incomplete = { reason: "expansion-unverified", capturedChildren: children.length };
  } else if (children.length === 0) {
    node.incomplete = { reason: "no-children-captured", capturedChildren: 0 };
  } else {
    node.incomplete = { reason: "child-count-unverifiable", capturedChildren: children.length };
  }
  return node;
}

/** Counts nodes carrying an `incomplete` flag, for the result-level summary. */
function countIncompleteNodes(node: MindMapNode): number {
  return (node.incomplete ? 1 : 0) + node.children.reduce((n, c) => n + countIncompleteNodes(c), 0);
}

/**
 * On open, the tree briefly renders a much larger item burst (58 seen live
 * against a fresh artifact) before settling to its true initial collapsed
 * state (6: root + its direct children) within well under a second.
 * Reading immediately after `waitFor({state:"attached"})` — which only
 * confirms SOMETHING is present, not that this transient has finished —
 * was confirmed live to occasionally grab a stale/mid-transition element
 * as "root", producing a single-leaf result with a nonsensical label
 * pulled from deep in the burst. Wait for the count to stop changing
 * across consecutive polls before reading anything.
 */
async function waitForTreeSettled(frame: Frame, page: Page, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let stableStreak = 0;
  // Requires a full ~3s of an unchanging count before proceeding. A short
  // streak (previously 3 checks / ~600ms) was live-confirmed to
  // occasionally latch onto an intermediate plateau mid-collapse rather
  // than the true final settled state, silently reading the wrong root
  // and children. The real settle (once reached) was observed to hold
  // rock-stable for 8+ seconds, so a 3s quiet window is conservative
  // without meaningfully slowing extraction down.
  while (Date.now() < deadline) {
    const count = await frame.locator('[role="treeitem"]').count();
    if (count === lastCount) {
      stableStreak++;
      if (stableStreak >= 10) return;
    } else {
      stableStreak = 0;
      lastCount = count;
    }
    await page.waitForTimeout(300);
  }
}

async function extractMindMap(page: Page): Promise<MindMapResult> {
  await openStructuredViewer(page, READY_SELECTORS);
  const frame = await getSandboxFrame(page);
  // `getSandboxFrame` only confirms the frame EXISTS, not that its Angular
  // app has finished rendering the tree.
  await frame
    .locator('[role="treeitem"][aria-level="1"]')
    .first()
    .waitFor({ state: "attached", timeout: 15_000 });
  await waitForTreeSettled(frame, page);

  // The tree's true root is NOT reliably the first `[role="treeitem"]` in
  // DOM order — live-confirmed: on some opens the widget auto-focuses a
  // different branch, reordering it first in the DOM while it is really a
  // level-3+ descendant. `aria-level="1"` is the reliable identifier.
  const rootLocator = frame.locator('[role="treeitem"][aria-level="1"]').first();
  const root = await expandAndCaptureNode(frame, page, rootLocator);
  const incompleteNodes = countIncompleteNodes(root);
  // Surface partiality at the top level too: a single flagged node buried
  // several levels down is easy to miss in a large tree.
  return incompleteNodes > 0 ? { root, incomplete: true, incompleteNodes } : { root };
}

// Kind ("structured") comes from STRUCTURED_KIND_TYPES via `studioKindOf`
// in the engine, not from this object — see studio-outputs.ts.
registerStudioStrategy("mindmap", {
  triggerSelectors: TRIGGER_SELECTORS,
  // No in-progress DOM/text was observed live this session (mirrors the
  // same empty-array convention used by video-overview.ts/slides.ts). An
  // empty list means the engine has no DOM signal for this type at all —
  // repeat-call protection comes from its in-flight record instead.
  inProgressPhrases: [],
  readySelectors: READY_SELECTORS,
  trigger: triggerMindMap,
  extractContent: extractMindMap,
});
