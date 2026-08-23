#!/usr/bin/env node

/**
 * NotebookLM MCP Server
 *
 * MCP Server for Google NotebookLM - Chat with Gemini 2.5 through NotebookLM
 * with session support and human-like behavior!
 *
 * Features:
 * - Session-based contextual conversations
 * - Auto re-login on session expiry
 * - Human-like typing and mouse movements
 * - Persistent browser fingerprint
 * - Stealth mode with Patchright
 * - Claude Code integration via npx
 *
 * Usage:
 *   npx notebooklm-mcp
 *   node dist/index.js
 *
 * Environment Variables:
 *   NOTEBOOK_URL - Default NotebookLM notebook URL
 *   AUTO_LOGIN_ENABLED - Enable automatic login (true/false)
 *   LOGIN_EMAIL - Google email for auto-login
 *   LOGIN_PASSWORD - Google password for auto-login
 *   HEADLESS - Run browser in headless mode (true/false)
 *   MAX_SESSIONS - Maximum concurrent sessions (default: 10)
 *   SESSION_TIMEOUT - Session timeout in seconds (default: 900)
 *
 * Based on the Python NotebookLM API implementation
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  METHOD_NOT_FOUND,
  ProtocolError,
  Server,
  isInputRequiredResult,
} from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { ClientCapabilities, ServerContext, Tool } from "@modelcontextprotocol/server";

import type { ProgressCallback } from "./types.js";
import { AuthManager } from "./auth/auth-manager.js";
import { applyAccountToConfig, getRequestedAccount } from "./auth/account-switcher.js";
import { SessionManager } from "./session/session-manager.js";
import { NotebookLibrary } from "./library/notebook-library.js";
import { ToolHandlers, buildToolDefinitions } from "./tools/index.js";
import { validateToolArgs } from "./tools/validate-args.js";
import { ResourceHandlers } from "./resources/resource-handlers.js";
import { SettingsManager } from "./utils/settings-manager.js";
import { CliHandler } from "./utils/cli-handler.js";
import { CONFIG, ensureDirectories } from "./config.js";
import { startHttpTransport } from "./transport/http.js";
import { log } from "./utils/logger.js";

/**
 * Server-level instructions consumed by MCP clients during initialization.
 * Per the MCP spec, these describe **cross-tool workflows, ID flows, and
 * constraints** so an LLM agent can use the server end-to-end without prior
 * context. We deliberately keep individual tool descriptions terse — no
 * duplicating workflow advice across every tool.
 *
 * Reference: modelcontextprotocol typescript-sdk → "Server instructions".
 */
const SERVER_INSTRUCTIONS = `# notebooklm-mcp — research with Google NotebookLM

This server lets an LLM run a fully session-based research workflow against
a NotebookLM notebook (chat with Gemini 2.5 grounded on user-uploaded
sources, ingest sources, generate Audio Overviews).

## First-run flow

1. \`get_health\` → if \`authenticated=false\`, run \`setup_auth\` (opens
   a browser tab — user logs in once, cookies persist).
2. Get notebooks into the library, either way:
   - \`discover_notebooks\` — no input, scans the account's dashboard and
     registers every notebook already there (including ones created
     directly in the web UI, which \`add_notebook\` alone can't see). Safe
     to re-run; already-registered notebooks are skipped, not duplicated.
   - \`add_notebook\` — register one specific notebook by share-URL (the
     user must provide it — see add_notebook for the link workflow).
   Optionally \`select_notebook\` to make one the default.
3. \`ask_question\` — start asking. Save the returned \`session_id\` and
   reuse it for follow-up questions to keep context.

## Notebook ID flow

\`list_notebooks\` / \`search_notebooks\` / \`get_notebook\` all return
notebook objects with an \`id\` field. That \`id\` feeds
\`select_notebook\`, \`update_notebook\`, \`remove_notebook\`, and the
optional \`notebook_id\` argument on \`ask_question\` / \`add_source\` /
audio tools.

## Session ID flow

\`ask_question\` returns \`session_id\` on every call. Pass that same id
back as \`session_id\` on later \`ask_question\` calls to maintain a
conversational context (NotebookLM uses session-RAG so follow-ups get
sharper). \`list_sessions\` enumerates live sessions; \`reset_session\`
clears chat history (same id), \`close_session\` ends a session.

A follow-up that passes only \`session_id\` stays on that session's own
notebook — it is NOT retargeted at whatever notebook is currently active.
To move to a different notebook, start a new session (omit
\`session_id\`) or pass \`notebook_id\`/\`notebook_url\` explicitly.
If the \`session_id\` you pass is not a live session, a new one answers
and the response carries a \`session_note\` saying so — the earlier
conversation's context is gone.

Every browser-touching tool (\`add_source\`, the audio tools, the studio
tools) also returns the \`session_id\` it used. Reuse it for the next call
on the same notebook, and \`close_session\` it when finished instead of
leaving it to idle out.

## Source ingestion (multi-source)

Call \`add_source\` once per source — text snippets and URLs are supported.
NotebookLM crawls/indexes each source asynchronously; new sources are
typically queryable within 5–30 seconds after \`add_source\` succeeds.

## Audio Overview (async chain — important)

\`generate_audio\` is **non-blocking** by default: it triggers the render
and returns immediately with \`status: "started"\` (or \`"in_progress"\` if
a generation was already running, or \`"ready"\` if one already existed).
Generation typically takes 2–10 minutes.

To complete the workflow, poll \`get_audio_status\` every ~30 s. When it
returns \`status: "ready"\`, call \`download_audio\` with an absolute
\`destination_dir\` to save the file. Calling \`download_audio\` before
\`ready\` will surface a clear error.

For synchronous behaviour pass \`wait_for_completion: true\` to
\`generate_audio\` (legacy mode — blocks for up to \`timeout_ms\`).

## Constraints

- Free Google accounts: 50 NotebookLM queries/day. \`re_auth\` rotates
  accounts.
- Session timeout: ~15 min idle (see \`get_health.session_timeout\`).
- File / YouTube / Drive source uploads are not yet implemented in v2.0.
- 8 of the 9 Studio output types are implemented, exposed via
  \`generate_studio_output\`/\`get_studio_output_status\`/
  \`download_studio_output\`/\`get_studio_output_content\` (and the legacy
  \`generate_audio\`/\`get_audio_status\`/\`download_audio\` audio-only
  aliases): Audio Overview, Video Overview, Infographic, and Slide Deck
  (file-kind, use \`download_studio_output\`); Mind Map, Data Table, Quiz,
  and Flashcards (structured-kind, use \`get_studio_output_content\`, which
  returns each node/card/question honestly flagged if a partial read
  ever occurs rather than silently wrong). Only \`report\` returns a clear
  "not yet implemented" error (Phase 2) — its trigger dialog is
  live-confirmed but its completed-content viewer still needs DOM
  reconnaissance before extraction can be built.
- KNOWN LIMITATION: mid-generation status reporting is only partly
  reliable. This server remembers generations IT started, so a repeat
  \`generate_studio_output\` for the same type returns \`in_progress\`
  rather than starting a duplicate, and it also looks for an in-progress
  tile on the page. A generation started ELSEWHERE (the NotebookLM web UI,
  another process) can still read as \`not_started\` until its tile
  appears — poll instead of re-triggering.
- \`difficulty\` on \`generate_studio_output\` is accepted but not wired
  into the Customize dialog; passing it returns a warning in
  \`result.warnings\` and the default difficulty is used.
- Citations: pass \`source_format\` other than \`none\` on
  \`ask_question\` to get a \`sources\` array. If the answer carried no
  citation markers you get \`sources_note\` explaining that, rather than a
  silently missing field.
- Downloads require an ABSOLUTE \`destination_dir\` (created if missing);
  a relative path is rejected, and an existing file is never overwritten.
`;

/**
 * MCP progress tokens live in `params._meta.progressToken` — a sibling of
 * `params.arguments`, NOT a key inside the arguments object.
 *
 * This used to read `arguments._meta.progressToken`, which no compliant client
 * ever populates, so `sendProgress` was gated on a token that was always
 * undefined and **not a single progress notification was ever emitted** (a live
 * MCP client run recorded 0 notifications across a 26-second `ask_question`).
 * We read the spec location first and keep the old one as a tolerated fallback
 * for any caller that copied the previous behaviour.
 */
function extractProgressToken(
  params: {
    _meta?: unknown;
    arguments?: Record<string, unknown>;
  },
  ctx?: ServerContext
): string | number | undefined {
  // The v2 SDK hands the handler its `_meta` on the request context (with the
  // reserved `io.modelcontextprotocol/*` envelope keys already lifted out), so
  // this is the authoritative place to look. `params._meta` is checked next
  // for transports/eras that leave it in place, and the old
  // `arguments._meta` is kept only as a tolerated fallback.
  const fromCtx = readProgressToken(ctx?.mcpReq?._meta);
  if (fromCtx !== undefined) return fromCtx;
  const fromMeta = readProgressToken(params?._meta);
  if (fromMeta !== undefined) return fromMeta;
  return readProgressToken(params?.arguments?._meta);
}

/**
 * The calling client's declared capabilities.
 *
 * On protocol revision 2026-07-28 there is no `initialize` handshake, so
 * `Server.getClientCapabilities()` returns UNDEFINED and every capability gate
 * built on it silently reads "not supported" — which for a confirmation gate
 * means a destructive tool proceeds unconfirmed. Verified on the wire: the
 * envelope carried `{elicitation:{}}` while the accessor returned undefined.
 * The per-request envelope is authoritative on the modern era; the accessor is
 * the fallback for 2025-era connections.
 */
function clientCapabilities(server: Server, ctx?: ServerContext): ClientCapabilities | undefined {
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined;
  const fromEnvelope = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  if (fromEnvelope && typeof fromEnvelope === "object") {
    return fromEnvelope as ClientCapabilities;
  }
  return server.getClientCapabilities();
}

function readProgressToken(meta: unknown): string | number | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const token = (meta as { progressToken?: unknown }).progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

/**
 * A confirmation round-trip, as the tool handlers see it.
 *
 * `canElicit` is whether this client can answer a confirmation at all;
 * `responses` carries the answers a retried call brought back (the
 * multi-round-trip flow of protocol revision 2026-07-28, which the SDK also
 * serves to 2025-era clients through its legacy elicitation shim).
 */
export interface ConfirmContext {
  canElicit: boolean;
  responses?: Record<string, unknown>;
}

type ToolDispatchEntry = (
  args: Record<string, unknown> | undefined,
  sendProgress: ProgressCallback,
  confirm: ConfirmContext
) => Promise<unknown>;

type ToolDispatch = Map<string, ToolDispatchEntry>;

/**
 * Main MCP Server Class
 */
class NotebookLMMCPServer {
  private server: Server;
  private authManager: AuthManager;
  private sessionManager: SessionManager;
  private library: NotebookLibrary;
  private toolHandlers: ToolHandlers;
  private resourceHandlers: ResourceHandlers;
  private settingsManager: SettingsManager;
  private toolDefinitions: Tool[];
  /** Set when shutdown was triggered by a crash, so we exit non-zero. */
  private shutdownFailed = false;
  /** Installed by `start()` for the stdio transport (see setupShutdownHandlers). */
  private stdinShutdownHook?: () => void;
  /** Closeable handle for the HTTP transport, when that transport is in use. */
  private httpHandle?: { close: () => Promise<void> };
  /** Closeable handle for the stdio entry, when that transport is in use. */
  private stdioHandle?: StdioServerHandle;

  constructor() {
    // Initialize managers (shared by every connection)
    this.authManager = new AuthManager();
    this.sessionManager = new SessionManager(this.authManager);
    this.library = new NotebookLibrary();
    this.settingsManager = new SettingsManager();
    this.resourceHandlers = new ResourceHandlers(this.library);

    // The primary connection. `createConnection()` can be called again per
    // HTTP session — see `start()`.
    const primary = this.createConnection();
    this.server = primary.server;
    this.toolHandlers = primary.toolHandlers;

    // Build and Filter tool definitions.
    //
    // These are only the STARTUP snapshot, kept for the banner. The live
    // handlers rebuild on every request: `ask_question`'s description is
    // generated from the library's active notebook, so a snapshot taken in the
    // constructor kept advertising whatever notebook was active when the
    // process started, even after `select_notebook` / `add_notebook` /
    // `discover_notebooks` changed it.
    this.toolDefinitions = this.getActiveTools();

    this.setupShutdownHandlers();

    const activeSettings = this.settingsManager.getEffectiveSettings();
    log.info("🚀 NotebookLM MCP Server initialized");
    log.info(`  Version: 2.0.0`);
    log.info(`  Node: ${process.version}`);
    log.info(`  Platform: ${process.platform}`);
    log.info(`  Profile: ${activeSettings.profile} (${this.toolDefinitions.length} tools active)`);
  }

  /**
   * Build one MCP `Server` instance with its own handler set.
   *
   * WHY a factory: the SDK's `Server.connect()` binds exactly one transport
   * per instance and throws on a second call. The HTTP transport creates a
   * transport per session, so re-using a single `Server` meant the *second*
   * concurrent HTTP client crashed the request handler and got a 500 — the
   * multi-session support the transport advertises did not exist. Each
   * connection now gets its own `Server` (and its own `ToolHandlers`, so
   * elicitation is routed back to the client that asked), while all real state
   * — sessions, browser context, library — stays in the shared managers.
   */
  private createConnection(): { server: Server; toolHandlers: ToolHandlers } {
    const server = new Server(
      {
        name: "notebooklm-mcp",
        version: "2.0.0",
      },
      {
        capabilities: {
          tools: {},
          // Resource templates are part of the `resources` capability per the
          // MCP spec, not a sibling key — `resourceTemplates: {}` here was
          // never a valid capability declaration.
          resources: { listChanged: true },
          prompts: {},
          completions: {}, // Required for completion/complete support
          // `logging: {}` was declared with no SetLevelRequestSchema handler
          // and no sendLoggingMessage call anywhere in the codebase — the
          // same "declared but not backed" bug fixed for `prompts` below.
          // Dropped rather than implemented: nothing in this codebase emits
          // MCP log messages today, so a real implementation has no content
          // to carry yet. Re-add when something needs it.
        },
        // MCP-spec server instructions (clients merge into the system prompt).
        // Use these for cross-tool workflow guidance — do not duplicate
        // information that already lives in individual tool descriptions.
        instructions: SERVER_INSTRUCTIONS,
      }
    );

    // Initialize handlers.
    //
    // Confirmation prompts are NOT a server→client request any more. The
    // 2026-07-28 revision removed that channel entirely: a handler that needs
    // user input returns `inputRequired(...)` and the client re-calls the tool
    // with the answers attached. The SDK's legacy shim turns the same return
    // value into a real `elicitation/create` request for 2025-era clients, so
    // one code path serves both eras and the old elicit callback is gone.
    //
    // What the handler still needs from the connection is (a) whether this
    // client can answer at all, so a client with no elicitation capability
    // keeps the old fall-through behaviour instead of getting a capability
    // error, and (b) the answers carried by a retried call.
    const toolHandlers = new ToolHandlers(this.sessionManager, this.authManager, this.library);

    this.setupHandlers(server, this.buildToolDispatch(toolHandlers));
    return { server, toolHandlers };
  }

  /**
   * The tools this server currently exposes: rebuilt from the live library so
   * dynamic descriptions stay current, then filtered by the active profile /
   * `disabledTools` setting.
   */
  private getActiveTools(): Tool[] {
    const allTools = buildToolDefinitions(this.library) as Tool[];
    return this.settingsManager.filterTools(allTools);
  }

  /**
   * Build the tool-name → handler dispatch table used by the
   * `CallToolRequestSchema` handler. A direct 1:1 transcription of every
   * tool case previously handled by a `switch` statement — no new logic.
   * `Parameters<typeof h.handleX>[0]` derives each handler's argument type
   * from its own declaration in `handlers.ts`, so it cannot silently drift
   * out of sync with the handler signatures.
   */
  private buildToolDispatch(handlers: ToolHandlers): ToolDispatch {
    const h = handlers;
    return new Map<string, ToolDispatchEntry>([
      [
        "ask_question",
        (args, sendProgress) =>
          h.handleAskQuestion(args as Parameters<typeof h.handleAskQuestion>[0], sendProgress),
      ],
      [
        "add_notebook",
        (args) => h.handleAddNotebook(args as unknown as Parameters<typeof h.handleAddNotebook>[0]),
      ],
      ["discover_notebooks", () => h.handleDiscoverNotebooks()],
      ["list_notebooks", () => h.handleListNotebooks()],
      [
        "get_notebook",
        (args) => h.handleGetNotebook(args as Parameters<typeof h.handleGetNotebook>[0]),
      ],
      [
        "select_notebook",
        (args) => h.handleSelectNotebook(args as Parameters<typeof h.handleSelectNotebook>[0]),
      ],
      [
        "update_notebook",
        (args) =>
          h.handleUpdateNotebook(args as unknown as Parameters<typeof h.handleUpdateNotebook>[0]),
      ],
      [
        "remove_notebook",
        (args, _sendProgress, confirm) =>
          h.handleRemoveNotebook(args as Parameters<typeof h.handleRemoveNotebook>[0], confirm),
      ],
      [
        "search_notebooks",
        (args) => h.handleSearchNotebooks(args as Parameters<typeof h.handleSearchNotebooks>[0]),
      ],
      ["get_library_stats", () => h.handleGetLibraryStats()],
      ["list_sessions", () => h.handleListSessions()],
      [
        "close_session",
        (args) => h.handleCloseSession(args as Parameters<typeof h.handleCloseSession>[0]),
      ],
      [
        "reset_session",
        (args) => h.handleResetSession(args as Parameters<typeof h.handleResetSession>[0]),
      ],
      ["get_health", () => h.handleGetHealth()],
      [
        "setup_auth",
        (args, sendProgress) =>
          h.handleSetupAuth(args as Parameters<typeof h.handleSetupAuth>[0], sendProgress),
      ],
      [
        "re_auth",
        (args, sendProgress) =>
          h.handleReAuth(args as Parameters<typeof h.handleReAuth>[0], sendProgress),
      ],
      [
        "cleanup_data",
        (args, _sendProgress, confirm) =>
          h.handleCleanupData(args as Parameters<typeof h.handleCleanupData>[0], confirm),
      ],
      ["add_source", (args) => h.handleAddSource(args as Parameters<typeof h.handleAddSource>[0])],
      [
        "generate_audio",
        (args) => h.handleGenerateAudio(args as Parameters<typeof h.handleGenerateAudio>[0]),
      ],
      [
        "get_audio_status",
        (args) => h.handleGetAudioStatus(args as Parameters<typeof h.handleGetAudioStatus>[0]),
      ],
      [
        "download_audio",
        (args) => h.handleDownloadAudio(args as Parameters<typeof h.handleDownloadAudio>[0]),
      ],
      [
        "generate_studio_output",
        (args) =>
          h.handleGenerateStudioOutput(args as Parameters<typeof h.handleGenerateStudioOutput>[0]),
      ],
      [
        "get_studio_output_status",
        (args) =>
          h.handleGetStudioOutputStatus(
            args as Parameters<typeof h.handleGetStudioOutputStatus>[0]
          ),
      ],
      [
        "download_studio_output",
        (args) =>
          h.handleDownloadStudioOutput(args as Parameters<typeof h.handleDownloadStudioOutput>[0]),
      ],
      [
        "get_studio_output_content",
        (args) =>
          h.handleGetStudioOutputContent(
            args as Parameters<typeof h.handleGetStudioOutputContent>[0]
          ),
      ],
    ]);
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers(server: Server, toolDispatch: ToolDispatch): void {
    // Register Resource Handlers (Resources, Templates, Completions)
    this.resourceHandlers.registerHandlers(server);

    // List available tools. Rebuilt per request so `ask_question`'s
    // library-derived description reflects the CURRENT active notebook.
    server.setRequestHandler("tools/list", async () => {
      log.info("📋 [MCP] list_tools request received");
      this.toolDefinitions = this.getActiveTools();
      return {
        tools: this.toolDefinitions,
      };
    });

    // Handle tool calls
    server.setRequestHandler("tools/call", async (request, ctx: ServerContext) => {
      const { name, arguments: args } = request.params;
      const progressToken = extractProgressToken(request.params, ctx);

      log.info(`🔧 [MCP] Tool call: ${name}`);
      if (progressToken !== undefined) {
        log.info(`  📊 Progress token: ${progressToken}`);
      }

      // Resolve the tool definition from the LIVE set so profile filtering and
      // schema validation both act on what this server actually advertises.
      const activeTools = this.getActiveTools();
      const tool = activeTools.find((t) => t.name === name);
      const declaresOutputSchema = tool?.outputSchema !== undefined;

      /**
       * A tool-level failure. Tools that declare an `outputSchema` MUST set the
       * protocol-level `isError` when they do not return `structuredContent` —
       * an SDK-based client otherwise rejects the result with "Tool X has an
       * output schema but did not return structured content".
       */
      const failure = (message: string, withIsError = declaresOutputSchema) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: message }, null, 2),
          },
        ],
        ...(withIsError ? { isError: true } : {}),
      });

      // Create progress callback function.
      // Progress is best-effort telemetry: a transport hiccup here must never
      // discard an otherwise-successful tool result, so failures are logged
      // and swallowed rather than propagated.
      const sendProgress = async (message: string, progress?: number, total?: number) => {
        // `0` is a legitimate progress token (the SDK client uses the
        // JSON-RPC message id, which starts at 0), so this must be an
        // explicit undefined check — a truthiness test silently dropped
        // every progress notification for the first call on a connection.
        if (progressToken === undefined) return;
        try {
          // `ctx.mcpReq.notify` correlates the notification with THIS request,
          // which the 2026-07-28 revision needs (and which a bare
          // `server.notification` cannot express).
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: {
              progressToken,
              message,
              ...(progress !== undefined && { progress }),
              ...(total !== undefined && { total }),
            },
          });
          log.dim(`  📊 Progress: ${message}`);
        } catch (error) {
          log.warning(`  ⚠️  Progress notification failed (ignored): ${error}`);
        }
      };

      try {
        const handler = toolDispatch.get(name);
        if (!handler) {
          log.error(`❌ [MCP] Unknown tool: ${name}`);
          // Unknown method names are a protocol-level error, not a tool
          // result: returning a success-shaped payload made a typo look like
          // a tool that ran and failed.
          throw new ProtocolError(
            METHOD_NOT_FOUND,
            `Unknown tool: ${name}. Call tools/list for the active set.`
          );
        }

        // A tool hidden by the active profile / `disabledTools` must not be
        // callable: filtering only tools/list left every disabled tool fully
        // invokable by name, so the profile setting was cosmetic.
        if (!tool) {
          log.error(`❌ [MCP] Tool disabled by profile: ${name}`);
          throw new ProtocolError(
            METHOD_NOT_FOUND,
            `Tool "${name}" is not available in the active profile ` +
              `("${this.settingsManager.getEffectiveSettings().profile}"). ` +
              `Call tools/list for the active set.`
          );
        }

        // The low-level Server does not validate arguments against
        // inputSchema; without this a missing required argument reached the
        // handler and surfaced as an internal TypeError (or, worse, was
        // silently written to disk).
        const validationError = validateToolArgs(tool, args);
        if (validationError) {
          log.error(`❌ [MCP] Invalid arguments for ${name}: ${validationError}`);
          return failure(`Invalid arguments for \`${name}\`: ${validationError}`);
        }

        const result = await handler(args, sendProgress, {
          // A client that never declared `elicitation` cannot answer a
          // confirmation request, so the handlers keep their old
          // no-confirmation behaviour instead of failing with a capability
          // error. Read from the per-request envelope on 2026-07-28 — see
          // `clientCapabilities`.
          canElicit: clientCapabilities(server, ctx)?.elicitation !== undefined,
          // Answers carried by a retried call (multi-round-trip). Empty on
          // the first call.
          responses: ctx.mcpReq.inputResponses,
        });

        // A handler that needs the user to answer something returns the
        // SDK's input-required result. It is a protocol result in its own
        // right — pass it straight through rather than JSON-stringifying it
        // into a text block. The SDK serves it natively on 2026-07-28 and,
        // via its legacy shim, as a real elicitation request to 2025 clients.
        if (isInputRequiredResult(result)) {
          log.info(`  ⏸️  ${name} needs client input — returning input_required`);
          return result;
        }

        // Never attach structuredContent to an error result — only the
        // success shape is covered by the declared outputSchema.
        const isSuccessResult =
          typeof result === "object" &&
          result !== null &&
          (result as { success?: boolean }).success !== false;

        // Return result
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          ...(declaresOutputSchema && isSuccessResult
            ? { structuredContent: result as Record<string, unknown> }
            : {}),
          ...(declaresOutputSchema && !isSuccessResult ? { isError: true } : {}),
        };
      } catch (error) {
        // Protocol-level errors (unknown/disabled tool) must reach the client
        // as JSON-RPC errors, not as a tool result.
        if (error instanceof ProtocolError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`❌ [MCP] Tool execution error: ${errorMessage}`);

        // Same isError rule as above: an exception escaping a handler that
        // declares an outputSchema previously produced a result SDK clients
        // reject outright, hiding the real error message from the model.
        return failure(errorMessage);
      }
    });
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    let shuttingDown = false;

    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      log.info(`\n🛑 Received ${signal}, shutting down gracefully...`);

      // Hard ceiling on cleanup so a wedged browser context can't keep the
      // process alive (issue #29 — orphan Chrome on macOS after MCP reconnects).
      // After 5 s we give up gracefully and let `process.exit` reap children.
      const watchdog = setTimeout(() => {
        log.error("⏱️  Shutdown stalled — forcing exit (issue #29 watchdog)");
        process.exit(1);
      }, 5_000);
      watchdog.unref();

      try {
        await this.toolHandlers.cleanup();
        // `serveStdio`'s handle owns the instance it pinned to the connection
        // and the transport underneath it; closing the primary Server alone
        // would leave both open.
        await this.stdioHandle?.close();
        await this.server.close();
        // An HTTP transport keeps a listening socket that `server.close()`
        // does not own; leaving it open kept the process alive past shutdown.
        await this.httpHandle?.close();
        log.success("✅ Shutdown complete");
        clearTimeout(watchdog);
        // A shutdown triggered by a crash must not report success to the
        // supervisor that started us.
        process.exit(this.shutdownFailed ? 1 : 0);
      } catch (error) {
        log.error(`❌ Error during shutdown: ${error}`);
        clearTimeout(watchdog);
        process.exit(1);
      }
    };

    const requestShutdown = (signal: string) => {
      void shutdown(signal);
    };

    process.on("SIGINT", () => requestShutdown("SIGINT"));
    process.on("SIGTERM", () => requestShutdown("SIGTERM"));

    process.on("uncaughtException", (error) => {
      log.error(`💥 Uncaught exception: ${error}`);
      log.error(error.stack || "");
      this.shutdownFailed = true;
      requestShutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason, promise) => {
      log.error(`💥 Unhandled rejection at: ${promise}`);
      log.error(`Reason: ${reason}`);
      this.shutdownFailed = true;
      requestShutdown("unhandledRejection");
    });

    // A stdio client that goes away never sends a signal — it just closes the
    // pipe. Without this the process (and its Chrome) lived on as an orphan
    // after every MCP client restart or /mcp reconnect (issue #29).
    this.stdinShutdownHook = () => requestShutdown("stdin-closed");
  }

  /**
   * Start the MCP server using stdio (default) or HTTP transport (issue #4).
   */
  async start(options: TransportOptions = { kind: "stdio" }): Promise<void> {
    log.info("🎯 Starting NotebookLM MCP Server...");
    log.info("");
    log.info("📝 Configuration:");
    log.info(`  Config Dir: ${CONFIG.configDir}`);
    log.info(`  Data Dir: ${CONFIG.dataDir}`);
    log.info(`  Headless: ${CONFIG.headless}`);
    log.info(`  Max Sessions: ${CONFIG.maxSessions}`);
    log.info(`  Session Timeout: ${CONFIG.sessionTimeout}s`);
    log.info(`  Stealth: ${CONFIG.stealthEnabled}`);
    log.info(`  Transport: ${options.kind}`);
    log.info("");

    if (options.kind === "http") {
      // The SDK's HTTP entry builds an instance per exchange from this factory.
      this.httpHandle = await startHttpTransport({
        port: options.port,
        host: options.host,
        factory: () => this.createConnection().server,
      });
      log.success("✅ MCP Server connected via Streamable HTTP (2026-07-28 + legacy)");
    } else {
      // `serveStdio` — NOT `new StdioServerTransport()` + `connect()` — is what
      // selects the protocol era. The v1-style wiring speaks the 2025 era only;
      // this entry answers `server/discover` and serves the stateless
      // 2026-07-28 revision, while `legacy` (default 'serve') keeps answering
      // the older `initialize` handshake for clients that have not moved.
      this.stdioHandle = serveStdio(() => this.createConnection().server, {
        onerror: (error) => log.warning(`⚠️  [stdio] ${error.message}`),
      });
      // A stdio client that disconnects closes the pipe without a signal;
      // without this the server and its Chrome outlive the client (issue #29).
      process.stdin.on("close", () => this.stdinShutdownHook?.());
      process.stdin.on("end", () => this.stdinShutdownHook?.());
      log.success("✅ MCP Server serving stdio (2026-07-28 + legacy)");
    }

    log.success("🎉 Ready to receive requests from Claude Code!");
    log.info("");
    log.info("💡 Available tools:");
    for (const tool of this.toolDefinitions) {
      const desc = tool.description ? tool.description.split("\n")[0] : "No description";
      log.info(`  - ${tool.name}: ${desc.substring(0, 80)}...`);
    }
    log.info("");
    log.info("📖 For documentation, see: README.md");
    log.info("");
  }
}

type TransportOptions = { kind: "stdio" } | { kind: "http"; port: number; host?: string };

function parseTransportOptions(argv: readonly string[]): TransportOptions {
  let kind: "stdio" | "http" = "stdio";
  let port = 3000;
  let host: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--transport") {
      const next = argv[i + 1];
      if (next === "http" || next === "stdio") {
        kind = next;
        i++;
      }
    } else if (arg.startsWith("--transport=")) {
      const value = arg.slice("--transport=".length);
      if (value === "http" || value === "stdio") kind = value;
    } else if (arg === "--port") {
      const next = argv[i + 1];
      const parsed = next ? Number.parseInt(next, 10) : Number.NaN;
      if (Number.isFinite(parsed)) {
        port = parsed;
        i++;
      }
    } else if (arg.startsWith("--port=")) {
      const parsed = Number.parseInt(arg.slice("--port=".length), 10);
      if (Number.isFinite(parsed)) port = parsed;
    } else if (arg === "--host") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        host = next;
        i++;
      }
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    }
  }

  // Env-var fallbacks for hosted deployments.
  const envTransport = process.env.NOTEBOOKLM_TRANSPORT;
  if (envTransport === "http" || envTransport === "stdio") kind = envTransport;
  const envPort = process.env.NOTEBOOKLM_PORT;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (Number.isFinite(parsed)) port = parsed;
  }
  const envHost = process.env.NOTEBOOKLM_HOST;
  if (envHost) host = envHost;

  if (kind === "http") return { kind, port, host };
  return { kind: "stdio" };
}

/**
 * Main entry point
 */
async function main() {
  // Handle CLI commands
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] === "config") {
    const cli = new CliHandler();
    await cli.handleCommand(args);
    process.exit(0);
  }

  // Apply --account / NOTEBOOKLM_ACCOUNT before any directory or browser is
  // touched (issue #2). The account-switcher rewrites CONFIG paths so each
  // Google account gets an isolated Chrome profile + auth state directory.
  const account = getRequestedAccount();
  if (account) {
    applyAccountToConfig(CONFIG, account);
    ensureDirectories();
    log.info(`👤 Account profile active: ${account}`);
  }

  // Print banner
  console.error("╔══════════════════════════════════════════════════════════╗");
  console.error("║                                                          ║");
  console.error("║           NotebookLM MCP Server v2.0.0                   ║");
  console.error("║                                                          ║");
  console.error("║   Chat with Gemini 2.5 through NotebookLM via MCP       ║");
  console.error("║                                                          ║");
  console.error("╚══════════════════════════════════════════════════════════╝");
  console.error("");

  try {
    const transportOptions = parseTransportOptions(args);
    const server = new NotebookLMMCPServer();
    await server.start(transportOptions);
  } catch (error) {
    log.error(`💥 Fatal error starting server: ${error}`);
    if (error instanceof Error) {
      log.error(error.stack || "");
    }
    process.exit(1);
  }
}

// Run the server
main();
