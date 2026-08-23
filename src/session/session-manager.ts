/**
 * Session Manager
 *
 * Manages multiple parallel browser sessions for NotebookLM API
 *
 * Features:
 * - Session lifecycle management
 * - Auto-cleanup of inactive sessions
 * - Resource limits (max concurrent sessions)
 * - Shared PERSISTENT browser fingerprint (ONE context for all sessions)
 *
 * Based on the Python implementation from session_manager.py
 */

import type { AuthManager } from "../auth/auth-manager.js";
import { BrowserSession } from "./browser-session.js";
import { SharedContextManager } from "./shared-context-manager.js";
import { CONFIG } from "../config.js";
import { log } from "../utils/logger.js";
import type { SessionInfo } from "../types.js";
import { parseNotebookUrl } from "../library/notebook-library.js";
import { randomBytes } from "crypto";

export class SessionManager {
  private authManager: AuthManager;
  private sharedContextManager: SharedContextManager;
  private sessions: Map<string, BrowserSession> = new Map();
  private maxSessions: number;
  private sessionTimeout: number;
  private cleanupInterval?: NodeJS.Timeout;
  /**
   * Sessions currently executing a tool operation, REFCOUNTED. The idle
   * sweeper and the max-sessions eviction both skip these: `lastActivity` does
   * not advance during a long operation, so without this a session gets closed
   * underneath the request that is using it.
   *
   * A plain Set was wrong: with two overlapping operations on one session (a
   * client issuing parallel tool calls, or two HTTP exchanges), the FIRST to
   * finish deleted the entry while the second was still running, and the
   * sweeper could then close the page mid-operation. The count only reaches
   * zero when the last operation returns.
   */
  private busySessions: Map<string, number> = new Map();

  /** True while at least one operation holds this session. */
  private isBusy(sessionId: string): boolean {
    return (this.busySessions.get(sessionId) ?? 0) > 0;
  }

  constructor(authManager: AuthManager) {
    this.authManager = authManager;
    this.sharedContextManager = new SharedContextManager(authManager);
    this.maxSessions = CONFIG.maxSessions;
    this.sessionTimeout = CONFIG.sessionTimeout;

    log.info("🎯 SessionManager initialized");
    log.info(`  Max sessions: ${this.maxSessions}`);
    log.info(
      `  Timeout: ${this.sessionTimeout}s (${Math.floor(this.sessionTimeout / 60)} minutes)`
    );

    const cleanupIntervalSeconds = Math.max(60, Math.min(Math.floor(this.sessionTimeout / 2), 300));
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveSessions().catch((error) => {
        log.warning(`⚠️  Error during automatic session cleanup: ${error}`);
      });
    }, cleanupIntervalSeconds * 1000);
    this.cleanupInterval.unref();
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return randomBytes(4).toString("hex");
  }

  /**
   * Get the shared authenticated browser context directly, without
   * creating a per-notebook session. For tools that operate on the
   * account level (e.g. discover_notebooks) rather than one notebook.
   */
  async getSharedContext(overrideHeadless?: boolean) {
    return this.sharedContextManager.getOrCreateContext(overrideHeadless);
  }

  /**
   * Get existing session or create a new one
   *
   * @param sessionId Optional session ID to reuse existing session
   * @param notebookUrl Notebook URL for the session
   * @param overrideHeadless Optional override for headless mode (true = show browser)
   */
  async getOrCreateSession(
    sessionId?: string,
    notebookUrl?: string,
    overrideHeadless?: boolean
  ): Promise<BrowserSession> {
    // Determine target notebook URL
    const rawUrl = (notebookUrl || CONFIG.notebookUrl || "").trim();
    if (!rawUrl) {
      throw new Error("Notebook URL is required to create a session");
    }

    // Hard allowlist. `startsWith("http")` was the ONLY check, so any caller
    // (or any URL previously stored in library.json, which was equally
    // unvalidated) could point this at an arbitrary origin — and the session
    // then drives the SIGNED-IN, persistent Chrome profile there, exposes the
    // Google session storage this server restores to that page, and returns
    // whatever text it finds as if it were a NotebookLM answer.
    const parsed = parseNotebookUrl(rawUrl);
    if (!parsed) {
      throw new Error(
        `Refusing to open "${rawUrl}": not a NotebookLM notebook URL. ` +
          `Expected https://notebook.google.com/notebook/<uuid> ` +
          `(legacy https://notebooklm.google.com/notebook/<uuid> is also accepted).`
      );
    }
    const targetUrl = parsed.url;

    // Generate ID if not provided
    if (!sessionId) {
      sessionId = this.generateSessionId();
      log.info(`🆕 Auto-generated session ID: ${sessionId}`);
    }

    // Check if browser visibility mode needs to change
    if (overrideHeadless !== undefined) {
      if (this.sharedContextManager.needsHeadlessModeChange(overrideHeadless)) {
        log.warning(
          `🔄 Browser visibility changed - closing all sessions to recreate browser context...`
        );
        const currentMode = this.sharedContextManager.getCurrentHeadlessMode();
        log.info(
          `  Switching from ${currentMode ? "HEADLESS" : "VISIBLE"} to ${overrideHeadless ? "VISIBLE" : "HEADLESS"}`
        );

        // Close all sessions (they all use the same context)
        await this.closeAllSessions();
        log.success(`  ✅ All sessions closed, browser context will be recreated with new mode`);
      }
    }

    // Return existing session if found
    if (this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      // Compare CANONICAL forms. A session opened from a stored legacy-host
      // URL and a request naming the same notebook on the current host are the
      // same notebook; a raw string comparison treated them as different and
      // silently destroyed the session to "retarget" it at itself.
      const sessionCanonical = parseNotebookUrl(session.notebookUrl)?.url ?? session.notebookUrl;
      if (sessionCanonical !== targetUrl) {
        // Retargeting closes the page. Refuse while another call is using it —
        // silently closing a busy session fails that call with an unexplained
        // "Target closed".
        if (this.isBusy(sessionId)) {
          throw new Error(
            `Session ${sessionId} is busy with another operation and is open on a different ` +
              `notebook. Wait for it to finish, or omit session_id to work in a new session.`
          );
        }
        log.warning(`♻️  Replacing session ${sessionId} with new notebook URL`);
        await session.close();
        this.sessions.delete(sessionId);
      } else {
        session.updateActivity();
        log.success(`♻️  Reusing existing session ${sessionId}`);
        return session;
      }
    }

    // Check if we need to free up space
    if (this.sessions.size >= this.maxSessions) {
      log.warning(`⚠️  Max sessions (${this.maxSessions}) reached, cleaning up...`);
      const freed = await this.cleanupOldestSession();
      if (!freed) {
        throw new Error(
          `Max sessions (${this.maxSessions}) reached and no inactive sessions to clean up`
        );
      }
    }

    // Create new session
    log.info(`🆕 Creating new session ${sessionId}...`);
    if (overrideHeadless !== undefined) {
      log.info(`  Show browser: ${overrideHeadless}`);
    }
    try {
      // Ensure the shared context exists (ONE fingerprint for all sessions!)
      await this.sharedContextManager.getOrCreateContext(overrideHeadless);

      // Create and initialize session
      const session = new BrowserSession(
        sessionId,
        this.sharedContextManager,
        this.authManager,
        targetUrl
      );
      await session.init();

      this.sessions.set(sessionId, session);
      log.success(
        `✅ Session ${sessionId} created (${this.sessions.size}/${this.maxSessions} active)`
      );
      return session;
    } catch (error) {
      log.error(`❌ Failed to create session: ${error}`);
      throw error;
    }
  }

  /**
   * Get an existing session by ID
   */
  getSession(sessionId: string): BrowserSession | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Run `fn` with a session marked busy, so neither the idle sweeper nor the
   * max-sessions eviction can close it mid-operation. Always releases, and
   * refreshes `lastActivity` on the way out so a just-finished long operation
   * does not immediately look idle.
   */
  async withSessionBusy<T>(session: BrowserSession, fn: () => Promise<T>): Promise<T> {
    const id = session.sessionId;
    this.busySessions.set(id, (this.busySessions.get(id) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const remaining = (this.busySessions.get(id) ?? 1) - 1;
      if (remaining > 0) this.busySessions.set(id, remaining);
      else this.busySessions.delete(id);
      try {
        session.updateActivity();
      } catch {
        /* session may already be closed — nothing to refresh */
      }
    }
  }

  /**
   * Close and remove a specific session
   */
  async closeSession(sessionId: string): Promise<boolean> {
    if (!this.sessions.has(sessionId)) {
      log.warning(`⚠️  Session ${sessionId} not found`);
      return false;
    }

    const session = this.sessions.get(sessionId)!;
    await session.close();
    this.sessions.delete(sessionId);

    log.success(
      `✅ Session ${sessionId} closed (${this.sessions.size}/${this.maxSessions} active)`
    );
    return true;
  }

  /**
   * Close all sessions that are using the provided notebook URL
   */
  async closeSessionsForNotebook(url: string): Promise<number> {
    let closed = 0;

    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      if (session.notebookUrl === url) {
        try {
          await session.close();
        } catch (error) {
          log.warning(`  ⚠️  Error closing ${sessionId}: ${error}`);
        } finally {
          this.sessions.delete(sessionId);
          closed++;
        }
      }
    }

    if (closed > 0) {
      log.warning(
        `🧹 Closed ${closed} session(s) using removed notebook (${this.sessions.size}/${this.maxSessions} active)`
      );
    }

    return closed;
  }

  /**
   * Clean up all inactive sessions
   */
  async cleanupInactiveSessions(): Promise<number> {
    const inactiveSessions: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      // `lastActivity` only advances when a session is handed out, so a
      // long-running operation (a 10-minute audio generation, a mind-map
      // expansion) looks idle to this sweeper the whole time it runs. Closing
      // a busy session pulls the page out from under the operation, which
      // surfaces to the caller as an unexplained "Target closed".
      if (this.isBusy(sessionId)) {
        continue;
      }
      if (session.isExpired(this.sessionTimeout)) {
        inactiveSessions.push(sessionId);
      }
    }

    if (inactiveSessions.length === 0) {
      return 0;
    }

    log.warning(`🧹 Cleaning up ${inactiveSessions.length} inactive sessions...`);

    for (const sessionId of inactiveSessions) {
      try {
        const session = this.sessions.get(sessionId)!;
        const age = (Date.now() - session.createdAt) / 1000;
        const inactive = (Date.now() - session.lastActivity) / 1000;

        log.warning(
          `  🗑️  ${sessionId}: age=${age.toFixed(0)}s, inactive=${inactive.toFixed(0)}s, messages=${session.messageCount}`
        );

        await session.close();
        this.sessions.delete(sessionId);
      } catch (error) {
        log.warning(`  ⚠️  Error cleaning up ${sessionId}: ${error}`);
      }
    }

    log.success(
      `✅ Cleaned up ${inactiveSessions.length} sessions (${this.sessions.size}/${this.maxSessions} active)`
    );
    return inactiveSessions.length;
  }

  /**
   * Clean up the oldest session to make space
   */
  private async cleanupOldestSession(): Promise<boolean> {
    if (this.sessions.size === 0) {
      return false;
    }

    // Find the oldest session that is not mid-operation. Evicting by creation
    // time alone force-closed the page of a session that was actively
    // answering a question — the caller got a "Target closed" error for work
    // that was proceeding fine.
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (this.isBusy(sessionId)) continue;
      if (session.createdAt < oldestTime) {
        oldestTime = session.createdAt;
        oldestId = sessionId;
      }
    }

    if (!oldestId) {
      log.warning("  ⚠️  Every session is currently busy — nothing can be evicted");
      return false;
    }

    const oldestSession = this.sessions.get(oldestId)!;
    const age = (Date.now() - oldestSession.createdAt) / 1000;

    log.warning(`🗑️  Removing oldest session ${oldestId} (age: ${age.toFixed(0)}s)`);

    await oldestSession.close();
    this.sessions.delete(oldestId);

    return true;
  }

  /**
   * Close all sessions (used during shutdown)
   */
  async closeAllSessions(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    if (this.sessions.size === 0) {
      log.warning("🛑 Closing shared context (no active sessions)...");
      await this.sharedContextManager.closeContext();
      log.success("✅ All sessions closed");
      return;
    }

    log.warning(`🛑 Closing all ${this.sessions.size} sessions...`);

    for (const sessionId of Array.from(this.sessions.keys())) {
      try {
        const session = this.sessions.get(sessionId)!;
        await session.close();
        this.sessions.delete(sessionId);
      } catch (error) {
        log.warning(`  ⚠️  Error closing ${sessionId}: ${error}`);
      }
    }

    // Close the shared context
    await this.sharedContextManager.closeContext();

    log.success("✅ All sessions closed");
  }

  /**
   * Get all sessions info
   */
  getAllSessionsInfo(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => session.getInfo());
  }

  /**
   * Get aggregate stats
   */
  getStats(): {
    active_sessions: number;
    max_sessions: number;
    session_timeout: number;
    oldest_session_seconds: number;
    total_messages: number;
  } {
    const sessionsInfo = this.getAllSessionsInfo();

    const totalMessages = sessionsInfo.reduce((sum, info) => sum + info.message_count, 0);
    const oldestSessionSeconds = Math.max(...sessionsInfo.map((info) => info.age_seconds), 0);

    return {
      active_sessions: sessionsInfo.length,
      max_sessions: this.maxSessions,
      session_timeout: this.sessionTimeout,
      oldest_session_seconds: oldestSessionSeconds,
      total_messages: totalMessages,
    };
  }
}
