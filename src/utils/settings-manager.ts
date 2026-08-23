/**
 * Settings Manager
 *
 * Handles persistent configuration for the NotebookLM MCP Server.
 * Manages profiles, disabled tools, and environment variable overrides.
 */

import fs from "fs/promises";
import { existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import type { Tool } from "@modelcontextprotocol/server";

export type ProfileName = "minimal" | "standard" | "full";

export interface Settings {
  profile: ProfileName;
  disabledTools: string[];
  customSettings?: Record<string, unknown>;
}

const DEFAULT_SETTINGS: Settings = {
  profile: "full",
  disabledTools: [],
};

function isProfileName(value: string | undefined): value is ProfileName {
  return value === "minimal" || value === "standard" || value === "full";
}

const PROFILES: Record<ProfileName, string[]> = {
  minimal: [
    "ask_question",
    "get_health",
    "list_notebooks",
    "select_notebook",
    "get_notebook", // Added as it is read-only and useful
    // `setup_auth` is not optional in any profile: without it an
    // unauthenticated user has NO way to authenticate, and every other tool in
    // this profile fails until they do. `get_health` even tells them to call
    // it — a tool the profile used to hide.
    "setup_auth",
  ],
  standard: [
    "ask_question",
    "get_health",
    "list_notebooks",
    "select_notebook",
    "get_notebook",
    "setup_auth",
    "list_sessions",
    "add_notebook",
    "discover_notebooks",
    "update_notebook",
    "search_notebooks",
    "get_studio_output_status",
  ],
  full: ["*"], // All tools
};

export class SettingsManager {
  private settingsPath: string;
  private settings: Settings;

  constructor() {
    // Use the config directory from env-paths defined in config.ts
    this.settingsPath = path.join(CONFIG.configDir, "settings.json");
    this.settings = this.loadSettings();
  }

  /**
   * Load settings from file, falling back to defaults
   */
  private loadSettings(): Settings {
    try {
      // Ensure config dir exists
      if (!existsSync(CONFIG.configDir)) {
        mkdirSync(CONFIG.configDir, { recursive: true });
      }

      if (existsSync(this.settingsPath)) {
        // Synchronous read keeps the constructor simple — settings are tiny
        // and we need them before any tool dispatch can happen.
        const data = readFileSync(this.settingsPath, "utf-8");
        const parsed = JSON.parse(data) as Partial<Settings>;
        const merged: Settings = { ...DEFAULT_SETTINGS, ...parsed };

        // A typo'd profile ("standrd") used to reach `PROFILES[profile]` as
        // `undefined` and crash the whole server on the first tools/list with
        // a bare "Cannot read properties of undefined (reading 'includes')".
        // Fall back to the default and say what happened.
        if (!isProfileName(merged.profile)) {
          log.warning(
            `⚠️  Unknown profile "${String(merged.profile)}" in ${this.settingsPath} — ` +
              `using "${DEFAULT_SETTINGS.profile}". Valid profiles: minimal, standard, full.`
          );
          merged.profile = DEFAULT_SETTINGS.profile;
        }
        if (!Array.isArray(merged.disabledTools)) {
          log.warning(`⚠️  \`disabledTools\` must be an array — ignoring it.`);
          merged.disabledTools = [];
        }
        return merged;
      }
    } catch (error) {
      log.warning(`⚠️  Failed to load settings: ${error}. Using defaults.`);
    }
    return { ...DEFAULT_SETTINGS };
  }

  /**
   * Save current settings to file
   */
  async saveSettings(newSettings: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...newSettings };
    try {
      await fs.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
    } catch (error) {
      throw new Error(`Failed to save settings: ${error}`, { cause: error });
    }
  }

  /**
   * Get effective configuration (merging File settings with Env Vars)
   */
  getEffectiveSettings(): Settings {
    const envProfileRaw = process.env.NOTEBOOKLM_PROFILE;
    const envProfile = isProfileName(envProfileRaw) ? envProfileRaw : undefined;
    const envDisabled = process.env.NOTEBOOKLM_DISABLED_TOOLS;

    const effectiveProfile = envProfile ?? this.settings.profile;

    let effectiveDisabled = [...this.settings.disabledTools];
    if (envDisabled) {
      const envDisabledList = envDisabled.split(",").map((t) => t.trim());
      effectiveDisabled = [...new Set([...effectiveDisabled, ...envDisabledList])];
    }

    return {
      profile: effectiveProfile,
      disabledTools: effectiveDisabled,
      customSettings: this.settings.customSettings,
    };
  }

  /**
   * Filter tools based on effective configuration
   */
  filterTools(allTools: Tool[]): Tool[] {
    const { profile, disabledTools } = this.getEffectiveSettings();
    // Defensive: an unknown profile is already normalised at load time, but a
    // caller could still hand us one — never index into PROFILES blindly.
    const allowedTools = PROFILES[profile] ?? PROFILES[DEFAULT_SETTINGS.profile];

    return allTools.filter((tool) => {
      // 1. Check if allowed by profile (unless profile is full/wildcard)
      if (!allowedTools.includes("*") && !allowedTools.includes(tool.name)) {
        return false;
      }

      // 2. Check if explicitly disabled
      if (disabledTools.includes(tool.name)) {
        return false;
      }

      return true;
    });
  }

  getSettingsPath(): string {
    return this.settingsPath;
  }

  getProfiles(): Record<ProfileName, string[]> {
    return PROFILES;
  }
}
