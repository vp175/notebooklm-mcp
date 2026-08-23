/**
 * Custom Error Types for NotebookLM MCP Server
 */

/**
 * Error thrown when NotebookLM rate limit is exceeded
 *
 * Free users have 50 queries/day limit.
 * This error indicates the user should:
 * - Use re_auth tool to switch Google accounts
 * - Wait until tomorrow for quota reset
 * - Upgrade to Google AI Pro/Ultra for higher limits
 */
export class RateLimitError extends Error {
  constructor(
    message: string = "NotebookLM rate limit reached (50 queries/day for free accounts)"
  ) {
    super(message);
    this.name = "RateLimitError";

    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RateLimitError);
    }
  }
}

/**
 * Error thrown when authentication fails
 *
 * This error can suggest cleanup workflow for persistent issues.
 * Especially useful when upgrading from old installation (notebooklm-mcp-nodejs).
 */
export class AuthenticationError extends Error {
  suggestCleanup: boolean;

  constructor(message: string, suggestCleanup: boolean = false) {
    super(message);
    this.name = "AuthenticationError";
    this.suggestCleanup = suggestCleanup;

    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AuthenticationError);
    }
  }
}

/**
 * Error thrown by the `elicit` callback (wired in index.ts) specifically when
 * the client HAS declared the `elicitation` capability but the underlying
 * `server.elicitInput()` request itself failed — rejected, errored, or (most
 * commonly) timed out waiting for a human to answer the confirmation dialog.
 *
 * This is distinct from the "capability not declared" case, which the
 * callback signals by resolving to `undefined` rather than throwing. Callers
 * that need fail-closed behavior on a failed confirmation (e.g.
 * `remove_notebook`, a destructive tool) should catch this specific error
 * type and refuse to proceed, rather than treating it the same as "elicitation
 * unavailable, proceed as before".
 */
export class ElicitationRequestError extends Error {
  constructor(message: string = "Elicitation request failed") {
    super(message);
    this.name = "ElicitationRequestError";

    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ElicitationRequestError);
    }
  }
}
