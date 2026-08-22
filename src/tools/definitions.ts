/**
 * MCP Tool Definitions
 *
 * Aggregates tool definitions from sub-modules.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { NotebookLibrary } from "../library/notebook-library.js";
import { askQuestionTool, buildAskQuestionDescription } from "./definitions/ask-question.js";
import { notebookManagementTools } from "./definitions/notebook-management.js";
import { sessionManagementTools } from "./definitions/session-management.js";
import { systemTools } from "./definitions/system.js";
import { sourceTools } from "./definitions/sources.js";
import { studioTools } from "./definitions/studio.js";

/**
 * Build Tool Definitions with NotebookLibrary context
 */
export function buildToolDefinitions(library: NotebookLibrary): Tool[] {
  // Update the description for ask_question based on the library state
  const dynamicAskQuestionTool = {
    ...askQuestionTool,
    description: buildAskQuestionDescription(library),
  };

  return [
    dynamicAskQuestionTool,
    ...notebookManagementTools,
    ...sessionManagementTools,
    ...systemTools,
    ...sourceTools,
    ...studioTools,
  ];
}
