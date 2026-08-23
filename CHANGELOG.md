# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Fork of upstream v2.0.0. A multi-agent review pass over the whole server, the
generic Studio-output engine, and a move to **MCP protocol revision
2026-07-28**. Not published to npm — the `notebooklm-mcp` package on npm is
upstream and contains none of this.

### Added

- **MCP protocol revision 2026-07-28** — the stateless revision: no
  `initialize` handshake, no `Mcp-Session-Id`, a per-request `_meta` envelope
  carrying the protocol version and client capabilities, a mandatory
  `server/discover`, and `resultType`/`ttlMs`/`cacheScope` on results. The
  server is **dual-era**: 2025-06-18 clients keep working unchanged. Moved to
  `@modelcontextprotocol/server` 2.0.0; the entry point (`serveStdio` for
  stdio, `createMcpHandler` for HTTP) is what selects the era — upgrading the
  package alone puts no 2026-07-28 byte on the wire. Confirmation prompts
  became the multi-round-trip `inputRequired` return, which the SDK's legacy
  shim still serves to 2025-era clients as a real elicitation request. Full
  write-up, including the fail-open trap it exposed, in
  `MIGRATION-2026-07-28.md`.

- **Generic Studio-output tools**: `generate_studio_output`,
  `get_studio_output_status`, `download_studio_output`,
  `get_studio_output_content` cover all 9 `StudioOutputType` values by schema.
  Eight are backed by live-verified strategies — `audio`, `video`,
  `infographic`, `slides` (file kinds) and `mindmap`, `datatable`, `quiz`,
  `flashcards` (structured kinds). Only `report` returns a clear "not yet
  implemented (Phase 2)" error. `generate_audio` / `get_audio_status` /
  `download_audio` remain backward-compatible aliases for `output_type:
  "audio"`.
- **`discover_notebooks`**: registers every notebook on the account's
  dashboard, including ones created in the web UI that `add_notebook` can
  never see because it only stores the URL it is handed. Dedupes by notebook
  UUID, so re-running is safe.
- **Argument validation against each tool's `inputSchema`** before dispatch.
  The low-level `Server` does not validate, so every published `required`
  array was advisory: `add_notebook` accepted a call with no
  `description`/`topics` and wrote a half-empty library entry, and
  `get_studio_output_status` read `args.output_type` outside its own
  try/catch and surfaced a raw `TypeError`. Unknown extra properties are
  still tolerated.
- **`data.session_id` on every browser-touching tool** (`add_source`, the
  three audio tools, the four Studio tools). These create a session when none
  is passed; it was previously invisible to the caller and leaked until the
  idle timeout. Callers can now `close_session` it or reuse it.
- **`sources_note` and `session_note` on `ask_question`** — a requested
  citation format that produced nothing, and a supplied `session_id` that was
  not a live session (so a new session answered, carrying no prior context).
  Both cases used to be silent.
- **The two prompts the server advertised**, `notebooklm.auth-setup` and
  `notebooklm.auth-repair`. The `prompts: {}` capability was declared and tool
  descriptions pointed at them, but no `ListPromptsRequestSchema` /
  `GetPromptRequestSchema` handler was ever registered, so calling either
  failed.
- **`structuredContent` / `outputSchema`** on tool results that declare an
  output schema, with `isError` set correctly on failure.

### Changed

- **Profile filtering applies to `tools/call`, not only `tools/list`.** Tools
  hidden by the active profile or by `disabled-tools` stayed fully callable by
  name, which made the setting cosmetic. Both a hidden and an unknown tool name
  now return a JSON-RPC `MethodNotFound` error rather than a success-shaped
  failure payload. `setup_auth` is in every profile, including `minimal` —
  without it an unauthenticated user cannot authenticate at all.
- **`setup_auth` is annotated `destructiveHint: true`** and documented as
  blocking (up to 10 minutes). It closes live sessions and replaces the Chrome
  profile; `destructiveHint: false` told hosts that gate destructive tools the
  opposite of the truth.
- **`cleanup_data` deletion is confined to an allow-list** of this server's own
  directories, checked both at enumeration and again immediately before each
  recursive delete. It no longer touches the MCP client's project/session
  directories (`~/.claude/projects/*` — irreplaceable transcripts whose
  directory names matched the old `*notebooklm-mcp*` glob) or the OS Trash
  (unrecoverable, and not this server's data). Categories flagged `optional`
  are skipped unless explicitly requested; they previously logged a warning and
  deleted anyway, so opting out was impossible.
- **`report` is classified honestly** as neither a file nor a structured kind.
  It was listed as a file kind; its menu offers "Export to Docs"/"Export to
  Sheets" with no browser download at all.
- **Declared MCP capabilities corrected**: dropped the invalid
  `resourceTemplates` sibling key (resource templates belong to the `resources`
  capability per spec), dropped the unbacked `logging` declaration, and added
  `resources: { listChanged: true }` with `resources/list_changed` sent only on
  a genuine list change — a notebook added, removed, or renamed — rather than on
  every library write, including the `use_count` bump on every `ask_question`.
- **Tool dispatch** moved from a large switch statement to a handler map, with
  a shared `withRecovery()` helper in `BrowserSession` behind `ask_question`,
  `reset_session`, and every audio/Studio call.
- **Documentation** rewritten against the code: real return shapes for every
  tool, the true tool count (25), a consistent account of Studio-output status,
  `notebook.google.com` as the current domain (legacy host noted as accepted),
  the full HTTP route list with its lack of authentication stated plainly, and a
  prominent note that the published npm package is upstream and does not contain
  this fork's work.

### Fixed

- **Audio generation actually starts.** The trigger tile always opens a
  "Customize Audio Overview" dialog; the bare click stopped there, so
  generation had likely never started via this server despite the tool
  reporting `status: "started"`.
- **Downloads actually land.** Clicking "Download" opens a new popup page and
  the browser `download` event fires there, not on the original page — the old
  code listened on the wrong page and timed out after 60 s even though the click
  had succeeded.
- **A follow-up question stays on its own session's notebook.**
  `ask_question({ session_id })` with no explicit notebook resolved to whatever
  notebook was active, and a differing URL makes `getOrCreateSession` retarget:
  it closed the caller's session and answered from different sources while still
  reporting success. Reproduced live across two notebooks.
- **A stale `session_id` is no longer hidden.** Creating a fresh session
  silently looked like a successful follow-up with the conversational context
  gone.
- **An errored status probe reports failure.** `get_audio_status` /
  `get_studio_output_status` returned `success: true` for an engine error,
  hiding a missing Studio panel or a stale viewer behind what looked like a
  clean `not_started`.
- **Citation markers are polled for.** They mount a beat after the answer text
  settles, so a single read taken the moment the text stabilised found nothing
  and reported "no sources" for answers that plainly had them.
- **Structured-kind extraction signals partial reads** instead of returning
  silently-wrong data: an `incomplete` marker on a mindmap node whose captured
  children fall short of its declared count, `missingPositions` on quiz and
  flashcards. Quiz options are read from the DOM, never clicked — clicking an
  answer would record it server-side.
- **The HTTP transport supports concurrent sessions.** The SDK binds a `Server`
  to exactly one transport, so sharing one instance made the second concurrent
  client fail with "already connected" and receive a 500. Each session now gets
  its own `Server`; the managers stay shared.
- **Progress notifications fire.** The progress token was read from
  `arguments._meta.progressToken`, which no compliant client populates — a live
  run recorded zero notifications across a 26-second `ask_question`. It is read
  from `params._meta` now, with the old location kept as a fallback.
- **Per-call browser options can no longer corrupt the global config
  permanently.** The snapshot/restore pattern let one overlapping call restore
  another's mutated config, so a single `show_browser: true` could leave the
  server headed — or, with stealth disabled, permanently unstealthed — for the
  rest of the process.
- **A stdio client disconnect shuts the server down.** A client that goes away
  closes the pipe without sending a signal, so the server and its Chrome
  survived as orphans after every client restart or `/mcp` reconnect.
- **A caller-supplied `timeout_ms` of `0` no longer pins a session forever.**
  It was passed straight into `locator.waitFor({ timeout: 0 })`, which
  Playwright reads as "no timeout at all". Zero, negatives, `NaN`, `Infinity`
  and non-numbers all mean "use the default" now, and any value is capped at
  30 minutes.
- **A malformed `library.json` is quarantined** rather than silently replaced,
  unknown top-level keys round-trip, and notebooks dedupe by the UUID parsed
  from the URL — so the same notebook cannot register twice under two hosts or
  with different query strings.
- **A typo'd profile in `settings.json`** falls back to `full` with a warning
  instead of crashing the first `tools/list` with "Cannot read properties of
  undefined".
- **`package.json`'s `files` array** no longer lists `NOTEBOOKLM_USAGE.md`,
  which does not exist in the repository.

## [2.0.0] - 2026-04-30

Major release that closes the issue backlog and replaces the brittle parts of
the v1.x extraction stack with a single source of truth. v1 is no longer
supported.

### Added

- **Streamable-HTTP transport** (`--transport http --port 3000`) using the
  MCP SDK's `StreamableHTTPServerTransport`. Supports the spec's session
  header model so multiple clients can share one server. Closes #4 / #7.
- **`add_source` tool** for programmatic source ingestion (URL or pasted text,
  with auto-confirmed insertion and source-count verification). Closes #25.
- **Audio Overview tools**: `generate_audio` + `download_audio`. Audio is the
  most-asked Studio output; Video / Infographic / Slides are tracked for a
  follow-up. Closes #11 (audio scope).
- **Citations on `ask_question`**: new `source_format` argument (`none`,
  `inline`, `footnotes`, `json`) populates a structured `sources[]` field
  by reading the DOM citation panel after the answer settles. Closes #20.
- **Multi-account support** via `--account <name>` / `NOTEBOOKLM_ACCOUNT`.
  Each account gets an isolated Chrome profile under
  `~/.local/share/notebooklm-mcp/accounts/<name>/`. No credential storage —
  authentication is still handled by Chrome's persistent profile. Closes #2.
- **Bundled-Chromium fallback** (`BROWSER_CHANNEL=chromium` /
  `NOTEBOOKLM_BROWSER_CHANNEL=chromium`). Used automatically when system
  Chrome refuses to launch. Closes #13 (macOS Tahoe), #19 (Windows exit 21).
- **`ANSWER_TIMEOUT_MS`** env var + `browser_options.timeout_ms` parameter
  to override the answer wait. Default raised to 600 s. Closes #14, #27.
- **Provenance envelope** on `ask_question` results: `_provenance` field +
  AI-generated marker prefix (`NOTEBOOKLM_AI_MARKER=false` to opt out).
  Closes #42.

### Changed

- **Streaming-stability answer detection** replaces the broken
  `div.thinking-message` poll. Answers settle when the text is identical
  across N consecutive 750 ms polls. Robust against the 2026 NotebookLM UI
  changes that broke v1.x. Closes #43.
- **`FOLLOW_UP_REMINDER` is opt-in** via `NOTEBOOKLM_FOLLOW_UP_REMINDER=true`.
  The previous default tripped prompt-injection guards on safety-trained
  host agents. Closes #28.
- **Selector registry** (`src/notebooklm/selectors.ts`) is now the single
  source of truth for every CSS / aria selector targeting NotebookLM. UI
  changes from Google now require touching exactly one file.
- **Browser-launch lifecycle** moved into a dedicated module with profile
  strategy fallback (`auto` → isolated profile when the base profile is
  locked) and aggressive shutdown watchdog. Closes #29.
- **Watchdog poll loop**: bounded poll count + Node-side sleep fallback +
  periodic `page.evaluate(() => true)` health check. Defuses zombie tabs
  that previously turned the answer wait into a 100 % CPU spin. Closes #16.
- **Resource error message** for unknown URIs now lists the supported set
  (`notebooklm://library`, `notebooklm://library/{id}`, `notebooklm://metadata`).
  Closes #15.
- **Library metadata accessors** in `src/library/metadata.ts` defend against
  notebooks loaded from disk that omit `topics`/`use_cases`/`content_types`.
  Replaces the bare `.join()` / `.map()` calls that crashed
  `buildAskQuestionDescription`. Closes #33.

### Tooling

- ESLint flat config + Prettier added with `npm run lint`, `npm run format`,
  `npm run check`. Build is now type-safe with no `any` casts and DOM types
  enabled for in-page evaluations.
- TypeScript `lib` widened to `["ES2022", "DOM", "DOM.Iterable"]`.
- New tools registered in MCP profile: `add_source`, `generate_audio`,
  `download_audio` (full profile only by default).

### Removed

- Hard-coded `120 000 ms` answer timeout in `BrowserSession.ask`.
- Unused `ServerState` interface and the dead `as any` chain across
  resource handlers, browser session, shared-context manager, and the
  config env-override path.
- Reliance on `div.thinking-message` for answer completion.

### Migration Notes

- v1 callers that depended on the old answer prefix should set
  `NOTEBOOKLM_AI_MARKER=false` if they want the unprefixed answer back.
- v1 callers that depended on the appended follow-up reminder must opt in
  via `NOTEBOOKLM_FOLLOW_UP_REMINDER=true`.
- The default answer timeout grew from 120 s to 600 s. Lower it explicitly
  via `ANSWER_TIMEOUT_MS` if you relied on the 2-minute ceiling for
  fail-fast behaviour.

## [1.2.0] - 2025-11-21

### Added
- **Tool Profiles System** - Reduce token usage by loading only the tools you need
  - Three profiles: `minimal` (5 tools), `standard` (10 tools), `full` (16 tools)
  - Persistent configuration via `~/.config/notebooklm-mcp/settings.json`
  - Environment variable overrides: `NOTEBOOKLM_PROFILE`, `NOTEBOOKLM_DISABLED_TOOLS`

- **CLI Configuration Commands** - Easy profile management without editing files
  - `npx notebooklm-mcp config get` - Show current configuration
  - `npx notebooklm-mcp config set profile <name>` - Set profile (minimal/standard/full)
  - `npx notebooklm-mcp config set disabled-tools <list>` - Disable specific tools
  - `npx notebooklm-mcp config reset` - Reset to defaults

### Changed
- **Modularized Codebase** - Improved maintainability and code organization
  - Split monolithic `src/tools/index.ts` into `definitions.ts` and `handlers.ts`
  - Extracted resource handling into dedicated `ResourceHandlers` class
  - Cleaner separation of concerns throughout the codebase

### Fixed
- **LibreChat Compatibility** - Fixed "Server does not support completions" error
  - Added `prompts: {}` and `logging: {}` to server capabilities
  - Resolves GitHub Issue #3 for LibreChat integration

- **Thinking Message Detection** - Fixed incomplete answers showing placeholder text
  - Now waits for `div.thinking-message` element to disappear before reading answer
  - Removed unreliable text-based placeholder detection (`PLACEHOLDER_SNIPPETS`)
  - Answers like "Reviewing the content..." or "Looking for answers..." no longer returned prematurely
  - Works reliably across all languages and NotebookLM UI changes

## [1.1.2] - 2025-10-19

### Changed
- **README Documentation** - Added Claude Code Skill reference
  - New badge linking to [notebooklm-skill](https://github.com/PleasePrompto/notebooklm-skill) repository
  - Added prominent callout section explaining Claude Code Skill availability
  - Clarified differences between MCP server and Skill implementations
  - Added navigation link to Skill repository in top menu
  - Both implementations use the same browser automation technology

## [1.1.1] - 2025-10-18

### Fixed
- **Binary executable permissions** - Fixed "Permission denied" error when running via npx
  - Added `postbuild` script that automatically runs `chmod +x dist/index.js`
  - Ensures binary has executable permissions after compilation
  - Fixes installation issue where users couldn't run the MCP server

### Repository
- **Added package-lock.json** - Committed lockfile to repository for reproducible builds
  - Ensures consistent dependency versions across all environments
  - Improves contributor experience with identical development setup
  - Enables `npm ci` for faster, reliable installations in CI/CD
  - Follows npm best practices for library development (2025)

## [1.1.0] - 2025-10-18

### Added
- **Deep Cleanup Tool** - Comprehensive system cleanup for fresh NotebookLM MCP installations
  - Scans entire system for ALL NotebookLM files (installation data, caches, logs, temp files)
  - Finds hidden files in NPM cache, Claude CLI logs, editor logs, system trash, temp backups
  - Shows categorized preview before deletion with exact file list and sizes
  - Safe by design: Always requires explicit confirmation after preview
  - Cross-platform support: Linux, Windows, macOS
  - Enhanced legacy path detection for old config.json files
  - New dependency: globby@^14.0.0 for advanced file pattern matching
- CHANGELOG.md for version tracking
- Changelog badge and link in README.md

### Changed
- **Configuration System Simplified** - No config files needed anymore!
  - `config.json` completely removed - works out of the box with sensible defaults
  - Settings passed as tool parameters (`browser_options`) or environment variables
  - Claude can now control ALL browser settings via tool parameters
  - `saveUserConfig()` and `loadUserConfig()` functions removed
- **Unified Data Paths** - Consolidated from `notebooklm-mcp-nodejs` to `notebooklm-mcp`
  - Linux: `~/.local/share/notebooklm-mcp/` (was: `notebooklm-mcp-nodejs`)
  - macOS: `~/Library/Application Support/notebooklm-mcp/`
  - Windows: `%LOCALAPPDATA%\notebooklm-mcp\`
  - Old paths automatically detected by cleanup tool
- **Advanced Browser Options** - New `browser_options` parameter for browser-based tools
  - Control visibility, typing speed, stealth mode, timeouts, viewport size
  - Stealth settings: Random delays, human typing, mouse movements
  - Typing speed: Configurable WPM range (default: 160-240 WPM)
  - Delays: Configurable min/max delays (default: 100-400ms)
  - Viewport: Configurable size (default: 1024x768, changed from 1920x1080)
  - All settings optional with sensible defaults
- **Default Viewport Size** - Changed from 1920x1080 to 1024x768
  - More reasonable default for most use cases
  - Can be overridden via `browser_options.viewport` parameter
- Config directory (`~/.config/notebooklm-mcp/`) no longer created (not needed)
- Improved logging for sessionStorage (NotebookLM does not use sessionStorage)
- README.md updated to reflect config-less architecture

### Fixed
- **Critical: envPaths() default suffix bug** - `env-paths` library appends `-nodejs` suffix by default
  - All paths were incorrectly created with `-nodejs` suffix
  - Fix: Explicitly pass `{suffix: ""}` to disable default behavior
  - Affects: `config.ts` and `cleanup-manager.ts`
  - Result: Correct paths now used (`notebooklm-mcp` instead of `notebooklm-mcp-nodejs`)
- Enhanced cleanup tool to detect all legacy paths including manual installations
  - Added `getManualLegacyPaths()` method for comprehensive legacy file detection
  - Finds old config.json files across all platforms
  - Cross-platform legacy path detection (Linux XDG dirs, macOS Library, Windows AppData)
- **Library Preservation Option** - cleanup_data can now preserve library.json
  - New parameter: `preserve_library` (default: false)
  - When true: Deletes everything (browser data, caches, logs) EXCEPT library.json
  - Perfect for clean reinstalls without losing notebook configurations
- **Improved Auth Troubleshooting** - Better guidance for authentication issues
  - New `AuthenticationError` class with cleanup suggestions
  - Tool descriptions updated with troubleshooting workflows
  - `get_health` now returns `troubleshooting_tip` when not authenticated
  - Clear workflow: Close Chrome → cleanup_data(preserve_library=true) → setup_auth/re_auth
  - Critical warnings about closing Chrome instances before cleanup
- **Critical: Browser visibility (show_browser) not working** - Fixed headless mode switching
  - **Root cause**: `overrideHeadless` parameter was not passed from `handleAskQuestion` to `SessionManager`
  - **Impact**: `show_browser=true` and `browser_options.show=true` were ignored, browser stayed headless
  - **Solution**:
    - `handleAskQuestion` now calculates and passes `overrideHeadless` parameter correctly
    - `SharedContextManager.getOrCreateContext()` checks for headless mode changes before reusing context
    - `needsHeadlessModeChange()` now checks CONFIG.headless when no override parameter provided
  - **Session behavior**: When browser mode changes (headless ↔ visible):
    - Existing session is automatically closed and recreated with same session ID
    - Browser context is recreated with new visibility mode
    - Chat history is reset (message_count returns to 0)
    - This is necessary because NotebookLM chat state is not persistent across browser restarts
  - **Files changed**: `src/tools/index.ts`, `src/session/shared-context-manager.ts`

### Removed
- Empty postinstall scripts (cleaner codebase)
  - Deleted: `src/postinstall.ts`, `dist/postinstall.js`, type definitions
  - Removed: `postinstall` npm script from package.json
  - Follows DRY & KISS principles

## [1.0.5] - 2025-10-17

### Changed
- Documentation improvements
- Updated README installation instructions

## [1.0.4] - 2025-10-17

### Changed
- Enhanced usage examples in documentation
- Fixed formatting in usage guide

## [1.0.3] - 2025-10-16

### Changed
- Improved troubleshooting guide
- Added common issues and solutions

## [1.0.2] - 2025-10-16

### Fixed
- Fixed typos in documentation
- Clarified authentication flow

## [1.0.1] - 2025-10-16

### Changed
- Enhanced README with better examples
- Added more detailed setup instructions

## [1.0.0] - 2025-10-16

### Added
- Initial release
- NotebookLM integration via Model Context Protocol (MCP)
- Session-based conversations with Gemini 2.5
- Source-grounded answers from notebook documents
- Notebook library management system
- Google authentication with persistent browser sessions
- 16 MCP tools for comprehensive NotebookLM interaction
- Support for Claude Code, Codex, Cursor, and other MCP clients
- TypeScript implementation with full type safety
- Playwright browser automation with stealth mode