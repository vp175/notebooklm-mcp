/**
 * MCP tool definitions for the generic Studio-output engine (Task 7).
 *
 * These 4 tools expose all 9 `StudioOutputType` values through one
 * generate/poll/download-or-extract shape. Only `audio` is registered with
 * a live strategy as of Task 7 (see studio-outputs.ts); the other 8 types
 * are accepted by the schema but return a clear "not yet implemented"
 * error until later tasks register their strategies.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const sharedNotebookTargeting = {
  session_id: { type: "string", description: "Reuse an existing browser session by id. See list_sessions." },
  notebook_id: { type: "string", description: "Library notebook id. Defaults to the active notebook when omitted." },
  notebook_url: { type: "string", description: "Direct NotebookLM URL — overrides notebook_id." },
};

const ALL_TYPES = ["audio", "video", "report", "slides", "infographic", "mindmap", "datatable", "quiz", "flashcards"];
const FILE_TYPES = ["audio", "video", "report", "slides", "infographic"];
const STRUCTURED_TYPES = ["mindmap", "datatable", "quiz", "flashcards"];

export const generateStudioOutputTool: Tool = {
  name: "generate_studio_output",
  description:
    "Trigger generation of any NotebookLM Studio output. **Async by default** " +
    "— returns immediately with status `started`/`in_progress`/`ready`. " +
    "Phase 1 of this server implements `audio`, `report`, and `flashcards`; " +
    "the other 6 types in the enum return a clear \"not yet implemented\" " +
    "error until Phase 2. Workflow: generate_studio_output → poll " +
    "get_studio_output_status → download_studio_output (file kinds: audio/" +
    "video/report/slides/infographic) or get_studio_output_content " +
    "(structured kinds: mindmap/datatable/quiz/flashcards).",
  inputSchema: {
    type: "object",
    properties: {
      output_type: { type: "string", enum: ALL_TYPES, description: "Which Studio output to generate." },
      custom_prompt: { type: "string", description: "Optional focus prompt, passed into the Customize dialog before generation." },
      difficulty: { type: "string", description: "Only used by quiz/flashcards (Phase 2). Ignored by other types." },
      wait_for_completion: { type: "boolean", description: "If true, block until ready (up to timeout_ms). Default false." },
      timeout_ms: { type: "number", description: "Only relevant when wait_for_completion=true. Default 600000 (10 min)." },
      show_browser: { type: "boolean", description: "Show the browser window for debugging. Default: false." },
      ...sharedNotebookTargeting,
    },
    required: ["output_type"],
  },
  annotations: { title: "Generate Studio output", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      output_type: { type: "string", enum: ALL_TYPES, description: "Which Studio output to check." },
      show_browser: { type: "boolean", description: "Show the browser window for debugging. Default: false." },
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
      output_type: { type: "string", enum: FILE_TYPES, description: "Which file-kind Studio output to download." },
      destination_dir: { type: "string", description: "Absolute directory path where the file is saved (created if missing)." },
      show_browser: { type: "boolean", description: "Show the browser window for debugging. Default: false." },
      ...sharedNotebookTargeting,
    },
    required: ["output_type", "destination_dir"],
  },
  annotations: { title: "Download Studio output", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      output_type: { type: "string", enum: STRUCTURED_TYPES, description: "Which structured-kind Studio output to extract." },
      show_browser: { type: "boolean", description: "Show the browser window for debugging. Default: false." },
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
