/**
 * NotebookLM Library Manager
 *
 * Manages a persistent library of NotebookLM notebooks.
 * Allows Claude to autonomously add, remove, and switch between
 * multiple notebooks based on the task at hand.
 *
 * library.json is shared state: several MCP server processes (Claude, Codex,
 * Hermes, …) routinely run against the same data dir at the same time. Every
 * mutation therefore goes through `mutate()`, which re-reads the file, applies
 * the change to that fresh state, and writes it back atomically under a
 * best-effort lock — never over a stale in-memory snapshot.
 */

import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { log } from "../utils/logger.js";
import type {
  NotebookEntry,
  Library,
  AddNotebookInput,
  UpdateNotebookInput,
  LibraryStats,
} from "./types.js";

/**
 * Extract the notebook UUID from a NotebookLM/Gemini Notebook URL, e.g.
 * "https://notebook.google.com/notebook/<uuid>" or the legacy
 * "https://notebooklm.google.com/notebook/<uuid>?authuser=0". Used to dedupe
 * discovered notebooks against the library by identity, not by name/title
 * (titles can collide or get renamed in the account after being registered).
 */
export function extractNotebookId(url: string): string | null {
  const match = url.match(/\/notebook\/([a-f0-9-]{36})/i);
  return match ? match[1] : null;
}

/** Current host, plus the legacy one Google still redirects from. */
const NOTEBOOK_HOSTS = ["notebook.google.com", "notebooklm.google.com"] as const;
const CANONICAL_NOTEBOOK_HOST = "notebook.google.com";
const NOTEBOOK_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quoted in every rejection message so the caller knows what is accepted. */
export const NOTEBOOK_URL_FORMAT = "https://notebook.google.com/notebook/<uuid>";

/**
 * Validate + canonicalise a notebook URL.
 *
 * A stored URL is not inert data: sessions navigate the *authenticated*
 * persistent Chrome profile to it, so an arbitrary string here means "drive a
 * logged-in browser to an attacker's origin". Only https on the two known
 * hosts with a `/notebook/<uuid>` path is accepted; the legacy host is
 * normalised to notebook.google.com and query/hash are dropped, so the same
 * notebook always canonicalises to exactly one string (which is what dedupe
 * by identity relies on).
 *
 * Returns null for anything else — other hosts, http://, javascript:, file:,
 * userinfo/port tricks, path traversal, or a missing/invalid UUID.
 */
export function parseNotebookUrl(raw: string): { url: string; notebookId: string } | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null; // not an absolute URL at all
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null; // https://notebook.google.com@evil/
  if (parsed.port !== "") return null;
  if (!NOTEBOOK_HOSTS.includes(parsed.hostname.toLowerCase() as (typeof NOTEBOOK_HOSTS)[number])) {
    return null; // exact host match — rejects notebook.google.com.evil.com
  }

  // `new URL` has already resolved "..", so traversal cannot survive this match.
  const match = parsed.pathname.match(/^\/notebook\/([^/]+)\/?$/);
  if (!match) return null;

  const notebookId = match[1].toLowerCase();
  if (!NOTEBOOK_UUID_PATTERN.test(notebookId)) return null;

  return { url: `https://${CANONICAL_NOTEBOOK_HOST}/notebook/${notebookId}`, notebookId };
}

/** parseNotebookUrl, but throwing the caller-facing error message. */
function requireNotebookUrl(raw: string): { url: string; notebookId: string } {
  const parsed = parseNotebookUrl(raw);
  if (!parsed) {
    throw new Error(
      `Invalid notebook URL: ${JSON.stringify(raw)}. Expected ${NOTEBOOK_URL_FORMAT} ` +
        `(the legacy host https://notebooklm.google.com/notebook/<uuid> is accepted and normalised).`
    );
  }
  return parsed;
}

/**
 * Identity key for dedupe. Prefers the strict parse, but falls back to the
 * loose extractor so entries written by older versions (odd query strings,
 * legacy host) still dedupe against a freshly parsed URL.
 */
function notebookKey(url: string | undefined): string | null {
  if (typeof url !== "string") return null;
  const parsed = parseNotebookUrl(url);
  if (parsed) return parsed.notebookId;
  const loose = extractNotebookId(url);
  return loose ? loose.toLowerCase() : null;
}

/**
 * Slug id from a name, made unique against `taken` and reserved in it.
 * Collisions get -2, -3, … so ids stay unique *and* stable: an id already
 * belonging to another notebook is never handed out twice.
 */
function generateUniqueId(name: string, taken: Set<string>): string {
  const base =
    (typeof name === "string" ? name : "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 30) || "notebook";

  let id = base;
  let counter = 2;
  while (taken.has(id)) {
    id = `${base}-${counter}`;
    counter++;
  }
  taken.add(id);
  return id;
}

/**
 * Coerce whatever was on disk into a usable Library. Throws when the file is
 * not a library at all (caller quarantines); tolerates missing/odd optional
 * fields and preserves unknown top-level keys so a newer schema round-trips.
 */
function normalizeLibrary(parsed: unknown): Library {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("library.json does not contain a JSON object");
  }

  const obj = parsed as Partial<Library> & Record<string, unknown>;
  if (!Array.isArray(obj.notebooks)) {
    throw new Error("library.json has no `notebooks` array");
  }

  const notebooks = obj.notebooks.filter(
    (n): n is NotebookEntry =>
      !!n && typeof n === "object" && typeof (n as NotebookEntry).id === "string"
  );
  if (notebooks.length !== obj.notebooks.length) {
    log.warning(
      `  ⚠️  Dropped ${obj.notebooks.length - notebooks.length} malformed notebook entr(ies) from library.json`
    );
  }

  return {
    ...obj,
    notebooks,
    active_notebook_id: typeof obj.active_notebook_id === "string" ? obj.active_notebook_id : null,
    last_modified:
      typeof obj.last_modified === "string" ? obj.last_modified : new Date().toISOString(),
    version: typeof obj.version === "string" ? obj.version : "1.0.0",
  };
}

/** Blocking sleep — the whole read-modify-write path is synchronous fs. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_STALE_MS = 10_000; // holder is presumed crashed after this
const LOCK_WAIT_MS = 2_000; // then give up and proceed lock-free
const LOCK_RETRY_MS = 50;
const RENAME_RETRIES = 3; // Windows: AV/indexer can hold the target briefly
const RENAME_RETRY_MS = 50;
const READ_RETRIES = 3;

export class NotebookLibrary {
  private libraryPath: string;
  private lockPath: string;
  private library: Library;
  private changeListeners: Array<() => void> = [];
  /**
   * Set when library.json could not be read AND could not be moved aside.
   * While set, every save refuses rather than overwriting a file that may
   * still hold the only copy of the user's notebooks. Cleared by any later
   * successful read (self-heals once the file is readable again).
   */
  private saveBlockedReason: string | null = null;

  /** Register a callback fired after every successful library mutation. */
  onChange(cb: () => void): void {
    this.changeListeners.push(cb);
  }

  private notifyChanged(): void {
    for (const cb of this.changeListeners) {
      try {
        cb();
      } catch (error) {
        log.warning(`  ⚠️  Library change listener threw: ${error}`);
      }
    }
  }

  constructor() {
    this.libraryPath = path.join(CONFIG.dataDir, "library.json");
    this.lockPath = path.join(CONFIG.dataDir, "library.lock");
    this.library = this.bootstrapLibrary();

    log.info("📚 NotebookLibrary initialized");
    log.info(`  Library path: ${this.libraryPath}`);
    log.info(`  Notebooks: ${this.library.notebooks.length}`);
    if (this.library.active_notebook_id) {
      log.info(`  Active: ${this.library.active_notebook_id}`);
    }
  }

  /**
   * Load the library at startup, creating the default one if there is nothing
   * on disk yet. Must never throw: a bad NOTEBOOK_URL or an unwritable data
   * dir used to take the whole server down before it finished starting.
   */
  private bootstrapLibrary(): Library {
    try {
      fs.mkdirSync(path.dirname(this.libraryPath), { recursive: true });
    } catch (error) {
      log.warning(`  ⚠️  Could not create data dir ${path.dirname(this.libraryPath)}: ${error}`);
    }

    const onDisk = this.readLibraryFromDisk();
    if (onDisk) {
      log.success(`  ✅ Loaded library with ${onDisk.notebooks.length} notebooks`);
      return onDisk;
    }

    log.info("  🆕 Creating new library...");
    return this.withLock(() => {
      // Re-check under the lock: a second process starting at the same moment
      // may have just written the default library, and we must not clobber it.
      const raced = this.readLibraryFromDisk();
      if (raced) {
        log.info("  ↩️  Another process created the library first — using it");
        return raced;
      }

      const created = this.createDefaultLibrary();
      if (this.saveBlockedReason) {
        log.error(`  ❌ Not writing a fresh library: ${this.saveBlockedReason}`);
        return created;
      }
      try {
        this.writeLibraryAtomic(created);
        log.success(`  💾 Library created (${created.notebooks.length} notebooks)`);
      } catch (error) {
        // Starting read-only beats not starting at all (mutations will report).
        log.error(`  ❌ Failed to write new library: ${error}`);
      }
      return created;
    });
  }

  /**
   * Read + validate library.json.
   * Returns null when there is nothing usable on disk. A file that exists but
   * cannot be read or parsed is moved aside first (never silently discarded —
   * that is how a whole library used to disappear on the next save).
   */
  private readLibraryFromDisk(): Library | null {
    let raw: string | null = null;

    for (let attempt = 1; attempt <= READ_RETRIES; attempt++) {
      try {
        raw = fs.readFileSync(this.libraryPath, "utf-8");
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null; // first run / freshly wiped data dir
        if (attempt === READ_RETRIES) {
          this.quarantineCorruptFile(`unreadable (${error})`);
          return null;
        }
        sleepSync(RENAME_RETRY_MS); // transient lock (AV, concurrent writer)
      }
    }

    try {
      const library = normalizeLibrary(JSON.parse(raw as string));
      this.saveBlockedReason = null; // file is readable again
      return library;
    } catch (error) {
      this.quarantineCorruptFile(`unparseable (${error})`);
      return null;
    }
  }

  /**
   * Move a damaged library.json aside so the next save cannot overwrite it.
   * If even that fails, block saving entirely — an in-memory empty library
   * must never be allowed to replace the only copy of the user's notebooks.
   */
  private quarantineCorruptFile(reason: string): void {
    // ISO timestamps contain ':' and '.', which are illegal in Windows filenames.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(path.dirname(this.libraryPath), `library.corrupt-${stamp}.json`);

    log.error(`  ❌ library.json is ${reason}`);
    try {
      renameWithRetry(this.libraryPath, target);
      this.saveBlockedReason = null;
      log.error(
        `  🚑 Damaged library moved to ${target} — continuing with an EMPTY library. ` +
          `Your notebooks are still in that file; recover them before re-registering.`
      );
    } catch (error) {
      this.saveBlockedReason =
        `library.json is ${reason} and could not be moved aside to ${target} (${error}). ` +
        `Refusing to save over it — fix or move the file by hand, then retry.`;
      log.error(`  ❌ ${this.saveBlockedReason}`);
    }
  }

  /**
   * Create default library from current CONFIG
   */
  private createDefaultLibrary(): Library {
    const description = CONFIG.notebookDescription ?? "";
    const hasConfig =
      !!CONFIG.notebookUrl &&
      !!description &&
      description !==
        "General knowledge base - configure NOTEBOOK_DESCRIPTION to help Claude understand what's in this notebook";

    const notebooks: NotebookEntry[] = [];

    // A bad NOTEBOOK_URL is a config problem, not a reason to fail startup.
    const parsed = CONFIG.notebookUrl ? parseNotebookUrl(CONFIG.notebookUrl) : null;
    if (CONFIG.notebookUrl && !parsed) {
      log.warning(
        `  ⚠️  Ignoring NOTEBOOK_URL ${JSON.stringify(CONFIG.notebookUrl)} — not a notebook URL ` +
          `(expected ${NOTEBOOK_URL_FORMAT}). Starting with an empty library.`
      );
    }

    if (hasConfig && parsed) {
      // Create first entry from CONFIG
      const id = generateUniqueId(description, new Set<string>());
      notebooks.push({
        id,
        url: parsed.url,
        name: description.substring(0, 50), // First 50 chars as name
        description,
        topics: CONFIG.notebookTopics ?? [],
        content_types: CONFIG.notebookContentTypes ?? ["documentation", "examples"],
        use_cases: CONFIG.notebookUseCases ?? [],
        added_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 0,
        tags: [],
      });

      log.success(`  ✅ Created default notebook: ${id}`);
    }

    return {
      notebooks,
      active_notebook_id: notebooks.length > 0 ? notebooks[0].id : null,
      last_modified: new Date().toISOString(),
      version: "1.0.0",
    };
  }

  /**
   * Write library.json without ever exposing a half-written file: serialise to
   * library.json.tmp-<pid> in the same directory, fsync it, then rename over
   * the target (atomic on the same volume). A crash or a concurrent reader now
   * sees either the old file or the new one, never a truncated one.
   */
  private writeLibraryAtomic(library: Library): void {
    if (this.saveBlockedReason) {
      throw new Error(this.saveBlockedReason);
    }

    library.last_modified = new Date().toISOString();
    const dir = path.dirname(this.libraryPath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = path.join(dir, `library.json.tmp-${process.pid}`);
    const data = JSON.stringify(library, null, 2);

    try {
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, data, "utf-8");
        fs.fsyncSync(fd); // rename is only atomic if the bytes actually landed
      } finally {
        fs.closeSync(fd);
      }
      renameWithRetry(tmpPath, this.libraryPath);
    } catch (error) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* tmp already gone (or never created) */
      }
      throw error;
    }
  }

  /**
   * Save library to disk (atomically), refresh the cache, notify listeners.
   */
  private saveLibrary(library: Library): void {
    try {
      this.writeLibraryAtomic(library);
      this.library = library;
      log.success(`  💾 Library saved (${library.notebooks.length} notebooks)`);
      this.notifyChanged();
    } catch (error) {
      log.error(`  ❌ Failed to save library: ${error}`);
      throw error;
    }
  }

  /**
   * Best-effort exclusive lock file. Two processes are far less likely to
   * interleave a read-modify-write while this is held; failing to take it is
   * never fatal — we log and proceed, because the read-modify-write itself is
   * what actually preserves the other process's notebooks.
   */
  private acquireLock(): number | null {
    const deadline = Date.now() + LOCK_WAIT_MS;

    for (;;) {
      try {
        return fs.openSync(this.lockPath, "wx");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          log.warning(`  ⚠️  Could not create ${this.lockPath} (${error}) — proceeding unlocked`);
          return null;
        }

        try {
          const ageMs = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (ageMs > LOCK_STALE_MS) {
            log.warning(
              `  ⚠️  Removing stale library.lock (${Math.round(ageMs / 1000)}s old — holder likely crashed)`
            );
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch {
          continue; // lock vanished between open and stat — try again immediately
        }

        if (Date.now() >= deadline) {
          log.warning("  ⚠️  library.lock still held — proceeding unlocked (merge still applies)");
          return null;
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
  }

  private releaseLock(fd: number): void {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      /* another process may have reclaimed it as stale */
    }
  }

  private withLock<T>(fn: () => T): T {
    let fd: number | null;
    try {
      fd = this.acquireLock();
    } catch (error) {
      // The lock is an optimisation, never a precondition — losing it must
      // not fail the mutation the user asked for.
      log.warning(`  ⚠️  Lock acquisition failed (${error}) — proceeding unlocked`);
      fd = null;
    }

    try {
      return fn();
    } finally {
      if (fd !== null) this.releaseLock(fd);
    }
  }

  /**
   * Read-modify-write. Every mutation runs against the state currently on
   * disk, not against this process's snapshot — otherwise two servers sharing
   * one library.json each save their own copy and the last writer silently
   * deletes the other's notebooks.
   *
   * `apply` mutates the fresh library and returns the caller's value; set
   * `changed: false` to skip the write (nothing to persist).
   */
  private mutate<T>(apply: (library: Library) => { value: T; changed?: boolean }): T {
    return this.withLock(() => {
      const base = this.readLibraryFromDisk() ?? this.library;
      const fresh: Library = { ...base, notebooks: [...base.notebooks] };

      const { value, changed = true } = apply(fresh);
      if (changed) {
        this.saveLibrary(fresh);
      } else {
        this.library = fresh; // keep the cache current even without a write
      }
      return value;
    });
  }

  /**
   * Add a new notebook to the library
   */
  addNotebook(input: AddNotebookInput): NotebookEntry {
    log.info(`📝 Adding notebook: ${input?.name}`);

    // Validate before touching the library: a stored URL later drives the
    // authenticated browser profile (see parseNotebookUrl).
    const parsed = requireNotebookUrl(input?.url);

    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (!name) {
      throw new Error("`name` is required and cannot be empty.");
    }

    const notebook = this.mutate((library) => {
      // Dedupe on the notebook UUID, not the raw string: the same notebook can
      // arrive as either host, with or without a query string.
      const duplicate = library.notebooks.find((n) => notebookKey(n.url) === parsed.notebookId);
      if (duplicate) {
        throw new Error(
          `Notebook ${parsed.notebookId} is already registered as "${duplicate.id}" ` +
            `(${duplicate.name ?? "unnamed"}). Use update_notebook to change its metadata, ` +
            `or select_notebook to switch to it.`
        );
      }

      const entry: NotebookEntry = {
        id: generateUniqueId(name, new Set(library.notebooks.map((n) => n.id))),
        url: parsed.url,
        name,
        description: input.description ?? "",
        topics: Array.isArray(input.topics) ? input.topics : [],
        content_types: input.content_types || ["documentation", "examples"],
        use_cases: input.use_cases || [
          `Learning about ${name}`,
          `Implementing features with ${name}`,
        ],
        added_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 0,
        tags: input.tags || [],
      };

      library.notebooks.push(entry);

      // Set as active if it's the first notebook
      if (library.notebooks.length === 1) {
        library.active_notebook_id = entry.id;
      }

      return { value: entry };
    });

    log.success(`✅ Notebook added: ${notebook.id}`);
    return notebook;
  }

  /**
   * List all notebooks in library
   */
  listNotebooks(): NotebookEntry[] {
    return this.library.notebooks;
  }

  /**
   * Get a specific notebook by ID
   */
  getNotebook(id: string): NotebookEntry | null {
    return this.library.notebooks.find((n) => n.id === id) || null;
  }

  /**
   * Get the currently active notebook
   */
  getActiveNotebook(): NotebookEntry | null {
    if (!this.library.active_notebook_id) {
      return null;
    }
    return this.getNotebook(this.library.active_notebook_id);
  }

  /**
   * Select a notebook as active
   */
  selectNotebook(id: string): NotebookEntry {
    log.info(`🎯 Selecting notebook: ${id}`);

    // Existence is checked against the on-disk state inside mutate(), not the
    // cache — another process may have added or removed this id since load.
    const selected = this.mutate((library) => {
      const index = library.notebooks.findIndex((n) => n.id === id);
      if (index === -1) {
        throw new Error(`Notebook not found: ${id}`);
      }

      const updated: NotebookEntry = {
        ...library.notebooks[index],
        last_used: new Date().toISOString(),
      };
      library.notebooks[index] = updated;
      library.active_notebook_id = id;

      return { value: updated };
    });

    log.success(`✅ Active notebook: ${id}`);
    return selected;
  }

  /**
   * Update notebook metadata
   *
   * An absent field means "leave unchanged"; a field that is present but empty
   * is a real instruction. `description`/`topics`/`tags` are genuinely cleared
   * (the old `input.x && {...}` form dropped them while reporting success),
   * while an empty `name`/`url` is rejected instead of silently ignored.
   */
  updateNotebook(input: UpdateNotebookInput): NotebookEntry {
    log.info(`📝 Updating notebook: ${input?.id}`);

    const patch: Partial<NotebookEntry> = {};

    if (input.name !== undefined) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) {
        throw new Error("`name` cannot be empty — omit it to leave the name unchanged.");
      }
      patch.name = name;
    }

    // update is a URL-storing path too, so it validates exactly like add.
    const parsedUrl = input.url !== undefined ? requireNotebookUrl(input.url) : null;
    if (parsedUrl) {
      patch.url = parsedUrl.url;
    }

    if (input.description !== undefined) patch.description = input.description;
    if (input.topics !== undefined) patch.topics = input.topics;
    if (input.content_types !== undefined) patch.content_types = input.content_types;
    if (input.use_cases !== undefined) patch.use_cases = input.use_cases;
    if (input.tags !== undefined) patch.tags = input.tags;

    const updated = this.mutate((library) => {
      const index = library.notebooks.findIndex((n) => n.id === input.id);
      if (index === -1) {
        throw new Error(`Notebook not found: ${input.id}`);
      }

      if (parsedUrl) {
        const clash = library.notebooks.find(
          (n, i) => i !== index && notebookKey(n.url) === parsedUrl.notebookId
        );
        if (clash) {
          throw new Error(
            `Notebook ${parsedUrl.notebookId} is already registered as "${clash.id}" — ` +
              `remove that entry first if you meant to move it.`
          );
        }
      }

      const entry: NotebookEntry = { ...library.notebooks[index], ...patch };
      library.notebooks[index] = entry;

      return { value: entry };
    });

    log.success(`✅ Notebook updated: ${input.id}`);
    return updated;
  }

  /**
   * Remove notebook from library
   */
  removeNotebook(id: string): boolean {
    const removed = this.mutate((library) => {
      const remaining = library.notebooks.filter((n) => n.id !== id);
      if (remaining.length === library.notebooks.length) {
        return { value: false, changed: false }; // not present on disk either
      }

      log.info(`🗑️  Removing notebook: ${id}`);
      library.notebooks = remaining;

      // If we removed the active notebook, select another one
      if (library.active_notebook_id === id) {
        library.active_notebook_id = remaining.length > 0 ? remaining[0].id : null;
      }

      return { value: true };
    });

    if (removed) {
      log.success(`✅ Notebook removed: ${id}`);
    }
    return removed;
  }

  /**
   * Increment use count for a notebook
   */
  incrementUseCount(id: string): NotebookEntry | null {
    return this.mutate((library) => {
      const index = library.notebooks.findIndex((n) => n.id === id);
      if (index === -1) {
        return { value: null as NotebookEntry | null, changed: false };
      }

      const current = library.notebooks[index];
      const updated: NotebookEntry = {
        ...current,
        // ?? 0: entries written by older versions may have no use_count, and
        // `undefined + 1` would persist NaN into library.json.
        use_count: (current.use_count ?? 0) + 1,
        last_used: new Date().toISOString(),
      };
      library.notebooks[index] = updated;

      return { value: updated as NotebookEntry | null };
    });
  }

  /**
   * Get library statistics
   */
  getStats(): LibraryStats {
    const totalQueries = this.library.notebooks.reduce((sum, n) => sum + (n.use_count ?? 0), 0);

    const mostUsed = this.library.notebooks.reduce(
      (max, n) => ((n.use_count ?? 0) > (max?.use_count ?? 0) ? n : max),
      null as NotebookEntry | null
    );

    return {
      total_notebooks: this.library.notebooks.length,
      active_notebook: this.library.active_notebook_id,
      most_used_notebook: mostUsed?.id || null,
      total_queries: totalQueries,
      last_modified: this.library.last_modified,
    };
  }

  /**
   * Register any discovered notebooks (from the account's dashboard) that
   * aren't already in the library. Dedupes by the notebook UUID parsed
   * from the URL, so calling this repeatedly with the same account state is
   * always safe — already-registered notebooks are silently skipped, never
   * duplicated or overwritten.
   */
  syncDiscovered(discovered: Array<{ id: string; url: string; title: string }>): {
    added: NotebookEntry[];
    skipped_existing: number;
  } {
    const incoming = Array.isArray(discovered) ? discovered : [];

    const result = this.mutate((library) => {
      const existingUuids = new Set(
        library.notebooks.map((n) => notebookKey(n.url)).filter((id): id is string => id !== null)
      );

      // Slugs are reserved as they are handed out, so ids assigned earlier in
      // this same batch (not yet committed) still count as taken.
      const usedSlugs = new Set(library.notebooks.map((n) => n.id));
      const added: NotebookEntry[] = [];

      for (const d of incoming) {
        const parsed = parseNotebookUrl(d?.url ?? "");
        // Fall back to the raw discovery values when the dashboard hands us a
        // URL shape we don't know — this product has already been renamed and
        // moved once, and discovery must survive the next drift.
        const uuid = parsed?.notebookId ?? (typeof d?.id === "string" ? d.id.toLowerCase() : null);
        if (!uuid || existingUuids.has(uuid)) continue;

        const title = (typeof d?.title === "string" && d.title.trim()) || "Untitled notebook";
        const entry: NotebookEntry = {
          id: generateUniqueId(title, usedSlugs),
          url: parsed?.url ?? d.url,
          name: title,
          description: `Auto-discovered from your NotebookLM account: ${title}`,
          topics: [],
          content_types: ["documentation", "examples"],
          use_cases: [`Answering questions about ${title}`],
          added_at: new Date().toISOString(),
          last_used: new Date().toISOString(),
          use_count: 0,
          tags: ["auto-discovered"],
        };

        library.notebooks.push(entry);
        added.push(entry);
        existingUuids.add(uuid);
      }

      let changed = added.length > 0;
      if (!library.active_notebook_id && library.notebooks.length > 0) {
        library.active_notebook_id = library.notebooks[0].id;
        changed = true;
      }

      return {
        value: { added, skipped_existing: incoming.length - added.length },
        changed,
      };
    });

    if (result.added.length > 0) {
      log.success(
        `✅ Synced ${result.added.length} discovered notebook(s), skipped ${result.skipped_existing} already registered`
      );
    }

    return result;
  }

  /**
   * Search notebooks by query (searches name, description, topics, tags)
   *
   * Every field access is type-guarded: entries written by an older version or
   * left partially written have undefined name/description/topics, and the old
   * direct `.toLowerCase()` threw on *every* search once one such entry
   * existed (issue #33).
   */
  searchNotebooks(query: string): NotebookEntry[] {
    const lowerQuery = (typeof query === "string" ? query : "").toLowerCase();

    const matches = (value: unknown): boolean =>
      typeof value === "string" && value.toLowerCase().includes(lowerQuery);
    const matchesAny = (values: unknown): boolean =>
      Array.isArray(values) && values.some((v) => matches(v));

    return this.library.notebooks.filter(
      (n) => matches(n.name) || matches(n.description) || matchesAny(n.topics) || matchesAny(n.tags)
    );
  }
}

/**
 * renameSync, retried: on Windows an antivirus/indexer holding the target
 * briefly surfaces as EPERM/EBUSY. Never falls back to a direct write — that
 * would reintroduce the non-atomic save this exists to prevent.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_RETRIES) throw error;
      sleepSync(RENAME_RETRY_MS);
    }
  }
}
