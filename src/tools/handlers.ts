/**
 * MCP Tool Handlers
 *
 * Implements the logic for all MCP tools.
 */

import type { SessionManager } from "../session/session-manager.js";
import type { AuthManager } from "../auth/auth-manager.js";
import type { NotebookLibrary } from "../library/notebook-library.js";
import type {
  AddNotebookInput,
  LibraryStats,
  NotebookEntry,
  UpdateNotebookInput,
} from "../library/types.js";
import type { AddSourceResult } from "../notebooklm/sources.js";
import { discoverNotebooks, type DiscoveredNotebook } from "../notebooklm/discovery.js";
import type { AudioGenerationResult, DownloadAudioResult } from "../notebooklm/audio.js";
import type { StudioOutputType } from "../notebooklm/studio-outputs.js";
import { isStudioTypeImplemented, implementedStudioTypes } from "../notebooklm/studio-outputs.js";
import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { CONFIG, applyBrowserOptions, type BrowserOptions } from "../config.js";
import type { ConfirmContext } from "../index.js";
import { log } from "../utils/logger.js";
import type { AskQuestionResult, ToolResult, ProgressCallback } from "../types.js";
import { RateLimitError } from "../errors.js";
import { CleanupManager } from "../utils/cleanup-manager.js";
import { applyAiMarker, PROVENANCE } from "../utils/disclaimer.js";

/**
 * Follow-up reminder appended to ask_question answers when explicitly enabled.
 * Off by default in v2 (issue #28) — the imperative phrasing reads like
 * adversarial prompt injection to safety-trained host agents and creates
 * noisy false positives. Opt back in via `NOTEBOOKLM_FOLLOW_UP_REMINDER=true`.
 */
const FOLLOW_UP_REMINDER =
  "\n\nIs that all you need to know? You can always ask another question using the same session ID. Before you reply to the user, review their original request and this answer; if anything is still unclear or missing, ask another question first.";

function followUpReminderEnabled(): boolean {
  const raw = process.env.NOTEBOOKLM_FOLLOW_UP_REMINDER;
  if (raw === undefined) return false;
  const lower = raw.trim().toLowerCase();
  return lower === "true" || lower === "1" || lower === "yes";
}

/**
 * Per-call browser options are applied by mutating the process-global CONFIG,
 * because the browser/session layer reads that singleton directly.
 *
 * The previous pattern — snapshot `{...CONFIG}` at the top of a handler and
 * `Object.assign(CONFIG, snapshot)` in its `finally` — corrupted the config
 * PERMANENTLY under concurrency: with two overlapping calls, the second one
 * snapshots the first one's *mutated* config and restores that on the way out,
 * so a `show_browser: true` call could leave the server headed for the rest of
 * the process (or, with `stealth.enabled: false`, permanently unstealthed).
 *
 * Refcounting fixes the durable damage: the pristine config is captured once,
 * when the first override starts, and restored once, when the last one ends —
 * so CONFIG always converges back to the baseline. Overlapping calls with
 * *conflicting* options still share one global while both are in flight (last
 * writer wins for the overlap); that is inherent to a mutable singleton and is
 * the reason these options are documented as per-call hints, not guarantees.
 */
let configOverrideDepth = 0;
let pristineConfig: Partial<typeof CONFIG> | null = null;

/** Token returned by {@link beginConfigOverride}; pass it to {@link endConfigOverride}. */
type ConfigOverrideToken = { applied: boolean };

function beginConfigOverride(effective?: typeof CONFIG): ConfigOverrideToken {
  if (!effective) return { applied: false };
  if (configOverrideDepth === 0) {
    pristineConfig = { ...CONFIG };
  }
  configOverrideDepth++;
  Object.assign(CONFIG, effective);
  return { applied: true };
}

function endConfigOverride(token: ConfigOverrideToken): void {
  if (!token.applied) return;
  configOverrideDepth = Math.max(0, configOverrideDepth - 1);
  if (configOverrideDepth === 0 && pristineConfig) {
    Object.assign(CONFIG, pristineConfig);
    pristineConfig = null;
  }
}

/**
 * Identifier for the confirmation round-trip. The server assigns it when it
 * returns `input_required`; the client echoes it back under the same key in
 * `inputResponses`, which is how the retried call is matched to the question.
 */
const CONFIRM_KEY = "confirm";

/**
 * MCP Tool Handlers
 */
export class ToolHandlers {
  private sessionManager: SessionManager;
  private authManager: AuthManager;
  private library: NotebookLibrary;

  constructor(
    sessionManager: SessionManager,
    authManager: AuthManager,
    library: NotebookLibrary
  ) {
    this.sessionManager = sessionManager;
    this.authManager = authManager;
    this.library = library;
  }

  /**
   * Handle ask_question tool
   */
  async handleAskQuestion(
    args: {
      question: string;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
      browser_options?: BrowserOptions;
      source_format?: "none" | "inline" | "footnotes" | "json";
    },
    sendProgress?: ProgressCallback
  ): Promise<ToolResult<AskQuestionResult>> {
    const {
      question,
      session_id,
      notebook_id,
      notebook_url,
      show_browser,
      browser_options,
      source_format = "none",
    } = args;

    log.info(`🔧 [TOOL] ask_question called`);
    log.info(`  Question: "${question.substring(0, 100)}"...`);
    if (session_id) {
      log.info(`  Session ID: ${session_id}`);
    }
    if (notebook_id) {
      log.info(`  Notebook ID: ${notebook_id}`);
    }
    if (notebook_url) {
      log.info(`  Notebook URL: ${notebook_url}`);
    }

    try {
      // Resolve notebook URL
      let resolvedNotebookUrl = notebook_url;

      if (!resolvedNotebookUrl && notebook_id) {
        const notebook = this.library.incrementUseCount(notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${notebook_id}`);
        }

        resolvedNotebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!resolvedNotebookUrl && session_id) {
        // A follow-up question in an existing session stays on THAT session's
        // notebook. Falling through to the active notebook here silently
        // destroyed the session and answered from different sources — see
        // `resolveNotebookUrl` for the full note.
        const existing = this.sessionManager.getSession(session_id);
        if (existing) {
          resolvedNotebookUrl = existing.notebookUrl;
          log.info(`  Continuing session ${session_id} on its own notebook`);
        }
      }

      if (!resolvedNotebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          const notebook = this.library.incrementUseCount(active.id);
          if (!notebook) {
            throw new Error(`Active notebook not found: ${active.id}`);
          }
          resolvedNotebookUrl = notebook.url;
          log.info(`  Using active notebook: ${notebook.name}`);
        }
      }

      // A session_id the server does not know is almost always a stale id from
      // an earlier process or an expired session. Creating a fresh session
      // silently (the old behaviour) looked like a successful follow-up while
      // the conversational context was gone, so say so in the result.
      const requestedSessionKnown = session_id
        ? this.sessionManager.getSession(session_id) !== null
        : true;

      // Progress: Getting or creating session
      await sendProgress?.("Getting or creating browser session...", 1, 5);

      // Apply browser options temporarily
      const configToken = beginConfigOverride(applyBrowserOptions(browser_options, show_browser));

      // Calculate overrideHeadless parameter for session manager
      // show_browser takes precedence over browser_options.headless
      let overrideHeadless: boolean | undefined = undefined;
      if (show_browser !== undefined) {
        overrideHeadless = show_browser;
      } else if (browser_options?.show !== undefined) {
        overrideHeadless = browser_options.show;
      } else if (browser_options?.headless !== undefined) {
        overrideHeadless = !browser_options.headless;
      }

      try {
        // Get or create session (with headless override to handle mode changes)
        const session = await this.sessionManager.getOrCreateSession(
          session_id,
          resolvedNotebookUrl,
          overrideHeadless
        );

        // Progress: Asking question
        await sendProgress?.("Asking question to NotebookLM...", 2, 5);

        // Ask the question (pass progress callback). The session is marked
        // busy for the whole answer+citation window: neither the idle sweeper
        // nor max-sessions eviction may close this page mid-question.
        const citationResult = await this.sessionManager.withSessionBusy(session, async () => {
          const rawAnswer = await session.ask(question, sendProgress);
          // Extract citations from the same page session before any other call
          // disturbs the source panel (issue #20).
          return session.extractCitations(rawAnswer, source_format);
        });
        const baseAnswer = citationResult.formattedAnswer;

        const trimmed = baseAnswer.trimEnd();
        const withReminder = followUpReminderEnabled()
          ? `${trimmed}${FOLLOW_UP_REMINDER}`
          : trimmed;
        const answer = applyAiMarker(withReminder);

        // Get session info
        const sessionInfo = session.getInfo();

        const result: AskQuestionResult = {
          status: "success",
          question,
          answer,
          session_id: session.sessionId,
          notebook_url: session.notebookUrl,
          session_info: {
            age_seconds: sessionInfo.age_seconds,
            message_count: sessionInfo.message_count,
            last_activity: sessionInfo.last_activity,
          },
          _provenance: PROVENANCE,
          source_format,
          ...(citationResult.citations.length > 0 && { sources: citationResult.citations }),
          // Say plainly when a requested citation format produced nothing, and
          // when a supplied session_id did not name a live session — both used
          // to be invisible in a success response.
          ...(citationResult.note ? { sources_note: citationResult.note } : {}),
          ...(requestedSessionKnown
            ? {}
            : {
                session_note:
                  `session_id "${session_id}" was not a live session on this server, ` +
                  `so a NEW session (${session.sessionId}) answered this question — ` +
                  `it carries no history from the earlier conversation.`,
              }),
        };

        // Progress: Complete
        await sendProgress?.("Question answered successfully!", 5, 5);

        log.success(`✅ [TOOL] ask_question completed successfully`);
        return {
          success: true,
          data: result,
        };
      } finally {
        // Restore original CONFIG
        endConfigOverride(configToken);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Special handling for rate limit errors
      if (error instanceof RateLimitError || errorMessage.toLowerCase().includes("rate limit")) {
        log.error(`🚫 [TOOL] Rate limit detected`);
        return {
          success: false,
          error:
            "NotebookLM rate limit reached (50 queries/day for free accounts).\n\n" +
            "You can:\n" +
            "1. Use the 're_auth' tool to login with a different Google account\n" +
            "2. Wait until tomorrow for the quota to reset\n" +
            "3. Upgrade to Google AI Pro/Ultra for 5x higher limits\n\n" +
            `Original error: ${errorMessage}`,
        };
      }

      log.error(`❌ [TOOL] ask_question failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle list_sessions tool
   */
  async handleListSessions(): Promise<
    ToolResult<{
      active_sessions: number;
      max_sessions: number;
      session_timeout: number;
      oldest_session_seconds: number;
      total_messages: number;
      sessions: Array<{
        id: string;
        created_at: number;
        last_activity: number;
        age_seconds: number;
        inactive_seconds: number;
        message_count: number;
        notebook_url: string;
      }>;
    }>
  > {
    log.info(`🔧 [TOOL] list_sessions called`);

    try {
      const stats = this.sessionManager.getStats();
      const sessions = this.sessionManager.getAllSessionsInfo();

      const result = {
        active_sessions: stats.active_sessions,
        max_sessions: stats.max_sessions,
        session_timeout: stats.session_timeout,
        oldest_session_seconds: stats.oldest_session_seconds,
        total_messages: stats.total_messages,
        sessions: sessions.map((info) => ({
          id: info.id,
          created_at: info.created_at,
          last_activity: info.last_activity,
          age_seconds: info.age_seconds,
          inactive_seconds: info.inactive_seconds,
          message_count: info.message_count,
          notebook_url: info.notebook_url,
        })),
      };

      log.success(`✅ [TOOL] list_sessions completed (${result.active_sessions} sessions)`);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_sessions failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle close_session tool
   */
  async handleCloseSession(args: {
    session_id: string;
  }): Promise<ToolResult<{ status: string; message: string; session_id: string }>> {
    const { session_id } = args;

    log.info(`🔧 [TOOL] close_session called`);
    log.info(`  Session ID: ${session_id}`);

    try {
      const closed = await this.sessionManager.closeSession(session_id);

      if (closed) {
        log.success(`✅ [TOOL] close_session completed`);
        return {
          success: true,
          data: {
            status: "success",
            message: `Session ${session_id} closed successfully`,
            session_id,
          },
        };
      } else {
        log.warning(`⚠️  [TOOL] Session ${session_id} not found`);
        return {
          success: false,
          error: `Session ${session_id} not found`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] close_session failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle reset_session tool
   */
  async handleResetSession(args: {
    session_id: string;
  }): Promise<ToolResult<{ status: string; message: string; session_id: string }>> {
    const { session_id } = args;

    log.info(`🔧 [TOOL] reset_session called`);
    log.info(`  Session ID: ${session_id}`);

    try {
      const session = this.sessionManager.getSession(session_id);

      if (!session) {
        log.warning(`⚠️  [TOOL] Session ${session_id} not found`);
        return {
          success: false,
          error: `Session ${session_id} not found`,
        };
      }

      await session.reset();

      log.success(`✅ [TOOL] reset_session completed`);
      return {
        success: true,
        data: {
          status: "success",
          message: `Session ${session_id} reset successfully`,
          session_id,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] reset_session failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_health tool
   */
  async handleGetHealth(): Promise<
    ToolResult<{
      status: string;
      authenticated: boolean;
      notebook_url: string;
      active_notebook_id: string | null;
      active_notebook_name: string | null;
      total_notebooks: number;
      active_sessions: number;
      max_sessions: number;
      session_timeout: number;
      total_messages: number;
      headless: boolean;
      auto_login_enabled: boolean;
      stealth_enabled: boolean;
      troubleshooting_tip?: string;
    }>
  > {
    log.info(`🔧 [TOOL] get_health called`);

    try {
      // Check authentication status
      const statePath = await this.authManager.getValidStatePath();
      const authenticated = statePath !== null;

      // Get session stats
      const stats = this.sessionManager.getStats();

      // Resolve current notebook from the library — `CONFIG.notebookUrl` is a
      // legacy field (v1) that's no longer set in v2's library-driven flow.
      const active = this.library.getActiveNotebook();
      const notebookUrl = active?.url || CONFIG.notebookUrl || "not configured";

      const result = {
        status: "ok",
        authenticated,
        notebook_url: notebookUrl,
        active_notebook_id: active?.id ?? null,
        active_notebook_name: active?.name ?? null,
        total_notebooks: this.library.getStats().total_notebooks,
        active_sessions: stats.active_sessions,
        max_sessions: stats.max_sessions,
        session_timeout: stats.session_timeout,
        total_messages: stats.total_messages,
        headless: CONFIG.headless,
        auto_login_enabled: CONFIG.autoLoginEnabled,
        stealth_enabled: CONFIG.stealthEnabled,
        // Add troubleshooting tip if not authenticated
        ...(!authenticated && {
          troubleshooting_tip:
            "For fresh start with clean browser session: Close all Chrome instances → " +
            "cleanup_data(confirm=true, preserve_library=true) → setup_auth",
        }),
      };

      log.success(`✅ [TOOL] get_health completed`);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_health failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle setup_auth tool
   *
   * Opens a browser window for manual login with live progress updates.
   * The operation waits synchronously for login completion (up to 10 minutes).
   */
  async handleSetupAuth(
    args: {
      show_browser?: boolean;
      browser_options?: BrowserOptions;
    },
    sendProgress?: ProgressCallback
  ): Promise<
    ToolResult<{
      status: string;
      message: string;
      authenticated: boolean;
      duration_seconds?: number;
    }>
  > {
    const { show_browser, browser_options } = args;

    // CRITICAL: Send immediate progress to reset timeout from the very start
    await sendProgress?.("Initializing authentication setup...", 0, 10);

    log.info(`🔧 [TOOL] setup_auth called`);
    if (show_browser !== undefined) {
      log.info(`  Show browser: ${show_browser}`);
    }

    const startTime = Date.now();

    // Apply browser options temporarily
    const configToken = beginConfigOverride(applyBrowserOptions(browser_options, show_browser));

    try {
      // Progress: Starting
      await sendProgress?.("Preparing authentication browser...", 1, 10);

      log.info(`  🌐 Opening browser for interactive login...`);

      // Progress: Opening browser
      await sendProgress?.("Opening browser window...", 2, 10);

      // Close live sessions FIRST. `performSetup` deletes and relaunches the
      // Chrome profile; doing that under a running shared context left the old
      // browser holding a deleted profile directory — sessions that survived
      // the wipe then failed in confusing ways and could keep a Chrome process
      // alive against a profile that no longer exists.
      if (this.sessionManager.getAllSessionsInfo().length > 0) {
        log.warning("  🧹 Closing live sessions before re-authenticating...");
        await this.sessionManager.closeAllSessions();
      }

      // Perform setup with progress updates (uses CONFIG internally)
      const success = await this.authManager.performSetup(sendProgress);

      const durationSeconds = (Date.now() - startTime) / 1000;

      if (success) {
        // Progress: Complete
        await sendProgress?.("Authentication saved successfully!", 10, 10);

        log.success(`✅ [TOOL] setup_auth completed (${durationSeconds.toFixed(1)}s)`);
        return {
          success: true,
          data: {
            status: "authenticated",
            message: "Successfully authenticated and saved browser state",
            authenticated: true,
            duration_seconds: durationSeconds,
          },
        };
      } else {
        log.error(`❌ [TOOL] setup_auth failed (${durationSeconds.toFixed(1)}s)`);
        return {
          success: false,
          error: "Authentication failed or was cancelled",
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationSeconds = (Date.now() - startTime) / 1000;
      log.error(`❌ [TOOL] setup_auth failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`);
      return {
        success: false,
        error: errorMessage,
      };
    } finally {
      // Restore original CONFIG
      endConfigOverride(configToken);
    }
  }

  /**
   * Handle re_auth tool
   *
   * Performs a complete re-authentication:
   * 1. Closes all active browser sessions
   * 2. Deletes all saved authentication data (cookies, Chrome profile)
   * 3. Opens browser for fresh Google login
   *
   * Use for switching Google accounts or recovering from rate limits.
   */
  async handleReAuth(
    args: {
      show_browser?: boolean;
      browser_options?: BrowserOptions;
    },
    sendProgress?: ProgressCallback
  ): Promise<
    ToolResult<{
      status: string;
      message: string;
      authenticated: boolean;
      duration_seconds?: number;
    }>
  > {
    const { show_browser, browser_options } = args;

    await sendProgress?.("Preparing re-authentication...", 0, 12);
    log.info(`🔧 [TOOL] re_auth called`);
    if (show_browser !== undefined) {
      log.info(`  Show browser: ${show_browser}`);
    }

    const startTime = Date.now();

    // Apply browser options temporarily
    const configToken = beginConfigOverride(applyBrowserOptions(browser_options, show_browser));

    try {
      // 1. Close all active sessions
      await sendProgress?.("Closing all active sessions...", 1, 12);
      log.info("  🛑 Closing all sessions...");
      await this.sessionManager.closeAllSessions();
      log.success("  ✅ All sessions closed");

      // 2. Clear all auth data
      await sendProgress?.("Clearing authentication data...", 2, 12);
      log.info("  🗑️  Clearing all auth data...");
      await this.authManager.clearAllAuthData();
      log.success("  ✅ Auth data cleared");

      // 3. Perform fresh setup
      await sendProgress?.("Starting fresh authentication...", 3, 12);
      log.info("  🌐 Starting fresh authentication setup...");
      const success = await this.authManager.performSetup(sendProgress);

      const durationSeconds = (Date.now() - startTime) / 1000;

      if (success) {
        await sendProgress?.("Re-authentication complete!", 12, 12);
        log.success(`✅ [TOOL] re_auth completed (${durationSeconds.toFixed(1)}s)`);
        return {
          success: true,
          data: {
            status: "authenticated",
            message:
              "Successfully re-authenticated with new account. All previous sessions have been closed.",
            authenticated: true,
            duration_seconds: durationSeconds,
          },
        };
      } else {
        log.error(`❌ [TOOL] re_auth failed (${durationSeconds.toFixed(1)}s)`);
        return {
          success: false,
          error: "Re-authentication failed or was cancelled",
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationSeconds = (Date.now() - startTime) / 1000;
      log.error(`❌ [TOOL] re_auth failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`);
      return {
        success: false,
        error: errorMessage,
      };
    } finally {
      // Restore original CONFIG
      endConfigOverride(configToken);
    }
  }

  /**
   * Handle add_notebook tool
   */
  async handleAddNotebook(
    args: AddNotebookInput
  ): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] add_notebook called`);
    log.info(`  Name: ${args.name}`);

    try {
      const notebook = this.library.addNotebook(args);
      log.success(`✅ [TOOL] add_notebook completed: ${notebook.id}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] add_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle discover_notebooks tool
   */
  async handleDiscoverNotebooks(): Promise<
    ToolResult<{
      discovered: DiscoveredNotebook[];
      added: NotebookEntry[];
      skipped_existing: number;
      note?: string;
    }>
  > {
    log.info(`🔧 [TOOL] discover_notebooks called`);

    try {
      const statePath = await this.authManager.getValidStatePath();
      if (!statePath) {
        throw new Error("Not authenticated — run setup_auth first, then retry discover_notebooks.");
      }

      const context = await this.sessionManager.getSharedContext();
      const { notebooks: discovered, note } = await discoverNotebooks(context);
      const { added, skipped_existing } = this.library.syncDiscovered(discovered);

      log.success(
        `✅ [TOOL] discover_notebooks completed: ${discovered.length} found, ${added.length} newly registered, ${skipped_existing} already known`
      );
      return {
        success: true,
        data: { discovered, added, skipped_existing, ...(note && { note }) },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] discover_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle list_notebooks tool
   */
  async handleListNotebooks(): Promise<ToolResult<{ notebooks: NotebookEntry[] }>> {
    log.info(`🔧 [TOOL] list_notebooks called`);

    try {
      const notebooks = this.library.listNotebooks();
      log.success(`✅ [TOOL] list_notebooks completed (${notebooks.length} notebooks)`);
      return {
        success: true,
        data: { notebooks },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_notebook tool
   */
  async handleGetNotebook(args: { id: string }): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] get_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.getNotebook(args.id);
      if (!notebook) {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }

      log.success(`✅ [TOOL] get_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle select_notebook tool
   */
  async handleSelectNotebook(args: {
    id: string;
  }): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] select_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.selectNotebook(args.id);
      log.success(`✅ [TOOL] select_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] select_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle update_notebook tool
   */
  async handleUpdateNotebook(
    args: UpdateNotebookInput
  ): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] update_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.updateNotebook(args);
      log.success(`✅ [TOOL] update_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] update_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle remove_notebook tool
   */
  async handleRemoveNotebook(
    args: {
      id: string;
    },
    confirm?: ConfirmContext
  ): Promise<ToolResult<{ removed: boolean; closed_sessions: number }> | InputRequiredResult> {
    log.info(`🔧 [TOOL] remove_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.getNotebook(args.id);
      if (!notebook) {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }

      // Confirmation is a multi-round-trip request: we return `input_required`
      // and the client re-calls this tool with the answer attached. The SDK
      // serves that natively on protocol revision 2026-07-28 and, through its
      // legacy shim, as a real `elicitation/create` request to 2025-era
      // clients — so this one path covers both.
      if (confirm?.canElicit) {
        const answer = acceptedContent<{ confirmed?: boolean }>(confirm.responses, CONFIRM_KEY);
        if (answer === undefined) {
          const view = inputResponse(confirm.responses, CONFIRM_KEY);
          if (view.kind === "missing") {
            // First round: ask.
            return inputRequired({
              inputRequests: {
                [CONFIRM_KEY]: inputRequired.elicit({
                  message:
                    `Remove notebook "${notebook.name}" (${notebook.id}) from your local ` +
                    `library? This does not delete the notebook on NotebookLM itself — ` +
                    `only the local library entry.`,
                  requestedSchema: {
                    type: "object",
                    properties: { confirmed: { type: "boolean" } },
                    required: ["confirmed"],
                  },
                }),
              },
            });
          }
          // Declined, cancelled, or an unreadable response. Fail CLOSED: a
          // destructive tool must never treat "no usable answer" as consent.
          log.info(`  ℹ️  remove_notebook not confirmed (${view.kind})`);
          return {
            success: false,
            error: `Removal not confirmed — notebook "${notebook.name}" (${notebook.id}) was NOT removed.`,
          };
        }
        if (answer.confirmed !== true) {
          log.info(`  ℹ️  remove_notebook declined by user`);
          return { success: false, error: "Removal declined by user." };
        }
      }

      const removed = this.library.removeNotebook(args.id);
      if (removed) {
        const closedSessions = await this.sessionManager.closeSessionsForNotebook(notebook.url);
        log.success(`✅ [TOOL] remove_notebook completed`);
        return {
          success: true,
          data: { removed: true, closed_sessions: closedSessions },
        };
      } else {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] remove_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle search_notebooks tool
   */
  async handleSearchNotebooks(args: {
    query: string;
  }): Promise<ToolResult<{ notebooks: NotebookEntry[] }>> {
    log.info(`🔧 [TOOL] search_notebooks called`);
    log.info(`  Query: "${args.query}"`);

    try {
      const notebooks = this.library.searchNotebooks(args.query);
      log.success(`✅ [TOOL] search_notebooks completed (${notebooks.length} results)`);
      return {
        success: true,
        data: { notebooks },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] search_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_library_stats tool
   */
  async handleGetLibraryStats(): Promise<ToolResult<LibraryStats>> {
    log.info(`🔧 [TOOL] get_library_stats called`);

    try {
      const stats = this.library.getStats();
      log.success(`✅ [TOOL] get_library_stats completed`);
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_library_stats failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle cleanup_data tool
   *
   * ULTRATHINK Deep Cleanup - scans entire system for ALL NotebookLM MCP files
   */
  async handleCleanupData(
    args: { confirm: boolean; preserve_library?: boolean },
    confirmCtx?: ConfirmContext
  ): Promise<
    ToolResult<{
      status: string;
      mode: string;
      preview?: {
        categories: Array<{
          name: string;
          description: string;
          paths: string[];
          totalBytes: number;
          optional: boolean;
        }>;
        totalPaths: number;
        totalSizeBytes: number;
      };
      result?: {
        deletedPaths: string[];
        failedPaths: string[];
        totalSizeBytes: number;
        categorySummary: Record<string, { count: number; bytes: number }>;
      };
    }>
    | InputRequiredResult
  > {
    const { confirm, preserve_library = false } = args;

    // Defence in depth. The protocol layer now validates arguments against the
    // declared inputSchema, but this tool DELETES DATA IRREVERSIBLY: a truthy
    // non-boolean (`"false"`, `1`, `[]`) reaching `if (!confirm)` would skip
    // the preview and delete immediately, so re-check the type here rather
    // than trusting a single upstream guard.
    if (typeof confirm !== "boolean") {
      return {
        success: false,
        error:
          "`confirm` must be a boolean. Call cleanup_data with confirm:false first " +
          "to preview exactly what would be deleted, then confirm:true to delete it.",
      };
    }
    if (preserve_library !== undefined && typeof preserve_library !== "boolean") {
      return { success: false, error: "`preserve_library` must be a boolean when provided." };
    }

    log.info(`🔧 [TOOL] cleanup_data called`);
    log.info(`  Confirm: ${confirm}`);
    log.info(`  Preserve Library: ${preserve_library}`);

    const cleanupManager = new CleanupManager();

    try {
      // Always run in deep mode
      const mode = "deep";

      if (!confirm) {
        // Preview mode - show what would be deleted
        log.info(`  📋 Generating cleanup preview (mode: ${mode})...`);

        const preview = await cleanupManager.getCleanupPaths(mode, preserve_library);
        const platformInfo = cleanupManager.getPlatformInfo();

        log.info(
          `  Found ${preview.totalPaths.length} items (${cleanupManager.formatBytes(preview.totalSizeBytes)})`
        );
        log.info(`  Platform: ${platformInfo.platform}`);

        if (confirmCtx?.canElicit) {
          const answer = acceptedContent<{ confirmed?: boolean }>(
            confirmCtx.responses,
            CONFIRM_KEY
          );
          const view = inputResponse(confirmCtx.responses, CONFIRM_KEY);

          if (answer === undefined && view.kind === "missing") {
            // First round: ask. The client re-calls this tool with the answer.
            return inputRequired({
              inputRequests: {
                [CONFIRM_KEY]: inputRequired.elicit({
                  // Name the categories that will actually be deleted rather
                  // than a vague summary — the previous wording ("auth state,
                  // browser profile, and optionally the notebook library")
                  // understated it, and a user cannot consent to what they are
                  // not told.
                  message:
                    `Delete ${preview.totalPaths.length} item(s) totalling ${cleanupManager.formatBytes(preview.totalSizeBytes)}?\n` +
                    // Optional categories appear in the preview but are NOT
                    // deleted, so label them rather than implying consent.
                    `Categories: ${
                      preview.categories
                        .map((c) => (c.optional ? `${c.name} (listed only, not deleted)` : c.name))
                        .join(", ") || "(none)"
                    }.\n` +
                    `You will have to sign in to NotebookLM again.` +
                    (preserve_library
                      ? " The notebook library will be KEPT."
                      : " The notebook library WILL be deleted.") +
                    `\nThis cannot be undone.`,
                  requestedSchema: {
                    type: "object",
                    properties: { confirmed: { type: "boolean" } },
                    required: ["confirmed"],
                  },
                }),
              },
            });
          }

          if (answer?.confirmed === true) {
            const result = await cleanupManager.performCleanup(mode, preserve_library);
            log.success(
              `✅ [TOOL] cleanup_data completed after confirmation - deleted ${result.deletedPaths.length} items`
            );
            return {
              success: result.success,
              data: {
                status: result.success ? "completed" : "partial",
                mode,
                result: {
                  deletedPaths: result.deletedPaths,
                  failedPaths: result.failedPaths,
                  totalSizeBytes: result.totalSizeBytes,
                  categorySummary: result.categorySummary,
                },
              },
            };
          }

          // Declined, cancelled, or an unreadable answer. Unlike
          // remove_notebook there is nothing unsafe about continuing here:
          // this is the preview branch, nothing has been deleted, and the
          // preview is already computed — so return it rather than an opaque
          // error.
          log.info(`  ℹ️  cleanup_data not confirmed (${view.kind}) — returning preview only`);
        }

        return {
          success: true,
          data: {
            status: "preview",
            mode,
            preview: {
              categories: preview.categories,
              totalPaths: preview.totalPaths.length,
              totalSizeBytes: preview.totalSizeBytes,
            },
          },
        };
      } else {
        // Cleanup mode - actually delete files
        log.info(`  🗑️  Performing cleanup (mode: ${mode})...`);

        const result = await cleanupManager.performCleanup(mode, preserve_library);

        if (result.success) {
          log.success(
            `✅ [TOOL] cleanup_data completed - deleted ${result.deletedPaths.length} items`
          );
        } else {
          log.warning(`⚠️  [TOOL] cleanup_data completed with ${result.failedPaths.length} errors`);
        }

        return {
          success: result.success,
          data: {
            status: result.success ? "completed" : "partial",
            mode,
            result: {
              deletedPaths: result.deletedPaths,
              failedPaths: result.failedPaths,
              totalSizeBytes: result.totalSizeBytes,
              categorySummary: result.categorySummary,
            },
          },
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] cleanup_data failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Resolve a notebook URL the same way `handleAskQuestion` does. Used by the
   * new source/audio tools so we don't duplicate the lookup logic.
   */
  private async resolveNotebookUrl(
    notebookId?: string,
    notebookUrl?: string,
    sessionId?: string
  ): Promise<string | undefined> {
    if (notebookUrl) return notebookUrl;
    if (notebookId) {
      const nb = this.library.getNotebook(notebookId);
      if (!nb) throw new Error(`Notebook not found in library: ${notebookId}`);
      return nb.url;
    }
    // A live session's OWN notebook wins over the library's active notebook.
    //
    // Without this, `ask_question({ session_id })` with no explicit notebook
    // resolved to whatever notebook happened to be active, and
    // `getOrCreateSession` treats a different URL as "retarget this session":
    // it CLOSED the caller's session and opened a new one on the other
    // notebook. The follow-up question was then answered from the wrong
    // sources with the conversation context gone — while still reporting
    // success. Reproduced live: a follow-up asked in a session opened on
    // "Income Tax Act, 2025" came back answered from "Direct Taxation Laws".
    if (sessionId) {
      const existing = this.sessionManager.getSession(sessionId);
      if (existing) return existing.notebookUrl;
    }
    const active = this.library.getActiveNotebook();
    return active?.url;
  }

  /**
   * Build the same "not yet implemented (Phase 2)" message `getStrategy()`
   * throws inside `studio-outputs.ts`, so the four Studio-output handlers can
   * surface it up front — before `resolveNotebookUrl`/`getOrCreateSession`
   * launch a browser — instead of only reaching it deep inside a live
   * session (where an unauthenticated/no-notebook caller would instead see
   * "Notebook URL is required to create a session" for every type,
   * implemented or not).
   */
  private studioTypeNotImplementedError(type: StudioOutputType): string {
    return (
      `Studio output type "${type}" is not yet implemented by this server (Phase 2). ` +
      `Implemented types: ${implementedStudioTypes().join(", ")}.`
    );
  }

  /**
   * Handle add_source tool (issue #25).
   */
  async handleAddSource(args: {
    type: "url" | "text";
    content: string;
    title?: string;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AddSourceResult; session_id: string }>> {
    log.info(`🔧 [TOOL] add_source called (type=${args.type})`);
    const configToken = beginConfigOverride(
      args.show_browser === undefined
        ? undefined
        : applyBrowserOptions(undefined, args.show_browser)
    );
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(
        args.notebook_id,
        args.notebook_url,
        args.session_id
      );
      const session = await this.sessionManager.getOrCreateSession(
        args.session_id,
        url,
        overrideHeadless
      );
      const result = await this.sessionManager.withSessionBusy(session, () =>
        session.addSource({
          type: args.type,
          content: args.content,
          title: args.title,
        })
      );
      return { success: result.success, data: { result, session_id: session.sessionId } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] add_source failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      endConfigOverride(configToken);
    }
  }

  /**
   * Handle generate_audio tool (issue #11).
   */
  async handleGenerateAudio(args: {
    custom_prompt?: string;
    timeout_ms?: number;
    wait_for_completion?: boolean;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AudioGenerationResult; session_id: string }>> {
    log.info(`🔧 [TOOL] generate_audio called`);
    const configToken = beginConfigOverride(
      args.show_browser === undefined
        ? undefined
        : applyBrowserOptions(undefined, args.show_browser)
    );
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(
        args.notebook_id,
        args.notebook_url,
        args.session_id
      );
      const session = await this.sessionManager.getOrCreateSession(
        args.session_id,
        url,
        overrideHeadless
      );
      const result = await this.sessionManager.withSessionBusy(session, () =>
        session.generateAudio({
          customPrompt: args.custom_prompt,
          timeoutMs: args.timeout_ms,
          waitForCompletion: args.wait_for_completion ?? false,
        })
      );
      // `started` and `in_progress` count as success — the generation is on
      // its way; the caller polls `get_audio_status` for completion.
      const ok =
        result.status === "ready" || result.status === "started" || result.status === "in_progress";
      return { success: ok, data: { result, session_id: session.sessionId } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] generate_audio failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      endConfigOverride(configToken);
    }
  }

  /**
   * Handle get_audio_status tool — non-blocking poll for Audio Overview state.
   */
  async handleGetAudioStatus(args: {
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AudioGenerationResult; session_id: string }>> {
    log.info(`🔧 [TOOL] get_audio_status called`);
    const configToken = beginConfigOverride(
      args.show_browser === undefined
        ? undefined
        : applyBrowserOptions(undefined, args.show_browser)
    );
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(
        args.notebook_id,
        args.notebook_url,
        args.session_id
      );
      const session = await this.sessionManager.getOrCreateSession(
        args.session_id,
        url,
        overrideHeadless
      );
      const result = await this.sessionManager.withSessionBusy(session, () =>
        session.getAudioStatus()
      );
      // A probe that itself failed is not a successful probe: returning
      // success:true here hid engine errors (a missing Studio panel, a stale
      // viewer) behind what looked like a clean "not_started" answer.
      return {
        success: result.status !== "error",
        data: { result, session_id: session.sessionId },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_audio_status failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      endConfigOverride(configToken);
    }
  }

  /**
   * Handle download_audio tool (issue #11).
   */
  async handleDownloadAudio(args: {
    destination_dir: string;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: DownloadAudioResult; session_id: string }>> {
    log.info(`🔧 [TOOL] download_audio called`);
    const configToken = beginConfigOverride(
      args.show_browser === undefined
        ? undefined
        : applyBrowserOptions(undefined, args.show_browser)
    );
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(
        args.notebook_id,
        args.notebook_url,
        args.session_id
      );
      const session = await this.sessionManager.getOrCreateSession(
        args.session_id,
        url,
        overrideHeadless
      );
      const result = await this.sessionManager.withSessionBusy(session, () =>
        session.downloadAudio(args.destination_dir)
      );
      return { success: result.success, data: { result, session_id: session.sessionId } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] download_audio failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      endConfigOverride(configToken);
    }
  }

  /**
   * Handle generate_studio_output tool (Task 7) — generic trigger for any
   * registered Studio output type.
   */
  async handleGenerateStudioOutput(args: {
    output_type: StudioOutputType;
    custom_prompt?: string;
    difficulty?: string;
    timeout_ms?: number;
    wait_for_completion?: boolean;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AudioGenerationResult; session_id: string }>> {
    log.info(`🔧 [TOOL] generate_studio_output called (type=${args.output_type})`);
    if (!isStudioTypeImplemented(args.output_type)) {
      const error = this.studioTypeNotImplementedError(args.output_type);
      log.error(`❌ [TOOL] generate_studio_output failed: ${error}`);
      return { success: false, error };
    }
    const configToken = beginConfigOverride(
      args.show_browser === undefined
        ? undefined
        : applyBrowserOptions(undefined, args.show_browser)
    );
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(
        args.notebook_id,
        args.notebook_url,
        args.session_id
      );
      const session = await this.sessionManager.getOrCreateSession(
        args.session_id,
        url,
        overrideHeadless
      );
      const result = await this.sessionManager.withSessionBusy(session, () =>
        session.generateStudioOutput(args.output_type, {
          customPrompt: args.custom_prompt,
          difficulty: args.difficulty,
          timeoutMs: args.timeout_ms,
          waitForCompletion: args.wait_for_completion ?? false,
        })
      );
      const ok =
        result.status === "ready" || result.status === "started" || result.status === "in_progress";
      return { success: ok, data: { result, session_id: session.sessionId } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] generate_studio_output failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      endConfigOverride(configToken);
    }
  }

  /**
   * Handle get_studio_output_status tool (Task 7) — non-blocking poll for
   * any registered Studio output type.
   */
  async handleGetStudioOutputStatus(args: {
    output_type: StudioOutputType;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AudioGenerationResult; session_id: string }>> {
    log.info(`🔧 [TOOL] get_studio_output_status called (type=${args.output_type})`);
    if (!isStudioTypeImplemented(args.output_type)) {
      const error = this.studioTypeNotImplementedError(args.output_type);
      log.error(`❌ [TOOL] get_studio_output_status failed: ${error}`);
      return { success: false, error };
    }
    const configToken = beginConfigOverride(
      args.show_browser === undefined
        ? undefined
        : applyBrowserOptions(undefined, args.show_browser)
    );
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(
        args.notebook_id,
        args.notebook_url,
        args.session_id
      );
      const session = await this.sessionManager.getOrCreateSession(
        args.session_id,
        url,
        overrideHeadless
      );
      const result = await this.sessionManager.withSessionBusy(session, () =>
        session.getStudioOutputStatus(args.output_type)
      );
      // Same rule as get_audio_status: an errored probe must not report success.
      return {
        success: result.status !== "error",
        data: { result, session_id: session.sessionId },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_studio_output_status failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      endConfigOverride(configToken);
    }
  }

  /**
   * Handle download_studio_output tool (Task 7) — save a completed
   * file-kind Studio output to disk.
   */
  async handleDownloadStudioOutput(args: {
    output_type: StudioOutputType;
    destination_dir: string;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: DownloadAudioResult; session_id: string }>> {
    log.info(`🔧 [TOOL] download_studio_output called (type=${args.output_type})`);
    if (!isStudioTypeImplemented(args.output_type)) {
      const error = this.studioTypeNotImplementedError(args.output_type);
      log.error(`❌ [TOOL] download_studio_output failed: ${error}`);
      return { success: false, error };
    }
    const configToken = beginConfigOverride(
      args.show_browser === undefined
        ? undefined
        : applyBrowserOptions(undefined, args.show_browser)
    );
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(
        args.notebook_id,
        args.notebook_url,
        args.session_id
      );
      const session = await this.sessionManager.getOrCreateSession(
        args.session_id,
        url,
        overrideHeadless
      );
      const result = await this.sessionManager.withSessionBusy(session, () =>
        session.downloadStudioOutput(args.output_type, args.destination_dir)
      );
      return { success: result.success, data: { result, session_id: session.sessionId } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] download_studio_output failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      endConfigOverride(configToken);
    }
  }

  /**
   * Handle get_studio_output_content tool (Task 7) — extract a completed
   * structured-kind Studio output as JSON.
   */
  async handleGetStudioOutputContent(args: {
    output_type: StudioOutputType;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<
    ToolResult<{
      result: { success: boolean; content?: unknown; message?: string };
      session_id: string;
    }>
  > {
    log.info(`🔧 [TOOL] get_studio_output_content called (type=${args.output_type})`);
    if (!isStudioTypeImplemented(args.output_type)) {
      const error = this.studioTypeNotImplementedError(args.output_type);
      log.error(`❌ [TOOL] get_studio_output_content failed: ${error}`);
      return { success: false, error };
    }
    const configToken = beginConfigOverride(
      args.show_browser === undefined
        ? undefined
        : applyBrowserOptions(undefined, args.show_browser)
    );
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(
        args.notebook_id,
        args.notebook_url,
        args.session_id
      );
      const session = await this.sessionManager.getOrCreateSession(
        args.session_id,
        url,
        overrideHeadless
      );
      const result = await this.sessionManager.withSessionBusy(session, () =>
        session.getStudioOutputContent(args.output_type)
      );
      return { success: result.success, data: { result, session_id: session.sessionId } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_studio_output_content failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      endConfigOverride(configToken);
    }
  }

  /**
   * Cleanup all resources (called on server shutdown)
   */
  async cleanup(): Promise<void> {
    log.info(`🧹 Cleaning up tool handlers...`);
    await this.sessionManager.closeAllSessions({ shutdown: true });
    log.success(`✅ Tool handlers cleanup complete`);
  }
}
