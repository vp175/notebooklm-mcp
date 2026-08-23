// Smoke the rewritten HTTP transport: healthz, a modern server/discover, a
// modern tools/list, a legacy initialize, and two CONCURRENT sessions (the
// case that used to 500 with "already connected").
import { spawn } from "node:child_process";

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 39117;
const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js"), "--transport", "http", "--port", String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, HEADLESS: "true" },
  stdio: ["pipe", "pipe", "pipe"],
});
const errs = [];
child.stderr.on("data", (d) => errs.push(d.toString()));

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "smoke", version: "0" },
};

const post = async (body, headers = {}) => {
  // The 2026-07-28 revision requires the method to be echoed in a header
  // (SEP-2243); the server rejects a mismatch/absence with 400 by design.
  if (body?.method && !("Mcp-Method" in headers)) headers["Mcp-Method"] = body.method;
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, ct: res.headers.get("content-type"), text };
};

const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`);
};

// wait for the listener
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    if (r.ok) {
      ok("GET /healthz", true, await r.text());
      up = true;
      break;
    }
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!up) ok("GET /healthz", false, "never came up");

if (up) {
  const notFound = await fetch(`http://127.0.0.1:${PORT}/nope`);
  ok("unknown route → 404", notFound.status === 404, notFound.status);

  const disc = await post({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } });
  ok(
    "modern server/discover → 2026-07-28",
    disc.text.includes("2026-07-28"),
    `${disc.status} ${disc.text.slice(0, 120)}`
  );

  const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META } });
  const count = (tools.text.match(/"name":/g) || []).length;
  ok("modern tools/list returns tools", count > 20, `${tools.status}, ~${count} name fields`);

  const init = await post({
    jsonrpc: "2.0",
    id: 3,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "0" } },
  });
  ok("legacy initialize served", init.text.includes("2025-06-18"), `${init.status} ${init.text.slice(0, 100)}`);

  // Two concurrent modern exchanges — the old code crashed the second one.
  const [a, b] = await Promise.all([
    post({ jsonrpc: "2.0", id: 10, method: "tools/list", params: { _meta: META } }),
    post({ jsonrpc: "2.0", id: 11, method: "tools/list", params: { _meta: META } }),
  ]);
  // Parse the payload (JSON or SSE-framed) and check the JSON-RPC members —
  // several tool output schemas legitimately declare an `error` property, so a
  // substring test is meaningless here.
  const parsed = (t) => {
    const line = t.split(String.fromCharCode(10)).find((l) => l.startsWith("data: ")) ?? t;
    try {
      return JSON.parse(line.replace(/^data: /, ""));
    } catch {
      return null;
    }
  };
  const okRpc = (t) => {
    const j = parsed(t);
    return !!j && j.error === undefined && j.result !== undefined;
  };
  ok(
    "two concurrent sessions both succeed",
    a.status === 200 && b.status === 200 && okRpc(a.text) && okRpc(b.text),
    `${a.status}/${b.status}`
  );

}

child.kill();
await new Promise((r) => setTimeout(r, 800));
const fail = results.filter((r) => !r.ok);
console.log(`\n== http-smoke: ${results.length - fail.length} pass, ${fail.length} fail`);
if (fail.length) {
  const tail = errs.join("").replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(-15).join("\n");
  console.log("--- server stderr tail ---\n" + tail);
}
process.exit(0);
