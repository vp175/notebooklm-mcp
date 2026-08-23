# Usage Guide

Practical end-to-end walkthroughs. Each section is a self-contained recipe with the exact tool calls / curl commands.

The `npx notebooklm-mcp@latest` lines below start the **upstream** published package. The Studio-output tools and `discover_notebooks` described here exist only in this fork — run it with `node /absolute/path/to/notebooklm-mcp-fork/dist/index.js` instead. See [Install](../README.md#install).

- [First-time setup](#first-time-setup)
- [Multi-turn session pattern](#multi-turn-session-pattern)
- [Citations workflow](#citations-workflow)
- [Audio Overview generation + download](#audio-overview-generation--download)
- [Multi-account switching](#multi-account-switching)
- [HTTP transport for n8n / Zapier](#http-transport-for-n8n--zapier)

---

## First-time setup

### 1. Install and start

```bash
npx notebooklm-mcp@latest
```

Wire it into your MCP client of choice (see the [README](../README.md#connect-to-claude-code)).

### 2. Authenticate

Call `setup_auth`. A Chrome window opens. Log in to the Google account that owns the NotebookLM notebooks you want to query.

**The tool call blocks until the login completes**, for up to 10 minutes — it does not return when the window opens, so expect it to stay outstanding while you sign in. Before starting, it closes every live browser session and replaces the stored Chrome profile; it is annotated `destructiveHint: true` for that reason, and a client that gates destructive tools may ask you to approve it first.

```json
{ "name": "setup_auth", "arguments": {} }
```

Verify:

```json
{ "name": "get_health", "arguments": {} }
```

Expect `"authenticated": true`.

### 3. Add a notebook to the local library

Get a NotebookLM share-URL: open the notebook at `notebook.google.com`, click _Share → Anyone with the link → Copy link_. (The legacy `notebooklm.google.com` host still redirects there, and URLs on it are accepted and normalised.) Then:

```json
{
  "name": "add_notebook",
  "arguments": {
    "url": "https://notebook.google.com/notebook/abcd-efgh",
    "name": "n8n Documentation",
    "description": "n8n core docs + builtin nodes",
    "topics": ["workflow automation", "n8n", "node configuration"],
    "use_cases": ["building n8n workflows", "debugging n8n executions"],
    "tags": ["docs", "n8n"]
  }
}
```

### 4. Ask the first question

```json
{
  "name": "ask_question",
  "arguments": {
    "question": "What is the recommended retry pattern for the HTTP Request node?"
  }
}
```

Capture `data.session_id` from the response — you will reuse it for follow-ups. If you later pass a `session_id` this server no longer knows (it expired, or the server restarted), the call does not fail: a new session answers and the result carries a `session_note` telling you the earlier context is gone.

---

## Multi-turn session pattern

Reusing `session_id` keeps NotebookLM's conversational context. The browser session also stays open, so each follow-up is faster.

```json
// 1. Open broad — captures session_id
{ "name": "ask_question", "arguments": {
  "question": "Give me an overview of the n8n error handling architecture."
}}
// → response.session_id = "a3f19c2b"

// 2. Drill in
{ "name": "ask_question", "arguments": {
  "question": "What's the recommended retry/backoff pattern for HTTP nodes?",
  "session_id": "a3f19c2b"
}}

// 3. Edge cases
{ "name": "ask_question", "arguments": {
  "question": "Common pitfalls when retrying webhook-triggered workflows?",
  "session_id": "a3f19c2b"
}}

// 4. Production sample
{ "name": "ask_question", "arguments": {
  "question": "Show me a production example combining retry + circuit-breaker.",
  "session_id": "a3f19c2b"
}}
```

When the task changes, either:

- Reset the same session: `{ "name": "reset_session", "arguments": { "session_id": "a3f19c2b" } }`
- Close it: `{ "name": "close_session", "arguments": { "session_id": "a3f19c2b" } }` — and start a new one with no `session_id`.

Sessions auto-expire after `SESSION_TIMEOUT` seconds of inactivity (default `900` = 15 min).

---

## Citations workflow

Set `source_format` on `ask_question`. Four modes:

### `none` (default)

Raw answer. No `sources` field.

### `inline`

```json
{ "name": "ask_question", "arguments": {
  "question": "How does refresh-token rotation work?",
  "source_format": "inline"
}}
```

`[1]` markers in the answer text get replaced with `(source name — short excerpt)` inline.

### `footnotes`

```json
{ "name": "ask_question", "arguments": {
  "question": "How does refresh-token rotation work?",
  "source_format": "footnotes"
}}
```

Response (abridged):

```jsonc
{
  "answer": "[AI-GENERATED ...] Refresh tokens are rotated on every refresh request [1]. The previous token is revoked server-side [2].\n\nSources:\n[1] auth-spec.pdf — \"Refresh tokens MUST be rotated…\"\n[2] auth-spec.pdf — \"On rotation, the previous token MUST be invalidated…\"",
  "sources": [
    {
      "marker": "[1]",
      "number": 1,
      "sourceName": "auth-spec.pdf",
      "sourceText": "Refresh tokens MUST be rotated…"
    },
    {
      "marker": "[2]",
      "number": 2,
      "sourceName": "auth-spec.pdf",
      "sourceText": "On rotation, the previous token MUST be invalidated…"
    }
  ],
  "source_format": "footnotes"
}
```

The fields are `marker`, `number`, `sourceName`, `sourceText` — `sourceText` is a best-effort excerpt and falls back to `sourceName` when the highlighted passage cannot be read. There is no `url`.

### `json`

Answer text is left untouched. Citations are returned only as a structured array on `sources`. Use this when you want to render citations yourself.

### When nothing comes back

If you asked for citations and none could be read, the result carries a `sources_note` saying so rather than simply omitting `sources` — which used to be indistinguishable from "citations were not requested". Extraction is bounded and never fails the question: a citation problem degrades to a missing excerpt, not a failed `ask_question`.

---

## Audio Overview generation + download

Three steps: generate, poll, download. `generate_audio` is **non-blocking by default** — it returns as soon as generation has been triggered, not when the audio is ready.

### 1. Generate

```json
{
  "name": "generate_audio",
  "arguments": {
    "custom_prompt": "Focus on the migration steps and breaking changes"
  }
}
```

You get back `data.result.status` of `started` (generation kicked off), `in_progress` (one was already running, this call attached to it), or `ready` with `alreadyExisted: true` (one already existed; nothing was triggered). `data.session_id` names the session that did the work — reuse it on the next two calls to skip the 10–15 s page load, and `close_session` it at the end.

To block instead, pass `wait_for_completion: true`; only then is `timeout_ms` read (default 600 000 ms / 10 min, hard-capped at 30 min):

```json
{
  "name": "generate_audio",
  "arguments": { "wait_for_completion": true, "timeout_ms": 900000 }
}
```

### 2. Poll

```json
{ "name": "get_audio_status", "arguments": { "session_id": "a3f19c2b" } }
```

Poll about every 30 s. Real generations run several minutes — roughly 7 minutes was measured live. Keep polling until `data.result.status` is `ready`.

`not_started` does **not** mean nothing is happening: it is also what you get while a generation is running but its tile has not yet appeared. Never read it as permission to trigger a second generation.

### 3. Download

```json
{
  "name": "download_audio",
  "arguments": {
    "destination_dir": "/Users/me/Downloads/notebooklm",
    "session_id": "a3f19c2b"
  }
}
```

`data.result` carries `success`, `filePath` (the absolute path actually written — it can differ from the suggested name when an existing file forced a ` (2)`-style non-clashing name), `bytes` (size on disk of the written file), and an optional `message`. There is no `file_path` field; the key is camelCase.

If you call `download_audio` before the status is `ready`, the call returns an error pointing at `generate_audio`. Run the three steps in order, against the same notebook.

The same three-step shape works for the other implemented Studio outputs via `generate_studio_output` → `get_studio_output_status` → `download_studio_output` (file kinds: `audio`, `video`, `slides`, `infographic`) or `get_studio_output_content` (structured kinds: `mindmap`, `datatable`, `quiz`, `flashcards`). Only `report` is unimplemented.

---

## Multi-account switching

Run two parallel installations against different Google accounts:

```bash
# Terminal A: work account
npx notebooklm-mcp@latest --account work

# Terminal B: personal account
npx notebooklm-mcp@latest --account personal
```

Each account gets its own Chrome profile under `<dataDir>/accounts/<name>/`. The first run for a new account requires its own `setup_auth`. Switching is just a matter of starting the server with a different `--account` flag (or `NOTEBOOKLM_ACCOUNT` env).

Use cases:

- Working notebooks on a corporate Google account, side-projects on a personal one.
- Rotating between two free-tier accounts to extend the daily quota.

There is no shared library between accounts — each account has its own `library.json`. If you want the same library across accounts, copy `library.json` between the two `accounts/<name>/` directories manually.

---

## HTTP transport for n8n / Zapier

Start the server in HTTP mode:

```bash
npx notebooklm-mcp@latest --transport http --port 3000
```

### Security — read before binding to anything but localhost

**The HTTP transport has no authentication and no `Host`/`Origin` validation.** There is no token, no allow-list, no DNS-rebinding protection. Anything that can open a TCP connection to the port has the full tool set: it can read every notebook in the library, spend the account's daily NotebookLM quota, and call `cleanup_data`.

Bind it to `127.0.0.1` (the default) and leave it there, or put it behind a reverse proxy that authenticates before forwarding. `--host 0.0.0.0` exposes an unauthenticated server on every interface — only do it inside a network you fully control, and preferably not even then.

### Routes

The transport serves four routes, not two:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/mcp` | JSON-RPC requests and responses. Creates a session when the body is an `initialize` request; otherwise requires a known `Mcp-Session-Id`. |
| `GET` | `/mcp` | SSE stream for server→client messages. Requires a known `Mcp-Session-Id`. |
| `DELETE` | `/mcp` | Terminate a session. Requires a known `Mcp-Session-Id`. |
| `GET` | `/healthz` | Liveness probe. Returns `{"status":"ok","protocol":"mcp-streamable-http"}` — no version, no auth state. |

Session routing uses the `Mcp-Session-Id` header, read case-insensitively; a value that arrives as an array resolves to its first entry.

Other responses:

- Any path other than `/mcp` or `GET /healthz` → `404` `{"error":"not found","expected":"/mcp"}`.
- Any other method on `/mcp` → `405` with `Allow: POST, GET, DELETE`.
- `GET` / `DELETE` `/mcp` with a missing or unknown session id → `404` `{"error":"unknown session"}`.
- A non-`initialize` `POST /mcp` with no usable session → `400`, telling you to pass `Mcp-Session-Id` or send `initialize`.
- A malformed JSON body, or any unhandled error → `500` `{"error":"internal server error"}`.

Each session gets its **own** MCP `Server` instance. The SDK binds a `Server` to exactly one transport, so re-using one made the second concurrent client fail with "already connected" and receive a 500 — the multi-session support the transport advertised did not actually exist. All real state (browser context, browser sessions, the notebook library) stays shared across sessions.

Limits worth knowing: sessions live only in process memory, so restarting the server invalidates all of them; there is no request size limit, no rate limiting, and no per-session isolation of the underlying Chrome — two HTTP clients share one browser and one NotebookLM account.

### 1. Initialize a session

```bash
curl -i -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "0.0.1" }
    }
  }'
```

Capture the `Mcp-Session-Id` response header. Pass it as a request header on every subsequent call.

### 2. Ask a question

```bash
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Mcp-Session-Id: <session-id-from-step-1>' \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "ask_question",
      "arguments": {
        "question": "What is the n8n Code node best for?",
        "source_format": "footnotes"
      }
    }
  }'
```

The response is the standard MCP `tools/call` envelope. The actual tool output lives under `result.content[0].text` as a JSON string.

### Liveness probe

```bash
curl http://localhost:3000/healthz
# {"status":"ok","protocol":"mcp-streamable-http"}
```

### Notes

- The default bind address is `127.0.0.1`. There is no authentication — see [Security](#security--read-before-binding-to-anything-but-localhost) above before changing it.
- Sessions are kept in process memory; restarting the server invalidates all sessions.
- For n8n, Zapier, and similar HTTP-only callers, an "HTTP Request" node configured with a per-execution session-id store is enough — initialize once at workflow start, reuse the session for the rest of the run, and let the `DELETE /mcp` route close it cleanly at the end.
