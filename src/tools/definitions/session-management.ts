import type { Tool } from "@modelcontextprotocol/server";

/**
 * Session management tools. The MCP server uses session IDs to keep
 * Gemini-side conversational context across follow-up `ask_question`
 * calls. These tools surface, reset, and close those sessions.
 *
 * Where do session IDs come from? — Every successful `ask_question` call
 * returns a `session_id` in its result. `list_sessions` enumerates the
 * currently live ones.
 */
export const sessionManagementTools: Tool[] = [
  {
    name: "list_sessions",
    description:
      "List all active browser sessions for this server. Each entry includes " +
      "`id`, `created_at`, `last_activity`, `age_seconds`, `inactive_seconds`, " +
      "`message_count`, and `notebook_url`. Useful before `reset_session` / " +
      "`close_session` or to recover a `session_id` you can pass back into " +
      "`ask_question` to continue an existing conversation. Sessions older " +
      "than `session_timeout` (see `get_health`) are auto-closed.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        data: {
          type: "object",
          properties: {
            active_sessions: { type: "number" },
            max_sessions: { type: "number" },
            session_timeout: { type: "number" },
            oldest_session_seconds: { type: "number" },
            total_messages: { type: "number" },
            sessions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  created_at: { type: "number" },
                  last_activity: { type: "number" },
                  age_seconds: { type: "number" },
                  inactive_seconds: { type: "number" },
                  message_count: { type: "number" },
                  notebook_url: { type: "string" },
                },
                required: [
                  "id",
                  "created_at",
                  "last_activity",
                  "age_seconds",
                  "inactive_seconds",
                  "message_count",
                  "notebook_url",
                ],
              },
            },
          },
          required: [
            "active_sessions",
            "max_sessions",
            "session_timeout",
            "oldest_session_seconds",
            "total_messages",
            "sessions",
          ],
        },
        error: { type: "string" },
      },
      required: ["success", "data"],
    },
    annotations: {
      title: "List sessions",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "close_session",
    description:
      "Permanently close a session and discard its browser tab. Use the " +
      "`id` returned by `list_sessions` (or the `session_id` from a prior " +
      "`ask_question` response). Closed sessions cannot be resumed — start " +
      "a new one with `ask_question` (no `session_id`) or pick another " +
      "from `list_sessions`. Ask the user before closing if the session " +
      "might still be needed.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Session id to close. Obtain from `list_sessions` or from any " +
            "prior `ask_question` response (`result.session_id`).",
        },
      },
      required: ["session_id"],
    },
    annotations: {
      title: "Close session",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "reset_session",
    description:
      "Clear a session's chat history while keeping the same session id. " +
      "Use this when the task changes mid-conversation and you want a " +
      "fresh context without losing the underlying browser tab. Ask the " +
      "user before resetting if they might still need the prior history.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Session id to reset. Obtain from `list_sessions` or from a " +
            "prior `ask_question` response (`result.session_id`).",
        },
      },
      required: ["session_id"],
    },
    annotations: {
      title: "Reset session",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];
