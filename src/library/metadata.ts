/**
 * Safe accessors for NotebookEntry metadata.
 *
 * Notebook entries loaded from disk may be missing array fields when written by
 * older versions or by hand. Direct `.join()` / `.map()` on undefined crashed
 * `buildAskQuestionDescription` (issue #33). These helpers always return a
 * defined string, so callers never need to null-check.
 */

import type { NotebookEntry } from "./types.js";

const FALLBACK_USE_CASES: readonly string[] = ["Research and exploration"];

export function getTopicsLine(notebook: NotebookEntry): string {
  return joinNonEmpty(notebook.topics, ", ", "general topics");
}

export function getUseCaseBullets(notebook: NotebookEntry, indent: string = "  "): string {
  const useCases = notebook.use_cases?.filter(isNonEmptyString) ?? [];
  const list = useCases.length > 0 ? useCases : FALLBACK_USE_CASES;
  return list.map((uc) => `${indent}- ${uc}`).join("\n");
}

function joinNonEmpty(value: readonly string[] | undefined, sep: string, fallback: string): string {
  const cleaned = (value ?? []).filter(isNonEmptyString);
  if (cleaned.length === 0) return fallback;
  return cleaned.join(sep);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
