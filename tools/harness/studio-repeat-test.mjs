import { connect, json, NB } from "./lib.mjs";
const { client, transport } = await connect({ era: process.argv[2] || "auto", name: "studio2" });
const read = async (sid) => {
  const r = await client.callTool(
    { name: "get_studio_output_content", arguments: { output_type: "mindmap", notebook_id: NB.primary, ...(sid ? { session_id: sid } : {}) } },
    { timeout: 240000 }
  );
  const d = json(r).data ?? {};
  const res = d.result ?? {};
  return { ok: res.success, sid: d.session_id, msg: (res.message || "").slice(0, 120), nodes: res.content ? JSON.stringify(res.content).length : 0 };
};
let sid;
for (let i = 1; i <= 4; i++) {
  const r = await read(sid);
  sid = r.sid;
  console.log(`read ${i}: ok=${r.ok} chars=${r.nodes} session=${r.sid} ${r.msg}`);
}
await client.close().catch(()=>{}); await transport.close().catch(()=>{});
process.exit(0);
