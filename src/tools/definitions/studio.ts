/**
 * MCP tool definitions for the generic Studio-output engine.
 *
 * These 4 tools expose the `StudioOutputType` values through one
 * generate/poll/download-or-extract shape. Eight of the nine types have a
 * live strategy (see studio-outputs.ts): audio, video, infographic and slides
 * are FILE kinds (fetched with download_studio_output); mindmap, datatable,
 * quiz and flashcards are STRUCTURED kinds (read with
 * get_studio_output_content). Only `report` is unimplemented and returns a
 * clear error.
 *
 * The type lists below are imported from the engine rather than hand-rolled,
 * so a change to the engine's kind classification cannot silently leave these
 * schemas advertising the wrong thing.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ALL_STUDIO_TYPES,
  FILE_KIND_TYPES,
  STRUCTURED_KIND_TYPES,
} from "../../notebooklm/studio-outputs.js";

const sharedNotebookTargeting = {
  session_id: {
    type: "string",
    description: "Reuse an existing browser session by id. See list_sessions.",
  },
  notebook_id: {
    type: "string",
    description: "Library notebook id. Defaults to the active notebook when omitted.",
  },
  notebook_url: { type: "string", description: "Direct NotebookLM URL — overrides notebook_id." },
};

// Single source of truth: the engine's own kind classification.
const ALL_TYPES = [...ALL_STUDIO_TYPES];
const FILE_TYPES = [...FILE_KIND_TYPES];
const STRUCTURED_TYPES = [...STRUCTURED_KIND_TYPES];

export const generateStudioOutputTool: Tool = {
  name: "generate_studio_output",
  description:
    "Trigger generation of any NotebookLM Studio output. **Async by default** " +
    "— returns immediately with status `started`/`in_progress`/`ready`. " +
    "Eight of the nine types are implemented: `audio`, `video`, " +
    "`infographic`, `slides` (file kinds) and `mindmap`, `datatable`, " +
    "`quiz`, `flashcards` (structured kinds). Only `report` returns a clear " +
    '"not yet implemented" error. KNOWN LIMITATION: mid-generation status ' +
    "reporting is only partly reliable. This server remembers generations " +
    "IT started (so a repeat call returns `in_progress` instead of starting " +
    "a duplicate), and it also looks for an in-progress tile in the page, " +
    "but a generation started elsewhere — the NotebookLM web UI, another " +
    "process — may still read as `not_started` until its tile appears. " +
    "Poll rather than re-triggering. Workflow: generate_studio_output → " +
    "poll get_studio_output_status → download_studio_output (file kinds) or " +
    "get_studio_output_content (structured kinds).",
  inputSchema: {
    type: "object",
    properties: {
      output_type: {
        type: "string",
        enum: ALL_TYPES,
        description: "Which Studio output to generate.",
      },
      custom_prompt: {
        type: "string",
        description:
          "Optional focus prompt, typed into the Customize dialog before " +
          "generation. Honoured by every implemented type whose Customize " +
          "dialog exposes a prompt field; where the dialog has no such field " +
          "it is ignored.",
      },
      difficulty: {
        type: "string",
        description:
          "ACCEPTED BUT NOT WIRED UP: no verified selector exists for the " +
          "Customize dialog's difficulty control, so generation always uses " +
          "the dialog's default. Passing this returns a warning in " +
          "`result.warnings` rather than silently pretending it applied.",
      },
      wait_for_completion: {
        type: "boolean",
        description: "If true, block until ready (up to timeout_ms). Default false.",
      },
      timeout_ms: {
        type: "number",
        description: "Only relevant when wait_for_completion=true. Default 600000 (10 min).",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["output_type"],
  },
  annotations: {
    title: "Generate Studio output",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const getStudioOutputStatusTool: Tool = {
  name: "get_studio_output_status",
  description:
    "Non-blocking status probe for any Studio output type. Returns `ready` / " +
    "`in_progress` / `not_started`. Safe to poll every ~30s while waiting for " +
    "generate_studio_output to finish.",
  inputSchema: {
    type: "object",
    properties: {
      output_type: {
        type: "string",
        enum: ALL_TYPES,
        description: "Which Studio output to check.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["output_type"],
  },
  outputSchema: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      data: {
        type: "object",
        properties: {
          result: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: ["ready", "in_progress", "not_started", "started", "error"],
              },
              alreadyExisted: { type: "boolean" },
              message: { type: "string" },
            },
            required: ["status"],
          },
        },
        required: ["result"],
      },
      error: { type: "string" },
    },
    required: ["success", "data"],
  },
  annotations: { title: "Get Studio output status", readOnlyHint: true, openWorldHint: true },
};

export const downloadStudioOutputTool: Tool = {
  name: "download_studio_output",
  description:
    "Save a completed file-kind Studio output to disk. Only valid for " +
    "output_type in [audio, video, report, slides, infographic] — for " +
    "mindmap/datatable/quiz/flashcards use get_studio_output_content instead. " +
    "Precondition: get_studio_output_status must report `ready`.",
  inputSchema: {
    type: "object",
    properties: {
      output_type: {
        type: "string",
        enum: FILE_TYPES,
        description: "Which file-kind Studio output to download.",
      },
      destination_dir: {
        type: "string",
        description:
          "Absolute directory path where the file is saved (created if " +
          "missing). A relative path is rejected. An existing file is never " +
          "overwritten — the download is saved as `name (2).ext` and the " +
          "path actually written is returned in `result.filePath`, with the " +
          "byte count in `result.bytes`.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["output_type", "destination_dir"],
  },
  annotations: {
    title: "Download Studio output",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const getStudioOutputContentTool: Tool = {
  name: "get_studio_output_content",
  description:
    "Extract a completed structured-kind Studio output as JSON. Only valid " +
    "for output_type in [mindmap, datatable, quiz, flashcards] — for audio/" +
    "video/report/slides/infographic use download_studio_output instead. " +
    "Precondition: get_studio_output_status must report `ready`.",
  inputSchema: {
    type: "object",
    properties: {
      output_type: {
        type: "string",
        enum: STRUCTURED_TYPES,
        description: "Which structured-kind Studio output to extract.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["output_type"],
  },
  outputSchema: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      data: {
        type: "object",
        properties: {
          result: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              content: {},
              message: { type: "string" },
            },
            required: ["success"],
          },
        },
        required: ["result"],
      },
      error: { type: "string" },
    },
    required: ["success", "data"],
  },
  annotations: { title: "Get Studio output content", readOnlyHint: true, openWorldHint: true },
};

export const studioTools: Tool[] = [
  generateStudioOutputTool,
  getStudioOutputStatusTool,
  downloadStudioOutputTool,
  getStudioOutputContentTool,
];
