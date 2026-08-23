// Prove the listener unsubscribe: run N HTTP exchanges and assert the shared
// library's listener count does not grow. Uses an in-process import so the
// private list can be counted.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { NotebookLibrary } = await import(pathToFileURL(path.join(REPO, "dist", "library", "notebook-library.js")).href);
const { ResourceHandlers } = await import(pathToFileURL(path.join(REPO, "dist", "resources", "resource-handlers.js")).href);
const { Server } = await import("@modelcontextprotocol/server");

const lib = new NotebookLibrary();
const rh = new ResourceHandlers(lib);
const count = () => lib.changeListeners.length;

console.log("listeners at start:", count());
const servers = [];
for (let i = 0; i < 25; i++) {
  const s = new Server({ name: "t", version: "0" }, { capabilities: { resources: { listChanged: true }, prompts: {}, completions: {}, tools: {} } });
  rh.registerHandlers(s);
  servers.push(s);
}
console.log("after 25 registrations:", count());
for (const s of servers) s.onclose?.();
console.log("after 25 closes:", count(), count() === 0 ? "[PASS] released" : "[FAIL] leaked");
process.exit(count() === 0 ? 0 : 1);
