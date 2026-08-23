import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * System / auth / cleanup tools. The cross-tool first-run workflow lives in
 * the server-level `instructions` string (see src/index.ts) so individual
 * descriptions stay focused on what each tool does, not how the suite
 * fits together.
 */
export const systemTools: Tool[] = [
  {
    name: "get_health",
    description:
      "Inspect server state. Returns:\n" +
      "  • `authenticated` — whether saved Google cookies are still valid\n" +
      "  • `notebook_url`, `active_notebook_id`, `active_notebook_name` —\n" +
      "    the currently selected library notebook (or null)\n" +
      "  • `total_notebooks` — library size\n" +
      "  • `active_sessions`, `max_sessions`, `session_timeout` — runtime\n" +
      "    session stats (timeout in seconds; sessions auto-close after this)\n" +
      "  • `headless`, `auto_login_enabled`, `stealth_enabled` — config\n" +
      "Use this first thing in a new conversation. If `authenticated=false`, " +
      "run `setup_auth` (or `re_auth` to switch accounts).",
    inputSchema: {
      type: "object",
      properties: {},
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        data: {
          type: "object",
          properties: {
            status: { type: "string" },
            authenticated: { type: "boolean" },
            notebook_url: { type: "string" },
            active_notebook_id: { type: ["string", "null"] },
            active_notebook_name: { type: ["string", "null"] },
            total_notebooks: { type: "number" },
            active_sessions: { type: "number" },
            max_sessions: { type: "number" },
            session_timeout: { type: "number" },
            total_messages: { type: "number" },
            headless: { type: "boolean" },
            auto_login_enabled: { type: "boolean" },
            stealth_enabled: { type: "boolean" },
            troubleshooting_tip: { type: "string" },
          },
          required: [
            "status",
            "authenticated",
            "notebook_url",
            "active_notebook_id",
            "active_notebook_name",
            "total_notebooks",
            "active_sessions",
            "max_sessions",
            "session_timeout",
            "total_messages",
            "headless",
            "auto_login_enabled",
            "stealth_enabled",
          ],
        },
        error: { type: "string" },
      },
      required: ["success", "data"],
    },
    annotations: {
      title: "Get server health",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "setup_auth",
    description:
      "Open a browser window for first-time Google login.\n\n" +
      "**This call BLOCKS until the user finishes signing in** (up to 10 " +
      "minutes) — it does not return as soon as the browser opens. Ask the " +
      "user to complete the login in the window that appears; cookies are " +
      "then persisted for future runs.\n\n" +
      "It also CLOSES any live browser sessions and replaces the stored " +
      "Chrome profile, so work in flight is ended.\n\n" +
      "When to use:\n" +
      "  • `get_health` reports `authenticated=false` for the first time\n" +
      "  • Auto-login credentials are not configured\n" +
      "  • `re_auth` is the right call when you want to *switch* accounts " +
      "or recover from a daily-quota lockout\n\n" +
      "After login finishes, call `get_health` to verify success.\n\n" +
      "If the browser session feels broken (auth keeps failing, stale cookies), " +
      "run `cleanup_data(confirm=true, preserve_library=true)` first, then " +
      "retry `setup_auth`.",
    inputSchema: {
      type: "object",
      properties: {
        show_browser: {
          type: "boolean",
          description:
            "Show the browser window. Default: true (must be visible so the " +
            "user can interact). For advanced control use `browser_options`.",
        },
        browser_options: {
          type: "object",
          description:
            "Advanced browser settings. Override visibility, timeout, or " +
            "headless mode (default: visible, 30 s).",
          properties: {
            show: { type: "boolean" },
            headless: { type: "boolean" },
            timeout_ms: { type: "number" },
          },
        },
      },
    },
    annotations: {
      title: "Set up Google authentication",
      readOnlyHint: false,
      // It wipes stored auth state and the Chrome profile and closes live
      // sessions. Declaring destructiveHint:false told hosts that gate
      // destructive tools the opposite of the truth.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "re_auth",
    description:
      "Switch to a different Google account or recover from broken auth. " +
      "Closes all active sessions, deletes saved cookies and Chrome profile, " +
      "and opens a fresh login browser.\n\n" +
      "Common triggers:\n" +
      "  • NotebookLM's 50 queries/day free-tier limit is reached and the " +
      "user wants to rotate to another Google account\n" +
      "  • `setup_auth` failed and a clean slate is needed\n\n" +
      "After login, call `get_health` to verify. For very stuck states, run " +
      "`cleanup_data(confirm=true, preserve_library=true)` before `re_auth`.",
    inputSchema: {
      type: "object",
      properties: {
        show_browser: {
          type: "boolean",
          description: "Show the browser window. Default: true.",
        },
        browser_options: {
          type: "object",
          properties: {
            show: { type: "boolean" },
            headless: { type: "boolean" },
            timeout_ms: { type: "number" },
          },
        },
      },
    },
    annotations: {
      title: "Re-authenticate",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "cleanup_data",
    description:
      "Two-phase deep cleanup of all server data on disk (auth state, " +
      "browser profiles, caches, MCP logs, temp backups). Cross-platform " +
      "(Linux/macOS/Windows). Always close all Chrome/Chromium instances " +
      "first — open browsers can lock files.\n\n" +
      "Phase 1 (preview): call with `confirm: false`. Returns a categorised " +
      "list of paths and total size. **With a client that does NOT support " +
      "elicitation, this is preview-only — no deletion happens.** " +
      "**With an elicitation-capable client, `confirm: false` also triggers " +
      "a confirmation prompt on the client side: declining it (or the " +
      "request failing/timing out) still results in preview-only, but " +
      "ACCEPTING it performs the deletion immediately — even though " +
      "`confirm` was passed as `false`.**\n" +
      "Phase 2 (delete): after the user reviews the preview and approves, " +
      "call with `confirm: true`. This always deletes, with no elicitation " +
      "step.\n\n" +
      "Set `preserve_library: true` to keep the notebook library file " +
      "(library.json) while wiping everything else — recommended when " +
      "troubleshooting auth.\n\n" +
      "Typical recovery flow:\n" +
      "  1. cleanup_data(confirm=false, preserve_library=true)  // preview\n" +
      "  2. cleanup_data(confirm=true, preserve_library=true)   // execute\n" +
      "  3. setup_auth (or re_auth)",
    inputSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          description:
            "REQUIRED — there is no default. false = preview only for a client without " +
            "elicitation; for an elicitation-capable client, accepting the " +
            "resulting confirmation prompt deletes immediately regardless " +
            "of this being false. true = always deletes, no elicitation.",
        },
        preserve_library: {
          type: "boolean",
          description:
            "Keep notebook library.json while deleting everything else. " +
            "Default: false. Set true when only auth/browser state is broken.",
          default: false,
        },
      },
      required: ["confirm"],
    },
    annotations: {
      title: "Cleanup all data",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];
