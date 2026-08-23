# Tools

This is a fork of notebooklm-mcp. It registers 24 tools total: the 20 tools from upstream v2.0.0, plus 4 new generic Studio-output tools added in this fork's Phase 1 protocol upgrade. Each entry below has parameter schema, an example invocation (MCP `tools/call` arguments shape), and the expected return shape. New-in-this-fork tools are flagged.

The server returns each tool result wrapped as `{ "success": true, "data": <object> }` (or `{ "success": false, "error": <string> }`). The shapes below describe the inner `data` — except the audio and Studio-output sections, which show the full envelope explicitly since their `data.result` nesting is easy to get wrong.

---

## ask_question

Ask a question against a notebook. Reuses an existing browser session when `session_id` is supplied. Citation extraction reads the DOM citation panel after the answer settles.

**v2 additions**: `source_format`, `_provenance` envelope on the result, AI-generated answer prefix.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `question` | string | yes | The question to ask. |
| `session_id` | string | no | Reuse an existing session for context. Omit to create a new one. |
| `notebook_id` | string | no | Library notebook ID. Falls back to active notebook. |
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
  "status": "success",
  "question": "How does the OAuth refresh token rotation work?",
  "answer": "[AI-GENERATED ...] The refresh token is rotated each ...\n\nSources:\n[1] auth-spec.pdf — ...",
  "session_id": "ses_…",
  "notebook_url": "https://notebooklm.google.com/notebook/…",
  "session_info": {
    "age_seconds": 12,
    "message_count": 3,
    "last_activity": "2026-04-30T12:00:00.000Z"
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
    { "index": 1, "title": "auth-spec.pdf", "excerpt": "Refresh tokens MUST be rotated…" }
  ]
}
```

`sources` is omitted when `source_format=none` or when no citations were found.

---

## add_source — new in v2

Add a source to a notebook. v2 supports `type=url` (web crawl) and `type=text` (paste). File / YouTube / Drive uploads are not supported.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `type` | `url` \| `text` | yes | |
| `content` | string | yes | URL when `type=url`, raw text when `type=text`. |
| `title` | string | no | Optional display title. NotebookLM picks a default. |
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
  "status": "success",
  "type": "url",
  "title": "n8n JMESPath builtin",
  "source_count_before": 12,
  "source_count_after": 13,
  "added": true
}
```

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
    "timeout_ms": 900000
  }
}
```

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "result": {
      "status": "started", // or "in_progress" | "ready" | "error"
      "alreadyExisted": false, // true when status="ready" and nothing was triggered
      "message": "..." // present on in_progress / error
    }
  }
}
```

Pair with `get_audio_status` (poll) and `download_audio` (persist) to complete the workflow. Audio Overview is the only Studio output this server currently implements — see [`generate_studio_output`](#generate_studio_output--new-in-this-fork) below for the Phase 1/2 boundary on the other 8 output types.

---

## get_audio_status — new in v2

Non-blocking probe for the current Audio Overview state of a notebook. Was previously undocumented here despite being registered since v2.0.0.

Equivalent to `get_studio_output_status` with `output_type: "audio"` — kept as a dedicated tool for backward compatibility.

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
      "status": "ready" // or "in_progress" | "not_started"
    }
  }
}
```

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
      "filePath": "/Users/me/Downloads/notebooklm/overview-2026-04-30.m4a"
    }
  }
}
```

Run `generate_audio` first if no Audio Overview exists yet.

---

## generate_studio_output — new in this fork

Generic trigger for any of the 9 `StudioOutputType` values. **Async by default**, same status semantics as `generate_audio`. **8 of 9 values are backed by live-verified strategies**: `audio`, `video`, `infographic`, `slides` (file-kind, use `download_studio_output`) and `mindmap`, `datatable`, `quiz`, `flashcards` (structured-kind, use `get_studio_output_content`). Only `report` returns an error: `Studio output type "report" is not yet implemented by this server (Phase 2).` KNOWN LIMITATION: in-progress status detection is unreliable against the current UI (a real ~7-minute generation was observed reporting `not_started` throughout) — avoid calling this twice for the same `output_type` in quick succession while a generation may already be running.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `output_type` | string | yes | One of `audio`, `video`, `report`, `slides`, `infographic`, `mindmap`, `datatable`, `quiz`, `flashcards`. |
| `custom_prompt` | string | no | Optional focus prompt. |
| `difficulty` | string | no | Intended for quiz/flashcards, but not currently forwarded to their trigger dialogs — both are generated at the dialog's default difficulty regardless of this value. |
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

Same shape as `generate_audio` above, wrapped under `data.result`.

---

## get_studio_output_status — new in this fork

Non-blocking status probe for any `output_type`. Read-only (`readOnlyHint: true`) — included in the `standard` profile.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `output_type` | string | yes | Same 9-value enum as above. |
| `show_browser` | boolean | no | |
| `session_id` / `notebook_id` / `notebook_url` | string | no | |

### Return shape

```jsonc
{
  "success": true,
  "data": {
    "result": {
      "status": "ready" // or "in_progress" | "not_started" | "started" | "error"
    }
  }
}
```

---

## download_studio_output — new in this fork

Save a completed **file-kind** output (`audio`, `video`, `report`, `slides`, `infographic`) to disk. For structured kinds use `get_studio_output_content` instead. **Precondition:** `get_studio_output_status` must report `ready`.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `output_type` | string | yes | One of `audio`, `video`, `report`, `slides`, `infographic`. |
| `destination_dir` | string | yes | Absolute directory. Created if missing. |
| `show_browser` | boolean | no | |
| `session_id` / `notebook_id` / `notebook_url` | string | no | |

### Return shape

Same shape as `download_audio` above, wrapped under `data.result`.

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
      "content": {} // shape depends on output_type, see below
    }
  }
}
```

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
  "status": "added",
  "id": "nb_abcd",
  "name": "n8n Documentation",
  "active": true
}
```

---

## discover_notebooks

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
  "active_notebook_id": "nb_abcd",
  "notebooks": [
    {
      "id": "nb_abcd",
      "name": "n8n Documentation",
      "url": "https://notebooklm.google.com/notebook/…",
      "description": "n8n core + builtin nodes",
      "topics": ["workflow automation", "n8n"],
      "use_cases": ["building n8n workflows"],
      "tags": ["docs"],
      "use_count": 42
    }
  ]
}
```

---

## get_notebook

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

Returns one entry from `list_notebooks`.

---

## select_notebook

Set a notebook as the active default.

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

### Return shape

```jsonc
{ "status": "active", "id": "nb_abcd", "name": "n8n Documentation" }
```

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

Returns the updated entry.

---

## remove_notebook

Removes the entry from the local library only — does not delete the notebook in NotebookLM.

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

---

## search_notebooks

Searches name, description, topics, tags.

| Name | Type | Required |
|---|---|---|
| `query` | string | yes |

Returns an array of matching entries.

---

## get_library_stats

No parameters. Returns total notebooks, total queries, top-used notebooks.

---

## list_sessions

No parameters. Returns active sessions with age, message count, last-activity timestamp.

---

## close_session

| Name | Type | Required |
|---|---|---|
| `session_id` | string | yes |

---

## reset_session

Clears chat history while keeping the same `session_id`.

| Name | Type | Required |
|---|---|---|
| `session_id` | string | yes |

---

## get_health

No parameters.

### Return shape

```jsonc
{
  "status": "ok",
  "authenticated": true,
  "active_sessions": 1,
  "version": "2.0.0",
  "config": {
    "headless": true,
    "stealth_enabled": true,
    "max_sessions": 10,
    "answer_timeout_ms": 600000
  }
}
```

When `authenticated=false` the response also carries a `troubleshooting_tip` pointing at `setup_auth` / `cleanup_data`.

---

## setup_auth

Opens a visible Chrome for first-time Google login.

| Name | Type | Required | Notes |
|---|---|---|---|
| `show_browser` | bool | no | Default `true` for setup. |
| `browser_options` | object | no | Same shape as `ask_question`. |

Returns immediately after the window is opened. The user has up to 10 minutes to complete the login. Verify with `get_health` afterwards.

---

## re_auth

Closes all sessions, deletes saved cookies + Chrome profile, opens a fresh login window.

| Name | Type | Required | Notes |
|---|---|---|---|
| `show_browser` | bool | no | Default `true`. |
| `browser_options` | object | no | |

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
