// Prove the critical cleanup fix on SIMULATED macOS / Linux layouts, where the
// "manual legacy" directories are the LIVE data/config dirs (only Windows nests
// a \Data subdirectory). Runs against a throwaway HOME — touches nothing real.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLATFORM = process.argv[2] || "darwin";
const root = fs.mkdtempSync(path.join(os.tmpdir(), `nblm-cleanup-${PLATFORM}-`));
const home = path.join(root, "home");

// Lie about the platform + home BEFORE the modules load and read them.
Object.defineProperty(process, "platform", { value: PLATFORM });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_DATA_HOME = "";
process.env.XDG_CONFIG_HOME = "";
os.homedir = () => home;

const layout =
  PLATFORM === "darwin"
    ? {
        data: path.join(home, "Library", "Application Support", "notebooklm-mcp"),
        config: path.join(home, "Library", "Preferences", "notebooklm-mcp"),
      }
    : {
        data: path.join(home, ".local", "share", "notebooklm-mcp"),
        config: path.join(home, ".config", "notebooklm-mcp"),
      };

fs.mkdirSync(layout.data, { recursive: true });
fs.mkdirSync(layout.config, { recursive: true });
const libraryFile = path.join(layout.data, "library.json");
fs.writeFileSync(libraryFile, JSON.stringify({ notebooks: [{ id: "keep-me" }] }));
// A genuinely legacy dir that SHOULD still be offered for deletion.
const legacyDir =
  PLATFORM === "darwin"
    ? path.join(home, "Library", "Application Support", "notebooklm-mcp-nodejs")
    : path.join(home, ".local", "share", "notebooklm-mcp-nodejs");
fs.mkdirSync(legacyDir, { recursive: true });
fs.writeFileSync(path.join(legacyDir, "old.json"), "{}");

const { CONFIG } = await import("file:///" + process.cwd().replace(/\\/g, "/") + "/dist/config.js");
CONFIG.dataDir = layout.data;
CONFIG.configDir = layout.config;
CONFIG.browserStateDir = path.join(layout.data, "browser_state");
CONFIG.chromeProfileDir = path.join(layout.data, "chrome_profile");
CONFIG.chromeInstancesDir = path.join(layout.data, "chrome_instances");

const { CleanupManager } = await import(
  "file:///" + process.cwd().replace(/\\/g, "/") + "/dist/utils/cleanup-manager.js"
);
const mgr = new CleanupManager();
const preview = await mgr.getCleanupPaths("deep", true); // preserve_library: true

const all = preview.totalPaths.map((p) => path.resolve(p));
// Under preserve_library the DATA dir (which holds library.json) must survive.
// configDir holds settings.json and is legitimately wiped by this mode.
// Fail on a path that IS the live data dir or CONTAINS it — an enumerated
// parent would destroy library.json just as surely as the dir itself, and an
// equality-only check would pass while that happened.
const contains = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const namesLive = all.filter((p) => contains(p, layout.data) || contains(p, libraryFile));
const sawLegacy = all.some((p) => p === path.resolve(legacyDir));

console.log(`platform=${PLATFORM}`);
console.log(`  live data dir : ${layout.data}`);
console.log(`  paths listed  : ${all.length}`);
console.log(
  `  ${namesLive.length === 0 ? "[PASS]" : "[FAIL]"} live DATA dir (holds library.json) NOT listed for deletion` +
    (namesLive.length ? ` — would delete ${namesLive.join(", ")}` : "")
);
console.log(`  ${sawLegacy ? "[PASS]" : "[FAIL]"} genuinely-legacy -nodejs dir still offered (positive control)`);
console.log(`  library.json still on disk: ${fs.existsSync(libraryFile)}`);

fs.rmSync(root, { recursive: true, force: true });
// `sawLegacy` is a HARD requirement, not a warning: without it a broken
// platform/homedir stub enumerates nothing and the test passes vacuously.
process.exit(namesLive.length === 0 && sawLegacy ? 0 : 1);
