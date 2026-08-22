# notebooklm-mcp: full-feature + protocol + efficiency upgrade

Date: 2026-08-22 (revised same day after independent Fable review — see §0)
Base: local fork of `PleasePrompto/notebooklm-mcp`, upstream commit `50b3e7f` (v2.0.0), cloned to this repo.
Delivery: **local fork only**. No upstream PR. The user's Claude Code `notebooklm` MCP entry will be repointed from `npx notebooklm-mcp@latest` to `node <fork>/dist/index.js` once the build is verified.

## 0. Independent review — verdict: APPROVE WITH CHANGES

A fresh Fable agent reviewed this spec against the actual source (not just the prose) and confirmed every factual claim in §2, then required 7 changes, all folded into this revision:

1. Tile-discrimination and concurrent-generation attribution added as explicit engine requirements (§3.1) — the existing audio selectors match *any* artifact tile, which is safe today only because audio is the sole output type.
2. `download_studio_output`/`get_studio_output_content` now enum-restrict `output_type` to their respective kind subsets in the JSON schema itself, not just at runtime (§3.2).
3. `logging: {}` and `resourceTemplates: {}` folded into the capabilities-must-match-reality fix alongside `prompts` (§3.3) — `resourceTemplates` isn't a valid top-level MCP capability key (templates live under `resources`), and `logging` has no backing handler either.
4. Elicitation corrected to `cleanup_data` + `remove_notebook` — `add_notebook` has no `confirm` parameter today (§3.3).
5. The Studio-output config table is now specified as a strategy registry (per-type hook functions), not static declarative data, because the 4 structured kinds need multi-step interaction, not a one-shot DOM read (§3.1).
6. SDK version floor must be verified at `npm install` time, not assumed (§3.5, new).
7. Delivery is explicitly phased — Phase 1 (this plan) builds the protocol fixes, refactors, and the engine verified end-to-end for audio plus 2 additional output types; the remaining 6 output types and the source/notes/research/chat-config tools are Phase 2, gated on live DOM reconnaissance (§5).

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
- **Bug (confirmed by independent review)**: server capabilities declare `prompts: {}` (`index.ts:163`), and `ask-question.ts`'s tool description instructs the calling LLM to invoke prompts named `notebooklm.auth-setup` and `notebooklm.auth-repair` (`ask-question.ts:23,39,108`) — but no `ListPromptsRequestSchema`/`GetPromptRequestSchema` handler exists anywhere in the codebase. Any client that follows the embedded instruction gets a JSON-RPC -32601.
- **Two more dead/malformed capabilities (found on review, not in the original draft)**: `logging: {}` (`index.ts:165`) has no `SetLevelRequestSchema` handler and the server never calls `sendLoggingMessage` — same "declared but not backed" bug as prompts. `resourceTemplates: {}` (`index.ts:162`) is not a valid top-level MCP capability key at all — resource templates are advertised as part of the `resources` capability, not a sibling of it.
- **Tile-discrimination gap (found on review)**: `Selectors.studio.audioPlayer` (`selectors.ts:304-310`) includes a fallback that matches *any* `artifact-library-item`, and `audioMoreMenuButton` (`selectors.ts:315-325`) opens the menu on the *first* such tile. This is safe today only because Audio Overview is the sole Studio output the server drives. The moment a second output type can be generated in the same notebook, `audioIsReady`/`downloadAudioOverview` can match the wrong tile, and the panel-wide in-progress phrase scan (`audio.ts:205-218`) can't attribute a spinner to a specific type when two generations run concurrently. This is a hard requirement for the new engine, not an implementation nicety — without it, adding new Studio outputs actively regresses the currently-working audio path.
- `src/resources/resource-handlers.ts` implements `resources/list`, `resources/templates/list`, `resources/read`, and `completion/complete` (for the `notebooklm://library/{id}` template) — solid, but no `resources/subscribe` and no `notifications/resources/list_changed` when the library actually changes (add/update/remove/select notebook all mutate `NotebookLibrary` silently).
- No tool returns `structuredContent`; every result is a JSON string inside one `content: [{type:"text"}]` block. No tool declares `outputSchema`.
- `selectors.ts` is a well-built locale-agnostic registry (class name → Material icon → role → locale aria-label fallback chain, covering 8 locales) — the new Studio-output selectors should follow this exact convention, not invent a new one.
- `@modelcontextprotocol/sdk` is pinned `^1.0.0`; latest on npm is `1.30.0`, which supports structured content, elicitation, and everything else in this design.
- No real test suite — `npm test` just boots the server (`tsx src/index.ts`). `npm run check` (prettier check + eslint + tsc build) is the only deterministic gate.

## 3. Architecture

### 3.1 Studio-output engine (replaces "add 8 files like audio.ts")

New `src/notebooklm/studio-outputs.ts`:

- A `StudioOutputType` union: `"audio" | "video" | "report" | "slides" | "infographic" | "mindmap" | "datatable" | "quiz" | "flashcards"`.
- **Strategy registry, not static config.** A `STUDIO_OUTPUT_STRATEGIES: Record<StudioOutputType, StudioOutputStrategy>` table where each entry carries *functions*, not just selector data: `trigger(page, opts)`, `isReady(page, tileRef)`, `isInProgress(page)`, and either `download(page, tileRef, destDir)` (file kinds) or `extractContent(page, tileRef)` returning JSON (structured kinds — mind-map node/edge list, data-table rows, quiz question/answer pairs, flashcard front/back pairs). This matters because the 4 structured kinds need real multi-step interaction (mind-map branch expansion, quiz/flashcard reveal-then-read cycles), not a one-shot DOM read — declarative selector data alone can't express that. Structured kinds may also declare an optional `downloadFallback` (e.g. mind map as an exported image) for when live extraction proves brittle.
- **Tile discrimination is a hard requirement, not an implementation detail.** Every strategy's `isReady`/`isInProgress`/tile-lookup must resolve to a tile *scoped to that specific output type* (and, where NotebookLM allows multiple artifacts of the same type, a specific instance) — never "the first/any `artifact-library-item`" the way the current `audioPlayer`/`audioMoreMenuButton` fallback selectors do. The in-progress phrase scan must be scoped per-type-tile, not panel-wide, so two concurrent generations don't cross-attribute their status.
- Generic functions built on the registry: `generateStudioOutput(page, type, options)`, `getStudioOutputStatus(page, type)`, `downloadStudioOutput(page, type, destDir)` (file kinds only), `getStudioOutputContent(page, type)` (structured kinds only). All reuse `safeSleep`/`isRecoverable`/`pageIsAlive` from `browser/watchdog.ts` and the `clickFirstVisible`/`ensureStudioPanelExpanded` helpers lifted out of `audio.ts` into this shared module.
- `audio.ts`'s existing exported functions become thin wrappers calling into the engine with `type: "audio"` pinned, **and audio's own selectors must be tightened to type-scoped tile matching as part of this work** — routing audio through the new engine without fixing its tile discrimination first would mean the "no regression" claim in §5 is false the moment a second output type exists. This is the one piece of the refactor that actively touches currently-working, in-production behavior, so it gets its own regression check in §5.

### 3.2 Tool surface

**Studio (4 new tools, replacing what an additive approach would need ~24-32 tools for):**

| Tool | Params | Notes |
|---|---|---|
| `generate_studio_output` | `output_type` (enum, all 9 values), `custom_prompt?`, `difficulty?` (quiz/flashcards), `timeout_ms?`, `wait_for_completion?`, session/notebook selectors, `show_browser?` | Mirrors `generate_audio`'s async-by-default contract |
| `get_studio_output_status` | `output_type` (enum, all 9 values), session/notebook selectors | |
| `download_studio_output` | `output_type` (enum restricted to the 5 file kinds: audio/video/report/slides/infographic), `destination_dir`, session/notebook selectors | Enum is restricted **in the JSON schema itself**, not just checked at runtime — a host LLM sees only valid choices instead of guessing. Runtime validation stays as a backstop, not the primary guard. |
| `get_studio_output_content` | `output_type` (enum restricted to the 4 structured kinds: mindmap/datatable/quiz/flashcards), session/notebook selectors | Same enum-restriction approach. Returns `structuredContent` (see §3.3) |

`generate_audio` / `get_audio_status` / `download_audio` remain as-is (deprecated-but-supported aliases delegating to the engine with `output_type: "audio"`), so existing configs/scripts referencing them by name keep working.

**Tool profiles.** `src/utils/settings-manager.ts` has fixed `minimal`/`standard` allowlists — new tools are invisible under those profiles unless explicitly added. Default: add all new tools to `full` only; do not add any to `minimal`/`standard` unless a specific one earns it (e.g. `get_studio_output_status` might belong in `standard` alongside the existing session tools) — a deliberate per-tool call during implementation, not a blanket addition.

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

- **Capabilities must match reality — three fixes, not one:**
  1. **Prompts (fix the dead reference):** implement `ListPromptsRequestSchema` + `GetPromptRequestSchema` in `resource-handlers.ts` (or a new `src/prompts/prompt-handlers.ts` if that keeps the file focused). At minimum: `notebooklm.auth-setup`, `notebooklm.auth-repair` — the two already referenced by name in `ask-question.ts`. Their actual prompt *content* needs authoring, not just an empty registration: `auth-setup` should walk the caller through `setup_auth` → verify via `get_health`; `auth-repair` through `re_auth` → verify via `get_health`. Add `notebooklm.studio-workflow` as a third only if it earns its place (explains the generate→poll→download/content chain for the new Studio tools) — no speculative prompts beyond what tool descriptions actually reference.
  2. **`logging: {}`** — either implement `SetLevelRequestSchema` and actually call `sendLoggingMessage` somewhere, or drop the declared capability if this pass isn't going to exercise it. Don't leave it declared-but-dead like `prompts` was.
  3. **`resourceTemplates: {}`** — remove as a standalone capability key; resource templates are part of the `resources` capability in the MCP spec, not a sibling of it. Fold the existing `ListResourceTemplatesRequestSchema` handler under the corrected `resources` capability declaration.
- **Resource change notifications:** `NotebookLibrary` mutations (`add`, `update`, `remove`, `select`) call a new `notifyChanged()` hook. Use the SDK's `server.sendResourceListChanged()` helper if the installed SDK version exposes it (verify during implementation — fall back to a raw `server.notification({method: "notifications/resources/list_changed"})` only if it doesn't). Declare `resources: { listChanged: true }` once implemented, not before.
- **Structured content:** tools with a well-defined, stable result shape (`get_health`, `get_library_stats`, `list_sessions`, `list_sources`, `get_studio_output_status`, `get_studio_output_content`) get an `outputSchema` on their `Tool` definition and a `structuredContent` field alongside the existing `content` text block (additive — existing text-block consumers are unaffected). Caveat from review: clients that understand `outputSchema` *validate* `structuredContent` against it and fail the call on mismatch — keep the initial set narrow and genuinely stable, and never attach `structuredContent` to an error result.
- **Elicitation:** the confirmation step on `cleanup_data` (which already has a `confirm: boolean` param, `handlers.ts:843,866-878`) and on `remove_notebook` (currently prose-only self-confirmation in its tool description, `notebook-management.ts:160,212` — a destructive action, unlike `add_notebook` which is additive and was wrongly listed here in the first draft) gains an elicitation path used when the connected client declares elicitation capability; the existing/new `confirm` parameter remains as the fallback for clients that don't. Negotiated, not a breaking change. `add_notebook` is dropped from this list — it has no `confirm` param today and low-risk additive actions don't need mid-call elicitation.
- **Tool annotations:** every new tool gets `annotations` (readOnlyHint/destructiveHint/idempotentHint/openWorldHint) following the existing per-tool convention — audited for consistency across old + new tools as part of this work, not introduced fresh.
- **Explicitly not doing:** sampling (no genuine use case — NotebookLM's own Gemini already does the synthesis this server exposes), full interactive mind-map branch-click-to-chat traversal (node/edge extraction only, not a live sub-chat session).

### 3.5 Dependency floor

`@modelcontextprotocol/sdk` is currently pinned `^1.0.0` and `node_modules` isn't installed in this fork yet — do not assume a specific resolved version. During implementation, run `npm install`, confirm the resolved version actually exposes `elicitInput`, `structuredContent`/`outputSchema` support, and `sendResourceListChanged`, and bump the declared floor in `package.json` (e.g. `^1.x.0` at whatever minimum genuinely has them) rather than leaving `^1.0.0` and hoping.

### 3.4 Optimization pass

- `src/index.ts`: replace the `switch` in the `CallToolRequestSchema` handler with a `Map<string, (args, sendProgress) => Promise<unknown>>` built once in the constructor alongside `toolDefinitions`. Same dispatch semantics, no behavior change, removes the multiply-by-9 problem the additive approach would have created.
- `src/session/browser-session.ts`: extract the duplicated closed-page/context recovery try/catch (currently copy-pasted in `ask()` and `reset()`) into a private `withRecovery<T>(label: string, fn: () => Promise<T>): Promise<T>` used by both, and by any new pass-through methods this design adds (e.g. `getStudioOutputContent`).
- Studio engine consolidation (§3.1) is itself the main optimization: one maintained module instead of nine near-duplicates.
- Parameterized tool surface (§3.2) keeps the tool-list token cost roughly flat despite ~9x the Studio coverage, instead of growing 5-6x.
- Verification sweep: confirm every new `setInterval`/`setTimeout` is `.unref()`'d (existing `session-manager.ts` cleanup interval already is — pattern to match) and every new poll loop uses `page.waitForSelector`/`page.waitForEvent` over manual sleep-loops (existing `audio.ts` already does this correctly — pattern to match, not to invent).

## 4. Error handling

Reuse existing `RateLimitError` / `AuthenticationError` (`src/errors.ts`) and the `isRecoverable`/`pageIsAlive` watchdog primitives for all new code paths. No new error classes unless implementation surfaces a genuinely new failure category not covered by "recoverable browser/context loss" or "rate limited" — default to a plain `Error` with a clear message, matching `audio.ts`'s existing convention.

## 5. Phased delivery and verification plan

Independent review's strongest point: selector discovery against the live Studio panel for 8 previously-unwrapped output types (plus source/notes/research/chat-config flows) is the bulk of the actual risk and effort here, and it can only be done incrementally against the real DOM. Claiming a full 9-type smoke test upfront would overstate what a single implementation pass can respons­ibly verify. Delivery is therefore split:

### Phase 1 (this plan — implement now)

- All of §3.3's protocol fixes (prompts, `logging`/`resourceTemplates` capability correction, `resources.listChanged`, structured content on the narrow stable set, elicitation on `cleanup_data`/`remove_notebook`).
- The `index.ts` dispatch-map and `browser-session.ts` `withRecovery()` refactors (§3.4).
- The Studio-output engine (§3.1), built and DOM-verified end-to-end for: **`audio`** (regression-proofed with tightened, type-scoped selectors — not just re-wrapped) plus **two more output types**, one file kind and one structured kind, chosen during implementation for whichever has the most stable/discoverable selectors on first DOM recon (candidates: `report` for file kind, `quiz` or `flashcards` for structured kind — Mind Map is deliberately not a first-wave pick given its extra branch-expansion interaction complexity noted in §3.1).
- Tool surface for all 9 `output_type` values is registered (enum-complete per §3.2) even though only 3 types are DOM-verified — the other 6 return a clear "not yet implemented for this type" error rather than silently failing, so the surface is honest about Phase 1 vs Phase 2 coverage.

### Phase 2 (follow-on, explicitly deferred — not cut, not blocking Phase 1 "done")

- DOM implementation for the remaining 6 Studio output types.
- Source management extensions (`list_sources`/`remove_source`/file-type `add_source`), research tools, notes tools, chat-config tools — each needs its own live DOM reconnaissance pass.
- Each Phase 2 item follows the same pattern established in Phase 1: strategy-registry entry (or new small module) + DOM verification against the real account before being called done.

### Verification (Phase 1)

Standard risk (local dev tool, no client-facing deliverable) — per policy this needs deterministic checks, not a mandatory fresh reviewer.

- `npm run check` (prettier:check + eslint + tsc build) must pass — the only deterministic gate this codebase has.
- Manual smoke test against the user's real NotebookLM account (no mocking exists for the DOM layer today, matching upstream's own testing approach):
  - Full round trip for the 2 non-audio Studio output types actually built in Phase 1 (one file-kind download, one structured-kind content extraction).
  - Audio Overview regression check specifically: `generate_audio`/`get_audio_status`/`download_audio` still work end-to-end after being routed through the tightened, type-scoped engine — this is the one path where a real behavior change was made, not just a wrapper.
  - `list_sources` is Phase 2 — not smoke-tested in Phase 1 (not built yet).
  - A `prompts/get` call against `notebooklm.auth-setup` to confirm the dead-reference bug is actually fixed.
  - Observe a `notifications/resources/list_changed` notification (via the calling client, or a minimal manual JSON-RPC probe over the HTTP transport) after `add_notebook`.
- Regression check: existing `ask_question`, `list_notebooks`/`select_notebook`, and every other pre-existing tool must keep working unchanged after the dispatch-map and recovery-helper refactors — these touch shared code paths even though their own logic isn't changing.

## 6. Out of scope

These are never-doing items, distinct from the Phase 2 list in §5 (which is deferred, not cut):

- Upstream PR / contribution back to `PleasePrompto/notebooklm-mcp`.
- Changes to the authentication mechanism (cookie-based persistent Chrome profile stays as-is).
- MCP `sampling` capability.
- Full interactive mind-map traversal (click-branch-to-chat).
- Multi-account or HTTP-transport changes — untouched by this design.
