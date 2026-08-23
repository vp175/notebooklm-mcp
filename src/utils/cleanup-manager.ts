/**
 * Cleanup Manager for NotebookLM MCP Server
 *
 * ULTRATHINK EDITION - Complete cleanup across all platforms!
 *
 * Handles safe removal of:
 * - Legacy data from notebooklm-mcp-nodejs
 * - Current installation data (account-aware, taken from CONFIG)
 * - Browser profiles and session data
 * - NPM/NPX cache
 * - Claude CLI MCP logs (only this server's own `mcp-logs-*notebooklm*` dirs)
 * - Temporary backups
 * - Editor logs (Cursor, VSCode) - optional, opt-in only
 *
 * Explicitly NOT handled, because none of it is this server's data:
 * - Claude Code project directories (`~/.claude/projects/*`) hold the user's
 *   irreplaceable session transcripts, and their names are derived from the
 *   project path — a checkout of this repo produces a directory that matched
 *   the old `*notebooklm-mcp*` glob.
 * - The Recycle Bin / Trash, where deletion is unrecoverable.
 *
 * Every candidate path is checked against an allow-list of roots (see
 * `getAllowedRoots`) both when it is enumerated and again immediately before
 * `fs.rm`, so a sloppy glob can no longer destroy unrelated user data.
 *
 * Platform support: Linux, Windows, macOS
 */

import fs from "fs/promises";
import path from "path";
import { globby } from "globby";
import envPaths from "env-paths";
import os from "os";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";

export type CleanupMode = "legacy" | "all" | "deep";

export interface CleanupResult {
  success: boolean;
  mode: CleanupMode;
  deletedPaths: string[];
  failedPaths: string[];
  totalSizeBytes: number;
  categorySummary: Record<string, { count: number; bytes: number }>;
}

export interface CleanupCategory {
  name: string;
  description: string;
  paths: string[];
  totalBytes: number;
  optional: boolean;
}

interface Paths {
  data: string;
  config: string;
  cache: string;
  log: string;
  temp: string;
}

/**
 * One entry of the deletion allow-list. A candidate path must live inside
 * `base` (or be `base` itself) and satisfy whichever extra name constraints
 * are present, otherwise it is refused.
 */
interface AllowedRoot {
  /** Directory the candidate must be equal to, or live below. */
  base: string;
  /** When set, the candidate's own name must match this. */
  basename?: RegExp;
  /** When set, the first path segment below `base` must match this. */
  firstSegment?: RegExp;
}

/**
 * The only directory names under the Claude CLI cache that belong to this
 * server. Claude CLI writes `<cache>/<project-slug>/mcp-logs-<server-name>`,
 * so anything that is not an `mcp-logs-*notebooklm*` directory is somebody
 * else's data.
 */
const MCP_LOG_DIR_PATTERN = /^mcp-logs-.*notebooklm/i;

export class CleanupManager {
  private legacyPaths: Paths;
  private currentPaths: Paths;
  private homeDir: string;
  private tempDir: string;

  constructor() {
    // envPaths() does NOT create directories - it just returns path strings
    // IMPORTANT: envPaths() has a default suffix 'nodejs', so we must explicitly disable it!

    // Legacy paths with -nodejs suffix (using default suffix behavior)
    this.legacyPaths = envPaths("notebooklm-mcp"); // This becomes notebooklm-mcp-nodejs by default
    // Current paths without suffix (disable the default suffix with empty string)
    this.currentPaths = envPaths("notebooklm-mcp", { suffix: "" });
    // Platform-agnostic paths
    this.homeDir = os.homedir();
    this.tempDir = os.tmpdir();
  }

  // ============================================================================
  // Platform-Specific Path Resolution
  // ============================================================================

  /**
   * Get NPM cache directory (platform-specific)
   */
  private getNpmCachePath(): string {
    return path.join(this.homeDir, ".npm");
  }

  /**
   * Get Claude CLI cache directory (platform-specific)
   *
   * Verified on Windows: the CLI cache lives under LOCALAPPDATA
   * (`%LOCALAPPDATA%\claude-cli-nodejs`), not APPDATA — the sibling
   * `getClaudeProjectsPath()` helper got this wrong and has been removed
   * along with the category that used it.
   */
  private getClaudeCliCachePath(): string {
    const platform = process.platform;

    if (platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || path.join(this.homeDir, "AppData", "Local");
      return path.join(localAppData, "claude-cli-nodejs");
    } else if (platform === "darwin") {
      return path.join(this.homeDir, "Library", "Caches", "claude-cli-nodejs");
    } else {
      // Linux and others
      return path.join(this.homeDir, ".cache", "claude-cli-nodejs");
    }
  }

  /**
   * Get editor config paths (Cursor, VSCode)
   */
  private getEditorConfigPaths(): string[] {
    const platform = process.platform;
    const paths: string[] = [];

    if (platform === "win32") {
      const appData = process.env.APPDATA || path.join(this.homeDir, "AppData", "Roaming");
      paths.push(path.join(appData, "Cursor", "logs"), path.join(appData, "Code", "logs"));
    } else if (platform === "darwin") {
      paths.push(
        path.join(this.homeDir, "Library", "Application Support", "Cursor", "logs"),
        path.join(this.homeDir, "Library", "Application Support", "Code", "logs")
      );
    } else {
      // Linux
      paths.push(
        path.join(this.homeDir, ".config", "Cursor", "logs"),
        path.join(this.homeDir, ".config", "Code", "logs")
      );
    }

    return paths;
  }

  /**
   * Get manual legacy config paths that might not be caught by envPaths
   * This ensures we catch ALL legacy installations including old config.json files
   */
  private getManualLegacyPaths(): string[] {
    const paths: string[] = [];
    const platform = process.platform;

    if (platform === "linux") {
      // Linux-specific paths
      paths.push(
        path.join(this.homeDir, ".config", "notebooklm-mcp"),
        path.join(this.homeDir, ".config", "notebooklm-mcp-nodejs"),
        path.join(this.homeDir, ".local", "share", "notebooklm-mcp"),
        path.join(this.homeDir, ".local", "share", "notebooklm-mcp-nodejs"),
        path.join(this.homeDir, ".cache", "notebooklm-mcp"),
        path.join(this.homeDir, ".cache", "notebooklm-mcp-nodejs"),
        path.join(this.homeDir, ".local", "state", "notebooklm-mcp"),
        path.join(this.homeDir, ".local", "state", "notebooklm-mcp-nodejs")
      );
    } else if (platform === "darwin") {
      // macOS-specific paths
      paths.push(
        path.join(this.homeDir, "Library", "Application Support", "notebooklm-mcp"),
        path.join(this.homeDir, "Library", "Application Support", "notebooklm-mcp-nodejs"),
        path.join(this.homeDir, "Library", "Preferences", "notebooklm-mcp"),
        path.join(this.homeDir, "Library", "Preferences", "notebooklm-mcp-nodejs"),
        path.join(this.homeDir, "Library", "Caches", "notebooklm-mcp"),
        path.join(this.homeDir, "Library", "Caches", "notebooklm-mcp-nodejs"),
        path.join(this.homeDir, "Library", "Logs", "notebooklm-mcp"),
        path.join(this.homeDir, "Library", "Logs", "notebooklm-mcp-nodejs")
      );
    } else if (platform === "win32") {
      // Windows-specific paths
      const localAppData = process.env.LOCALAPPDATA || path.join(this.homeDir, "AppData", "Local");
      const appData = process.env.APPDATA || path.join(this.homeDir, "AppData", "Roaming");
      paths.push(
        path.join(localAppData, "notebooklm-mcp"),
        path.join(localAppData, "notebooklm-mcp-nodejs"),
        path.join(appData, "notebooklm-mcp"),
        path.join(appData, "notebooklm-mcp-nodejs")
      );
    }

    return paths;
  }

  // ============================================================================
  // Safety Guard Rails
  // ============================================================================

  /**
   * The complete set of roots this manager is ever allowed to delete inside.
   *
   * WHY: every candidate previously went straight from a glob into
   * `fs.rm(..., { recursive: true, force: true })`, so one loose pattern was
   * enough to destroy unrelated user data. Nothing outside this list is
   * deletable, regardless of what a finder returns.
   *
   * CONFIG — not a locally recomputed envPaths default — is the source of
   * truth for this server's own directories, because `applyAccountToConfig()`
   * re-roots them under `<dataDir>/accounts/<slug>` when `--account` /
   * `NOTEBOOKLM_ACCOUNT` is active. CONFIG is read here at call time and never
   * captured at module load, since that re-rooting happens during startup.
   */
  private getAllowedRoots(): AllowedRoot[] {
    return [
      // This server's own data/config (account-aware).
      { base: CONFIG.dataDir },
      { base: CONFIG.configDir },
      // envPaths locations CONFIG does not model. `currentPaths.data` is
      // deliberately absent: in default mode CONFIG.dataDir already is that
      // directory, and in account mode it is the shared parent that must stay.
      { base: this.currentPaths.cache },
      { base: this.currentPaths.log },
      { base: this.currentPaths.temp },
      // Legacy (-nodejs suffixed) installation.
      { base: this.legacyPaths.data },
      { base: this.legacyPaths.config },
      { base: this.legacyPaths.cache },
      { base: this.legacyPaths.log },
      { base: this.legacyPaths.temp },
      // Hand-written legacy locations from before envPaths was adopted.
      ...this.getManualLegacyPaths().map((base) => ({ base })),
      // NPX cache: only a `notebooklm-mcp` package directory, never a sibling.
      { base: path.join(this.getNpmCachePath(), "_npx"), basename: /^notebooklm-mcp$/i },
      // Claude CLI cache: only this server's own log directories.
      { base: this.getClaudeCliCachePath(), basename: MCP_LOG_DIR_PATTERN },
      // Editor logs: only individual *notebooklm*.log files.
      ...this.getEditorConfigPaths().map((base) => ({
        base,
        basename: /notebooklm.*\.log$/i,
      })),
      // System temp: only our own `notebooklm-*` backup trees, never the
      // temp directory itself or anyone else's scratch files.
      { base: this.tempDir, firstSegment: /^notebooklm-/i },
    ];
  }

  /**
   * True when `dir` is (or contains) this install's LIVE data or config
   * directory.
   *
   * CRITICAL, platform-specific: `getManualLegacyPaths()` lists the
   * non-suffixed application directories, and on macOS and Linux those ARE the
   * live ones — env-paths only nests a `\Data` / `\Config` subdirectory on
   * Windows (`~/Library/Application Support/notebooklm-mcp` and
   * `~/.local/share/notebooklm-mcp` are `CONFIG.dataDir` itself). Listing them
   * under "Legacy Installation" therefore deleted the live data directory —
   * `library.json` and the Chrome profile included — even when the caller
   * passed `preserve_library: true` and was told "the notebook library will be
   * KEPT". The Windows layout hid it: there the same entry is the PARENT of
   * `dataDir`, which the parent-guard already refuses.
   */
  private isLiveInstallPath(dir: string): boolean {
    const resolved = path.resolve(dir);
    for (const live of [CONFIG.dataDir, CONFIG.configDir]) {
      const liveResolved = path.resolve(live);
      if (resolved === liveResolved) return true;
      if (this.isStrictlyInside(liveResolved, resolved)) return true; // dir contains it
    }
    return false;
  }

  /**
   * True when `child` resolves to a location strictly below `parent`.
   * Uses the relative-path form rather than `startsWith`, which would treat
   * `/data-old` as living inside `/data`.
   */
  private isStrictlyInside(child: string, parent: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /**
   * Decide whether a path may be deleted. Called both while enumerating
   * candidates and again immediately before the irreversible `fs.rm`.
   */
  private isPathAllowed(target: string): { allowed: boolean; reason?: string } {
    const resolved = path.resolve(target);

    // Absolute stops, checked before the allow-list so no entry can widen them.
    if (resolved === path.parse(resolved).root) {
      return { allowed: false, reason: "path resolves to a filesystem root" };
    }
    if (resolved === path.resolve(this.homeDir)) {
      return { allowed: false, reason: "path resolves to the user's home directory" };
    }
    if (resolved === path.resolve(this.tempDir)) {
      return { allowed: false, reason: "path resolves to the system temp directory" };
    }
    // A parent of the live data directory is never deletable: under an account
    // profile that would take every other account's data with it, and in the
    // default layout it would remove the app root out from under CONFIG.
    if (this.isStrictlyInside(CONFIG.dataDir, resolved)) {
      return {
        allowed: false,
        reason: `path is a parent of CONFIG.dataDir (${CONFIG.dataDir})`,
      };
    }

    for (const root of this.getAllowedRoots()) {
      const base = path.resolve(root.base);
      const rel = path.relative(base, resolved);
      const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      if (!inside) continue;

      if (root.basename && !root.basename.test(path.basename(resolved))) continue;

      if (root.firstSegment) {
        const segments = rel.split(path.sep).filter(Boolean);
        if (segments.length === 0 || !root.firstSegment.test(segments[0])) continue;
      }

      return { allowed: true };
    }

    return { allowed: false, reason: "path is outside every allowed cleanup root" };
  }

  /**
   * Allow-list filter used while building the categories.
   *
   * WHY filter at enumeration and not only at delete time: on Windows
   * `getManualLegacyPaths()` lists `%LOCALAPPDATA%\notebooklm-mcp`, which is
   * the parent of CONFIG.dataDir and therefore permanently refused. Listing it
   * anyway would promise a deletion in the preview and then report every deep
   * cleanup as "partial" forever. Its Data/Cache/Log children are still removed
   * by the current-installation category.
   */
  private isSafeCandidate(candidate: string, category: string): boolean {
    const verdict = this.isPathAllowed(candidate);
    if (!verdict.allowed) {
      log.warning(
        `⚠️  Skipping ${category} path outside the cleanup allow-list: ${candidate} (${verdict.reason})`
      );
    }
    return verdict.allowed;
  }

  // ============================================================================
  // Search Methods for Different File Types
  // ============================================================================

  /**
   * Find NPM/NPX cache files
   */
  private async findNpmCache(): Promise<string[]> {
    const found: string[] = [];

    try {
      const npmCachePath = this.getNpmCachePath();
      const npxPath = path.join(npmCachePath, "_npx");

      if (!(await this.pathExists(npxPath))) {
        return found;
      }

      // Search for notebooklm-mcp in npx cache
      const pattern = path.join(npxPath, "*/node_modules/notebooklm-mcp");
      const matches = await globby(pattern, { onlyDirectories: true, absolute: true });
      found.push(...matches);
    } catch (error) {
      log.warning(`⚠️  Error searching NPM cache: ${error}`);
    }

    return found;
  }

  /**
   * Find Claude CLI MCP logs
   */
  private async findClaudeCliLogs(): Promise<string[]> {
    const found: string[] = [];

    try {
      const claudeCliPath = this.getClaudeCliCachePath();

      if (!(await this.pathExists(claudeCliPath))) {
        return found;
      }

      // Search for notebooklm MCP logs, one level below the cache root only.
      //
      // WHY the old top-level `*notebooklm-mcp*` pattern is gone: Claude CLI
      // names its per-project cache directories after the project path, so a
      // checkout of this repo produces `<cache>/C--...-notebooklm-mcp-fork`
      // as a direct child of the cache root. That matched the glob, and the
      // recursive delete would have taken every MCP server's logs for that
      // project — none of which is this server's data. Only an
      // `mcp-logs-*notebooklm*` directory genuinely belongs to us.
      const patterns = [
        path.join(claudeCliPath, "*/mcp-logs-notebooklm*"),
        path.join(claudeCliPath, "*/mcp-logs-*notebooklm-mcp*"),
      ];

      for (const pattern of patterns) {
        const matches = await globby(pattern, { onlyDirectories: true, absolute: true });
        for (const match of matches) {
          // Defence in depth: the pattern alone must not be trusted.
          if (!MCP_LOG_DIR_PATTERN.test(path.basename(match))) {
            log.warning(`⚠️  Ignoring unexpected Claude CLI cache match: ${match}`);
            continue;
          }
          if (!found.includes(match)) {
            found.push(match);
          }
        }
      }
    } catch (error) {
      log.warning(`⚠️  Error searching Claude CLI cache: ${error}`);
    }

    return found;
  }

  /**
   * Find temporary backups
   */
  private async findTemporaryBackups(): Promise<string[]> {
    const found: string[] = [];

    try {
      // Search for notebooklm backup directories in temp
      const pattern = path.join(this.tempDir, "notebooklm-backup-*");
      const matches = await globby(pattern, { onlyDirectories: true, absolute: true });
      found.push(...matches);
    } catch (error) {
      log.warning(`⚠️  Error searching temp backups: ${error}`);
    }

    return found;
  }

  /**
   * Find editor logs (Cursor, VSCode)
   */
  private async findEditorLogs(): Promise<string[]> {
    const found: string[] = [];

    try {
      const editorPaths = this.getEditorConfigPaths();

      for (const editorPath of editorPaths) {
        if (!(await this.pathExists(editorPath))) {
          continue;
        }

        // Search for MCP notebooklm logs
        const pattern = path.join(editorPath, "**/exthost/**/*notebooklm*.log");
        const matches = await globby(pattern, { onlyFiles: true, absolute: true });
        found.push(...matches);
      }
    } catch (error) {
      log.warning(`⚠️  Error searching editor logs: ${error}`);
    }

    return found;
  }

  // ============================================================================
  // Main Cleanup Methods
  // ============================================================================

  /**
   * Get all paths that would be deleted for a given mode (with categorization)
   */
  async getCleanupPaths(
    mode: CleanupMode,
    preserveLibrary: boolean = false
  ): Promise<{
    categories: CleanupCategory[];
    totalPaths: string[];
    totalSizeBytes: number;
  }> {
    const categories: CleanupCategory[] = [];
    const allPaths: Set<string> = new Set();
    let totalSizeBytes = 0;

    // Category 1: Legacy Paths (notebooklm-mcp-nodejs & manual legacy paths)
    if (mode === "legacy" || mode === "all" || mode === "deep") {
      const legacyPaths: string[] = [];
      let legacyBytes = 0;

      // Check envPaths-based legacy directories
      const legacyDirs = [
        this.legacyPaths.data,
        this.legacyPaths.config,
        this.legacyPaths.cache,
        this.legacyPaths.log,
        this.legacyPaths.temp,
      ];

      for (const dir of legacyDirs) {
        if ((await this.pathExists(dir)) && this.isSafeCandidate(dir, "legacy")) {
          const size = await this.getDirectorySize(dir);
          legacyPaths.push(dir);
          legacyBytes += size;
          allPaths.add(dir);
        }
      }

      // CRITICAL: Also check manual legacy paths to catch old config.json files
      // and any paths that envPaths might miss
      const manualLegacyPaths = this.getManualLegacyPaths();
      for (const dir of manualLegacyPaths) {
        // Never let a "legacy" entry name the LIVE install (see
        // `isLiveInstallPath`) — on macOS/Linux they are the same directory,
        // and this category ignores `preserveLibrary`.
        if (this.isLiveInstallPath(dir)) {
          log.dim(`  ↩︎  Skipping ${dir} — it is this install's live data/config directory`);
          continue;
        }
        if (
          (await this.pathExists(dir)) &&
          !allPaths.has(dir) &&
          this.isSafeCandidate(dir, "legacy")
        ) {
          const size = await this.getDirectorySize(dir);
          legacyPaths.push(dir);
          legacyBytes += size;
          allPaths.add(dir);
        }
      }

      if (legacyPaths.length > 0) {
        categories.push({
          name: "Legacy Installation (notebooklm-mcp-nodejs)",
          description: "Old installation data with -nodejs suffix and legacy config files",
          paths: legacyPaths,
          totalBytes: legacyBytes,
          optional: false,
        });
        totalSizeBytes += legacyBytes;
      }
    }

    // Category 2: Current Installation
    if (mode === "all" || mode === "deep") {
      const currentPaths: string[] = [];
      let currentBytes = 0;

      // WHY these come from CONFIG rather than recomputed envPaths defaults:
      // `applyAccountToConfig()` re-roots dataDir and the browser/profile dirs
      // under `<dataDir>/accounts/<slug>` whenever `--account` /
      // `NOTEBOOKLM_ACCOUNT` is used. Reading the defaults here made
      // cleanup_data report success while deleting none of that account's data
      // — and, with preserve_library, delete the account's library.json along
      // with the shared root. cache/log/temp are not modelled by CONFIG, so
      // they still come from envPaths. In a default (no-account) run every
      // entry below resolves to exactly the same path as before.
      //
      // If preserveLibrary is true, don't delete the data directory itself
      // Instead, only delete subdirectories
      const currentDirs = preserveLibrary
        ? [
            // Don't include data directory - library.json lives directly in it
            CONFIG.configDir,
            this.currentPaths.cache,
            this.currentPaths.log,
            this.currentPaths.temp,
            // Only delete subdirectories, not the parent
            CONFIG.browserStateDir,
            CONFIG.chromeProfileDir,
            CONFIG.chromeInstancesDir,
          ]
        : [
            // Delete everything including data directory
            CONFIG.dataDir,
            CONFIG.configDir,
            this.currentPaths.cache,
            this.currentPaths.log,
            this.currentPaths.temp,
            // Specific subdirectories (only if parent doesn't exist)
            CONFIG.browserStateDir,
            CONFIG.chromeProfileDir,
            CONFIG.chromeInstancesDir,
          ];

      for (const dir of currentDirs) {
        if (
          (await this.pathExists(dir)) &&
          !allPaths.has(dir) &&
          this.isSafeCandidate(dir, "current installation")
        ) {
          const size = await this.getDirectorySize(dir);
          currentPaths.push(dir);
          currentBytes += size;
          allPaths.add(dir);
        }
      }

      if (currentPaths.length > 0) {
        const description = preserveLibrary
          ? "Active installation data and browser profiles (library.json will be preserved)"
          : "Active installation data and browser profiles";

        categories.push({
          name: "Current Installation (notebooklm-mcp)",
          description,
          paths: currentPaths,
          totalBytes: currentBytes,
          optional: false,
        });
        totalSizeBytes += currentBytes;
      }
    }

    // Category 3: NPM Cache
    if (mode === "all" || mode === "deep") {
      const npmPaths = (await this.findNpmCache()).filter((p) =>
        this.isSafeCandidate(p, "NPM/NPX cache")
      );
      if (npmPaths.length > 0) {
        let npmBytes = 0;
        for (const p of npmPaths) {
          if (!allPaths.has(p)) {
            npmBytes += await this.getDirectorySize(p);
            allPaths.add(p);
          }
        }

        if (npmBytes > 0) {
          categories.push({
            name: "NPM/NPX Cache",
            description: "NPX cached installations of notebooklm-mcp",
            paths: npmPaths,
            totalBytes: npmBytes,
            optional: false,
          });
          totalSizeBytes += npmBytes;
        }
      }
    }

    // Category 4: Claude CLI Logs
    if (mode === "all" || mode === "deep") {
      const claudeCliPaths = (await this.findClaudeCliLogs()).filter((p) =>
        this.isSafeCandidate(p, "Claude CLI MCP logs")
      );
      if (claudeCliPaths.length > 0) {
        let claudeCliBytes = 0;
        for (const p of claudeCliPaths) {
          if (!allPaths.has(p)) {
            claudeCliBytes += await this.getDirectorySize(p);
            allPaths.add(p);
          }
        }

        if (claudeCliBytes > 0) {
          categories.push({
            name: "Claude CLI MCP Logs",
            description: "MCP server logs from Claude CLI",
            paths: claudeCliPaths,
            totalBytes: claudeCliBytes,
            optional: false,
          });
          totalSizeBytes += claudeCliBytes;
        }
      }
    }

    // Category 5: Temporary Backups
    if (mode === "all" || mode === "deep") {
      const backupPaths = (await this.findTemporaryBackups()).filter((p) =>
        this.isSafeCandidate(p, "temporary backup")
      );
      if (backupPaths.length > 0) {
        let backupBytes = 0;
        for (const p of backupPaths) {
          if (!allPaths.has(p)) {
            backupBytes += await this.getDirectorySize(p);
            allPaths.add(p);
          }
        }

        if (backupBytes > 0) {
          categories.push({
            name: "Temporary Backups",
            description: "Temporary backup directories in system temp",
            paths: backupPaths,
            totalBytes: backupBytes,
            optional: false,
          });
          totalSizeBytes += backupBytes;
        }
      }
    }

    // Category 6: Editor Logs (deep mode only)
    //
    // NOTE: the former "Claude Projects Cache" category lived here and has been
    // removed. It globbed `<claudeProjects>/*notebooklm-mcp*` and recursively
    // deleted the matches, but Claude Code names those directories after the
    // project path — so a checkout of this repo yields
    // `C--...-notebooklm-mcp-fork`, and cleanup_data would have destroyed the
    // user's irreplaceable session transcripts for this very repository.
    if (mode === "deep") {
      const editorPaths = (await this.findEditorLogs()).filter((p) =>
        this.isSafeCandidate(p, "editor log")
      );
      if (editorPaths.length > 0) {
        let editorBytes = 0;
        for (const p of editorPaths) {
          if (!allPaths.has(p)) {
            editorBytes += await this.getFileSize(p);
            allPaths.add(p);
          }
        }

        if (editorBytes > 0) {
          categories.push({
            name: "Editor Logs (Cursor/VSCode)",
            description: "MCP logs from code editors",
            paths: editorPaths,
            totalBytes: editorBytes,
            optional: true,
          });
          totalSizeBytes += editorBytes;
        }
      }
    }

    // NOTE: the former "Trash Files" category lived here and has been removed.
    // It globbed `<Trash>/**/*notebooklm*` and deleted the matches, which is
    // both unrecoverable and not this server's data — the Trash is exactly
    // where a user puts something they may still want to restore.

    return {
      categories,
      totalPaths: Array.from(allPaths),
      totalSizeBytes,
    };
  }

  /**
   * Perform cleanup with safety checks and detailed reporting
   *
   * `includeOptional` defaults to false: optional categories are reported but
   * never deleted unless the caller explicitly opts in.
   */
  async performCleanup(
    mode: CleanupMode,
    preserveLibrary: boolean = false,
    includeOptional: boolean = false
  ): Promise<CleanupResult> {
    log.info(`🧹 Starting cleanup in "${mode}" mode...`);
    if (preserveLibrary) {
      log.info(`📚 Library preservation enabled - library.json will be kept!`);
    }

    const { categories } = await this.getCleanupPaths(mode, preserveLibrary);
    const deletedPaths: string[] = [];
    const failedPaths: string[] = [];
    const categorySummary: Record<string, { count: number; bytes: number }> = {};
    // Only categories we are actually allowed to touch count towards the
    // reported total - previously the skipped bytes were reported as deleted.
    let eligibleSizeBytes = 0;

    // Delete by category
    for (const category of categories) {
      // WHY: `optional` used to log a warning and then delete the category
      // anyway, so opting out was impossible. Optional categories are now
      // skipped unless the caller asks for them.
      if (category.optional && !includeOptional) {
        log.warning(
          `\n⏭️  ${category.name} — skipped (optional): ${category.paths.length} items, ` +
            `${this.formatBytes(category.totalBytes)} left untouched. ` +
            `Pass includeOptional=true to performCleanup() to delete these.`
        );
        categorySummary[`${category.name} — skipped (optional)`] = { count: 0, bytes: 0 };
        continue;
      }

      eligibleSizeBytes += category.totalBytes;

      log.info(
        `\n📦 ${category.name} (${category.paths.length} items, ${this.formatBytes(category.totalBytes)})`
      );

      if (category.optional) {
        log.warning(`  ⚠️  Optional category, explicitly included - ${category.description}`);
      }

      let categoryDeleted = 0;
      let categoryBytes = 0;

      for (const itemPath of category.paths) {
        // Last line of defence before an irreversible recursive delete: a path
        // that is not inside one of this server's own roots never gets removed,
        // however it ended up in the category.
        const verdict = this.isPathAllowed(itemPath);
        if (!verdict.allowed) {
          log.error(`  ⛔ Refusing to delete: ${itemPath} - ${verdict.reason}`);
          failedPaths.push(`${itemPath} (refused: ${verdict.reason})`);
          continue;
        }

        try {
          if (await this.pathExists(itemPath)) {
            const size = await this.getDirectorySize(itemPath);
            log.info(`  🗑️  Deleting: ${itemPath}`);
            await fs.rm(itemPath, { recursive: true, force: true });
            deletedPaths.push(itemPath);
            categoryDeleted++;
            categoryBytes += size;
            log.success(`  ✅ Deleted: ${itemPath} (${this.formatBytes(size)})`);
          }
        } catch (error) {
          log.error(`  ❌ Failed to delete: ${itemPath} - ${error}`);
          failedPaths.push(itemPath);
        }
      }

      categorySummary[category.name] = {
        count: categoryDeleted,
        bytes: categoryBytes,
      };
    }

    const success = failedPaths.length === 0;

    if (success) {
      log.success(
        `\n✅ Cleanup complete! Deleted ${deletedPaths.length} items (${this.formatBytes(eligibleSizeBytes)})`
      );
    } else {
      log.warning(`\n⚠️  Cleanup completed with ${failedPaths.length} errors`);
      log.success(`  Deleted: ${deletedPaths.length} items`);
      log.error(`  Failed: ${failedPaths.length} items`);
    }

    return {
      success,
      mode,
      deletedPaths,
      failedPaths,
      // Excludes skipped optional categories so the figure reflects what this
      // run was actually allowed to delete.
      totalSizeBytes: eligibleSizeBytes,
      categorySummary,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Check if a path exists
   */
  private async pathExists(dirPath: string): Promise<boolean> {
    try {
      await fs.access(dirPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the size of a single file
   */
  private async getFileSize(filePath: string): Promise<number> {
    try {
      const stats = await fs.stat(filePath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  /**
   * Get the total size of a directory (recursive)
   */
  private async getDirectorySize(dirPath: string): Promise<number> {
    try {
      const stats = await fs.stat(dirPath);
      if (!stats.isDirectory()) {
        return stats.size;
      }

      let totalSize = 0;
      const files = await fs.readdir(dirPath);

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const fileStats = await fs.stat(filePath);

        if (fileStats.isDirectory()) {
          totalSize += await this.getDirectorySize(filePath);
        } else {
          totalSize += fileStats.size;
        }
      }

      return totalSize;
    } catch {
      return 0;
    }
  }

  /**
   * Format bytes to human-readable string
   */
  formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  /**
   * Get platform-specific path info
   *
   * `claudeProjectsPath` was removed along with the Claude Projects category:
   * reporting a path this manager deliberately never touches would only invite
   * it back. `currentBasePath` now reflects the live CONFIG, so it shows the
   * account sub-tree when an account profile is active.
   */
  getPlatformInfo(): {
    platform: string;
    legacyBasePath: string;
    currentBasePath: string;
    npmCachePath: string;
    claudeCliCachePath: string;
  } {
    const platform = process.platform;
    let platformName = "Unknown";

    switch (platform) {
      case "win32":
        platformName = "Windows";
        break;
      case "darwin":
        platformName = "macOS";
        break;
      case "linux":
        platformName = "Linux";
        break;
    }

    return {
      platform: platformName,
      legacyBasePath: this.legacyPaths.data,
      currentBasePath: CONFIG.dataDir,
      npmCachePath: this.getNpmCachePath(),
      claudeCliCachePath: this.getClaudeCliCachePath(),
    };
  }
}
