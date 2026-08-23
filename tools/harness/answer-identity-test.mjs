// The two hard cases for the answer wait, in one session:
//  A/B: the SAME question twice -> identical answers are legitimate; must not
//       hang and must not be rejected as "prior".
//  C:   a DIFFERENT question -> must not return A/B's text.
import { connect, json, NB, CALL_TIMEOUT } from "./lib.mjs";
const { client, transport } = await connect({ era: "auto", name: "repeat" });
const ask = async (q, session_id) => {
  const t = Date.now();
  const r = await client.callTool(
    { name: "ask_question", arguments: { question: q, ...(session_id ? { session_id } : { notebook_id: NB.primary }) } },
    { timeout: CALL_TIMEOUT }
  );
  const d = json(r).data ?? {};
  return { ms: Date.now() - t, ok: json(r).success, answer: (d.answer || "").trim(), sid: d.session_id };
};
const Q = "Reply with exactly this and nothing else: alpha.";
const a = await ask(Q);
console.log(`A ${a.ms}ms ok=${a.ok} len=${a.answer.length}`);
const b = await ask(Q, a.sid);
console.log(`B ${b.ms}ms ok=${b.ok} len=${b.answer.length} identical=${a.answer === b.answer}`);
const c = await ask("Reply with exactly this and nothing else: bravo.", a.sid);
console.log(`C ${c.ms}ms ok=${c.ok} len=${c.answer.length} sameAsB=${c.answer === b.answer}`);
console.log(`\n[${b.ok && b.ms < 120000 ? "PASS" : "FAIL"}] repeated question answered without hanging`);
console.log(`[${c.answer !== b.answer ? "PASS" : "FAIL"}] different question got a different answer`);
await client.close().catch(()=>{}); await transport.close().catch(()=>{});
process.exit(0);
