# Tools

This is a fork of notebooklm-mcp. It registers **25 tools** total: the 20 tools from upstream v2.0.0, plus 5 added by this fork — the 4 generic Studio-output tools and `discover_notebooks`. Each entry below has parameter schema, an example invocation (MCP `tools/call` arguments shape), and the expected return shape. New-in-this-fork tools are flagged.

The server returns each tool result wrapped as `{ "success": true, "data": <object> }` (or `{ "success": false, "error": <string> }`). Every return shape below shows the full envelope, because several tools nest their payload one level further under `data.result` and that is easy to get wrong.

Two conventions worth knowing before reading the individual entries:

- **`data.session_id`.** Every browser-touching tool other than `ask_question` returns the id of the session that did the work alongside its `result` — `add_source`, `generate_audio`, `get_audio_status`, `download_audio`, `generate_studio_output`, `get_studio_output_status`, `download_studio_output`, `get_studio_output_content`. These tools create a session when you do not pass one, so without this the session was invisible to the caller and leaked until the idle timeout. Pass it to `close_session` when you are done, or back in as `session_id` to keep working on the same page.
- **Argument validation.** Tool-call arguments are validated against each tool's declared `inputSchema` before dispatch. A missing required argument, a wrong type, or a value outside an `enum` comes back as `{ "success": false, "error": "Invalid arguments for \`<tool>\`: …" }` instead of an internal stack trace. Unknown extra properties are tolerated, so a newer client sending a field this build does not know about is not rejected.
- **Profile filtering applies to calls, not just listings.** A tool hidden by the active profile or by `disabled-tools` can no longer be invoked by name. `tools/call` for a hidden tool returns a JSON-RPC `MethodNotFound` error naming the active profile — previously the filter only trimmed `tools/list`, so every "disabled" tool stayed fully callable and the setting was cosmetic. An unknown tool name is likewise a protocol-level error rather than a success-shaped failure payload.

---

## ask_question

Ask a question against a notebook. Reuses an existing browser session when `session_id` is supplied. Citation extraction reads the DOM citation panel after the answer settles.

**v2 additions**: `source_format`, `_provenance` envelope on the result, AI-generated answer prefix.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `question` | string | yes | The question to ask. |
| `session_id` | string | no | Reuse an existing session for context. Omit to create a new one. A session that this server does not know (stale id, expired session, different process) does not fail — a new session answers, and the result carries `session_note` saying so. |
| `notebook_id` | string | no | Library notebook ID. Falls back to the active notebook. |
| `notebook_url` | string | no | Ad-hoc NotebookLM URL. Overrides `notebook_id`. |
| `source_format` | `none` \| `inline` \| `footnotes` \| `json` | no | Citation rendering. Default `none`. |
| `show_browser` | bool | no | Shorthand for `browser_options.show`. |
| `browser_options` | object | no | Per-call browser overrides — see [`docs/configuration.md`](./configuration.md#per-call-browser-options). |

### Example

```json
{
  "name": "ask_question",
  "arguments": {
    "question": "How does the OAuth refresh token rotation work?",
    "notebook_id": "auth-notebook",
    "source_format": "footnotes"
  }
}
```

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "status": "success",
    "question": "How does the OAuth refresh token rotation work?",
    "answer": "[AI-GENERATED ...] The refresh token is rotated each ...\n\nSources:\n[1] auth-spec.pdf — ...",
    "session_id": "a3f19c2b",              // 8 hex chars
    "notebook_url": "https://notebook.google.com/notebook/…",
    "session_info": {
      "age_seconds": 12.4,
      "message_count": 3,
      "last_activity": 1777291200000       // epoch milliseconds, not an ISO string
    },
    "_provenance": {
      "provider": "google-notebooklm",
      "model": "gemini-2.5",
      "via": "chrome-automation",
      "grounding": "user-uploaded-documents",
      "ai_generated": true
    },
    "source_format": "footnotes",
    "sources": [
      {
        "marker": "[1]",
        "number": 1,
        "sourceName": "auth-spec.pdf",
        "sourceText": "Refresh tokens MUST be rotated…"   // best-effort excerpt; falls back to sourceName
      }
    ],
    "sources_note": "…",                   // only when citations were requested but none were found
    "session_note": "…"                    // only when the supplied session_id was not live
  }
}
```

`sources` is omitted when `source_format=none` or when no citations were found. The entries are `Citation` objects (`src/notebooklm/citations.ts`) — `marker`, `number`, `sourceName`, `sourceText`. There is no `url` field: the citation panel exposes the source's name and the highlighted passage, not a link.

Two fields appear only when they have something to say:

- `sources_note` — a non-`none` `source_format` was requested but no citations could be read from the answer. Previously indistinguishable from "citations not requested", since both simply omitted `sources`.
- `session_note` — the `session_id` you passed was not a live session on this server, so a **new** session answered and carries none of the earlier conversation. The note names both ids.

When you pass only `session_id` (no `notebook_id` / `notebook_url`), the question stays on **that session's own notebook**, not the library's active notebook.

---

## add_source — new in v2

Add a source to a notebook. v2 supports `type=url` (web crawl) and `type=text` (paste). File / YouTube / Drive uploads are not supported.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `type` | `url` \| `text` | yes | |
| `content` | string | yes | URL when `type=url`, raw text when `type=text`. |
| `title` | string | no | Optional display title. NotebookLM picks a default. |
| `show_browser` | boolean | no | Show the browser window for debugging. Default `false`. |
| `session_id` | string | no | Reuse an existing browser session. |
| `notebook_id` | string | no | Library notebook ID. |
| `notebook_url` | string | no | Ad-hoc URL. Overrides `notebook_id`. |

### Example

```json
{
  "name": "add_source",
  "arguments": {
    "type": "url",
    "content": "https://docs.n8n.io/code/builtin/json-jmespath/",
    "title": "n8n JMESPath builtin"
  }
}
```

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "result": {
      "success": true,
      "type": "url",                 // echoes the requested source type
      "sourceCountBefore": 12,
      "sourceCountAfter": 13,
      "message": "…"                 // optional; present on failure and on some quirk paths
    },
    "session_id": "a3f19c2b"         // the session that did the work — close_session it when done
  }
}
```

The payload is nested under `data.result`, and the field names are camelCase (`sourceCountBefore` / `sourceCountAfter`) — there is no `added` flag and no `title` echo. Compare the two counts to verify the source landed. The envelope's outer `success` mirrors `result.success`.

---

## generate_audio — new in v2

Generate a podcast-style Audio Overview for a notebook. **Async by default** — returns immediately; poll `get_audio_status` for completion, or pass `wait_for_completion: true` to block.

Equivalent to `generate_studio_output` with `output_type: "audio"` — kept as a dedicated tool for backward compatibility.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `custom_prompt` | string | no | Optional focus prompt. |
| `wait_for_completion` | boolean | no | Block until ready (up to `timeout_ms`). Default `false`. |
| `timeout_ms` | number | no | Only relevant when `wait_for_completion=true`. Default `600000`. |
| `show_browser` | boolean | no | Show the browser window for debugging. Default `false`. |
| `session_id` | string | no | |
| `notebook_id` | string | no | |
| `notebook_url` | string | no | |

### Example

```json
{
  "name": "generate_audio",
  "arguments": {
    "custom_prompt": "Focus on the migration strategy",
    "wait_for_completion": true,
    "timeout_ms": 900000
  }
}
```

`timeout_ms` is only read when `wait_for_completion` is `true`; on its own it does nothing, because the default async call returns as soon as generation is triggered.

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "result": {
      "status": "started",       // or "in_progress" | "ready" | "not_started" | "error"
      "alreadyExisted": false,   // true when status="ready" and nothing was triggered
      "message": "...",          // optional
      "warnings": ["..."]        // optional — non-fatal problems, e.g. a custom_prompt the
                                 // Customize dialog had no field for
    },
    "session_id": "a3f19c2b"     // the session that did the work — close_session it when done
  }
}
```

The envelope's outer `success` is `true` for `ready`, `started` and `in_progress` — all three mean the generation is on its way or already done.

Pair with `get_audio_status` (poll) and `download_audio` (persist) to complete the workflow. Audio is one of **8 implemented Studio output types**; see [`generate_studio_output`](#generate_studio_output--new-in-this-fork) below for the other seven and for the one type (`report`) that is not implemented.

---

## get_audio_status — new in v2

Non-blocking probe for the current Audio Overview state of a notebook. Was previously undocumented here despite being registered since v2.0.0.

Equivalent to `get_studio_output_status` with `output_type: "audio"` — kept as a dedicated tool for backward compatibility.

`not_started` is also what you get while a generation is running but its tile has not yet appeared, so never read it as proof that nothing is being generated. If you just called `generate_audio`, keep polling rather than triggering a second generation.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `show_browser` | boolean | no | Show the browser window for debugging. Default `false`. |
| `session_id` | string | no | |
| `notebook_id` | string | no | |
| `notebook_url` | string | no | |

### Example

```json
{
  "name": "get_audio_status",
  "arguments": {}
}
```

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "result": {
      "status": "ready",       // or "in_progress" | "not_started" | "error"
      "alreadyExisted": true,  // optional
      "message": "...",        // optional
      "warnings": ["..."]      // optional
    },
    "session_id": "a3f19c2b"   // the session that did the probing
  }
}
```

The envelope's outer `success` is `false` when `result.status` is `"error"` — a probe that itself failed is not a successful probe, and must not be read as a clean `not_started`.

---

## download_audio — new in v2

Download the most recent Audio Overview to disk as a `.m4a` file. **Precondition:** `get_audio_status` must report `status: "ready"`.

Equivalent to `download_studio_output` with `output_type: "audio"` — kept as a dedicated tool for backward compatibility.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `destination_dir` | string | yes | Absolute directory. Created if missing. |
| `show_browser` | boolean | no | Show the browser window for debugging. Default `false`. |
| `session_id` | string | no | |
| `notebook_id` | string | no | |
| `notebook_url` | string | no | |

### Example

```json
{
  "name": "download_audio",
  "arguments": {
    "destination_dir": "/Users/me/Downloads/notebooklm"
  }
}
```

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "result": {
      "success": true,
      "filePath": "/Users/me/Downloads/notebooklm/Audio_Overview.m4a",
      // Absolute path actually written — may differ from the suggested name when an
      // existing file forced a " (2)"-style non-clashing name.
      "bytes": 48234496,   // size on disk of the written file
      "message": "..."     // optional; carries the reason on failure
    },
    "session_id": "a3f19c2b"
  }
}
```

Run `generate_audio` first if no Audio Overview exists yet.

---

## generate_studio_output — new in this fork

Generic trigger for any of the 9 `StudioOutputType` values. **Async by default**, same status semantics as `generate_audio`. **8 of 9 values are backed by live-verified strategies**: `audio`, `video`, `infographic`, `slides` (file-kind, use `download_studio_output`) and `mindmap`, `datatable`, `quiz`, `flashcards` (structured-kind, use `get_studio_output_content`). Only `report` returns an error: `Studio output type "report" is not yet implemented by this server (Phase 2).`

KNOWN LIMITATION: mid-generation status reporting is only partly reliable. The server records the generations **it** starts, so a repeat call on the same session returns `in_progress` rather than starting a duplicate, and it also looks for an in-progress tile in the page. But that record is per-session (and expires after 30 minutes), so a generation started elsewhere — the NotebookLM web UI, another process, or a different session of this server — can still read as `not_started` until its tile appears. Poll rather than re-triggering, and keep reusing the `session_id` you got back.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `output_type` | string | yes | One of `audio`, `video`, `report`, `slides`, `infographic`, `mindmap`, `datatable`, `quiz`, `flashcards`. `report` errors. |
| `custom_prompt` | string | no | Focus prompt typed into the Customize dialog before generation. Honoured by every implemented type whose dialog exposes a prompt field; ignored where the dialog has none. |
| `difficulty` | string | no | Accepted but **not wired up** — no verified selector exists for the Customize dialog's difficulty control, so quiz/flashcards always generate at the dialog's default. Passing it adds an entry to `result.warnings` rather than silently pretending it applied. |
| `wait_for_completion` | boolean | no | Block until ready (up to `timeout_ms`). Default `false`. |
| `timeout_ms` | number | no | Default `600000`. |
| `show_browser` | boolean | no | |
| `session_id` / `notebook_id` / `notebook_url` | string | no | |

### Example

```json
{
  "name": "generate_studio_output",
  "arguments": { "output_type": "audio" }
}
```

### Return shape

Same shape as `generate_audio` above — `data.result` plus `data.session_id`.

---

## get_studio_output_status — new in this fork

Non-blocking status probe for any `output_type`. Read-only (`readOnlyHint: true`) — included in the `standard` profile.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `output_type` | string | yes | Same 9-value enum as above. `report` returns the "not yet implemented" error. |
| `show_browser` | boolean | no | |
| `session_id` / `notebook_id` / `notebook_url` | string | no | |

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "result": {
      "status": "ready",       // or "in_progress" | "not_started" | "started" | "error"
      "alreadyExisted": true,  // optional
      "message": "...",        // optional
      "warnings": ["..."]      // optional
    },
    "session_id": "a3f19c2b"
  }
}
```

This is the shape declared by the tool's `outputSchema`, so a successful call also returns it as `structuredContent`. As with `get_audio_status`, `result.status: "error"` sets the envelope's `success` to `false`.

---

## download_studio_output — new in this fork

Save a completed **file-kind** output to disk. The implemented file kinds are `audio`, `video`, `slides`, and `infographic`. For structured kinds use `get_studio_output_content` instead. **Precondition:** `get_studio_output_status` must report `ready`.

`report` is **not** a file kind and cannot be downloaded. Its three-dot menu offers "Export to Docs" / "Export to Sheets" (creating a file in the user's Drive) rather than triggering a browser download, so there is nothing for this tool to save. The parameter's `enum` is built from the engine's own `FILE_KIND_TYPES` list, so `report` is rejected by argument validation; reaching the handler with it would in any case return `Studio output type "report" is not yet implemented by this server (Phase 2).`

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `output_type` | string | yes | One of `audio`, `video`, `slides`, `infographic`. |
| `destination_dir` | string | yes | Absolute directory. Created if missing. |
| `show_browser` | boolean | no | |
| `session_id` / `notebook_id` / `notebook_url` | string | no | |

### Return shape

Same shape as `download_audio` above — `data.result` (`success`, `filePath`, `bytes`, `message`) plus `data.session_id`.

---

## get_studio_output_content — new in this fork

Extract a completed **structured-kind** output (`mindmap`, `datatable`, `quiz`, `flashcards`) as JSON. For file kinds use `download_studio_output` instead. **Precondition:** `get_studio_output_status` must report `ready`.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `output_type` | string | yes | One of `mindmap`, `datatable`, `quiz`, `flashcards`. |
| `show_browser` | boolean | no | |
| `session_id` / `notebook_id` / `notebook_url` | string | no | |

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "result": {
      "success": true,
      "content": {},   // shape depends on output_type, see below
      "message": "..." // optional; carries the reason on failure
    },
    "session_id": "a3f19c2b"
  }
}
```

This is the shape declared by the tool's `outputSchema`, so a successful call also returns it as `structuredContent`. The envelope's outer `success` mirrors `result.success`.

`content`'s shape per `output_type` (see each type's own module — `src/notebooklm/mindmap.ts`, `datatable.ts`, `flashcards.ts`, `quiz.ts` — for the live-confirmed DOM behavior each extraction works around):

- `mindmap`: `{ root: { label: string, children: [...], incomplete?: { expectedChildren, capturedChildren } } }`. `incomplete` appears on a node only when fewer children were captured than its own declared count — an honest partial-read signal, never silently dropped.
- `datatable`: `{ headers: string[], rows: string[][] }`.
- `flashcards`: `{ cards: { front: string, back: string }[], missingPositions?: number[] }`.
- `quiz`: `{ questions: { question: string, options: string[] }[], missingPositions?: number[] }`. Options are read directly from the DOM, never selected — clicking an answer would record it server-side, a side effect this tool has no business causing.

For `flashcards`/`quiz`, `missingPositions` (1-indexed) lists any position that was never captured during the walk — again an honest signal rather than a silent gap.

---

## add_notebook

Add a NotebookLM share-URL to the local library. The tool description enforces a confirmation workflow on the host agent — do not call without explicit user consent.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | NotebookLM share URL. |
| `name` | string | yes | Display name. |
| `description` | string | yes | Short description of the notebook content. |
| `topics` | string[] | yes | Topics covered. |
| `content_types` | string[] | no | e.g. `["documentation", "examples"]`. |
| `use_cases` | string[] | no | When to consult this notebook. |
| `tags` | string[] | no | Optional organizational tags. |

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "notebook": {
      "id": "n8n-documentation",          // slug derived from `name`, de-duplicated with -2, -3, …
      "url": "https://notebook.google.com/notebook/abcd-efgh",
      "name": "n8n Documentation",
      "description": "n8n core + builtin nodes",
      "topics": ["workflow automation", "n8n"],
      "content_types": ["documentation", "examples"],
      "use_cases": ["Learning about n8n Documentation", "Implementing features with n8n Documentation"],
      "added_at": "2026-08-23T09:14:02.113Z",
      "last_used": "2026-08-23T09:14:02.113Z",
      "use_count": 0,
      "tags": ["docs"]
    }
  }
}
```

The whole `NotebookEntry` comes back under `data.notebook` — there is no `status` or `active` field. `content_types` and `use_cases` are filled with defaults when you omit them. Adding the **first** notebook also makes it active; later ones do not become active on their own (use `select_notebook`). Re-adding a notebook UUID that is already registered is an error, not a duplicate.

---

## discover_notebooks — new in this fork

Scan the account's NotebookLM dashboard (https://notebook.google.com/) and register any notebooks not already in the local library — notebooks created directly in the web UI, which `add_notebook` alone can never see since it only stores whatever URL it's handed. No parameters. Requires an authenticated session. Dedupes by notebook UUID, so it's safe to call repeatedly. Newly-registered notebooks get placeholder metadata (empty `topics`, a generic `description`, the `auto-discovered` tag) — follow up with `update_notebook` to fill those in.

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "discovered": [{ "id": "…", "url": "https://notebook.google.com/notebook/…", "title": "…" }],
    "added": [/* full NotebookEntry objects, only the newly-registered ones */],
    "skipped_existing": 0,
    "note": "present only when 0 tiles were found, to distinguish a genuinely empty account from a possible selector/layout change"
  }
}
```

---

## list_notebooks

No parameters. Returns the full library.

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "notebooks": [
      {
        "id": "n8n-documentation",
        "url": "https://notebook.google.com/notebook/…",
        "name": "n8n Documentation",
        "description": "n8n core + builtin nodes",
        "topics": ["workflow automation", "n8n"],
        "content_types": ["documentation", "examples"],
        "use_cases": ["building n8n workflows"],
        "added_at": "2026-08-23T09:14:02.113Z",
        "last_used": "2026-08-23T11:02:44.900Z",
        "use_count": 42,
        "tags": ["docs"]
      }
    ]
  }
}
```

`data` holds `notebooks` and nothing else — the active notebook id is **not** returned here. Read it from `get_health` (`active_notebook_id`) or `get_library_stats` (`active_notebook`).

---

## get_notebook

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

### Return shape

```jsonc
{ "success": true, "data": { "notebook": { /* one full NotebookEntry, as above */ } } }
```

An unknown `id` returns `{ "success": false, "error": "Notebook not found: <id>" }`.

---

## select_notebook

Set a notebook as the active default.

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

### Return shape

```jsonc
{ "success": true, "data": { "notebook": { /* the now-active NotebookEntry */ } } }
```

The full entry comes back under `data.notebook` — there is no `status` field, and the id/name are read off the entry.

---

## update_notebook

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |
| `name` | string | no |
| `description` | string | no |
| `topics` | string[] | no |
| `content_types` | string[] | no |
| `use_cases` | string[] | no |
| `tags` | string[] | no |
| `url` | string | no |

### Return shape

```jsonc
{ "success": true, "data": { "notebook": { /* the updated NotebookEntry */ } } }
```

Array fields are replaced wholesale, not appended to.

---

## remove_notebook

Removes the entry from the local library only — does not delete the notebook in NotebookLM. Any live session on that notebook is closed.

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

On a client that declares the MCP `elicitation` capability, the server asks for confirmation first. If that confirmation request fails or times out, the removal is refused rather than proceeding unconfirmed. A client that never declares the capability is not prompted and the removal proceeds.

### Return shape

```jsonc
{ "success": true, "data": { "removed": true, "closed_sessions": 1 } }
```

---

## search_notebooks

Searches name, description, topics, tags.

| Name | Type | Required |
|---|---|---|
| `query` | string | yes |

### Return shape

```jsonc
{ "success": true, "data": { "notebooks": [ /* matching NotebookEntry objects */ ] } }
```

---

## get_library_stats

No parameters.

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "total_notebooks": 7,
    "active_notebook": "n8n-documentation",   // id, or null
    "most_used_notebook": "n8n-documentation", // id, or null
    "total_queries": 128,                      // sum of every notebook's use_count
    "last_modified": "2026-08-23T11:02:44.900Z"
  }
}
```

---

## list_sessions

No parameters.

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "active_sessions": 2,
    "max_sessions": 10,
    "session_timeout": 900,          // seconds
    "oldest_session_seconds": 412.7,
    "total_messages": 9,
    "sessions": [
      {
        "id": "a3f19c2b",
        "created_at": 1777290787900, // epoch milliseconds
        "last_activity": 1777291200000,
        "age_seconds": 412.1,
        "inactive_seconds": 12.4,
        "message_count": 3,
        "notebook_url": "https://notebook.google.com/notebook/…"
      }
    ]
  }
}
```

---

## close_session

| Name | Type | Required |
|---|---|---|
| `session_id` | string | yes |

### Return shape

```jsonc
{
  "success": true,
  "data": { "status": "success", "message": "Session a3f19c2b closed successfully", "session_id": "a3f19c2b" }
}
```

An unknown id returns `{ "success": false, "error": "Session <id> not found" }`.

---

## reset_session

Clears chat history while keeping the same `session_id`.

| Name | Type | Required |
|---|---|---|
| `session_id` | string | yes |

### Return shape

Same shape as `close_session` (`status`, `message`, `session_id`).

---

## get_health

No parameters.

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "status": "ok",
    "authenticated": true,
    "notebook_url": "https://notebook.google.com/notebook/…",  // or "not configured"
    "active_notebook_id": "n8n-documentation",                  // or null
    "active_notebook_name": "n8n Documentation",                // or null
    "total_notebooks": 7,
    "active_sessions": 1,
    "max_sessions": 10,
    "session_timeout": 900,          // seconds; sessions auto-close after this idle period
    "total_messages": 9,
    "headless": true,
    "auto_login_enabled": false,
    "stealth_enabled": true,
    "troubleshooting_tip": "..."     // only when authenticated=false
  }
}
```

`data` is **flat** — there is no nested `config` object, and no `version` field. This shape is declared as the tool's `outputSchema`, so a successful call also returns it as `structuredContent`. `answer_timeout_ms` is not reported here; it is an env-only setting (`ANSWER_TIMEOUT_MS`).

When `authenticated=false` the response also carries a `troubleshooting_tip` pointing at `setup_auth` / `cleanup_data`.

---

## setup_auth

Opens a visible Chrome for first-time Google login.

| Name | Type | Required | Notes |
|---|---|---|---|
| `show_browser` | bool | no | Default `true` for setup — the window must be visible for the user to interact with it. |
| `browser_options` | object | no | Same shape as `ask_question`. |

**This call BLOCKS until the login completes**, for up to 10 minutes — it does not return as soon as the browser opens. Tell the user to finish signing in in the window that appeared, and expect the tool call to stay outstanding until they do.

It is annotated `destructiveHint: true`, and that is not decorative: before starting, it **closes every live browser session**, and `performSetup` deletes and relaunches the stored Chrome profile. Work in flight is ended.

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "status": "authenticated",
    "message": "Successfully authenticated and saved browser state",
    "authenticated": true,
    "duration_seconds": 47.2
  }
}
```

A cancelled or failed login returns `{ "success": false, "error": "Authentication failed or was cancelled" }`. Verify with `get_health` afterwards.

---

## re_auth

Closes all sessions, deletes saved cookies + Chrome profile, opens a fresh login window. Also blocking, also `destructiveHint: true`.

| Name | Type | Required | Notes |
|---|---|---|---|
| `show_browser` | bool | no | Default `true`. |
| `browser_options` | object | no | |

### Return shape

Same shape as `setup_auth`, with `message` noting that previous sessions were closed.

---

## cleanup_data

Categorised preview + delete of every NotebookLM MCP file the server can find on the system. Designed for fresh-start workflows.

| Name | Type | Required | Notes |
|---|---|---|---|
| `confirm` | bool | yes | See below — `false` is not always preview-only. `true` = always delete, no elicitation. |
| `preserve_library` | bool | no | Keep `library.json` while wiping everything else. Default `false`. |

`confirm: false` behavior depends on the connected client's capabilities:

- **Client without elicitation support:** `confirm: false` is preview-only — no deletion happens.
- **Elicitation-capable client:** `confirm: false` still returns the preview, but first triggers a client-side confirmation prompt. Declining that prompt (or the request failing/timing out) also results in preview-only, no deletion. **Accepting the prompt performs the deletion immediately, even though `confirm` was passed as `false`.**

Workflow:

1. `cleanup_data({ confirm: false, preserve_library: true })` — see what will be deleted. (With an elicitation-capable client, accepting the confirmation prompt here deletes immediately instead of just previewing.)
2. Close all Chrome instances.
3. `cleanup_data({ confirm: true, preserve_library: true })` — execute.

### What it will and will not touch

Every candidate path is checked against an allow-list of this server's own directories — both when it is enumerated and again immediately before the recursive delete — so a sloppy glob cannot reach unrelated user data. In scope: this server's data/config/cache dirs (account-aware), the legacy `notebooklm-mcp-nodejs` tree, Chrome profiles and browser state, the npm/npx cache entries, temp backups, and only this server's own `mcp-logs-*notebooklm*` directories under the Claude CLI cache.

Explicitly out of scope, because none of it is this server's data:

- **The MCP client's own project/session directories** (`~/.claude/projects/*`). Those hold the user's session transcripts, and their names are derived from the project path — a checkout of this repo produced a directory that matched the old `*notebooklm-mcp*` glob.
- **The Recycle Bin / Trash.** The former "Trash Files" category globbed `<Trash>/**/*notebooklm*` and deleted the matches, which is both unrecoverable and not this server's data.

Categories flagged `optional` (editor MCP logs from Cursor / VSCode) are listed in the preview with their size but are **never deleted through this tool** — the handler does not expose the opt-in, so there is no parameter that turns them on. They are reported in `categorySummary` as `"<name> — skipped (optional)"` with zero count and zero bytes, and the reported `totalSizeBytes` counts only what was actually eligible.

### Return shape

Preview (`status: "preview"`):

```jsonc
{
  "success": true,
  "data": {
    "status": "preview",
    "mode": "deep",
    "preview": {
      "categories": [
        { "name": "…", "description": "…", "paths": ["…"], "totalBytes": 12345, "optional": false }
      ],
      "totalPaths": 42,          // a count, not the array
      "totalSizeBytes": 987654
    }
  }
}
```

Deletion (`status: "completed"`, or `"partial"` when some paths failed):

```jsonc
{
  "success": true,
  "data": {
    "status": "completed",
    "mode": "deep",
    "result": {
      "deletedPaths": ["…"],
      "failedPaths": [],
      "totalSizeBytes": 987654,
      "categorySummary": { "Browser Profiles": { "count": 3, "bytes": 812345 } }
    }
  }
}
```

`mode` is always `"deep"`. `confirm` is re-checked for being an actual boolean inside the handler as well as by schema validation — this tool deletes irreversibly, and a truthy non-boolean like `"false"` must not skip the preview.

---

## Resources (read-only)

| URI | Purpose |
|---|---|
| `notebooklm://library` | JSON view of the full library. |
| `notebooklm://library/{id}` | One notebook by ID. The `{id}` template autocompletes from the library. |
| `notebooklm://metadata` | Deprecated. Use `notebooklm://library` instead. |

The MCP server does not respond to `mcp://notebooklm` — that URI scheme never existed. Use `notebooklm://`.

---

## Prompts

| Name | Purpose |
|---|---|
| `notebooklm.auth-setup` | First-time authentication walkthrough: call `setup_auth`, then verify with `get_health`. |
| `notebooklm.auth-repair` | Fix a broken session: call `re_auth`, then verify with `get_health`. |

Neither prompt takes arguments. Both are referenced from `ask_question`'s description as the auth-recovery path.
