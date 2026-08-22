# notebooklm-mcp: full-feature + protocol + efficiency upgrade

Date: 2026-08-22
Base: local fork of `PleasePrompto/notebooklm-mcp`, upstream commit `50b3e7f` (v2.0.0), cloned to this repo.
Delivery: **local fork only**. No upstream PR. The user's Claude Code `notebooklm` MCP entry will be repointed from `npx notebooklm-mcp@latest` to `node <fork>/dist/index.js` once the build is verified.

## 1. Why

Three explicit asks from the user, all in scope together:

1. "Include as many features as possible" — the server wraps only Audio Overview from NotebookLM's Studio panel; NotebookLM (renamed "Gemini Notebook" July 2026, same domain) now ships 8 more Studio outputs plus source-side upgrades (Fast/Deep Research, Drive search, notes) that aren't wrapped at all.
2. "As robust as possible with the new MCP protocol" — several declared protocol capabilities are incomplete or partially dead (see §3).
3. "Review the complete MCP base and optimize the hell out of it" — the dispatch and recovery code has duplication that would multiply badly if the 8 new Studio outputs were added additively.

## 2. Current-state findings (grounding for this design)

Read directly from the cloned source (`src/`), not assumed:

- `src/index.ts` dispatches all ~20 tools through one large `switch` in the `CallToolRequestSchema` handler.
- `src/session/browser-session.ts` — `ask()` and `reset()` each contain an identical try/catch that detects a closed page/context, reinitializes, and retries once. Duplicated, not shared.
- `src/notebooklm/audio.ts` is the only Studio-output automation module. Its shape (idempotency check → in-progress check → expand panel → trigger → async-return-or-wait → separate status probe → separate download-via-menu) is the template the other 8 outputs would need, and NotebookLM's own docs/tool description text (`SERVER_INSTRUCTIONS` in `index.ts`) already lists them as known-missing: Video, Presentation/Slide Decks, Mind Map, Flashcards, Quiz, Infographic, Datatable. Our research adds "Reports" as a 9th (current Studio Tier-1 tool, briefing-doc/competitive-analysis generator).
- Tool `annotations` (readOnlyHint/destructiveHint/idempotentHint/openWorldHint) are already used per-tool (see `ask-question.ts`) — a pattern to continue, not introduce.
- Progress notifications already work end-to-end (`extractProgressToken` + `sendProgress` + `server.notification({method: "notifications/progress", ...})` in `index.ts`), used by `ask_question`, `setup_auth`, `re_auth`.
- **Bug**: server capabilities declare `prompts: {}`, and `ask-question.ts`'s tool description instructs the calling LLM to invoke prompts named `notebooklm.auth-setup` and `notebooklm.auth-repair` — but no `ListPromptsRequestSchema`/`GetPromptRequestSchema` handler exists anywhere in the codebase (confirmed via full-source grep). Any client that follows the embedded instruction gets a protocol error.
- `src/resources/resource-handlers.ts` implements `resources/list`, `resources/templates/list`, `resources/read`, and `completion/complete` (for the `notebooklm://library/{id}` template) — solid, but no `resources/subscribe` and no `notifications/resources/list_changed` when the library actually changes (add/update/remove/select notebook all mutate `NotebookLibrary` silently).
- No tool returns `structuredContent`; every result is a JSON string inside one `content: [{type:"text"}]` block. No tool declares `outputSchema`.
- `selectors.ts` is a well-built locale-agnostic registry (class name → Material icon → role → locale aria-label fallback chain, covering 8 locales) — the new Studio-output selectors should follow this exact convention, not invent a new one.
- `@modelcontextprotocol/sdk` is pinned `^1.0.0`; latest on npm is `1.30.0`, which supports structured content, elicitation, and everything else in this design.
- No real test suite — `npm test` just boots the server (`tsx src/index.ts`). `npm run check` (prettier check + eslint + tsc build) is the only deterministic gate.

## 3. Architecture

### 3.1 Studio-output engine (replaces "add 8 files like audio.ts")

New `src/notebooklm/studio-outputs.ts`:

- A `StudioOutputType` union: `"audio" | "video" | "report" | "slides" | "infographic" | "mindmap" | "datatable" | "quiz" | "flashcards"`.
- A `STUDIO_OUTPUT_CONFIGS: Record<StudioOutputType, StudioOutputConfig>` table. Each config carries: trigger selector(s) (entry button in the Studio panel, following the existing `Selectors.studio.*` convention), in-progress phrase list (multilingual, same pattern as `GENERATION_IN_PROGRESS_PHRASES`), ready-selector, `artifactKind: "file" | "structured"`, and either download-menu selectors (file kind) or a DOM-extraction function returning JSON (structured kind — e.g. mind-map node/edge list, data-table rows, quiz question/answer pairs, flashcard front/back pairs).
- Generic functions: `generateStudioOutput(page, type, options)`, `getStudioOutputStatus(page, type)`, `downloadStudioOutput(page, type, destDir)` (file kinds only), `getStudioOutputContent(page, type)` (structured kinds only). All reuse `safeSleep`/`isRecoverable`/`pageIsAlive` from `browser/watchdog.ts` and the `clickFirstVisible`/`ensureStudioPanelExpanded` helpers lifted out of `audio.ts` into this shared module.
- `audio.ts`'s existing exported functions become thin wrappers calling into the engine with `type: "audio"` pinned — so the *existing*, working, tested-in-production audio path keeps its exact current behavior and public signature; nothing about it regresses.

### 3.2 Tool surface

**Studio (4 new tools, replacing what an additive approach would need ~24-32 tools for):**

| Tool | Params | Notes |
|---|---|---|
| `generate_studio_output` | `output_type` (enum, 9 values), `custom_prompt?`, `difficulty?` (quiz/flashcards), `timeout_ms?`, `wait_for_completion?`, session/notebook selectors, `show_browser?` | Mirrors `generate_audio`'s async-by-default contract |
| `get_studio_output_status` | `output_type`, session/notebook selectors | |
| `download_studio_output` | `output_type` (file kinds only), `destination_dir`, session/notebook selectors | Errors clearly if called on a structured-kind type |
| `get_studio_output_content` | `output_type` (structured kinds only), session/notebook selectors | Returns `structuredContent` (see §3.4) |

`generate_audio` / `get_audio_status` / `download_audio` remain as-is (deprecated-but-supported aliases delegating to the engine with `output_type: "audio"`), so existing configs/scripts referencing them by name keep working.

**Sources:**
- `list_sources` — enumerate current notebook's sources (id/title/type).
- `remove_source` — by source id.
- `add_source` extended with `type: "file"` (local path, Playwright `setInputFiles`). Whether YouTube/Drive links need a distinct `type` vs. already being handled by the existing `type: "url"` path is a DOM-verification item during implementation (Studio panel's "Discover"/paste-link flow may already auto-detect them) — not asserted here as fact.

**Research:**
- `research_sources` — `mode: "web_fast" | "drive_fast" | "web_deep"`, `query`. Fast modes return a discovered-source list (JSON, not added to the notebook until the caller decides); `web_deep` triggers the synthesized-report flow and follows the same generate/status shape as a Studio output (may reuse the engine's async pattern rather than inventing a new one — implementation detail).

**Notes:**
- `save_note` — text + optional title.
- `note_to_source` — promote a saved note into a real source.

**Chat config:**
- `configure_chat` — set the notebook's custom instructions.
- `delete_chat_history` vs. existing `reset_session`: implementation must first confirm (by inspecting the live DOM) whether these are the same underlying action (`reset_session` already reloads the page, which clears visible chat). If identical, no new tool is added — `reset_session`'s description is updated to document the equivalence instead. This avoids shipping a redundant tool.

### 3.3 Protocol robustness

- **Prompts (fix the dead reference):** implement `ListPromptsRequestSchema` + `GetPromptRequestSchema` in `resource-handlers.ts` (or a new `src/prompts/prompt-handlers.ts` if that keeps the file focused — implementation's call within the existing module-boundary conventions). At minimum: `notebooklm.auth-setup`, `notebooklm.auth-repair` (the two already referenced by name in tool descriptions). Add `notebooklm.studio-workflow` as a third if it earns its place (explains the generate→poll→download/content chain for the new Studio tools) — do not add prompts speculatively beyond what tool descriptions actually reference.
- **Resource change notifications:** `NotebookLibrary` mutations (`add`, `update`, `remove`, `select`) call a new `notifyChanged()` hook that the server wires to `server.notification({method: "notifications/resources/list_changed"})`. Declare `resources: { listChanged: true }` in server capabilities once implemented (not before — capabilities must match reality, which is exactly the bug being fixed for `prompts`).
- **Structured content:** tools with a well-defined, stable result shape (`get_health`, `get_library_stats`, `list_sessions`, `list_sources`, `get_studio_output_status`, `get_studio_output_content`) get an `outputSchema` on their `Tool` definition and a `structuredContent` field alongside the existing `content` text block in their results (additive — existing text-block consumers are unaffected).
- **Elicitation:** `add_notebook` and `cleanup_data`'s confirmation step gains an elicitation path (`server.elicitInput` equivalent in SDK 1.30) used when the connected client declares elicitation capability; the existing `confirm: boolean` parameter remains as the fallback for clients that don't. Negotiated, not a breaking change.
- **Tool annotations:** every new tool gets `annotations` (readOnlyHint/destructiveHint/idempotentHint/openWorldHint) following the existing per-tool convention — audited for consistency across old + new tools as part of this work, not introduced fresh.
- **Explicitly not doing:** sampling (no genuine use case — NotebookLM's own Gemini already does the synthesis this server exposes), full interactive mind-map branch-click-to-chat traversal (node/edge extraction only, not a live sub-chat session).

### 3.4 Optimization pass

- `src/index.ts`: replace the `switch` in the `CallToolRequestSchema` handler with a `Map<string, (args, sendProgress) => Promise<unknown>>` built once in the constructor alongside `toolDefinitions`. Same dispatch semantics, no behavior change, removes the multiply-by-9 problem the additive approach would have created.
- `src/session/browser-session.ts`: extract the duplicated closed-page/context recovery try/catch (currently copy-pasted in `ask()` and `reset()`) into a private `withRecovery<T>(label: string, fn: () => Promise<T>): Promise<T>` used by both, and by any new pass-through methods this design adds (e.g. `getStudioOutputContent`).
- Studio engine consolidation (§3.1) is itself the main optimization: one maintained module instead of nine near-duplicates.
- Parameterized tool surface (§3.2) keeps the tool-list token cost roughly flat despite ~9x the Studio coverage, instead of growing 5-6x.
- Verification sweep: confirm every new `setInterval`/`setTimeout` is `.unref()`'d (existing `session-manager.ts` cleanup interval already is — pattern to match) and every new poll loop uses `page.waitForSelector`/`page.waitForEvent` over manual sleep-loops (existing `audio.ts` already does this correctly — pattern to match, not to invent).

## 4. Error handling

Reuse existing `RateLimitError` / `AuthenticationError` (`src/errors.ts`) and the `isRecoverable`/`pageIsAlive` watchdog primitives for all new code paths. No new error classes unless implementation surfaces a genuinely new failure category not covered by "recoverable browser/context loss" or "rate limited" — default to a plain `Error` with a clear message, matching `audio.ts`'s existing convention.

## 5. Verification plan

Standard risk (local dev tool, no client-facing deliverable) — per policy this needs deterministic checks, not a mandatory fresh reviewer.

- `npm run check` (prettier:check + eslint + tsc build) must pass — the only deterministic gate this codebase has.
- Manual smoke test against the user's real NotebookLM account (no mocking exists for the DOM layer today, matching upstream's own testing approach):
  - One full Studio-output round trip end-to-end (a file kind, e.g. `report` or `video`, plus a structured kind, e.g. `mindmap` or `quiz`).
  - `list_sources` against a real notebook.
  - A `prompts/get` call against `notebooklm.auth-setup` to confirm the dead-reference bug is actually fixed.
  - A `resources/list` after `add_notebook` to confirm the `list_changed` notification fires (observed via the calling client, or a minimal manual JSON-RPC probe over the HTTP transport if easier).
- Regression check: existing `ask_question`, `generate_audio`/`get_audio_status`/`download_audio`, `list_notebooks`/`select_notebook` must keep working unchanged after the dispatch-map and recovery-helper refactors — these touch shared code paths.

## 6. Out of scope

- Upstream PR / contribution back to `PleasePrompto/notebooklm-mcp`.
- Changes to the authentication mechanism (cookie-based persistent Chrome profile stays as-is).
- MCP `sampling` capability.
- Full interactive mind-map traversal (click-branch-to-chat).
- Multi-account or HTTP-transport changes — untouched by this design.
