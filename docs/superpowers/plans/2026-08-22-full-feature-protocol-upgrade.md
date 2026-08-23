# notebooklm-mcp Phase 1 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of the design spec (`docs/superpowers/specs/2026-08-22-full-feature-protocol-upgrade-design.md`, as revised after Fable review): fix three dead/malformed MCP capabilities, refactor the tool-dispatch and session-recovery duplication, build a Studio-output engine with tile-discrimination, and wrap 2 new Studio outputs (Report, Flash Cards) alongside a tile-scoped retrofit of the existing Audio Overview — without regressing any of the 20 tools that work today.

**Architecture:** A strategy-registry engine (`src/notebooklm/studio-outputs.ts`) replaces the "one file per Studio output" pattern that would otherwise be needed. Each Studio output type registers hook functions (trigger/isReady/isInProgress/download-or-extract), all tile-scoped so multiple output types coexist safely. 4 new parameterized MCP tools (`generate_studio_output`, `get_studio_output_status`, `download_studio_output`, `get_studio_output_content`) expose the registry; the existing `generate_audio`/`get_audio_status`/`download_audio` become thin aliases into the same engine. Protocol fixes (Prompts, capability corrections, resource-change notifications, structured content, elicitation) are layered on top of the existing `Server`/`ResourceHandlers` wiring, not a rewrite of it.

**Tech Stack:** TypeScript (strict, `tsc` via `npm run build`), `@modelcontextprotocol/sdk`, Patchright (`patchright` — stealth Playwright fork), Node.js ≥18, ESLint + Prettier (`npm run check`).

## Execution Note (discovered during Task 6 kickoff, 2026-08-22)

Neither this fork's data directory nor the already-connected live `notebooklm-mcp` server has an authenticated NotebookLM account (`get_health` on both reports `authenticated: false`, `total_notebooks: 0`, confirmed via both the fork's own HTTP transport and the live-connected `mcp__notebooklm__get_health` tool). `setup_auth` requires a human to interactively complete a Google login in a visible browser — not something an autonomous subagent can do, and the user is away for the remainder of this session.

This blocks every live-DOM-dependent verification step in Tasks 6, 8, 9, and part of 13. Rather than stall or fabricate unverified selectors (violates this plan's own "No fabricated selectors" constraint), execution proceeds as follows:

- **Task 6:** engine + audio retrofit are built in full. The tile-discrimination selector fix adds the new icon-scoped selector alongside the existing (currently-working, single-tile-type-safe) broad selector — for `audioMoreMenuButton` (an ordered `clickFirstVisible` loop) this genuinely gives the new selector priority, but for `readySelectors` (a CSS OR via `joinAlt` + `.first()`) array position confers no priority, so the addition there is a structural no-op today, not a real fallback chain — which is exactly why behavior cannot regress even if the icon-redisplay hypothesis turns out wrong once it's actually checked against the live site. Making `readySelectors` genuinely discriminate requires removing the broad entries, deferred to Phase 2. The mandatory live-account regression check (original Step 7) is **deferred**, not skipped-and-claimed-done.
- **Tasks 8 and 9 (Report, Flash Cards):** deferred in full. No selectors are invented for UI never seen. This is a real, not cosmetic, reduction in this plan's original Phase-1 scope (Global Constraints above call for "exactly 2 new Studio output types end-to-end" — that bar is not met by this run). The engine (Task 6) is built so both slot in cleanly once someone with account access can do the live DOM recon Tasks 8/9 specify.
- **Task 13:** the live-account-dependent portions of the regression checklist are deferred. The step that repoints the user's actual Claude Code `notebooklm` MCP entry from `npx notebooklm-mcp@latest` to this fork's build is **not executed autonomously** — swapping the user's working daily-driver server for an unverified one is exactly the kind of hard-to-reverse, trust-load-bearing change that needs either live verification or the user's explicit go-ahead, neither of which is available right now.
- Everything else in the plan (Tasks 1-5, 7, 10, 11, 12 minus Report/Flash Cards-specific doc lines) proceeds as written — none of it depends on a live authenticated account.

This is recorded as an open loop for the user's return: once they can run `setup_auth` once (interactively, ~10 minutes), Tasks 6's deferred check and Tasks 8/9 in full can proceed.

## Global Constraints

- **Delivery:** local fork only (`<path-to-your-clone>`). No upstream PR.
- **No regressions:** `ask_question`, `list_notebooks`/`select_notebook`/`update_notebook`/`add_notebook`/`remove_notebook`/`search_notebooks`/`get_library_stats`, `list_sessions`/`close_session`/`reset_session`, `get_health`/`setup_auth`/`re_auth`/`cleanup_data`, `add_source`, and `generate_audio`/`get_audio_status`/`download_audio` must keep their exact current tool names, parameter shapes, and behavior after this plan.
- **No new test framework.** This codebase has none (`npm test` just boots the server). Deterministic verification is `npm run check` (prettier:check + eslint + tsc build) plus, where the change is protocol-visible and not DOM-dependent, a `curl` JSON-RPC probe against the HTTP transport (`--transport http --port 3000`). DOM-dependent behavior is verified manually against the user's real NotebookLM account — there is no way around this in a codebase with zero DOM mocking, and inventing one is out of scope for this plan.
- **No fabricated selectors.** Any CSS/ARIA selector for UI not already wrapped by the existing code (Report tile, Flash Cards tile, and the tile-discrimination fix to the existing Audio selectors) is discovered via live DOM reconnaissance as literal Step 1 of its task, following the exact anchor-priority convention already documented at the top of `src/notebooklm/selectors.ts` (class name → Material-Symbols icon text → `role` attribute → locale-bound aria-label, in that priority order). Do not invent selector strings.
- **SDK floor:** `@modelcontextprotocol/sdk` is currently `^1.0.0` in `package.json` and `node_modules` is not installed. Task 1 resolves the actual installed version and confirms it exposes the APIs this plan depends on before any other task touches SDK-dependent code.
- **Elicitation scope:** `cleanup_data` (has an existing `confirm: boolean` param) and `remove_notebook` (currently prose-only self-confirmation) — not `add_notebook`, which has no `confirm` param and is a low-risk additive action.
- **Phase boundary:** this plan builds exactly 2 new Studio output types end-to-end (Report — file kind; Flash Cards — structured kind) plus the tile-scoped Audio retrofit. The remaining 6 Studio output types and all source/notes/research/chat-config tools from the design spec are Phase 2 — explicitly out of this plan's "done" criteria. The tool schema for `generate_studio_output`/`get_studio_output_status` still enumerates all 9 `output_type` values (see Task 9), but calling one of the 6 unimplemented types returns a clear "not yet implemented for this type" error rather than a confusing failure.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `package.json` | modify | Bump `@modelcontextprotocol/sdk` floor once Task 1 confirms the resolved version |
| `src/index.ts` | modify | Fix capabilities object; switch → dispatch map; wire new tool cases |
| `src/resources/resource-handlers.ts` | modify | Add `ListPromptsRequestSchema`/`GetPromptRequestSchema` handlers; add `resources.listChanged`/`sendResourceListChanged` wiring |
| `src/library/notebook-library.ts` | modify | Add an `onChange` callback hook fired by `add`/`update`/`remove`/`select` |
| `src/session/browser-session.ts` | modify | Extract `withRecovery<T>()`; add `generateStudioOutput`/`getStudioOutputStatus`/`downloadStudioOutput`/`getStudioOutputContent` pass-throughs |
| `src/notebooklm/studio-outputs.ts` | create | Strategy-registry engine: types, generic `generateStudioOutput`/`getStudioOutputStatus`/`downloadStudioOutput`/`getStudioOutputContent`, shared `clickFirstVisible`/`ensureStudioPanelExpanded` helpers (lifted from `audio.ts`) |
| `src/notebooklm/audio.ts` | modify | Selectors tightened to tile-scoped matching; exported functions become thin wrappers around the engine with `type: "audio"` |
| `src/notebooklm/selectors.ts` | modify | Add tile-scoped audio selectors; add `report`/`flashcards` selector groups under `studio` |
| `src/tools/definitions/studio.ts` | create | `generate_studio_output`, `get_studio_output_status`, `download_studio_output`, `get_studio_output_content` tool definitions with enum-restricted schemas |
| `src/tools/definitions/sources.ts` | modify | Keep `generateAudioTool`/`getAudioStatusTool`/`downloadAudioTool` as documented aliases (description updated to point at the new tools) |
| `src/tools/definitions.ts` | modify | Register the new `studio.ts` tools in `buildToolDefinitions` |
| `src/tools/handlers.ts` | modify | Add `handleGenerateStudioOutput`/`handleGetStudioOutputStatus`/`handleDownloadStudioOutput`/`handleGetStudioOutputContent`; add `structuredContent` to the narrow stable set; add elicitation to `handleCleanupData`/`handleRemoveNotebook` |
| `src/utils/settings-manager.ts` | modify | Add new tool names to the `full` profile (implicit via `"*"`) and decide `standard` inclusion |
| `README.md`, `docs/tools.md` | modify | Document new tools, corrected capabilities, Phase 1/2 boundary |

---

## Task 1: Install dependencies and verify the SDK API surface

**Files:**
- Modify: `package.json` (dependency floor, after verification)
- Test: none (verification task)

**Interfaces:**
- Produces: confirmed answers, recorded in this task's commit message, for: (a) resolved `@modelcontextprotocol/sdk` version, (b) exact import path + signature for `server.elicitInput` (or equivalent), (c) exact import path + signature for `server.sendResourceListChanged` (or equivalent — if absent, later tasks use raw `server.notification`), (d) confirmation that `CallToolResult` supports a `structuredContent` field alongside `content`, (e) confirmation that `Tool` supports `outputSchema`.

- [ ] **Step 1: Install dependencies**

Run: `cd "<path-to-your-clone>" && npm install`
Expected: exits 0, creates `node_modules/`.

- [ ] **Step 2: Confirm the resolved SDK version**

Run: `npm ls @modelcontextprotocol/sdk`
Record the resolved version (e.g. `notebooklm-mcp@2.0.0 ... └── @modelcontextprotocol/sdk@1.x.x`).

- [ ] **Step 3: Verify elicitation, structuredContent, outputSchema, and resource-list-changed APIs exist**

Run (from the fork root):
```bash
grep -r "elicitInput" node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts
grep -r "sendResourceListChanged" node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts
grep -rn "structuredContent" node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts
grep -rn "outputSchema" node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts
grep -rn "ElicitRequestSchema\|ElicitResultSchema" node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts
```
Expected: each grep returns at least one match. If the `dist/esm` path doesn't exist, `ls node_modules/@modelcontextprotocol/sdk/dist` first and adjust the path (the SDK has shipped both `dist/cjs`+`dist/esm` and a flat `dist/` layout across versions — use whichever exists).

If any of the four capabilities is genuinely absent in the resolved version: stop and bump `@modelcontextprotocol/sdk` in `package.json` to a version known to include it (check `https://www.npmjs.com/package/@modelcontextprotocol/sdk?activeTab=versions` for the changelog entry that introduced it — as of this plan's writing, elicitation and structured content shipped in the 1.13–1.15 range), then re-run Steps 1–3.

- [ ] **Step 4: Record findings and bump the floor**

Edit `package.json`'s `dependencies["@modelcontextprotocol/sdk"]` from `"^1.0.0"` to `"^<resolved-major.minor>.0"` (e.g. `"^1.13.0"`) so a future `npm install` on a clean machine can't resolve below the version this plan was built against.

- [ ] **Step 5: Build baseline**

Run: `npm run build`
Expected: exits 0 (confirms the untouched codebase still compiles before any changes).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install deps, pin SDK floor to verified version"
```

---

## Task 2: Fix declared MCP capabilities and implement real Prompts

**Files:**
- Modify: `src/index.ts:159-171` (capabilities object)
- Modify: `src/resources/resource-handlers.ts` (add Prompts handlers)
- Test: manual JSON-RPC probe via HTTP transport (below)

**Interfaces:**
- Consumes: `Server` from `@modelcontextprotocol/sdk/server/index.js` (existing import in `index.ts`), `ResourceHandlers.registerHandlers(server: Server)` (existing, `resource-handlers.ts:24`).
- Produces: `ResourceHandlers` now also registers `prompts/list` and `prompts/get`. `notebooklm.auth-setup` and `notebooklm.auth-repair` are real, callable prompts.

- [ ] **Step 1: Correct the capabilities object in `src/index.ts`**

Current (`index.ts:159-166`):
```typescript
      {
        capabilities: {
          tools: {},
          resources: {},
          resourceTemplates: {},
          prompts: {},
          completions: {}, // Required for completion/complete support
          logging: {},
        },
```

Replace with:
```typescript
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
```

- [ ] **Step 2: Add Prompts request handlers to `ResourceHandlers`**

In `src/resources/resource-handlers.ts`, add the import:
```typescript
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  CompleteRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
```

Add a `PROMPTS` constant above the `ResourceHandlers` class:
```typescript
const PROMPTS = [
  {
    name: "notebooklm.auth-setup",
    description:
      "First-time NotebookLM authentication walkthrough: run setup_auth, " +
      "then verify with get_health before doing anything else.",
  },
  {
    name: "notebooklm.auth-repair",
    description:
      "Fix a broken NotebookLM session (expired cookies, auth errors): " +
      "run re_auth, then verify with get_health.",
  },
] as const;

function buildPromptMessages(name: string): { role: "user"; content: { type: "text"; text: string } }[] {
  if (name === "notebooklm.auth-setup") {
    return [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Set up NotebookLM authentication for the first time:\n" +
            "1. Call `setup_auth` with `show_browser: true`. A Chrome window " +
            "opens — the human logs into their Google account (up to 10 " +
            "minutes).\n" +
            "2. Call `get_health` and confirm `authenticated: true`.\n" +
            "3. If `get_health` still reports unauthenticated after step 1, " +
            "wait 30 seconds and re-check — the login may still be in " +
            "progress in the visible browser window.",
        },
      },
    ];
  }
  if (name === "notebooklm.auth-repair") {
    return [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Repair a broken NotebookLM session:\n" +
            "1. Call `re_auth` with `show_browser: true` to wipe stored " +
            "auth and log in again.\n" +
            "2. Call `get_health` and confirm `authenticated: true`.\n" +
            "3. If the notebook itself is inaccessible after re-auth, " +
            "confirm the notebook URL is still valid with `get_notebook` " +
            "or `list_notebooks`.",
        },
      },
    ];
  }
  throw new Error(`Unknown prompt: ${name}`);
}
```

In `registerHandlers(server: Server)`, after the existing `CompleteRequestSchema` handler, add:
```typescript
    // List available prompts
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      log.info("📜 [MCP] list_prompts request received");
      return { prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description })) };
    });

    // Get a specific prompt's messages
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name } = request.params;
      log.info(`📜 [MCP] get_prompt request: ${name}`);
      const prompt = PROMPTS.find((p) => p.name === name);
      if (!prompt) {
        throw new Error(
          `Unknown prompt: ${name}. Supported: ${PROMPTS.map((p) => p.name).join(", ")}. ` +
            "Call prompts/list to discover the active set."
        );
      }
      return { description: prompt.description, messages: buildPromptMessages(name) };
    });
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Manual protocol verification via HTTP transport**

Terminal A:
```bash
node dist/index.js --transport http --port 3100
```
Expected output includes `✅ MCP Server connected via Streamable HTTP`.

Terminal B — initialize a session, then call `prompts/list`:
```bash
SESSION=$(curl -sD - -o /dev/null -X POST http://127.0.0.1:3100/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"plan-verify","version":"0.0.1"}}}' \
  | grep -i mcp-session-id | tr -d '\r' | cut -d' ' -f2)
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"prompts/list","params":{}}'
```
Expected: a JSON-RPC result containing both `notebooklm.auth-setup` and `notebooklm.auth-repair` — **not** a `-32601 Method not found` error, which is what the pre-fix code returns.

```bash
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":3,"method":"prompts/get","params":{"name":"notebooklm.auth-setup"}}'
```
Expected: a JSON-RPC result with a `messages` array containing the setup_auth → get_health walkthrough text from Step 2.

Stop the server (Ctrl-C in Terminal A).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/resources/resource-handlers.ts
git commit -m "fix: correct declared MCP capabilities, implement the two dead-referenced prompts"
```

---

## Task 3: Replace the tool-dispatch switch with a handler map

**Files:**
- Modify: `src/index.ts:203-445` (`setupHandlers`)
- Test: HTTP `tools/call` probe (below) — pure refactor, output must be byte-identical to pre-refactor for every existing tool.

**Interfaces:**
- Consumes: `this.toolHandlers` (existing `ToolHandlers` instance), all existing `handle*` methods (unchanged signatures).
- Produces: `this.toolDispatch: Map<string, (args: Record<string, unknown> | undefined, sendProgress: ProgressCallback) => Promise<unknown>>`, built once in the constructor.

- [ ] **Step 1: Capture current behavior as a baseline (manual, before editing)**

Run: `npm run build && node dist/index.js --transport http --port 3100` (Terminal A), then in Terminal B, using the `$SESSION` pattern from Task 2 Step 4:
```bash
curl -s -X POST http://127.0.0.1:3100/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_health","arguments":{}}}'
```
Save this output — it's the regression baseline for `get_health`'s exact response shape. Stop the server.

- [ ] **Step 2: Build the dispatch map in the constructor**

In `src/index.ts`, add a new private field to `NotebookLMMCPServer`:
```typescript
  private toolDispatch: Map<
    string,
    (args: Record<string, unknown> | undefined, sendProgress: ProgressCallback) => Promise<unknown>
  >;
```

(Add the import `import type { ProgressCallback } from "./types.js";` near the top if not already present — check first; `types.js` already exports `ProgressCallback` per `src/types.ts:107-111`.)

In the constructor, after `this.resourceHandlers = new ResourceHandlers(this.library);`, add:
```typescript
    this.toolDispatch = this.buildToolDispatch();
```

Add a new private method (replaces the body of the `switch` in `setupHandlers`'s `CallToolRequestSchema` handler — this is a direct 1:1 transcription of every existing `case`, not new logic):
```typescript
  private buildToolDispatch(): Map<
    string,
    (args: Record<string, unknown> | undefined, sendProgress: ProgressCallback) => Promise<unknown>
  > {
    const h = this.toolHandlers;
    return new Map<
      string,
      (args: Record<string, unknown> | undefined, sendProgress: ProgressCallback) => Promise<unknown>
    >([
      ["ask_question", (args, sendProgress) => h.handleAskQuestion(args as Parameters<typeof h.handleAskQuestion>[0], sendProgress)],
      ["add_notebook", (args) => h.handleAddNotebook(args as Parameters<typeof h.handleAddNotebook>[0])],
      ["list_notebooks", () => h.handleListNotebooks()],
      ["get_notebook", (args) => h.handleGetNotebook(args as Parameters<typeof h.handleGetNotebook>[0])],
      ["select_notebook", (args) => h.handleSelectNotebook(args as Parameters<typeof h.handleSelectNotebook>[0])],
      ["update_notebook", (args) => h.handleUpdateNotebook(args as Parameters<typeof h.handleUpdateNotebook>[0])],
      ["remove_notebook", (args) => h.handleRemoveNotebook(args as Parameters<typeof h.handleRemoveNotebook>[0])],
      ["search_notebooks", (args) => h.handleSearchNotebooks(args as Parameters<typeof h.handleSearchNotebooks>[0])],
      ["get_library_stats", () => h.handleGetLibraryStats()],
      ["list_sessions", () => h.handleListSessions()],
      ["close_session", (args) => h.handleCloseSession(args as Parameters<typeof h.handleCloseSession>[0])],
      ["reset_session", (args) => h.handleResetSession(args as Parameters<typeof h.handleResetSession>[0])],
      ["get_health", () => h.handleGetHealth()],
      ["setup_auth", (args, sendProgress) => h.handleSetupAuth(args as Parameters<typeof h.handleSetupAuth>[0], sendProgress)],
      ["re_auth", (args, sendProgress) => h.handleReAuth(args as Parameters<typeof h.handleReAuth>[0], sendProgress)],
      ["cleanup_data", (args) => h.handleCleanupData(args as Parameters<typeof h.handleCleanupData>[0])],
      ["add_source", (args) => h.handleAddSource(args as Parameters<typeof h.handleAddSource>[0])],
      ["generate_audio", (args) => h.handleGenerateAudio(args as Parameters<typeof h.handleGenerateAudio>[0])],
      ["get_audio_status", (args) => h.handleGetAudioStatus(args as Parameters<typeof h.handleGetAudioStatus>[0])],
      ["download_audio", (args) => h.handleDownloadAudio(args as Parameters<typeof h.handleDownloadAudio>[0])],
    ]);
  }
```

Note: `Parameters<typeof h.handleX>[0]` derives each handler's exact argument type from its own declaration, so this cannot silently drift out of sync with `handlers.ts` the way a hand-copied inline type could.

- [ ] **Step 3: Replace the switch body with a map lookup**

In the `CallToolRequestSchema` handler (`index.ts:216-444`), replace the entire `try { let result; switch (name) { ... } ... }` block's dispatch portion. Keep the progress-token extraction and the outer try/catch exactly as-is; replace only:
```typescript
        let result;

        switch (name) {
          // ... 20 cases ...
          default:
            log.error(`❌ [MCP] Unknown tool: ${name}`);
            return { content: [{ type: "text", text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }, null, 2) }] };
        }
```
with:
```typescript
        const handler = this.toolDispatch.get(name);
        if (!handler) {
          log.error(`❌ [MCP] Unknown tool: ${name}`);
          return {
            content: [
              { type: "text", text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }, null, 2) },
            ],
          };
        }
        const result = await handler(args, sendProgress);
```

Leave the `return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };` and the `catch (error)` block below it untouched.

- [ ] **Step 4: Build and re-run the regression probe**

Run: `npm run build && node dist/index.js --transport http --port 3100` (Terminal A), then repeat the exact `get_health` curl from Step 1 in Terminal B.
Expected: byte-identical JSON to the Step 1 baseline (aside from any timestamp-like fields `get_health` may include — compare structurally, not necessarily byte-for-byte on those). Stop the server.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "refactor: replace tool-dispatch switch with a handler map"
```

---

## Task 4: Extract `withRecovery()` in `browser-session.ts`

**Files:**
- Modify: `src/session/browser-session.ts:363-482` (`ask`), `:741-783` (`reset`)
- Test: `npm run build`; behavioral verification folded into Task 6's audio regression check (this helper is exercised by every session call).

**Interfaces:**
- Produces: `private async withRecovery<T>(label: string, fn: () => Promise<T>): Promise<T>` on `BrowserSession`, used by `ask()`, `reset()`, and (from Task 6 onward) the new Studio pass-through methods.

- [ ] **Step 1: Add the `withRecovery` helper**

In `src/session/browser-session.ts`, inside the `BrowserSession` class, add (near `isPageClosedSafe`):
```typescript
  /**
   * Runs `fn` once; if it fails with a closed-page/context error, reinitialises
   * the session and retries `fn` exactly once. Shared by every method that
   * touches `this.page`, so page/context loss is recovered from consistently
   * instead of each caller reimplementing the same regex + reinit + retry.
   */
  private async withRecovery<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/has been closed|Target .* closed|Browser has been closed|Context .* closed/i.test(msg)) {
        log.warning(`  ♻️  Detected closed page/context during ${label}. Recovering session and retrying...`);
        this.initialized = false;
        if (this.page) {
          try {
            await this.page.close();
          } catch {
            /* page already gone */
          }
        }
        this.page = null;
        await this.init();
        return await fn();
      }
      log.error(`❌ [${this.sessionId}] Failed during ${label}: ${msg}`);
      throw error;
    }
  }
```

- [ ] **Step 2: Rewire `ask()` to use it**

Replace the outer try/catch in `ask()` (`browser-session.ts:456-482`, currently `try { return await askOnce(); } catch (error) { ... }`) with:
```typescript
    return this.withRecovery("ask", askOnce);
```
The `askOnce` inner function (`browser-session.ts:364-454`) is unchanged — only the outer wrapper is replaced.

- [ ] **Step 3: Rewire `reset()` to use it**

Replace the outer try/catch in `reset()` (`browser-session.ts:761-783`, currently `try { await resetOnce(); } catch (error) { ... }`) with:
```typescript
    await this.withRecovery("reset", resetOnce);
```
The `resetOnce` inner function (`browser-session.ts:742-759`) is unchanged.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/session/browser-session.ts
git commit -m "refactor: extract withRecovery() from ask()/reset() duplication"
```

---

## Task 5: Add `resources.listChanged` notifications on library mutations

**Files:**
- Modify: `src/library/notebook-library.ts` (add change hook)
- Modify: `src/resources/resource-handlers.ts` (wire the hook to the server)
- Modify: `src/index.ts` (pass `server` reference so `ResourceHandlers` can call `sendResourceListChanged`)
- Test: manual JSON-RPC probe (below)

**Interfaces:**
- Consumes: SDK method confirmed present in Task 1 Step 3 — use `server.sendResourceListChanged()` if it exists on the installed SDK's `Server` class; otherwise use `server.notification({ method: "notifications/resources/list_changed" })` (both are valid; prefer the named helper if available).
- Produces: `NotebookLibrary.onChange(cb: () => void): void` — registers a callback fired after every successful `saveLibrary()`.

- [ ] **Step 1: Add a change-notification hook to `NotebookLibrary`**

In `src/library/notebook-library.ts`, add a private field and public method:
```typescript
  private changeListeners: Array<() => void> = [];

  /** Register a callback fired after every successful library mutation. */
  onChange(cb: () => void): void {
    this.changeListeners.push(cb);
  }

  private notifyChanged(): void {
    for (const cb of this.changeListeners) {
      try {
        cb();
      } catch (error) {
        log.warning(`  ⚠️  Library change listener threw: ${error}`);
      }
    }
  }
```

In `saveLibrary` (currently ends with `log.success(...)` at line 108), add `this.notifyChanged();` as the last line of the method (after the log line, still inside the `try` block, before the closing brace — this fires on every mutation: `addNotebook`, `selectNotebook`, `updateNotebook`, `removeNotebook`, `incrementUseCount`, since they all call `saveLibrary`).

- [ ] **Step 2: Wire the hook in `ResourceHandlers`**

In `src/resources/resource-handlers.ts`, change `registerHandlers` to accept the server and store it for later notification use — it already receives `server: Server` as a parameter, so add at the top of `registerHandlers`, before the existing handler registrations:
```typescript
    this.library.onChange(() => {
      // Prefer the SDK's named helper if Task 1 confirmed it exists;
      // otherwise fall back to the raw notification call.
      void server.sendResourceListChanged().catch((error: unknown) => {
        log.warning(`⚠️  [MCP] Failed to send resources/list_changed: ${error}`);
      });
    });
```
(If Task 1 found `sendResourceListChanged` does **not** exist on the installed SDK's `Server`, use this fallback instead: `void server.notification({ method: "notifications/resources/list_changed" }).catch((error: unknown) => { log.warning(...); });` — same placement.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Manual verification**

Start the server on HTTP transport (`node dist/index.js --transport http --port 3100`), open the SSE stream in one terminal to observe notifications:
```bash
curl -N -s http://127.0.0.1:3100/mcp -H "Accept: text/event-stream" -H "Mcp-Session-Id: $SESSION" &
```
In another terminal, call `tools/call` with `add_notebook` (any valid `url`/`name`/`description`/`topics` — this is additive and safe to run against the real local library):
```bash
curl -s -X POST http://127.0.0.1:3100/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"add_notebook","arguments":{"url":"https://notebooklm.google.com/notebook/plan-verify-test","name":"Plan Verify Test","description":"Temporary notebook added to verify list_changed notifications","topics":["test"]}}}'
```
Expected: the SSE stream terminal prints a `notifications/resources/list_changed` JSON-RPC notification shortly after the `add_notebook` call completes.

Clean up: call `remove_notebook` with the id returned by `add_notebook` to remove the test entry from the local library before moving on.

- [ ] **Step 5: Commit**

```bash
git add src/library/notebook-library.ts src/resources/resource-handlers.ts
git commit -m "feat: emit resources/list_changed notifications on library mutations"
```

---

## Task 6: Build the Studio-output engine skeleton and retrofit Audio onto it

This is the highest-risk task in the plan — it's the one place currently-working, in-production behavior (`generate_audio`/`get_audio_status`/`download_audio`) gets touched. Read `src/notebooklm/audio.ts` and `src/notebooklm/selectors.ts:238-340` in full before starting (both already fully quoted in the design spec §2 and this plan's grounding — re-read the live files anyway, they are the source of truth).

**Files:**
- Create: `src/notebooklm/studio-outputs.ts`
- Modify: `src/notebooklm/selectors.ts:238-340` (tile-scoped audio selectors + type union)
- Modify: `src/notebooklm/audio.ts` (become a thin wrapper)
- Modify: `src/session/browser-session.ts` (add pass-through methods)
- Test: manual, against the real NotebookLM account

**Interfaces:**
- Produces:
  - `type StudioOutputType = "audio" | "video" | "report" | "slides" | "infographic" | "mindmap" | "datatable" | "quiz" | "flashcards";`
  - `type StudioArtifactKind = "file" | "structured";`
  - `interface StudioOutputStrategy { kind: StudioArtifactKind; trigger(page: Page, opts: { customPrompt?: string; difficulty?: string }): Promise<void>; findTile(page: Page): Locator; isReady(page: Page): Promise<boolean>; isInProgress(page: Page): Promise<boolean>; download?(page: Page, destDir: string): Promise<DownloadAudioResult>; extractContent?(page: Page): Promise<unknown>; }` (file-kind strategies implement `download`, structured-kind strategies implement `extractContent` — enforced by the generic functions checking `kind` before calling either, not by the type system, since TypeScript can't cleanly express "these two fields are mutually required based on a third field" without a discriminated union split that would complicate the registry — a runtime check with a clear error message is the pragmatic choice here).
  - `generateStudioOutput(page: Page, type: StudioOutputType, options: GenerateAudioOptions): Promise<AudioGenerationResult>`
  - `getStudioOutputStatus(page: Page, type: StudioOutputType): Promise<AudioGenerationResult>`
  - `downloadStudioOutput(page: Page, type: StudioOutputType, destDir: string): Promise<DownloadAudioResult>`
  - `getStudioOutputContent(page: Page, type: StudioOutputType): Promise<{ success: boolean; content?: unknown; message?: string }>`
  - (Reuses existing `AudioGenerationResult`/`DownloadAudioResult`/`AudioStatus`/`GenerateAudioOptions` types from `audio.ts` rather than duplicating them — those types are generic enough to serve every Studio output, not audio-specific in shape.)

- [ ] **Step 1: Live DOM reconnaissance — tile discrimination for Audio**

With `show_browser: true` (either via a temporary manual `node dist/index.js` run driving a real authenticated notebook, or via `generate_audio({ show_browser: true, ... })` through Claude Code against the live `notebooklm` MCP connection), open a notebook, generate an Audio Overview, and inspect the completed artifact tile in DevTools. Answer:
  1. Does the tile re-display the same Material-Symbols icon used on its trigger button (`audio_magic_eraser`) somewhere in its own markup (a badge, thumbnail, or icon element)? Record the exact selector if so.
  2. Does the tile carry any other type-identifying attribute (a `data-*` attribute, a class name segment, a visible label like "Audio Overview" as a heading) that's stable and language-agnostic or at least present in the locale you're testing?
  3. Confirm `.artifact-action-button` (the existing "Play" button anchor) and the three-dot `more_vert` menu button are scoped *within* one `artifact-library-item`, and check whether multiple tiles (e.g. generate a second unrelated artifact type manually via the NotebookLM UI, if quick to test) each get their own `artifact-library-item` with their own icon badge.

Record findings as comments in the code written in Step 2.

- [ ] **Step 2: Add tile-scoped audio selectors**

In `src/notebooklm/selectors.ts`, inside the `studio` object, add a new entry (keep the existing `audioPlayer`/`audioMoreMenuButton`/`audioDownloadMenuItem` arrays as-is for now — Step 4 replaces their call sites, not their declarations, so nothing else that might reference them breaks):
```typescript
    /**
     * Tile-scoping icon anchor for Audio Overview specifically, discovered
     * via live DOM recon (see studio-outputs.ts task). Used to filter
     * `artifact-library-item` down to audio's own tile instead of matching
     * the first/any artifact once more Studio output types exist.
     */
    audioTileIconAnchor: 'mat-icon:text-is("audio_magic_eraser")', // TODO(recon): replace if Step 1 found a different badge element
```
(If Step 1 found the tile does NOT redisplay the trigger icon, replace this with whatever stable anchor Step 1 actually found — e.g. a heading text pattern via `:has-text(...)` per-locale, following the same multi-locale array convention used elsewhere in this file. Do not leave the icon-anchor guess in place if recon disproved it.)

- [ ] **Step 3: Create the engine skeleton**

Create `src/notebooklm/studio-outputs.ts`:
```typescript
/**
 * Generic Studio-output engine (trigger / poll / download-or-extract) driving
 * a strategy registry, one entry per NotebookLM Studio output type. Built to
 * replace what would otherwise be 9 near-duplicate modules of the shape
 * `audio.ts` already has. Every strategy's tile lookups must be scoped to
 * that specific output type — never "the first/any artifact tile" — because
 * multiple output types can coexist in the same notebook once more than one
 * is wrapped.
 */
import type { Page, Locator } from "patchright";
import { safeSleep, isRecoverable } from "../browser/watchdog.js";
import { log } from "../utils/logger.js";
import { Selectors, joinAlt } from "./selectors.js";
import type { AudioStatus, AudioGenerationResult, DownloadAudioResult, GenerateAudioOptions } from "./audio.js";

export type StudioOutputType =
  | "audio"
  | "video"
  | "report"
  | "slides"
  | "infographic"
  | "mindmap"
  | "datatable"
  | "quiz"
  | "flashcards";

export const FILE_KIND_TYPES: readonly StudioOutputType[] = ["audio", "video", "report", "slides", "infographic"];
export const STRUCTURED_KIND_TYPES: readonly StudioOutputType[] = ["mindmap", "datatable", "quiz", "flashcards"];

export type StudioArtifactKind = "file" | "structured";

export interface StudioOutputStrategy {
  kind: StudioArtifactKind;
  /** Entry-button selector(s) in the Studio panel, following the Selectors.studio.* convention. */
  triggerSelectors: readonly string[];
  /** Multilingual "generation in progress" phrase list, scoped to this type's tile/card only. */
  inProgressPhrases: readonly string[];
  /** Selector(s) identifying this type's completed tile specifically (not any artifact tile). */
  readySelectors: readonly string[];
  trigger(page: Page, opts: { customPrompt?: string; difficulty?: string }): Promise<void>;
  download?(page: Page, destDir: string): Promise<DownloadAudioResult>;
  extractContent?(page: Page): Promise<unknown>;
}

const STRATEGIES = new Map<StudioOutputType, StudioOutputStrategy>();

export function registerStudioStrategy(type: StudioOutputType, strategy: StudioOutputStrategy): void {
  STRATEGIES.set(type, strategy);
}

function getStrategy(type: StudioOutputType): StudioOutputStrategy {
  const s = STRATEGIES.get(type);
  if (!s) {
    throw new Error(
      `Studio output type "${type}" is not yet implemented by this server (Phase 2). ` +
        `Implemented types: ${[...STRATEGIES.keys()].join(", ")}.`
    );
  }
  return s;
}

export async function clickFirstVisible(page: Page, selectors: readonly string[], label: string): Promise<void> {
  for (const sel of selectors) {
    const candidate = page.locator(sel).first();
    if (await candidate.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await candidate.click();
      await safeSleep(page, 300);
      return;
    }
  }
  throw new Error(`Could not find ${label} — selectors: ${selectors.join(" | ")}. NotebookLM Studio UI may have changed.`);
}

export async function ensureStudioPanelExpanded(page: Page, anyTriggerSelectors: readonly string[]): Promise<void> {
  const cardVisible = await page.locator(joinAlt(anyTriggerSelectors)).first().isVisible({ timeout: 500 }).catch(() => false);
  if (cardVisible) return;
  const expandSelectors = [
    'button:has(mat-icon:text-is("dock_to_left"))',
    'button[aria-label*="erweitern" i][aria-label*="studio" i]',
    'button[aria-label*="expand" i][aria-label*="studio" i]',
    'button[aria-label*="ouvrir" i][aria-label*="studio" i]',
    'button[aria-label*="abrir" i][aria-label*="studio" i]',
    'button[aria-label*="aprire" i][aria-label*="studio" i]',
  ];
  for (const sel of expandSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click().catch(() => undefined);
      await safeSleep(page, 400);
      return;
    }
  }
}

async function isReady(page: Page, strategy: StudioOutputStrategy): Promise<boolean> {
  return page.locator(joinAlt(strategy.readySelectors)).first().isVisible({ timeout: 500 }).catch(() => false);
}

async function isInProgress(page: Page, strategy: StudioOutputStrategy): Promise<boolean> {
  try {
    const studioText = await page.locator(".studio-panel").first().textContent({ timeout: 500 }).catch(() => null);
    if (!studioText) return false;
    const lower = studioText.toLowerCase();
    return strategy.inProgressPhrases.some((p) => lower.includes(p));
  } catch {
    return false;
  }
}

export async function generateStudioOutput(
  page: Page,
  type: StudioOutputType,
  options: GenerateAudioOptions & { difficulty?: string } = {}
): Promise<AudioGenerationResult> {
  const strategy = getStrategy(type);
  const { waitForCompletion = false, timeoutMs = 600_000 } = options;
  try {
    if (await isReady(page, strategy)) {
      log.info(`  ✅ Studio output "${type}" already generated, skipping trigger`);
      return { status: "ready", alreadyExisted: true };
    }
    if (await isInProgress(page, strategy)) {
      log.info(`  ⏳ Studio output "${type}" generation already running`);
      if (waitForCompletion) return await waitUntilReady(page, strategy, timeoutMs);
      return {
        status: "in_progress",
        message: `Generation for "${type}" is already running. Poll get_studio_output_status.`,
      };
    }
    await ensureStudioPanelExpanded(page, strategy.triggerSelectors);
    await strategy.trigger(page, { customPrompt: options.customPrompt, difficulty: options.difficulty });
    log.info(`  🎬 Studio output "${type}" generation triggered`);
    if (!waitForCompletion) {
      return {
        status: "started",
        message: `Generation for "${type}" started. Poll get_studio_output_status, then download_studio_output or get_studio_output_content.`,
      };
    }
    return await waitUntilReady(page, strategy, timeoutMs);
  } catch (err) {
    if (isRecoverable(err)) throw err;
    log.warning(`  ⚠️  Studio output "${type}" generation failed: ${err}`);
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

async function waitUntilReady(page: Page, strategy: StudioOutputStrategy, timeoutMs: number): Promise<AudioGenerationResult> {
  const tile = page.locator(joinAlt(strategy.readySelectors)).first();
  await tile.waitFor({ state: "visible", timeout: timeoutMs });
  return { status: "ready" };
}

export async function getStudioOutputStatus(page: Page, type: StudioOutputType): Promise<AudioGenerationResult> {
  const strategy = getStrategy(type);
  try {
    if (await isReady(page, strategy)) return { status: "ready" };
    if (await isInProgress(page, strategy)) {
      return { status: "in_progress", message: `Studio output "${type}" is still being generated.` };
    }
    return { status: "not_started", message: `No "${type}" output exists yet for this notebook.` };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function downloadStudioOutput(page: Page, type: StudioOutputType, destDir: string): Promise<DownloadAudioResult> {
  const strategy = getStrategy(type);
  if (strategy.kind !== "file" || !strategy.download) {
    return {
      success: false,
      message: `"${type}" is a structured-content output, not a file download. Use get_studio_output_content instead.`,
    };
  }
  if (!(await isReady(page, strategy))) {
    return {
      success: false,
      message: `No completed "${type}" output found. Call generate_studio_output first and wait for get_studio_output_status to report "ready".`,
    };
  }
  try {
    return await strategy.download(page, destDir);
  } catch (err) {
    if (isRecoverable(err)) throw err;
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function getStudioOutputContent(
  page: Page,
  type: StudioOutputType
): Promise<{ success: boolean; content?: unknown; message?: string }> {
  const strategy = getStrategy(type);
  if (strategy.kind !== "structured" || !strategy.extractContent) {
    return {
      success: false,
      message: `"${type}" is a file-download output, not structured content. Use download_studio_output instead.`,
    };
  }
  if (!(await isReady(page, strategy))) {
    return {
      success: false,
      message: `No completed "${type}" output found. Call generate_studio_output first and wait for get_studio_output_status to report "ready".`,
    };
  }
  try {
    const content = await strategy.extractContent(page);
    return { success: true, content };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export type { AudioStatus, AudioGenerationResult, DownloadAudioResult, GenerateAudioOptions, Locator };
```

- [ ] **Step 4: Register the Audio strategy and make `audio.ts` a thin wrapper**

Rewrite `src/notebooklm/audio.ts` in full:
```typescript
/**
 * Audio Overview strategy, registered into the Studio-output engine
 * (studio-outputs.ts). Public functions below are thin wrappers kept for
 * backward compatibility with existing callers (browser-session.ts,
 * handlers.ts) — the actual trigger/poll/download logic now lives in the
 * shared engine, with this file supplying only Audio's own selectors and
 * DOM interactions.
 */
import type { Page } from "patchright";
import path from "path";
import { Selectors, joinAlt } from "./selectors.js";
import { safeSleep, isRecoverable } from "../browser/watchdog.js";
import { log } from "../utils/logger.js";
import {
  registerStudioStrategy,
  generateStudioOutput,
  getStudioOutputStatus,
  downloadStudioOutput,
  clickFirstVisible,
} from "./studio-outputs.js";
import type { AudioGenerationResult, DownloadAudioResult, GenerateAudioOptions } from "./studio-outputs.js";

export type AudioStatus = "ready" | "in_progress" | "not_started";
export type { AudioGenerationResult, DownloadAudioResult, GenerateAudioOptions };

const GENERATION_IN_PROGRESS_PHRASES = [
  "check back in a few minutes", "come back in a few minutes", "audio overview is being generated", "generating your audio",
  "kommen sie in ein paar minuten wieder", "audio-zusammenfassung wird erstellt", "audio-zusammenfassung wird gener",
  "revenez dans quelques minutes", "génération de l'aperçu audio",
  "vuelve en unos minutos", "generando el resumen de audio",
  "torna tra qualche minuto", "generazione della panoramica audio",
  "volte em alguns minutos", "gerando a visão geral de áudio",
  "kom over een paar minuten terug", "audio-overzicht wordt gegenereerd",
  "数分後にもう一度ご確認ください", "音声の概要を生成しています",
];

async function triggerAudio(page: Page, opts: { customPrompt?: string }): Promise<void> {
  if (opts.customPrompt) {
    await clickFirstVisible(page, Selectors.studio.audioCustomiseButton, "Audio customise button");
    const overlay = page.locator(Selectors.sources.overlayPane).first();
    const promptField = overlay.locator("textarea, input[type='text']").first();
    if (await promptField.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await promptField.fill(opts.customPrompt);
      await safeSleep(page, 200);
    }
    await clickFirstVisible(page, Selectors.studio.generateButton, "Generate button");
  } else {
    await clickFirstVisible(page, Selectors.studio.audioOverviewButton, "Audio overview entry");
  }
}

async function downloadAudio(page: Page, destDir: string): Promise<DownloadAudioResult> {
  await clickFirstVisible(page, Selectors.studio.audioMoreMenuButton, "Audio more-menu button");
  await safeSleep(page, 250);
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await clickFirstVisible(page, Selectors.studio.audioDownloadMenuItem, "Audio download menu item");
  const download = await downloadPromise;
  const suggested = download.suggestedFilename();
  const targetPath = path.join(destDir, suggested || "notebooklm-audio.wav");
  await download.saveAs(targetPath);
  return { success: true, filePath: targetPath };
}

registerStudioStrategy("audio", {
  kind: "file",
  triggerSelectors: Selectors.studio.audioOverviewButton,
  inProgressPhrases: GENERATION_IN_PROGRESS_PHRASES,
  // Tile-scoped to Audio specifically (not "any artifact tile") via the icon
  // anchor discovered in Task 6 Step 1 — see selectors.ts audioTileIconAnchor.
  readySelectors: [`artifact-library-item:has(${Selectors.studio.audioTileIconAnchor}):has(button.artifact-action-button)`],
  trigger: triggerAudio,
  download: downloadAudio,
});

export async function generateAudioOverview(page: Page, options: GenerateAudioOptions = {}): Promise<AudioGenerationResult> {
  return generateStudioOutput(page, "audio", options);
}

export async function getAudioStatusOnPage(page: Page): Promise<AudioGenerationResult> {
  return getStudioOutputStatus(page, "audio");
}

export async function downloadAudioOverview(page: Page, destinationDir: string): Promise<DownloadAudioResult> {
  return downloadStudioOutput(page, "audio", destinationDir);
}
```

Note: `Selectors.studio.audioCustomiseButton` and `Selectors.studio.audioOverviewButton`/`audioMoreMenuButton`/`audioDownloadMenuItem`/`generateButton` already exist (the customise-dialog opener was previously inlined as `openAudioCustomiseDialog`'s local selector array in the old `audio.ts` — move that array into `selectors.ts` under `studio.audioCustomiseButton` as part of this step, using its existing values verbatim, so `selectors.ts` remains the single source of truth for all Studio selectors per the codebase's own convention).

- [ ] **Step 5: Add pass-through methods to `BrowserSession`**

`browser-session.ts`'s existing `generateAudio`/`getAudioStatus`/`downloadAudio` methods already call into `audio.ts`'s exported functions (`browser-session.ts:499-524`) — since those functions keep their exact names and signatures (Step 4), **no changes are needed to `browser-session.ts` for audio**. Confirm this by re-reading `browser-session.ts:496-524` after Step 4 and checking every import still resolves — if `npm run build` (Step 6) passes, it does.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: exits 0. If it fails, the most likely cause is a missing `Selectors.studio.audioCustomiseButton`/`audioTileIconAnchor` export — confirm both were added to `selectors.ts` in Steps 2 and 4.

- [ ] **Step 7: Manual regression verification against the real account**

Via the live `notebooklm` MCP connection (once repointed per the final task's Step 1, or by running `node dist/index.js` directly and driving it with a manual JSON-RPC client): call `generate_audio` (or reuse an existing ready Audio Overview), `get_audio_status`, and `download_audio` end-to-end against a real notebook. Expected: identical behavior to before this task — `status` values, `alreadyExisted` handling, and the downloaded file all work exactly as they did pre-refactor. This is the one check in this plan that isn't optional — audio is the server's only currently-proven-working Studio feature, and this task is the one place its internals changed.

- [ ] **Step 8: Commit**

```bash
git add src/notebooklm/studio-outputs.ts src/notebooklm/audio.ts src/notebooklm/selectors.ts
git commit -m "refactor: build Studio-output engine, retrofit Audio Overview onto it with tile-scoped selectors"
```

---

## Task 7: Register the 4 parameterized Studio tools

**Files:**
- Create: `src/tools/definitions/studio.ts`
- Modify: `src/tools/definitions.ts` (register new tools)
- Modify: `src/tools/definitions/sources.ts` (update the 3 audio tool descriptions to reference the new tools)
- Modify: `src/tools/handlers.ts` (4 new handler methods)
- Modify: `src/index.ts` (4 new dispatch-map entries)
- Test: HTTP `tools/list` + `tools/call` probes (below)

**Interfaces:**
- Consumes: `generateStudioOutput`/`getStudioOutputStatus`/`downloadStudioOutput`/`getStudioOutputContent` from `studio-outputs.ts` (Task 6); `SessionManager.getOrCreateSession` (existing, `session-manager.ts:66`); `BrowserSession` needs 4 new pass-through methods mirroring the existing `generateAudio`/`getAudioStatus`/`downloadAudio` pattern.
- Produces: 4 new `ToolHandlers` methods returning `ToolResult<{ result: ... }>` matching the existing `handleGenerateAudio`/`handleGetAudioStatus`/`handleDownloadAudio` shape exactly (same `ToolResult<T>` wrapper, same `resolveNotebookUrl`/CONFIG-override pattern).

- [ ] **Step 1: Add pass-through methods to `BrowserSession`**

In `src/session/browser-session.ts`, add (near the existing `generateAudio`/`getAudioStatus`/`downloadAudio`/`extractCitations` methods), importing from the engine:
```typescript
import {
  generateStudioOutput,
  getStudioOutputStatus,
  downloadStudioOutput,
  getStudioOutputContent,
  type StudioOutputType,
} from "../notebooklm/studio-outputs.js";
```
Then:
```typescript
  async generateStudioOutput(
    type: StudioOutputType,
    options: GenerateAudioOptions & { difficulty?: string } = {}
  ): Promise<AudioGenerationResult> {
    if (!this.initialized || !this.page || this.isPageClosedSafe()) await this.init();
    return this.withRecovery("generateStudioOutput", () => generateStudioOutput(this.page!, type, options));
  }

  async getStudioOutputStatus(type: StudioOutputType): Promise<AudioGenerationResult> {
    if (!this.initialized || !this.page || this.isPageClosedSafe()) await this.init();
    return this.withRecovery("getStudioOutputStatus", () => getStudioOutputStatus(this.page!, type));
  }

  async downloadStudioOutput(type: StudioOutputType, destinationDir: string): Promise<DownloadAudioResult> {
    if (!this.initialized || !this.page || this.isPageClosedSafe()) await this.init();
    return this.withRecovery("downloadStudioOutput", () => downloadStudioOutput(this.page!, type, destinationDir));
  }

  async getStudioOutputContent(type: StudioOutputType): Promise<{ success: boolean; content?: unknown; message?: string }> {
    if (!this.initialized || !this.page || this.isPageClosedSafe()) await this.init();
    return this.withRecovery("getStudioOutputContent", () => getStudioOutputContent(this.page!, type));
  }
```
(`GenerateAudioOptions`/`AudioGenerationResult`/`DownloadAudioResult` are already imported in this file from `../notebooklm/audio.js` per the existing top-of-file imports — those types are now re-exported from `studio-outputs.js` per Task 6 Step 3's `export type { ... }` line, so either import path works; keep using the existing `../notebooklm/audio.js` import to minimize the diff.)

- [ ] **Step 2: Create the tool definitions**

Create `src/tools/definitions/studio.ts`:
```typescript
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const sharedNotebookTargeting = {
  session_id: { type: "string", description: "Reuse an existing browser session by id. See list_sessions." },
  notebook_id: { type: "string", description: "Library notebook id. Defaults to the active notebook when omitted." },
  notebook_url: { type: "string", description: "Direct NotebookLM URL — overrides notebook_id." },
};

const ALL_TYPES = ["audio", "video", "report", "slides", "infographic", "mindmap", "datatable", "quiz", "flashcards"];
const FILE_TYPES = ["audio", "video", "report", "slides", "infographic"];
const STRUCTURED_TYPES = ["mindmap", "datatable", "quiz", "flashcards"];

export const generateStudioOutputTool: Tool = {
  name: "generate_studio_output",
  description:
    "Trigger generation of any NotebookLM Studio output. **Async by default** " +
    "— returns immediately with status `started`/`in_progress`/`ready`. " +
    "Phase 1 of this server implements `audio`, `report`, and `flashcards`; " +
    "the other 6 types in the enum return a clear \"not yet implemented\" " +
    "error until Phase 2. Workflow: generate_studio_output → poll " +
    "get_studio_output_status → download_studio_output (file kinds: audio/" +
    "video/report/slides/infographic) or get_studio_output_content " +
    "(structured kinds: mindmap/datatable/quiz/flashcards).",
  inputSchema: {
    type: "object",
    properties: {
      output_type: { type: "string", enum: ALL_TYPES, description: "Which Studio output to generate." },
      custom_prompt: { type: "string", description: "Optional focus prompt, passed into the Customize dialog before generation." },
      difficulty: { type: "string", description: "Only used by quiz/flashcards (Phase 2). Ignored by other types." },
      wait_for_completion: { type: "boolean", description: "If true, block until ready (up to timeout_ms). Default false." },
      timeout_ms: { type: "number", description: "Only relevant when wait_for_completion=true. Default 600000 (10 min)." },
      show_browser: { type: "boolean", description: "Show the browser window for debugging. Default: false." },
      ...sharedNotebookTargeting,
    },
    required: ["output_type"],
  },
  annotations: { title: "Generate Studio output", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const getStudioOutputStatusTool: Tool = {
  name: "get_studio_output_status",
  description:
    "Non-blocking status probe for any Studio output type. Returns `ready` / " +
    "`in_progress` / `not_started`. Safe to poll every ~30s while waiting for " +
    "generate_studio_output to finish.",
  inputSchema: {
    type: "object",
    properties: {
      output_type: { type: "string", enum: ALL_TYPES, description: "Which Studio output to check." },
      show_browser: { type: "boolean", description: "Show the browser window for debugging. Default: false." },
      ...sharedNotebookTargeting,
    },
    required: ["output_type"],
  },
  annotations: { title: "Get Studio output status", readOnlyHint: true, openWorldHint: true },
};

export const downloadStudioOutputTool: Tool = {
  name: "download_studio_output",
  description:
    "Save a completed file-kind Studio output to disk. Only valid for " +
    "output_type in [audio, video, report, slides, infographic] — for " +
    "mindmap/datatable/quiz/flashcards use get_studio_output_content instead. " +
    "Precondition: get_studio_output_status must report `ready`.",
  inputSchema: {
    type: "object",
    properties: {
      output_type: { type: "string", enum: FILE_TYPES, description: "Which file-kind Studio output to download." },
      destination_dir: { type: "string", description: "Absolute directory path where the file is saved (created if missing)." },
      show_browser: { type: "boolean", description: "Show the browser window for debugging. Default: false." },
      ...sharedNotebookTargeting,
    },
    required: ["output_type", "destination_dir"],
  },
  annotations: { title: "Download Studio output", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const getStudioOutputContentTool: Tool = {
  name: "get_studio_output_content",
  description:
    "Extract a completed structured-kind Studio output as JSON. Only valid " +
    "for output_type in [mindmap, datatable, quiz, flashcards] — for audio/" +
    "video/report/slides/infographic use download_studio_output instead. " +
    "Precondition: get_studio_output_status must report `ready`.",
  inputSchema: {
    type: "object",
    properties: {
      output_type: { type: "string", enum: STRUCTURED_TYPES, description: "Which structured-kind Studio output to extract." },
      show_browser: { type: "boolean", description: "Show the browser window for debugging. Default: false." },
      ...sharedNotebookTargeting,
    },
    required: ["output_type"],
  },
  annotations: { title: "Get Studio output content", readOnlyHint: true, openWorldHint: true },
};

export const studioTools: Tool[] = [
  generateStudioOutputTool,
  getStudioOutputStatusTool,
  downloadStudioOutputTool,
  getStudioOutputContentTool,
];
```

- [ ] **Step 3: Register in `buildToolDefinitions`**

Read `src/tools/definitions.ts` first to find the existing array assembly pattern (it currently imports `sourceTools` from `./definitions/sources.js` among others). Add `import { studioTools } from "./definitions/studio.js";` and include `...studioTools` in the same array-spread pattern the file already uses for `sourceTools` and the other definition groups.

- [ ] **Step 4: Add the 4 handler methods**

In `src/tools/handlers.ts`, add (mirroring `handleGenerateAudio`/`handleGetAudioStatus`/`handleDownloadAudio` exactly — same `resolveNotebookUrl` + CONFIG-override + try/finally pattern):
```typescript
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
  }): Promise<ToolResult<{ result: AudioGenerationResult }>> {
    log.info(`🔧 [TOOL] generate_studio_output called (type=${args.output_type})`);
    const originalConfig = { ...CONFIG };
    if (args.show_browser !== undefined) Object.assign(CONFIG, applyBrowserOptions(undefined, args.show_browser));
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
      const session = await this.sessionManager.getOrCreateSession(args.session_id, url, overrideHeadless);
      const result = await session.generateStudioOutput(args.output_type, {
        customPrompt: args.custom_prompt,
        difficulty: args.difficulty,
        timeoutMs: args.timeout_ms,
        waitForCompletion: args.wait_for_completion ?? false,
      });
      const ok = result.status === "ready" || result.status === "started" || result.status === "in_progress";
      return { success: ok, data: { result } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] generate_studio_output failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      Object.assign(CONFIG, originalConfig);
    }
  }

  async handleGetStudioOutputStatus(args: {
    output_type: StudioOutputType;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AudioGenerationResult }>> {
    log.info(`🔧 [TOOL] get_studio_output_status called (type=${args.output_type})`);
    const originalConfig = { ...CONFIG };
    if (args.show_browser !== undefined) Object.assign(CONFIG, applyBrowserOptions(undefined, args.show_browser));
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
      const session = await this.sessionManager.getOrCreateSession(args.session_id, url, overrideHeadless);
      const result = await session.getStudioOutputStatus(args.output_type);
      return { success: true, data: { result } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_studio_output_status failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      Object.assign(CONFIG, originalConfig);
    }
  }

  async handleDownloadStudioOutput(args: {
    output_type: StudioOutputType;
    destination_dir: string;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: DownloadAudioResult }>> {
    log.info(`🔧 [TOOL] download_studio_output called (type=${args.output_type})`);
    const originalConfig = { ...CONFIG };
    if (args.show_browser !== undefined) Object.assign(CONFIG, applyBrowserOptions(undefined, args.show_browser));
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
      const session = await this.sessionManager.getOrCreateSession(args.session_id, url, overrideHeadless);
      const result = await session.downloadStudioOutput(args.output_type, args.destination_dir);
      return { success: result.success, data: { result } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] download_studio_output failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      Object.assign(CONFIG, originalConfig);
    }
  }

  async handleGetStudioOutputContent(args: {
    output_type: StudioOutputType;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: { success: boolean; content?: unknown; message?: string } }>> {
    log.info(`🔧 [TOOL] get_studio_output_content called (type=${args.output_type})`);
    const originalConfig = { ...CONFIG };
    if (args.show_browser !== undefined) Object.assign(CONFIG, applyBrowserOptions(undefined, args.show_browser));
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    try {
      const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
      const session = await this.sessionManager.getOrCreateSession(args.session_id, url, overrideHeadless);
      const result = await session.getStudioOutputContent(args.output_type);
      return { success: result.success, data: { result } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_studio_output_content failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      Object.assign(CONFIG, originalConfig);
    }
  }
```
Add the import `import type { StudioOutputType } from "../notebooklm/studio-outputs.js";` at the top of `handlers.ts`.

- [ ] **Step 5: Add the 4 dispatch-map entries**

In `src/index.ts`'s `buildToolDispatch()` (Task 3), add 4 entries following the same pattern as the other cases:
```typescript
      ["generate_studio_output", (args, sendProgress) => h.handleGenerateStudioOutput(args as Parameters<typeof h.handleGenerateStudioOutput>[0])],
      ["get_studio_output_status", (args) => h.handleGetStudioOutputStatus(args as Parameters<typeof h.handleGetStudioOutputStatus>[0])],
      ["download_studio_output", (args) => h.handleDownloadStudioOutput(args as Parameters<typeof h.handleDownloadStudioOutput>[0])],
      ["get_studio_output_content", (args) => h.handleGetStudioOutputContent(args as Parameters<typeof h.handleGetStudioOutputContent>[0])],
```
(`sendProgress` is accepted but unused by these 4 handlers for now — matches the existing pattern where most handlers ignore the second dispatch-map callback argument.)

- [ ] **Step 6: Update the 3 existing audio tool descriptions**

In `src/tools/definitions/sources.ts`, update `generateAudioTool`/`getAudioStatusTool`/`downloadAudioTool`'s `description` strings to add one line each noting they're equivalent to `generate_studio_output`/`get_studio_output_status`/`download_studio_output` with `output_type: "audio"`, and that new Studio output types are only available through the new generic tools. Keep every existing sentence — this is an addition, not a rewrite, since these 3 tools remain fully supported aliases per the Global Constraints.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 8: Manual protocol verification**

Start the server on HTTP transport, confirm `tools/list` now includes all 24 tools (20 existing + 4 new), and confirm `generate_studio_output` with `output_type: "video"` (a Phase-2, not-yet-implemented type) returns the clear "not yet implemented" error rather than a crash or a silent no-op:
```bash
curl -s -X POST http://127.0.0.1:3100/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"generate_studio_output","arguments":{"output_type":"video","notebook_url":"https://notebooklm.google.com/notebook/does-not-matter-for-this-check"}}}'
```
Expected: the tool call itself succeeds at the protocol level (no JSON-RPC error) and the `result.data.result`/error path — check whichever your build's exact wrapping is, per `handleGenerateStudioOutput`'s `catch` — carries the message `Studio output type "video" is not yet implemented by this server (Phase 2). Implemented types: audio.` (only `audio` is registered until Task 8 adds `report` and `flashcards`).

- [ ] **Step 9: Commit**

```bash
git add src/tools/definitions/studio.ts src/tools/definitions.ts src/tools/definitions/sources.ts src/tools/handlers.ts src/index.ts src/session/browser-session.ts
git commit -m "feat: add generate/get_status/download/get_content Studio-output tools"
```

---

## Task 8: Implement the `report` strategy (file kind)

**Files:**
- Modify: `src/notebooklm/selectors.ts` (add `studio.reportButton`/`reportTileIconAnchor`/etc.)
- Create: `src/notebooklm/studio-strategies/report.ts`
- Modify: `src/index.ts` or wherever strategies are registered at startup (see Step 3)
- Test: manual, against the real NotebookLM account

**Interfaces:**
- Consumes: `registerStudioStrategy`, `clickFirstVisible`, `ensureStudioPanelExpanded` from `studio-outputs.ts` (Task 6).
- Produces: the `"report"` entry in the strategy registry, `kind: "file"`.

- [ ] **Step 1: Live DOM reconnaissance**

With `show_browser: true`, open a notebook's Studio panel, locate the "Reports" entry (per the design spec's research, this is a Tier-1 Studio tool that generates a briefing-doc/competitive-analysis style document — confirm the exact current label, since NotebookLM's copy may differ from the March-2026 article this plan's spec cited). Record, following `selectors.ts`'s documented anchor-priority (class name → Material-Symbols icon text → `role` → locale aria-label):
  1. The trigger control's selector(s) — likely a `.create-artifact-button-container` sibling to the Audio one, with its own `mat-icon` glyph name.
  2. Whether Reports offers a "Suggested Formats" or format-choice sub-dialog before generation (the spec's research noted this) — if so, note whether `custom_prompt` should map to a free-text field in that dialog or whether format selection needs its own parameter (if the latter, that's a Phase 2 schema addition — for Phase 1, wire `custom_prompt` into whatever free-text field exists, matching Audio's `customPrompt` → Customize-dialog pattern).
  3. The completed tile's type-discriminating anchor (mirroring Task 6 Step 1's approach for Audio) and its three-dot menu → Download flow, which is very likely structurally identical to Audio's (`artifact-library-item` + `more_vert` + a `[role="menuitem"]` Download entry) — confirm rather than assume.
  4. In-progress phrase text, at minimum in English (add other locales opportunistically if visible; do not block on translating all 8).

- [ ] **Step 2: Add selectors**

In `src/notebooklm/selectors.ts`'s `studio` object, add (using Step 1's actual findings — this shape mirrors `audioOverviewButton`/`audioTileIconAnchor`/`audioMoreMenuButton`/`audioDownloadMenuItem`):
```typescript
    reportButton: [
      /* filled from Task 8 Step 1 recon — e.g. '.create-artifact-button-container:has(mat-icon:text-is("<icon-name>"))' */
    ],
    reportTileIconAnchor: /* e.g. 'mat-icon:text-is("<icon-name>")' */,
```

- [ ] **Step 3: Create the strategy module and register it**

Create `src/notebooklm/studio-strategies/report.ts`:
```typescript
import type { Page } from "patchright";
import path from "path";
import { Selectors, joinAlt } from "../selectors.js";
import { safeSleep } from "../../browser/watchdog.js";
import { registerStudioStrategy, clickFirstVisible } from "../studio-outputs.js";
import type { DownloadAudioResult } from "../studio-outputs.js";

const REPORT_IN_PROGRESS_PHRASES = [
  "check back in a few minutes", "come back in a few minutes", "generating your report",
  /* add other locales found during Task 8 Step 1 if discovered */
];

async function triggerReport(page: Page, opts: { customPrompt?: string }): Promise<void> {
  if (opts.customPrompt) {
    // Fill in the customise/format dialog interaction discovered in Step 1.
    await clickFirstVisible(page, Selectors.studio.reportButton, "Report entry");
    const overlay = page.locator(Selectors.sources.overlayPane).first();
    const promptField = overlay.locator("textarea, input[type='text']").first();
    if (await promptField.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await promptField.fill(opts.customPrompt);
      await safeSleep(page, 200);
    }
    await clickFirstVisible(page, Selectors.studio.generateButton, "Generate button");
  } else {
    await clickFirstVisible(page, Selectors.studio.reportButton, "Report entry");
  }
}

async function downloadReport(page: Page, destDir: string): Promise<DownloadAudioResult> {
  await clickFirstVisible(page, Selectors.studio.audioMoreMenuButton, "Report more-menu button");
  await safeSleep(page, 250);
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await clickFirstVisible(page, Selectors.studio.audioDownloadMenuItem, "Report download menu item");
  const download = await downloadPromise;
  const suggested = download.suggestedFilename();
  const targetPath = path.join(destDir, suggested || "notebooklm-report.pdf");
  await download.saveAs(targetPath);
  return { success: true, filePath: targetPath };
}

registerStudioStrategy("report", {
  kind: "file",
  triggerSelectors: Selectors.studio.reportButton,
  inProgressPhrases: REPORT_IN_PROGRESS_PHRASES,
  readySelectors: [`artifact-library-item:has(${Selectors.studio.reportTileIconAnchor}):has(button.artifact-action-button)`],
  trigger: triggerReport,
  download: downloadReport,
});
```
Note: this reuses `Selectors.studio.audioMoreMenuButton`/`audioDownloadMenuItem` on the assumption (from Step 1.3) that the three-dot-menu/download-item pattern is shared across all file-kind artifact tiles — if Step 1 found Reports uses a genuinely different menu structure, replace these two lines with Report-specific selectors discovered the same way, and rename the shared ones only if they turn out not to be shared after all.

- [ ] **Step 4: Import the strategy module so registration runs at startup**

In `src/index.ts`, near the top-level imports (alongside where `audio.js`'s registration already runs implicitly via its import chain from `browser-session.ts` → `studio-outputs.js`), add:
```typescript
import "./notebooklm/studio-strategies/report.js";
```
(A side-effecting import — this file's only job is to call `registerStudioStrategy` at module load time. Confirm `audio.ts`'s own registration, from Task 6, is reachable the same way — it currently is, since `browser-session.ts` imports from `../notebooklm/audio.js` unconditionally.)

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Manual verification against the real account**

Via the live MCP connection: `generate_studio_output({ output_type: "report" })` → poll `get_studio_output_status({ output_type: "report" })` → `download_studio_output({ output_type: "report", destination_dir: "<some real path>" })`. Expected: a Report file lands at the returned `filePath`.

- [ ] **Step 7: Commit**

```bash
git add src/notebooklm/selectors.ts src/notebooklm/studio-strategies/report.ts src/index.ts
git commit -m "feat: implement Report Studio output (file kind)"
```

---

## Task 9: Implement the `flashcards` strategy (structured kind)

**Files:**
- Modify: `src/notebooklm/selectors.ts` (add `studio.flashcardsButton`/etc.)
- Create: `src/notebooklm/studio-strategies/flashcards.ts`
- Modify: `src/index.ts` (side-effecting import)
- Test: manual, against the real NotebookLM account

**Interfaces:**
- Same as Task 8, but `kind: "structured"` with `extractContent` instead of `download`.

- [ ] **Step 1: Live DOM reconnaissance**

With `show_browser: true`, locate the "Flash Cards" Studio entry, generate a set, and inspect the completed view in DevTools. Record:
  1. Trigger selector(s), following the same class/icon/role/aria-label priority.
  2. Whether generation exposes a `difficulty` parameter in a pre-generation dialog (the design spec's research noted "set the difficulty level" as a real Flash Cards feature) — if so, note the exact control (a `<select>`, a set of buttons) so `trigger`'s `opts.difficulty` can drive it; if a difficulty control isn't easily automatable within this task's scope, it's fine to ignore `opts.difficulty` for Phase 1 and generate at the default difficulty — note this explicitly in the code comment rather than silently dropping it.
  3. The completed set's container selector and each individual card's front/back structure — flashcards typically render as one card at a time with a flip/reveal interaction; identify the selector for "next card" and the front-text/back-text elements so `extractContent` can iterate through the full set programmatically (click through, read front, trigger reveal, read back, repeat until the deck loops back to the first card or a count indicator shows completion).
  4. In-progress phrase text (English at minimum).

- [ ] **Step 2: Add selectors**

```typescript
    flashcardsButton: [ /* from recon */ ],
    flashcardsTileIconAnchor: /* from recon */,
    flashcardsCardFront: /* from recon */,
    flashcardsCardBack: /* from recon */,
    flashcardsNextButton: /* from recon */,
```

- [ ] **Step 3: Create the strategy module**

Create `src/notebooklm/studio-strategies/flashcards.ts`:
```typescript
import type { Page } from "patchright";
import { Selectors, joinAlt } from "../selectors.js";
import { safeSleep } from "../../browser/watchdog.js";
import { registerStudioStrategy, clickFirstVisible } from "../studio-outputs.js";

const FLASHCARDS_IN_PROGRESS_PHRASES = [
  "check back in a few minutes", "come back in a few minutes", "generating your flashcards",
];

async function triggerFlashcards(page: Page, _opts: { difficulty?: string }): Promise<void> {
  await clickFirstVisible(page, Selectors.studio.flashcardsButton, "Flash Cards entry");
  // Difficulty control wiring: fill in during implementation if Step 1 found
  // an automatable pre-generation difficulty selector; otherwise Phase 1
  // generates at NotebookLM's default difficulty and this parameter is a
  // documented no-op until Phase 2.
}

interface Flashcard {
  front: string;
  back: string;
}

async function extractFlashcards(page: Page): Promise<Flashcard[]> {
  const cards: Flashcard[] = [];
  const seenFronts = new Set<string>();
  // Iterate the deck via "next" until it loops back to a front we've already
  // recorded — flashcards don't expose a total count, so cycle-detection
  // is the termination condition rather than a fixed loop bound.
  for (let i = 0; i < 200; i++) {
    const front = (await page.locator(joinAlt(Selectors.studio.flashcardsCardFront)).first().textContent().catch(() => null))?.trim();
    if (!front) break;
    if (seenFronts.has(front)) break;
    seenFronts.add(front);
    // Reveal the back (click/flip interaction — adjust per Step 1 findings;
    // some implementations reveal on click of the card itself rather than a
    // dedicated button).
    await page.locator(joinAlt(Selectors.studio.flashcardsCardFront)).first().click().catch(() => undefined);
    await safeSleep(page, 200);
    const back = (await page.locator(joinAlt(Selectors.studio.flashcardsCardBack)).first().textContent().catch(() => null))?.trim() ?? "";
    cards.push({ front, back });
    const hasNext = await page.locator(joinAlt(Selectors.studio.flashcardsNextButton)).first().isVisible({ timeout: 500 }).catch(() => false);
    if (!hasNext) break;
    await page.locator(joinAlt(Selectors.studio.flashcardsNextButton)).first().click().catch(() => undefined);
    await safeSleep(page, 300);
  }
  return cards;
}

registerStudioStrategy("flashcards", {
  kind: "structured",
  triggerSelectors: Selectors.studio.flashcardsButton,
  inProgressPhrases: FLASHCARDS_IN_PROGRESS_PHRASES,
  readySelectors: [`artifact-library-item:has(${Selectors.studio.flashcardsTileIconAnchor})`],
  trigger: triggerFlashcards,
  extractContent: extractFlashcards,
});
```

- [ ] **Step 4: Side-effecting import**

In `src/index.ts`, add alongside Task 8 Step 4's import:
```typescript
import "./notebooklm/studio-strategies/flashcards.js";
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Manual verification against the real account**

Via the live MCP connection: `generate_studio_output({ output_type: "flashcards" })` → poll `get_studio_output_status({ output_type: "flashcards" })` → `get_studio_output_content({ output_type: "flashcards" })`. Expected: a JSON array of `{ front, back }` pairs matching the actual generated deck (spot-check at least 2-3 cards against what's visible in the browser).

- [ ] **Step 7: Commit**

```bash
git add src/notebooklm/selectors.ts src/notebooklm/studio-strategies/flashcards.ts src/index.ts
git commit -m "feat: implement Flash Cards Studio output (structured kind)"
```

---

## Task 10: Add `structuredContent`/`outputSchema` to the narrow stable tool set

**Files:**
- Modify: `src/tools/definitions/system.ts` (or wherever `get_health`/`get_library_stats` are defined — confirm exact file when starting this task)
- Modify: `src/tools/definitions/session-management.ts` (`list_sessions`)
- Modify: `src/tools/definitions/studio.ts` (`get_studio_output_status`, `get_studio_output_content` — from Task 7)
- Modify: `src/index.ts` (attach `structuredContent` in the `CallToolRequestSchema` handler's response construction)
- Test: HTTP `tools/call` probe confirming `structuredContent` is present and schema-valid

**Interfaces:**
- Consumes: confirmed `outputSchema`/`structuredContent` support from Task 1.
- Produces: `Tool.outputSchema` (JSON Schema) on 4 tools; `CallToolResult.structuredContent` populated alongside `content` for those same 4 tools.

- [ ] **Step 1: Add `outputSchema` to `get_health`**

Find `get_health`'s `Tool` definition (in `src/tools/definitions/system.ts` or equivalent — confirm the exact file with `grep -rn "name: \"get_health\"" src/tools/definitions/`). Add an `outputSchema` field matching `handleGetHealth`'s actual return shape (read `handlers.ts:363` onward first to get the exact fields — do not guess). Example shape (adjust field names/types to match what Step 0's read of `handleGetHealth` actually returns):
```typescript
  outputSchema: {
    type: "object",
    properties: {
      authenticated: { type: "boolean" },
      profile: { type: "string" },
      active_sessions: { type: "number" },
      // ... every field handleGetHealth actually returns, typed correctly
    },
    required: ["authenticated"],
  },
```

- [ ] **Step 2: Add `outputSchema` to `get_library_stats`, `list_sessions`, `get_studio_output_status`, `get_studio_output_content`**

Same approach: read each handler's actual return type (`LibraryStats` from `library/types.ts` for `get_library_stats`; `SessionInfo[]`-wrapping shape for `list_sessions`; `AudioGenerationResult` for `get_studio_output_status`; `{ success, content?, message? }` for `get_studio_output_content`) and write an `outputSchema` that matches it exactly — a mismatch here causes outputSchema-aware clients to hard-fail the call per the design spec's §3.3 caveat, so precision matters more than completeness.

- [ ] **Step 3: Populate `structuredContent` in the tool-call response**

In `src/index.ts`'s `CallToolRequestSchema` handler, after `const result = await handler(args, sendProgress);` (Task 3's replacement code), change the response construction from:
```typescript
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
```
to:
```typescript
        const STRUCTURED_CONTENT_TOOLS = new Set([
          "get_health",
          "get_library_stats",
          "list_sessions",
          "get_studio_output_status",
          "get_studio_output_content",
        ]);
        const isSuccessResult = typeof result === "object" && result !== null && (result as { success?: boolean }).success !== false;
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          ...(STRUCTURED_CONTENT_TOOLS.has(name) && isSuccessResult ? { structuredContent: result as Record<string, unknown> } : {}),
        };
```
(The `isSuccessResult` guard implements the design spec's explicit rule: never attach `structuredContent` to an error result.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Manual verification**

Call `get_health` over the HTTP transport and confirm the JSON-RPC result's `result.structuredContent` field is present and matches `result.content[0].text`'s parsed JSON.

- [ ] **Step 6: Commit**

```bash
git add src/tools/definitions/ src/index.ts
git commit -m "feat: add structuredContent/outputSchema to the stable tool result set"
```

---

## Task 11: Add elicitation to `cleanup_data` and `remove_notebook`

**Files:**
- Modify: `src/tools/handlers.ts` (`handleCleanupData`, `handleRemoveNotebook`)
- Modify: `src/index.ts` (pass the `Server` instance, or an elicit callback, into `ToolHandlers` so handlers can call `server.elicitInput`)
- Test: manual — requires a client that declares elicitation capability; document the fallback-path verification if such a client isn't available

**Interfaces:**
- Consumes: `server.elicitInput` (signature confirmed in Task 1 Step 3).
- Produces: `ToolHandlers` constructor gains an optional `elicit?: (params: ElicitParams) => Promise<ElicitResult>` dependency; `handleCleanupData`/`handleRemoveNotebook` call it when available and the client declared the capability, otherwise fall back to their existing `confirm` param / prose-confirmation behavior unchanged.

- [ ] **Step 1: Thread an elicit callback into `ToolHandlers`**

In `src/tools/handlers.ts`, add an optional constructor parameter:
```typescript
  constructor(
    sessionManager: SessionManager,
    authManager: AuthManager,
    library: NotebookLibrary,
    private readonly elicit?: (message: string, schema: Record<string, unknown>) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>
  ) {
    this.sessionManager = sessionManager;
    this.authManager = authManager;
    this.library = library;
  }
```

In `src/index.ts`'s constructor, change:
```typescript
    this.toolHandlers = new ToolHandlers(this.sessionManager, this.authManager, this.library);
```
to:
```typescript
    this.toolHandlers = new ToolHandlers(this.sessionManager, this.authManager, this.library, (message, schema) =>
      this.server.elicitInput({ message, requestedSchema: schema })
    );
```
(Adjust the exact parameter names/shape of `elicitInput`'s argument to match whatever Task 1 Step 3 confirmed — this is the one place in this plan where the SDK's actual signature, not a guess, must be used verbatim.)

- [ ] **Step 2: Use elicitation in `handleRemoveNotebook`, falling back to prose-confirmation behavior**

`handleRemoveNotebook` currently has no `confirm` param at all (it acts immediately — the "confirmation" is purely the tool description's prose instruction to the LLM). Add an elicitation gate that only activates when `this.elicit` is available (i.e., the client declared the capability); otherwise behavior is unchanged from today:
```typescript
  async handleRemoveNotebook(args: { id: string }): Promise<ToolResult<{ removed: boolean; closed_sessions: number }>> {
    log.info(`🔧 [TOOL] remove_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.getNotebook(args.id);
      if (!notebook) {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return { success: false, error: `Notebook not found: ${args.id}` };
      }

      if (this.elicit) {
        const confirmation = await this.elicit(
          `Remove notebook "${notebook.name}" (${notebook.id}) from your local library? This does not delete the notebook on NotebookLM itself — only the local library entry.`,
          { type: "object", properties: { confirmed: { type: "boolean" } }, required: ["confirmed"] }
        );
        if (confirmation.action !== "accept" || confirmation.content?.confirmed !== true) {
          log.info(`  ℹ️  remove_notebook declined via elicitation`);
          return { success: false, error: "Removal declined by user." };
        }
      }
      // Clients without elicitation capability fall through here unchanged —
      // this.elicit is undefined for them, matching current behavior exactly.

      const removed = this.library.removeNotebook(args.id);
      if (removed) {
        const closedSessions = await this.sessionManager.closeSessionsForNotebook(notebook.url);
        log.success(`✅ [TOOL] remove_notebook completed`);
        return { success: true, data: { removed: true, closed_sessions: closedSessions } };
      } else {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return { success: false, error: `Notebook not found: ${args.id}` };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] remove_notebook failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }
```

- [ ] **Step 3: Use elicitation in `handleCleanupData`, preserving the existing `confirm` param as the non-elicitation path**

`handleCleanupData` already has `confirm: boolean` (preview when `false`, delete when `true`). Add: when `this.elicit` is available AND `confirm` was passed as `false` (i.e., the caller is in preview mode and hasn't explicitly said yes), offer elicitation as an *additional* confirmation path rather than replacing the existing preview/confirm flow — insert right after the preview branch's `return` is about to happen:
```typescript
      if (!confirm) {
        const preview = await cleanupManager.getCleanupPaths(mode, preserve_library);
        const platformInfo = cleanupManager.getPlatformInfo();
        log.info(`  Found ${preview.totalPaths.length} items (${cleanupManager.formatBytes(preview.totalSizeBytes)})`);
        log.info(`  Platform: ${platformInfo.platform}`);

        if (this.elicit) {
          const confirmation = await this.elicit(
            `Delete ${preview.totalPaths.length} item(s) totalling ${cleanupManager.formatBytes(preview.totalSizeBytes)} ` +
              `(auth state, browser profile, and optionally the notebook library)? This cannot be undone.`,
            { type: "object", properties: { confirmed: { type: "boolean" } }, required: ["confirmed"] }
          );
          if (confirmation.action === "accept" && confirmation.content?.confirmed === true) {
            const result = await cleanupManager.performCleanup(mode, preserve_library);
            log.success(`✅ [TOOL] cleanup_data completed via elicitation - deleted ${result.deletedPaths.length} items`);
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
          log.info(`  ℹ️  cleanup_data declined via elicitation — returning preview only`);
        }

        return {
          success: true,
          data: { status: "preview", mode, preview: { categories: preview.categories, totalPaths: preview.totalPaths.length, totalSizeBytes: preview.totalSizeBytes } },
        };
      } else {
        // unchanged — explicit confirm:true still works exactly as before, no elicitation involved
```
(The `else` branch — explicit `confirm: true` — is untouched: it's the existing non-elicitation path and must keep working for clients that don't support elicitation.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Manual verification (fallback path — always testable)**

Regardless of whether an elicitation-capable client is available: call `remove_notebook` and `cleanup_data(confirm: false)` through the existing `notebooklm` MCP connection in Claude Code (which may not declare elicitation capability, in which case `this.elicit` calls still route through the callback but the SDK/host will reject or the capability negotiation will mean `this.elicit` is effectively unused — confirm by checking log output shows no elicitation attempt, or that it degrades gracefully rather than hanging or crashing). Expected: both tools behave exactly as before this task if elicitation isn't available end-to-end.

- [ ] **Step 6: Commit**

```bash
git add src/tools/handlers.ts src/index.ts
git commit -m "feat: add elicitation to remove_notebook and cleanup_data, with fallback for clients without the capability"
```

---

## Task 12: Update tool profiles and documentation

**Files:**
- Modify: `src/utils/settings-manager.ts` (Task 12 decision: which new tools, if any, join `standard`)
- Modify: `README.md` (Tools table, Transports section's capability list, Changelog)
- Modify: `docs/tools.md`, `docs/configuration.md` if either references the old capability set or tool count
- Modify: `src/index.ts`'s `SERVER_INSTRUCTIONS` string (remove the "not yet implemented" claims for `report`/`flashcards` specifically; keep them accurate for the other 6 Phase-2 types)
- Test: `npm run check`

**Interfaces:** none new — this is a documentation/config-only task.

- [ ] **Step 1: Decide and apply `standard` profile inclusion**

Per the design spec's guidance: default new tools to `full` only. `PROFILES.full` is `["*"]`, so the 24 (20 existing + 4 new) tools are already all included there with zero changes. For `standard` (`settings-manager.ts:40-51`), add `get_studio_output_status` only — it's read-only (`readOnlyHint: true`) and mirrors why `list_sessions` is already in `standard`. Do not add `generate_studio_output`/`download_studio_output`/`get_studio_output_content` to `standard` — they're not read-only and `standard` otherwise contains no non-read-only Studio/audio tools today.

```typescript
  standard: [
    "ask_question", "get_health", "list_notebooks", "select_notebook", "get_notebook",
    "setup_auth", "list_sessions", "add_notebook", "update_notebook", "search_notebooks",
    "get_studio_output_status",
  ],
```

- [ ] **Step 2: Update `SERVER_INSTRUCTIONS` in `src/index.ts`**

Find the existing paragraph (`index.ts:112-120`):
```
## Constraints
...
- File / YouTube / Drive source uploads are not yet implemented in v2.0.
- Audio Overview is the only Studio output exposed in v2.0; Video, Presentation, Mindmap, Flashcards, Quiz, Infographic, and Datatable are generated by NotebookLM but not yet wrapped by this server.
```
Replace the last line with:
```
- Audio Overview, Report, and Flash Cards are the Studio outputs exposed via generate_studio_output/get_studio_output_status/download_studio_output/get_studio_output_content. Video, Slide Decks, Infographic, Mind Map, Data Table, and Quiz are recognised by the tool schema but return a clear "not yet implemented" error (Phase 2).
```

- [ ] **Step 3: Update `README.md`**

- In the "Tools" section's tables, add a new "Studio (generic)" subsection documenting the 4 new tools (mirroring the existing "Sources & Studio" table's format), and update the existing `generate_audio`/`get_audio_status`/`download_audio` rows to note they're now aliases.
- In "Resources (read-only)" or wherever capabilities are described, correct any mention of `resourceTemplates`/`logging` capabilities to match Task 2's fix.
- Add a `## Prompts` section (new) documenting `notebooklm.auth-setup` and `notebooklm.auth-repair` — these were previously undocumented (and non-functional) in the README.
- Add a short Changelog entry (or a new `## Unreleased (local fork)` section if the file has a Changelog section) summarizing: capability fixes, dispatch/recovery refactors, Studio-output engine + 3 verified types, structured content, elicitation.

- [ ] **Step 4: Build and lint**

Run: `npm run check`
Expected: exits 0 (prettier:check + eslint + tsc build all pass).

- [ ] **Step 5: Commit**

```bash
git add src/utils/settings-manager.ts src/index.ts README.md docs/
git commit -m "docs: update tool profiles, README, and server instructions for Phase 1"
```

---

## Task 13: Full Phase 1 regression pass and MCP config repoint

**Files:** none modified — verification only, plus the final Claude Code config change.

- [ ] **Step 1: Full build + lint gate**

Run: `npm run check`
Expected: exits 0.

- [ ] **Step 2: Full regression checklist (manual, against the real NotebookLM account)**

Run through, in order, confirming each behaves exactly as it did before this plan started:
  - `get_health` — reflects current auth state.
  - `ask_question` (new session, then a follow-up in the same session via `session_id`) — answer quality/citations unaffected.
  - `list_notebooks` / `select_notebook` / `add_notebook` / `update_notebook` / `search_notebooks` / `remove_notebook` (the last one specifically exercises Task 11's elicitation-gated path — confirm it still completes when accepted, and is skippable when the client doesn't support elicitation).
  - `list_sessions` / `close_session` / `reset_session`.
  - `add_source` (type `url` and `text`).
  - `generate_audio` / `get_audio_status` / `download_audio` — the Task 6 regression path; confirm end-to-end.
  - `cleanup_data(confirm: false)` — preview mode still returns the same preview shape (do not actually run `confirm: true` during this check unless you intend to wipe local auth state).
  - New: `generate_studio_output`/`get_studio_output_status`/`download_studio_output` with `output_type: "report"`.
  - New: `generate_studio_output`/`get_studio_output_status`/`get_studio_output_content` with `output_type: "flashcards"`.
  - New: `prompts/list` and `prompts/get` for both prompts (Task 2).
  - New: a `resources/list_changed` notification observed after an `add_notebook`/`remove_notebook` call (Task 5).

- [ ] **Step 3: Repoint the Claude Code MCP entry to this fork**

Find the current registration:
```bash
claude mcp list
```
Confirm it currently reads `npx notebooklm-mcp@latest`. Repoint it to the local build:
```bash
claude mcp remove notebooklm
claude mcp add notebooklm -- node "<path-to-your-clone>\dist\index.js"
```
(Or edit `~/.claude.json`'s `mcpServers.notebooklm` entry directly to the same effect, per the fork's own README "Manual form" instructions.)

- [ ] **Step 4: Restart Claude Code / reconnect the MCP server and smoke-test through the real client**

Restart the session (or use whatever reconnect mechanism applies), then call `get_health` and `list_notebooks` through the live `notebooklm` MCP tools (not the raw HTTP probe) to confirm the repointed server is live and behaving correctly end-to-end through the actual client this was built for.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: Phase 1 complete — full regression pass verified"
git log --oneline -15
```
