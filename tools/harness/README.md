# Live verification harness

Drives `dist/index.js` as a real MCP server over stdio, using the v2 SDK
client, on **either protocol era**. This is how the 2026-07-28 migration and
the fix pass were verified: several of the defects found here — a confirmation
gate that failed open, progress notifications that never fired, a follow-up
question answered with the previous turn's text — are invisible to unit tests
and to code review.

## Run it

```sh
npm run build                       # the harness drives dist/, not src/
node tools/harness/regression.mjs auto     # negotiates 2026-07-28 (modern era)
node tools/harness/regression.mjs legacy   # forces the 2025-06-18 handshake
node tools/harness/http-smoke.mjs          # HTTP transport, both eras
```

Results are printed and written to `tools/harness/out/` (git-ignored).

## What it needs

- **An authenticated NotebookLM account.** `get_health` must report
  `authenticated: true`; run `setup_auth` first otherwise.
- **A free Chrome profile.** The server uses ONE persistent profile, so no
  other instance may hold it — a second Chrome on the same `user_data_dir`
  fails to launch and every browser check fails with
  `Target page, context or browser has been closed`. Close other clients (or
  their browsers) before a run.
- `@modelcontextprotocol/client` (a devDependency).
- Notebook ids that exist in *your* library. The defaults are placeholders;
  set them:

  | env var | used for |
  |---|---|
  | `NBLM_TEST_NOTEBOOK` | the notebook questions are asked against |
  | `NBLM_TEST_NOTEBOOK_B` | a second notebook, to prove a session is not retargeted |
  | `NBLM_TEST_NOTEBOOK_REMOVABLE` | the notebook the `remove_notebook` confirmation test names (it is only ever DECLINED — nothing is removed) |

## What it costs

`regression.mjs` asks four real questions, so it spends four NotebookLM chat
queries per run, and reads a Studio output if one is ready. It never generates
a Studio output (minutes long) and never deletes anything: the destructive
paths are exercised only through decline / confirmed-false, and the suite
asserts the notebook is still there afterwards.

## Reading a failure

Each run writes the server's own stderr to
`tools/harness/out/server-stderr-<name>.log`. That log is usually the fastest
route to the cause — it carries the per-step progress lines, the session
lifecycle, and any selector that failed.
