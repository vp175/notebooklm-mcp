/**
 * NotebookLM chat extraction with streaming-stability detection.
 *
 * Replaces the legacy `waitForLatestAnswer()` (issue #43). Old logic gated on
 * `div.thinking-message`, which Google removed; calls timed out even though
 * the answer was visible. New logic only relies on the answer container itself
 * and treats text as final once it has been *stable* across N consecutive
 * polls (default 3). That makes the wait robust to UI churn and Material-icon
 * leaks (`more_vert`, `more_horiz`, …) which would otherwise destabilise the
 * extracted text.
 *
 * Companion fixes:
 * - issue #14 / #27 — timeout is fully configurable per call
 * - issue #16    — bounded polls + sleep fallback to defuse zombie pages
 * - issue #28    — sanitisation strips UI-control labels before delivery
 */

import type { Page } from "patchright";
import { Selectors } from "./selectors.js";
import { isRecoverable, pageIsAlive, safeSleep } from "../browser/watchdog.js";
import { RateLimitError } from "../errors.js";

/**
 * Loading-state phrases NotebookLM streams into the answer container before
 * the real response arrives. The stability detector would otherwise lock
 * onto these (they're "stable" while Gemini still thinks). Coverage spans
 * the eight major NotebookLM locales (EN, DE, FR, ES, PT, IT, NL, JA).
 */
const PLACEHOLDER_SNIPPETS = [
  // English
  "answer is being created",
  "answer is being generated",
  "creating answer",
  "generating answer",
  "getting the context",
  "getting the gist",
  "loading",
  "please wait",
  "looking for clues",
  "reading full chapters",
  "examining the specifics",
  "checking the scope",
  "opening your notes",
  "analyzing your files",
  "searching your docs",
  "scanning sources",
  "reviewing content",
  "processing request",
  "parsing the data",
  "gathering the facts",
  "thinking",
  "searching",
  // German
  "antwort wird erstellt",
  "antwort wird generiert",
  "wird erstellt",
  "wird generiert",
  "lädt",
  "wird geladen",
  "bitte warten",
  "quellen werden gescannt",
  "kontext wird abgerufen",
  "denke nach",
  // French
  "analyse en cours",
  "génération en cours",
  "réponse en cours",
  "chargement en cours",
  "veuillez patienter",
  "recherche en cours",
  // Spanish
  "generando respuesta",
  "creando respuesta",
  "cargando",
  "espere por favor",
  "buscando",
  "analizando",
  // Italian
  "generazione della risposta",
  "creazione della risposta",
  "caricamento",
  "attendere",
  "ricerca in corso",
  "analisi in corso",
  // Portuguese
  "gerando resposta",
  "criando resposta",
  "carregando",
  "por favor aguarde",
  "procurando",
  "analisando",
  // Dutch
  "antwoord wordt gegenereerd",
  "antwoord wordt gemaakt",
  "laden",
  "even geduld",
  "zoeken",
  "analyseren",
  // Japanese
  "回答を生成しています",
  "読み込み中",
  "お待ちください",
  "検索中",
  "分析中",
];

const ERROR_SNIPPETS = [
  // English
  "the system could not respond",
  "the system failed",
  "an error occurred",
  "try again later",
  // German
  "das system konnte keine antwort erstellen",
  "das system konnte nicht antworten",
  "es ist ein fehler aufgetreten",
  "versuche es später erneut",
  "versuchen sie es später erneut",
  // French
  "le système n'a pas pu répondre",
  "le système n'a pas réussi",
  "une erreur est survenue",
  "réessayez plus tard",
  // Spanish
  "el sistema no pudo responder",
  "ha ocurrido un error",
  "vuelve a intentarlo más tarde",
  "inténtalo de nuevo más tarde",
  // Italian
  "il sistema non è riuscito a rispondere",
  "si è verificato un errore",
  "riprova più tardi",
  // Portuguese
  "o sistema não pôde responder",
  "ocorreu um erro",
  "tente novamente mais tarde",
  // Dutch
  "het systeem kon niet reageren",
  "er is een fout opgetreden",
  "probeer het later opnieuw",
  // Japanese
  "システムが応答できませんでした",
  "エラーが発生しました",
  "後でもう一度お試しください",
];

const RATE_LIMIT_MESSAGES = [
  // English
  "daily discussion limit",
  "daily limit reached",
  "query limit reached",
  "rate limit exceeded",
  // German
  "tägliches diskussionslimit",
  "tageslimit erreicht",
  "ratenlimit überschritten",
  // French
  "vous avez atteint la limite quotidienne",
  "limite quotidienne de discussions",
  "limite quotidienne atteinte",
  // Spanish
  "límite diario alcanzado",
  "has alcanzado el límite diario",
  // Italian
  "limite giornaliero raggiunto",
  "hai raggiunto il limite giornaliero",
  // Portuguese
  "limite diário atingido",
  "você atingiu o limite diário",
  // Dutch
  "daglimiet bereikt",
  // Japanese
  "1日あたりの上限に達しました",
];

/**
 * Recognise a loading banner — and *only* a loading banner.
 *
 * WHY the shape test: the previous rule was `lower.includes(snippet)` over a
 * list containing ordinary words ("thinking", "searching", "loading",
 * "reviewing content", "gathering the facts"). Any genuine answer that merely
 * used one of those words was classified as a placeholder on every poll, so
 * `waitForStableAnswer` never accepted it and the call burned the full
 * 10-minute timeout before returning `null` ("no answer").
 *
 * A placeholder must now satisfy BOTH:
 *   (a) it is banner-shaped — short (< 200 chars) or carrying no
 *       sentence-ending punctuation; a real answer is long *and* punctuated;
 *   (b) a snippet is the whole trimmed text or opens it — never a substring
 *       buried mid-answer.
 * The legacy "short text ending in ..." rule is kept as an independent path.
 */
function isPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Short text ending with "..." is almost certainly a loading indicator;
  // real responses run well past 50 chars.
  if (trimmed.length < 50 && trimmed.endsWith("...")) return true;

  // (a) banner-shaped?
  const bannerShaped = trimmed.length < 200 || !/[.!?。！？]/.test(trimmed);
  if (!bannerShaped) return false;

  // (b) snippet at the start (leading glyphs/quotes — "⏳ Thinking…" — first
  // stripped) or as the entire text.
  const lower = trimmed.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "");
  return PLACEHOLDER_SNIPPETS.some((s) => lower === s || lower.startsWith(s));
}

/**
 * Is this text SHAPED like one of NotebookLM's own banners rather than an
 * answer that merely talks about errors?
 *
 * Same rule the placeholder check uses, and for the same reason: a bare
 * `includes()` over the whole answer misfires on real content. Ask a
 * troubleshooting notebook "what does the user see when the sync fails?" and
 * the answer legitimately contains "an error occurred … try again later"; ask
 * an API notebook about throttling and it contains "rate limit exceeded".
 * Without a shape gate those answers were THROWN as failures — and the
 * rate-limit one reached the caller as the 50-queries/day quota message,
 * advising the user to re-authenticate for no reason.
 */
function bannerShaped(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.length < 200 || !/[.!?。！？]/.test(trimmed);
}

/** Strip leading glyphs/quotes so "⚠️ An error occurred" still matches. */
function bannerBody(text: string): string {
  return text.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "");
}

/**
 * Match like `isPlaceholder`: the snippet must BE the text or OPEN it.
 *
 * `includes()` was still in here and subsumed the other two, so the length gate
 * was the only real guard and short real answers still tripped it — e.g. "The
 * guide says to wait a few minutes and try again later." (57 chars) was thrown
 * as a NotebookLM error, and "The API returns 429 when the rate limit exceeded
 * threshold is hit." was reported to the user as their daily quota.
 */
function bannerMatches(text: string, snippets: readonly string[]): boolean {
  if (!bannerShaped(text)) return false;
  const body = bannerBody(text);
  return snippets.some((s) => body === s || body.startsWith(s));
}

function isErrorMessage(text: string): boolean {
  return bannerMatches(text, ERROR_SNIPPETS);
}

function isRateLimitText(text: string): boolean {
  return bannerMatches(text, RATE_LIMIT_MESSAGES);
}

/**
 * Condense a NotebookLM banner into one bounded line for an Error message —
 * the raw banner can be multi-line and arbitrarily long, and it ends up in
 * the tool's user-facing `error` string.
 */
function banner(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
}

export interface AskOptions {
  /** The question text — used to skip echo lines that NotebookLM mirrors back. */
  question?: string;
  /** Hard ceiling on the wait. Default 600 000 ms (10 min) — overridable per call. */
  timeoutMs?: number;
  /** Poll cadence. Default 750 ms. Lower values increase load without much benefit. */
  pollIntervalMs?: number;
  /** Texts known *before* the question was submitted. Used to skip prior answers. */
  ignoreTexts?: string[];
  /**
   * How many answer containers existed before the question was submitted.
   *
   * REQUIRED: the whole "read this turn's own container" rule — the only thing
   * that lets an answer identical to an earlier one be accepted, and the only
   * thing that stops an older container being read — exists solely when this is
   * supplied. Optional, it could be dropped by a future caller and the
   * identical-answer hang would come back silently, so tsc enforces it.
   */
  priorAnswerCount: number;
  /** How many consecutive identical polls count as "answer settled". Default 3. */
  stablePolls?: number;
}

/**
 * Comparison key for "is this the same answer text?".
 *
 * Runs of whitespace are collapsed so that a prior answer NotebookLM
 * re-renders with cosmetically different wrapping still matches its snapshot
 * instead of looking like a brand-new turn.
 */
function answerKey(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Snapshot every visible assistant answer text *before* a new question is
 * submitted. Pass the result into `waitForStableAnswer({ ignoreTexts })` so
 * the new turn isn't confused with prior turns in the same session.
 *
 * WHY sanitised: this used to return raw `innerText`, while the live
 * comparison in `waitForStableAnswer` sees `sanitizeAnswer(raw)`. As soon as
 * a prior answer contained UI-control leakage (`more_vert`, a lone citation
 * digit, …) the raw snapshot could never equal the sanitised candidate, so
 * the *previous* turn's answer was not recognised as prior — and, being
 * already stable, was returned verbatim as the answer to the new question.
 */
export async function snapshotPriorAnswers(page: Page): Promise<string[]> {
  return page
    .locator(Selectors.chat.answerText)
    .allInnerTexts()
    .then((texts) => texts.map((t) => sanitizeAnswer(t)).filter(Boolean))
    .catch(() => []);
}

/**
 * Every answer container's sanitised text, in DOM order (empty ones included
 * as ""), read in ONE round trip.
 *
 * The count and the text must come from the same observation. When they came
 * from two separate reads — or worse, two different selectors — the wait could
 * see "a new container exists" while still reading the PREVIOUS turn's text,
 * and return that as the answer.
 */
export async function readAnswerTexts(page: Page): Promise<string[]> {
  return page
    .locator(Selectors.chat.answerText)
    .allInnerTexts()
    .then((texts) => texts.map((t) => sanitizeAnswer(t)))
    .catch(() => []);
}

/** How many answer containers are on the page right now. */
export async function countAnswerContainers(page: Page): Promise<number> {
  return readAnswerTexts(page).then((t) => t.length);
}


/**
 * Wait for the *latest* answer text to appear and stabilise.
 *
 * Returns the sanitised final text, or `null` on timeout. Ordinary UI hiccups
 * never surface as exceptions — they are retried on the next poll — but three
 * conditions do throw, because they are not "no answer yet":
 *   - `RateLimitError` when NotebookLM renders a quota banner;
 *   - a plain `Error` when it renders a hard-error banner;
 *   - a plain `Error` when the renderer stops answering the health check.
 * `browser-session.ts#ask()` lets all three propagate; `handleAskQuestion`
 * already special-cases `RateLimitError` and reports the rest as a failure —
 * which is the point: a banner must not be reported as a successful answer.
 */
export async function waitForStableAnswer(
  page: Page,
  options: AskOptions
): Promise<string | null> {
  const {
    question = "",
    timeoutMs = 600_000,
    pollIntervalMs = 750,
    ignoreTexts = [],
    priorAnswerCount,
    stablePolls = 3,
  } = options;


  const deadline = Date.now() + timeoutMs;
  const echoLower = question.trim().toLowerCase();
  // Ignore-list keys hold BOTH the raw snapshot text and its sanitised form.
  // `snapshotPriorAnswers` now sanitises, but the legacy fallback snapshot in
  // browser-session.ts still hands over raw `innerText`, and only a sanitised
  // key can ever equal a candidate coming out of `readAnswerTexts`.
  const ignoreKeys = new Set<string>();
  for (const text of ignoreTexts) {
    const raw = answerKey(text);
    if (raw) ignoreKeys.add(raw);
    const cleaned = answerKey(sanitizeAnswer(text));
    if (cleaned) ignoreKeys.add(cleaned);
  }
  // Hard ceiling on poll iterations defends against pathological
  // pollIntervalMs values combined with zombie-page sleep returns (issue #16).
  const maxPolls = Math.max(8, Math.ceil(timeoutMs / Math.max(50, pollIntervalMs)) + 4);

  let lastSeen: string | null = null;
  let stableStreak = 0;
  let pollCount = 0;


  while (Date.now() < deadline && pollCount < maxPolls) {
    pollCount++;

    // Every 10th poll we make sure the renderer still answers — bounded so a
    // wedged tab can't keep us spinning until the deadline (issue #16).
    if (pollCount % 10 === 0 && !(await pageIsAlive(page))) {
      throw new Error("Browser page unresponsive: health check timed out");
    }

    // ONE observation per poll: the same read answers both "is there a new
    // container?" and "what does it say?". Two separate reads let the wait
    // believe a new answer had arrived while it was still looking at the
    // previous turn's text.
    let texts: string[] = [];
    try {
      texts = await readAnswerTexts(page);
    } catch (err) {
      if (isRecoverable(err)) throw err;
      // Non-fatal extraction blip — try again next tick.
    }

    let candidate: string | null = null;
    let candidateIsNewTurn = false;

    if (texts.length > priorAnswerCount) {
      // At least one container appeared for THIS turn. Look ONLY within this
      // turn's containers (index >= priorAnswerCount):
      //  - never an older one, so an answer identical to an earlier one is
      //    still recognised as this turn's and stale text can never be
      //    substituted;
      //  - last non-empty rather than strictly the last, so a trailing empty
      //    container (a suggestions block, or the answer's own container
      //    before it paints) does not stall the wait.
      // While every new container is still empty we simply keep waiting.
      // LONGEST non-empty wins, not simply the last: a trailing block that
      // paints before the answer (suggestions, actions) would otherwise be
      // taken as the answer, and an answer element that is still empty would
      // otherwise stall the wait. Bounded to indices >= priorAnswerCount, so an
      // older container can never be read whatever it contains.
      for (let i = priorAnswerCount; i < texts.length; i++) {
        const own = texts[i] ?? "";
        if (own.length > (candidate?.length ?? 0)) {
          candidate = own;
          candidateIsNewTurn = true;
        }
      }
    } else {
      // No prior count (or none appeared yet): fall back to the last container
      // that has text, guarded by the ignore list below.
      for (let i = texts.length - 1; i >= 0; i--) {
        const t = texts[i] ?? "";
        if (t.length > 0) {
          candidate = t;
          break;
        }
      }
    }

    if (candidate) {
      const isEcho = candidate.toLowerCase() === echoLower;
      // The ignore list only applies when we could NOT identify this turn's own
      // container. Once we are reading that container, its text is this turn's
      // answer whatever it says — that is what makes a repeated question work.
      const isPrior = !candidateIsNewTurn && ignoreKeys.has(answerKey(candidate));

      if (!isEcho && !isPrior) {
        // Loading placeholders ("Parsing the data…", "Thinking…", …) are
        // stable while Gemini is still working — the old code locked on to
        // them and returned them as the final answer. Filter them out.
        if (isPlaceholder(candidate)) {
          stableStreak = 0;
          lastSeen = null;
          await safeSleep(page, Math.min(pollIntervalMs, 400));
          continue;
        }

        // Hard errors and rate-limit banners still short-circuit the wait —
        // no "stable" follow-up text is coming — but they must NOT be handed
        // back as if they were the answer: the caller reported the banner
        // text to the user as a successful response. Throwing keeps this
        // function's signature intact while making the outcome unmistakable.
        // Rate limit is tested first: a quota banner often also contains
        // "try again later", which is an ERROR_SNIPPETS phrase.
        if (isRateLimitText(candidate)) {
          // Do NOT assert a specific quota here: the banner text is the only
          // evidence, the limit differs by plan (a Google AI Pro account is
          // ~5x the free tier), and telling a Pro user they hit "50/day" sends
          // them to re-authenticate for no reason. Report what NotebookLM said.
          throw new RateLimitError(`NotebookLM reported a usage limit: ${banner(candidate)}`);
        }
        if (isErrorMessage(candidate)) {
          throw new Error(`NotebookLM returned an error: ${banner(candidate)}`);
        }

        if (candidate === lastSeen) {
          stableStreak++;
          if (stableStreak >= stablePolls) {
            return candidate;
          }
        } else {
          lastSeen = candidate;
          stableStreak = 1;
        }
      }
    }

    await safeSleep(page, pollIntervalMs);
  }

  return null;
}



/**
 * Strip Material-icon labels (`more_vert`, `more_horiz`, …) and orphaned
 * citation markers that NotebookLM occasionally leaks into `innerText`.
 * Only isolated lines are removed — never inline content — so legitimate
 * answer prose with the same words ("more horizontal") is not touched.
 */
export function sanitizeAnswer(text: string): string {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim());

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (Selectors.uiControlLabels.has(line)) continue;

    // Drop lone digits or punctuation flanking a UI-control label
    // (typical citation-marker leak: ["1", "more_vert"]).
    const next = lines[i + 1] ?? "";
    const prev = lines[i - 1] ?? "";
    const nextIsControl = Selectors.uiControlLabels.has(next);
    const prevIsControl = Selectors.uiControlLabels.has(prev);
    if (/^\d+$/.test(line) && nextIsControl) continue;
    if (/^[.,;:!?]+$/.test(line) && (nextIsControl || prevIsControl)) continue;

    kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();
}
