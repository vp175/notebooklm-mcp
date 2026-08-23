# MCP 2026-07-28 migration — notebooklm-mcp-fork

Date: 2026-08-23 · Branch: `mcp-v2-2026-07-28`

This server now speaks the **2026-07-28** protocol revision — the stateless one
— while still serving 2025-era clients from the same build.

## What the 2026-07-28 revision is

The short version, because the name "stateless MCP" undersells the change:

| | 2025-06-18 (the era every client here used) | 2026-07-28 |
|---|---|---|
| Connection setup | `initialize` handshake, then `notifications/initialized` | none — every request stands alone |
| Session identity | `Mcp-Session-Id` header (HTTP) | none |
| Discovery | `initialize` result | `server/discover` (mandatory) |
| Protocol version + client capabilities | negotiated once, at `initialize` | carried **per request** in an `_meta` envelope (`io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities`, `…/clientInfo`) |
| Results | bare result | carry `resultType`; list results also carry `ttlMs` / `cacheScope` |
| Tool order | unspecified | must be deterministic |
| Server → client requests (elicitation, sampling, roots) | server sends a JSON-RPC request mid-call | **removed.** The handler *returns* `input_required` with embedded requests; the client answers by **re-calling the tool** with the responses attached |
| Logging (`logging/setLevel`) | supported | deprecated (stderr / OpenTelemetry instead) |

The practical consequence for a server author is that anything relying on
connection-scoped state has to move into the request, and any confirmation
prompt has to become a return value instead of an awaited call.

## What changed here

**Dependencies.** `@modelcontextprotocol/sdk` ^1.30 → `@modelcontextprotocol/server`
2.0.0 (pinned), plus `zod` 4.4.3 (v2 requires ^4.2; nothing in `src/` imports
zod — it was only ever transitive).

**The entry point is what selects the era.** This is the part that is easy to
get wrong: upgrading the package alone puts *no* 2026-07-28 byte on the wire.
A hand-built `Server` + `server.connect(transport)` serves the 2025 era no
matter which package version it came from. The change that matters is:

```ts
// before — 2025 era only
const transport = new StdioServerTransport();
await this.server.connect(transport);

// after — answers server/discover, serves 2026-07-28, still serves 2025
this.stdioHandle = serveStdio(() => this.createConnection().server, { onerror });
```

`legacy` is left at its default, so pre-2026 clients keep working. Every MCP
client on this machine still negotiates 2025-06-18 today; nothing is dropped.

**HTTP transport** was rewritten on `createMcpHandler` — the HTTP-side modern
entry — with a small `node:http` ↔ `fetch` adapter. It builds an instance per
exchange from the same factory, which also retired the hand-rolled session map
whose single shared `Server` crashed every concurrent session after the first
("already connected", surfaced to the client as a 500).

**Elicitation → multi-round-trip.** `remove_notebook` and `cleanup_data` no
longer await a server→client request. They return

```ts
inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema }) } })
```

and read the answer with `acceptedContent(ctx.mcpReq.inputResponses, "confirm")`
when the client re-calls the tool. The SDK's legacy shim converts that same
return value into a real `elicitation/create` request for 2025-era clients, so
one code path serves both eras. `remove_notebook` still fails **closed** on
decline, cancel, or an unreadable answer; `cleanup_data` still falls back to
preview-only.

**Handler registration** moved from schema objects to method strings with a
request context: `setRequestHandler("tools/call", (request, ctx) => …)`.
Progress notifications go through `ctx.mcpReq.notify` so they are correlated
with the request that triggered them.

**Errors**: `McpError(ErrorCode.X, msg)` → `ProtocolError(X, msg)` with the
exported numeric codes.

## The trap that cost the most time

`Server.getClientCapabilities()` returns **undefined** on the modern era —
there was no handshake to populate it. Any capability gate built on it silently
reads "the client cannot do that". Here that gate guarded a destructive tool,
so `remove_notebook` deleted a library entry with no confirmation prompt ever
reaching the client. Verified on the wire: the request envelope carried
`{"elicitation":{}}` while the accessor returned `undefined`.

**Read client capabilities from `ctx.mcpReq.envelope[CLIENT_CAPABILITIES_META_KEY]`,
and treat the accessor as the 2025-era fallback.** Anything else fails open.

A second, smaller trap: the progress token arrives as `0` (the SDK client uses
the JSON-RPC message id, which starts at 0), so `if (progressToken)` drops
every progress notification on the first call of a connection.

## Verification

Era probe (`~/mcp-servers/tools/probe_mcp.py stdio -- node dist/index.js`):

```json
{ "modern": true, "legacy": true,
  "supportedVersions": ["2026-07-28"], "legacyVersion": "2025-06-18",
  "toolCount": 25,
  "toolsListModern": { "resultType": "complete", "ttlMs": 0,
                       "cacheScope": "private", "deterministic": true } }
```

Live end-to-end against the real NotebookLM account, driven by the v2 SDK
client: **36/36 checks pass on the 2026-07-28 era and 36/36 on 2025-06-18** —
tool surface, argument validation, spec error codes, structured results, the
confirmation round-trip (decline and accept-with-false both refuse and the
notebook survives), progress notifications, session/notebook targeting,
citations, and the structured-viewer sequence that used to break every later
Studio call in a session.

`npm run check` (prettier + eslint + tsc) is clean.

## Consumers

The registered command does not change (`node …/dist/index.js`), so
`.claude.json`, Codex and Hermes need no edit for the protocol change itself —
though a running client keeps its old process until it reconnects.
