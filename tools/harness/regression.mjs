// Full regression on the v2 client. Runs against whichever era is asked for:
//   node regress2.mjs auto     -> negotiates 2026-07-28 (modern)
//   node regress2.mjs legacy   -> forces the 2025-06-18 handshake
import { connect, json, makeReporter, NB, CALL_TIMEOUT } from "./lib.mjs";

const era = process.argv[2] || "auto";
const { ok, finish } = makeReporter(`regress2-${era}`);
const { client, transport, elicit, era: served } = await connect({ era, name: `regress2-${era}` });

ok(`protocol era is ${era === "auto" ? "modern" : "legacy"}`, served === (era === "auto" ? "modern" : "legacy"), served);

try {
  // ---------- surface ----------
  const list = await client.listTools();
  ok("tools/list returns 25 tools", list.tools.length === 25, list.tools.length);
  const withOutput = list.tools.filter((t) => t.outputSchema).map((t) => t.name).sort();
  ok(
    "outputSchema on exactly the 5 structured tools",
    withOutput.join(",") ===
      "get_health,get_library_stats,get_studio_output_content,get_studio_output_status,list_sessions",
    withOutput.join(",")
  );
  const order1 = list.tools.map((t) => t.name).join(",");
  const order2 = (await client.listTools()).tools.map((t) => t.name).join(",");
  ok("tools/list order is deterministic", order1 === order2);

  const prompts = await client.listPrompts();
  ok("prompts/list has both auth prompts", prompts.prompts.length === 2, prompts.prompts.map((p) => p.name).join(","));
  const res = await client.listResources();
  ok("resources/list non-empty", res.resources.length > 0, res.resources.length);

  // ---------- argument validation ----------
  let r = await client.callTool({ name: "add_notebook", arguments: { url: "https://example.com/x" } });
  ok("missing required args rejected", json(r).success === false, json(r).error);

  r = await client.callTool({
    name: "add_notebook",
    arguments: { url: "https://example.com/x", name: "bogus", description: "d", topics: ["t"] },
  });
  ok("non-NotebookLM URL rejected", json(r).success === false, json(r).error);

  r = await client.callTool({ name: "get_studio_output_status", arguments: {} });
  ok("missing output_type rejected + isError", json(r).success === false && r.isError === true, json(r).error);

  r = await client.callTool({ name: "get_studio_output_status", arguments: { output_type: "bogus" } });
  ok("invalid enum rejected", /one of/i.test(json(r).error || ""), json(r).error);

  r = await client.callTool({ name: "cleanup_data", arguments: { confirm: "yes" } });
  ok("non-boolean confirm rejected", json(r).success === false, json(r).error);

  let threw = null;
  try {
    await client.callTool({ name: "no_such_tool", arguments: {} });
  } catch (e) {
    threw = String(e);
  }
  ok("unknown tool → JSON-RPC error", threw !== null, threw);

  // ---------- structured results ----------
  r = await client.callTool({ name: "get_health", arguments: {} });
  ok("get_health structuredContent", !!r.structuredContent);
  ok("get_health authenticated", json(r).data?.authenticated === true);
  r = await client.callTool({ name: "get_library_stats", arguments: {} });
  ok("get_library_stats structuredContent", !!r.structuredContent, json(r).data?.total_notebooks);
  r = await client.callTool({ name: "list_sessions", arguments: {} });
  ok("list_sessions structuredContent", !!r.structuredContent);

  // ---------- spec error codes ----------
  let code = null;
  try {
    await client.getPrompt({ name: "notebooklm.nope" });
  } catch (e) {
    code = e?.code ?? String(e);
  }
  ok("unknown prompt → -32602", code === -32602, code);
  code = null;
  try {
    await client.readResource({ uri: "notebooklm://library/does-not-exist" });
  } catch (e) {
    code = e?.code ?? String(e);
  }
  ok("unknown resource → -32602", code === -32602, code);

  // ---------- confirmation round-trip (input_required / elicitation) ----------
  // Decline: the notebook must survive.
  elicit.mode = "decline";
  r = await client.callTool({ name: "remove_notebook", arguments: { id: NB.removable } }, { timeout: 60_000 });
  ok("remove_notebook declined → refused", json(r).success === false, json(r).error);
  ok("decline reached the client", elicit.log.length > 0, `${elicit.log.length} prompt(s)`);
  let still = await client.callTool({ name: "get_notebook", arguments: { id: NB.removable } });
  ok("notebook survived the decline", json(still).success === true, json(still).data?.notebook?.name);

  // Accept-with-false: same refusal, different path.
  elicit.mode = "accept-false";
  r = await client.callTool({ name: "remove_notebook", arguments: { id: NB.removable } }, { timeout: 60_000 });
  ok("remove_notebook confirmed:false → refused", json(r).success === false, json(r).error);
  still = await client.callTool({ name: "get_notebook", arguments: { id: NB.removable } });
  ok("notebook still present", json(still).success === true);

  // cleanup_data preview must NOT delete when declined.
  elicit.mode = "decline";
  r = await client.callTool(
    { name: "cleanup_data", arguments: { confirm: false, preserve_library: true } },
    { timeout: 120_000 }
  );
  ok("cleanup_data declined → preview only", json(r).data?.status === "preview", json(r).data?.status);

  // ---------- live ask (progress + session targeting + citations) ----------
  const progress = [];
  r = await client.callTool(
    { name: "ask_question", arguments: { question: "In one short sentence, what is this notebook about?", notebook_id: NB.primary } },
    { timeout: CALL_TIMEOUT, onprogress: (p) => progress.push(p.message) }
  );
  const d1 = json(r).data ?? {};
  ok("ask_question succeeded", json(r).success === true, (d1.answer || json(r).error || "").slice(0, 100));
  ok("progress notifications received", progress.length > 0, progress.length);
  const sid = d1.session_id;
  const nbUrl = d1.notebook_url;

  await client.callTool({ name: "select_notebook", arguments: { id: NB.secondary } });
  const r2 = await client.callTool(
    { name: "ask_question", arguments: { question: "Name one specific thing from the sources.", session_id: sid } },
    { timeout: CALL_TIMEOUT }
  );
  const d2 = json(r2).data ?? {};
  ok("follow-up stays on the session's notebook", d2.notebook_url === nbUrl, `${nbUrl} vs ${d2.notebook_url}`);
  ok("follow-up reuses the session", d2.session_id === sid, `${sid} → ${d2.session_id}`);
  const refused = (t) => /can.t answer this question|try rephrasing/i.test(t || "");
  ok(
    "follow-up is a fresh answer (or NotebookLM declined both)",
    (d2.answer || "") !== (d1.answer || "") || (refused(d1.answer) && refused(d2.answer)),
    refused(d2.answer) ? "notebook declined both questions" : (d2.answer || "").slice(0, 80)
  );

  const r3 = await client.callTool(
    { name: "ask_question", arguments: { question: "Say ok.", session_id: "deadbeef", notebook_id: NB.primary } },
    { timeout: CALL_TIMEOUT }
  );
  ok("stale session_id reported", !!json(r3).data?.session_note, json(r3).data?.session_note);

  const r4 = await client.callTool(
    { name: "ask_question", arguments: { question: "Summarise the sources in one sentence.", notebook_id: NB.secondary, source_format: "json" } },
    { timeout: CALL_TIMEOUT }
  );
  const d4 = json(r4).data ?? {};
  ok(
    "citations returned or explicitly absent",
    Array.isArray(d4.sources) ? d4.sources.length > 0 : !!d4.sources_note,
    Array.isArray(d4.sources) ? `${d4.sources.length}: ${JSON.stringify(d4.sources[0]).slice(0, 120)}` : d4.sources_note
  );

  // ---------- studio status + viewer-state regression ----------
  const st = await client.callTool(
    { name: "get_studio_output_status", arguments: { output_type: "mindmap", notebook_id: NB.primary } },
    { timeout: 120_000 }
  );
  ok("mindmap status probe", json(st).success === true, JSON.stringify(json(st).data?.result));
  if (json(st).data?.result?.status === "ready") {
    const c1 = await client.callTool(
      { name: "get_studio_output_content", arguments: { output_type: "mindmap", notebook_id: NB.primary } },
      { timeout: 240_000 }
    );
    ok("mindmap content read", json(c1).success === true, JSON.stringify(json(c1).data?.result).slice(0, 120));
    // THE regression: a second structured read in the same session used to fail
    // because the first viewer was never closed.
    const c2 = await client.callTool(
      { name: "get_studio_output_content", arguments: { output_type: "mindmap", notebook_id: NB.primary, session_id: json(c1).data?.session_id } },
      { timeout: 240_000 }
    );
    ok("second structured read in the same session works", json(c2).success === true, JSON.stringify(json(c2).data?.result).slice(0, 120));
    const st2 = await client.callTool(
      { name: "get_studio_output_status", arguments: { output_type: "mindmap", notebook_id: NB.primary, session_id: json(c1).data?.session_id } },
      { timeout: 120_000 }
    );
    ok("status still correct after content reads", json(st2).data?.result?.status === "ready", JSON.stringify(json(st2).data?.result));
  }

  // ---------- cleanup ----------
  const sess = json(await client.callTool({ name: "list_sessions", arguments: {} })).data ?? {};
  for (const s of sess.sessions ?? []) {
    await client.callTool({ name: "close_session", arguments: { session_id: s.id } });
  }
  const after = json(await client.callTool({ name: "list_sessions", arguments: {} })).data ?? {};
  ok("all sessions closed", after.active_sessions === 0, after.active_sessions);
} catch (e) {
  ok("suite ran to completion", false, String(e).slice(0, 400));
} finally {
  try {
    await client.callTool({ name: "select_notebook", arguments: { id: NB.secondary } });
  } catch {}
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

finish();
process.exit(0);
