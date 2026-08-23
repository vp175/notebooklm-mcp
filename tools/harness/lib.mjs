// v2-SDK harness: drives dist/index.js over stdio, on either protocol era.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** Repo root, derived from this file's location — no machine-specific paths. */
export const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Where run artefacts land. Git-ignored. */
export const OUT = path.join(PROJECT, "tools", "harness", "out");
fs.mkdirSync(OUT, { recursive: true });

/**
 * Notebook ids the live suite drives. Override per machine with
 * NBLM_TEST_NOTEBOOK / NBLM_TEST_NOTEBOOK_B — the defaults are placeholders that
 * will not exist in any library — set them to ids from yours.
 */
export const NB = {
  primary: process.env.NBLM_TEST_NOTEBOOK || "your-primary-notebook-id",
  removable: process.env.NBLM_TEST_NOTEBOOK_REMOVABLE || "your-removable-notebook-id",
  secondary: process.env.NBLM_TEST_NOTEBOOK_B || "your-secondary-notebook-id",
};

export const CALL_TIMEOUT = 240_000;

/**
 * @param {object} o
 * @param {"auto"|"legacy"} [o.era] "auto" probes for 2026-07-28; "legacy" forces the old handshake.
 */
export async function connect({ era = "auto", name = "h2", elicitation = true } = {}) {
  const stderrPath = path.join(OUT, `server-stderr-${name}.log`);
  fs.writeFileSync(stderrPath, "");
  const stderrFd = fs.openSync(stderrPath, "a");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT, "dist", "index.js")],
    cwd: PROJECT,
    stderr: "pipe",
  });

  const client = new Client(
    { name, version: "0.1" },
    {
      capabilities: elicitation ? { elicitation: {} } : {},
      ...(era === "auto" ? { versionNegotiation: { mode: "auto" } } : {}),
    }
  );

  // Answer confirmation prompts (both eras route through this handler: on
  // 2026-07-28 the client auto-fulfils an input_required result from it).
  const elicit = { mode: "decline", log: [] };
  if (elicitation) {
    client.setRequestHandler("elicitation/create", async (request) => {
      elicit.log.push({ message: request.params?.message, mode: elicit.mode });
      if (elicit.mode === "accept") return { action: "accept", content: { confirmed: true } };
      if (elicit.mode === "accept-false") return { action: "accept", content: { confirmed: false } };
      if (elicit.mode === "cancel") return { action: "cancel" };
      return { action: "decline" };
    });
  }

  await client.connect(transport);
  transport.stderr?.on("data", (d) => fs.writeSync(stderrFd, d));
  const eraServed = typeof client.getProtocolEra === "function" ? client.getProtocolEra() : "?";
  return { client, transport, elicit, era: eraServed, stderrPath };
}

export function json(res) {
  try {
    return JSON.parse(res.content?.[0]?.text ?? "{}");
  } catch {
    return {};
  }
}

export function makeReporter(label) {
  const checks = [];
  const ok = (name, cond, detail) => {
    checks.push({ name, ok: !!cond, detail });
    const d = detail === undefined ? "" : " — " + String(detail).replace(/\s+/g, " ").slice(0, 260);
    console.log(`${cond ? "[PASS]" : "[FAIL]"} ${name}${d}`);
  };
  const finish = () => {
    const pass = checks.filter((c) => c.ok).length;
    const fail = checks.filter((c) => !c.ok);
    fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(checks, null, 2));
    console.log(`\n== ${label}: ${pass} pass, ${fail.length} fail`);
    for (const f of fail) console.log(`   FAIL: ${f.name} :: ${String(f.detail).slice(0, 200)}`);
  };
  return { ok, finish, checks };
}
