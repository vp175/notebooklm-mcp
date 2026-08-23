/**
 * MCP tool definitions for source ingestion + Audio Overview (issues #25, #11).
 *
 * The cross-tool async-audio chain (generate → poll → download) is documented
 * in the server-level `instructions` string (see src/index.ts) so individual
 * descriptions stay focused on one operation each.
 */

import type { Tool } from "@modelcontextprotocol/server";

const sharedNotebookTargeting = {
  session_id: {
    type: "string",
    description:
      "Reuse an existing browser session by id. Recommended when you have " +
      "already called `ask_question` against the same notebook — saves the " +
      "10–15 s page-load time. Obtain from `list_sessions` or any prior " +
      "`ask_question` response (`result.session_id`).",
  },
  notebook_id: {
    type: "string",
    description:
      "Library notebook id (from `list_notebooks` / `search_notebooks`). " +
      "Defaults to the active notebook (see `select_notebook`) when omitted.",
  },
  notebook_url: {
    type: "string",
    description:
      "Direct NotebookLM URL — overrides `notebook_id`. Use for ad-hoc " +
      "notebooks not yet in your library. Format: " +
      "`https://notebook.google.com/notebook/<uuid>` (legacy " +
      "`notebooklm.google.com` also accepted).",
  },
};

export const addSourceTool: Tool = {
  name: "add_source",
  description:
    "Ingest a source into a NotebookLM notebook. Supports two source types " +
    "in v2.0:\n" +
    "  • `url` — NotebookLM crawls and indexes a website\n" +
    "  • `text` — paste raw text (treated as a copied document)\n\n" +
    "File / YouTube / Google-Drive uploads are not yet implemented.\n\n" +
    "Returns `sourceCountBefore`/`sourceCountAfter` so the caller can verify " +
    "the new source landed. Call once per source — multiple sources require " +
    "multiple calls. NotebookLM finishes indexing within 5–30 seconds; " +
    "subsequent `ask_question` calls then have the new source in context. " +
    "Free notebooks cap at 50 sources.\n\n" +
    "Known quirk: pasted-text uploads occasionally redirect to a freshly " +
    'created "Untitled notebook" on Google\'s side. The tool detects this ' +
    "and returns a clear error so you can re-try against the correct URL.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["url", "text"],
        description:
          "`url` crawls the supplied website; `text` ingests `content` " +
          "verbatim as a copied document.",
      },
      content: {
        type: "string",
        description:
          "When `type=url`: a fully-qualified URL (https://…). " +
          "When `type=text`: the raw text body (any length up to NotebookLM's per-source word limit, ~500 k for free tier).",
      },
      title: {
        type: "string",
        description:
          "Display title shown in the source list. Optional — NotebookLM " +
          "picks a sensible default (page title for URLs, first line for text). " +
          "For text sources, supplying a title is recommended for later " +
          "identification.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["type", "content"],
  },
  annotations: {
    title: "Add source to notebook",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const generateAudioTool: Tool = {
  name: "generate_audio",
  description:
    "Trigger podcast-style Audio Overview generation for a notebook.\n\n" +
    "**Async by default** — returns immediately with one of:\n" +
    '  • `status: "started"` — generation just kicked off\n' +
    '  • `status: "in_progress"` — a generation was already running; ' +
    "this call attached to it\n" +
    '  • `status: "ready"` (with `alreadyExisted: true`) — an Audio ' +
    "Overview already existed; nothing was triggered\n\n" +
    "Generation typically takes 2–10 minutes. **Workflow:**\n" +
    "  1. `generate_audio` → returns immediately\n" +
    "  2. Poll `get_audio_status` every ~30 s\n" +
    "  3. When status is `ready`, call `download_audio`\n\n" +
    "Pass `wait_for_completion: true` for legacy synchronous behaviour " +
    "(blocks for up to `timeout_ms`).\n\n" +
    'Equivalent to `generate_studio_output` with `output_type: "audio"` — ' +
    "kept as a dedicated tool for backward compatibility. Eight of the nine " +
    "Studio output types are implemented and reachable through the generic " +
    "`generate_studio_output` / `get_studio_output_status` / " +
    "`download_studio_output` / `get_studio_output_content` tools: audio, " +
    "video, infographic and slides (file-kind, downloaded to disk); mindmap, " +
    "datatable, quiz and flashcards (structured-kind, returned as JSON). " +
    'Only `report` returns a clear "not yet implemented" error.',
  inputSchema: {
    type: "object",
    properties: {
      custom_prompt: {
        type: "string",
        description:
          'Optional focus prompt for the Audio Overview, e.g. "Focus on the ' +
          'API authentication flow and skip pricing". Passed into the ' +
          'NotebookLM "Customize" sub-dialog before generation starts.',
      },
      wait_for_completion: {
        type: "boolean",
        description:
          "If true, block until the audio tile is ready (up to `timeout_ms`). " +
          "Default false — return immediately and let the caller poll " +
          "`get_audio_status`.",
      },
      timeout_ms: {
        type: "number",
        description:
          "Only relevant when `wait_for_completion=true`. Maximum wait for " +
          "the audio tile to appear. Default 600 000 (10 min).",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
  },
  annotations: {
    title: "Generate Audio Overview",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true, // Idempotent: existing audio is detected and returned as ready
    openWorldHint: true,
  },
};

export const getAudioStatusTool: Tool = {
  name: "get_audio_status",
  description:
    "Non-blocking probe for the current Audio Overview state of a notebook.\n\n" +
    "Returned `status` values:\n" +
    "  • `ready` — Audio Overview is generated and ready to download\n" +
    "  • `in_progress` — generation is currently running\n" +
    "  • `not_started` — no COMPLETED Audio Overview was found. This is " +
    "ALSO what you get while a generation is running but its tile has not " +
    "appeared yet, so never read `not_started` as proof that nothing is " +
    "being generated: if you just called `generate_audio`, keep polling " +
    "rather than triggering a second generation.\n\n" +
    "Safe to poll every ~30 s while waiting for `generate_audio` to finish. " +
    "When status flips to `ready`, call `download_audio` with a destination " +
    "directory.\n\n" +
    'Equivalent to `get_studio_output_status` with `output_type: "audio"` ' +
    "— kept as a dedicated tool for backward compatibility. The generic " +
    "`get_studio_output_status` tool serves every implemented type " +
    "(all except `report`).",
  inputSchema: {
    type: "object",
    properties: {
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
  },
  annotations: {
    title: "Get Audio Overview status",
    readOnlyHint: true,
    openWorldHint: true,
  },
};

export const downloadAudioTool: Tool = {
  name: "download_audio",
  description:
    "Save the completed Audio Overview to disk as a `.m4a` file. **Pre-" +
    'condition:** `get_audio_status` must report `status: "ready"`. ' +
    "Calling this before generation completes returns an error message " +
    "explaining what to do.\n\n" +
    "The file lands in `destination_dir` with NotebookLM's suggested " +
    "filename (sanitised — usually the audio's title with underscores). " +
    "The full saved path is returned in `result.filePath`.\n\n" +
    'Equivalent to `download_studio_output` with `output_type: "audio"` — ' +
    "kept as a dedicated tool for backward compatibility. The generic " +
    "`download_studio_output` tool also serves the other implemented " +
    "file-kind types (video, slides, infographic); `report` is not " +
    "implemented.",
  inputSchema: {
    type: "object",
    properties: {
      destination_dir: {
        type: "string",
        description:
          "Absolute directory path where the file is saved (created if " +
          "missing). Example: `C:/Users/jane/Downloads/notebooklm` or " +
          "`/tmp/audio`. A RELATIVE path is REJECTED with an error — the " +
          "server's working directory is not the caller's, so a relative " +
          "path would silently drop the file somewhere unexpected. If a " +
          "file of the same name already exists it is NOT overwritten; the " +
          "download is saved alongside it as `name (2).ext` and the path " +
          "actually written is returned in `result.filePath`.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["destination_dir"],
  },
  annotations: {
    title: "Download Audio Overview",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const sourceTools: Tool[] = [
  addSourceTool,
  generateAudioTool,
  getAudioStatusTool,
  downloadAudioTool,
];
