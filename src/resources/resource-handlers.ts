import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  CompleteRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { NotebookLibrary } from "../library/notebook-library.js";
import { log } from "../utils/logger.js";

const PROMPTS = [
  {
    name: "notebooklm.auth-setup",
    description:
      "First-time NotebookLM authentication walkthrough: run setup_auth, " +
      "then verify with get_health before doing anything else.",
  },
  {
    name: "notebooklm.auth-repair",
    description:
      "Fix a broken NotebookLM session (expired cookies, auth errors): " +
      "run re_auth, then verify with get_health.",
  },
] as const;

function buildPromptMessages(
  name: string
): { role: "user"; content: { type: "text"; text: string } }[] {
  if (name === "notebooklm.auth-setup") {
    return [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Set up NotebookLM authentication for the first time:\n" +
            "1. Call `setup_auth` with `show_browser: true`. A Chrome window " +
            "opens — the human logs into their Google account (up to 10 " +
            "minutes).\n" +
            "2. Call `get_health` and confirm `authenticated: true`.\n" +
            "3. If `get_health` still reports unauthenticated after step 1, " +
            "wait 30 seconds and re-check — the login may still be in " +
            "progress in the visible browser window.",
        },
      },
    ];
  }
  if (name === "notebooklm.auth-repair") {
    return [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Repair a broken NotebookLM session:\n" +
            "1. Call `re_auth` with `show_browser: true` to wipe stored " +
            "auth and log in again.\n" +
            "2. Call `get_health` and confirm `authenticated: true`.\n" +
            "3. If the notebook itself is inaccessible after re-auth, " +
            "confirm the notebook URL is still valid with `get_notebook` " +
            "or `list_notebooks`.",
        },
      },
    ];
  }
  throw new Error(`Unknown prompt: ${name}`);
}

/**
 * Handlers for MCP Resource-related requests
 */
export class ResourceHandlers {
  private library: NotebookLibrary;

  constructor(library: NotebookLibrary) {
    this.library = library;
  }

  /**
   * Register all resource handlers to the server
   */
  public registerHandlers(server: Server): void {
    // Notify subscribed clients whenever the library changes on disk (add,
    // remove, update, select, or use-count bump — all route through
    // NotebookLibrary.saveLibrary, which fires this hook).
    this.library.onChange(() => {
      void server.sendResourceListChanged().catch((error: unknown) => {
        log.warning(`⚠️  [MCP] Failed to send resources/list_changed: ${error}`);
      });
    });

    // List available resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      log.info("📚 [MCP] list_resources request received");

      const notebooks = this.library.listNotebooks();
      type ResourceDescriptor = {
        uri: string;
        name: string;
        description: string;
        mimeType: string;
      };
      const resources: ResourceDescriptor[] = [
        {
          uri: "notebooklm://library",
          name: "Notebook Library",
          description:
            "Complete notebook library with all available knowledge sources. " +
            "Read this to discover what notebooks are available. " +
            "⚠️ If you think a notebook might help with the user's task, " +
            "ASK THE USER FOR PERMISSION before consulting it: " +
            "'Should I consult the [notebook] for this task?'",
          mimeType: "application/json",
        },
      ];

      // Add individual notebook resources
      for (const notebook of notebooks) {
        resources.push({
          uri: `notebooklm://library/${notebook.id}`,
          name: notebook.name,
          description:
            `${notebook.description} | Topics: ${notebook.topics.join(", ")} | ` +
            `💡 Use ask_question to query this notebook (ask user permission first if task isn't explicitly about these topics)`,
          mimeType: "application/json",
        });
      }

      // Add legacy metadata resource for backwards compatibility
      const active = this.library.getActiveNotebook();
      if (active) {
        resources.push({
          uri: "notebooklm://metadata",
          name: "Active Notebook Metadata (Legacy)",
          description:
            "Information about the currently active notebook. " +
            "DEPRECATED: Use notebooklm://library instead for multi-notebook support. " +
            "⚠️ Always ask user permission before using notebooks for tasks they didn't explicitly mention.",
          mimeType: "application/json",
        });
      }

      return { resources };
    });

    // List resource templates
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      log.info("📑 [MCP] list_resource_templates request received");

      return {
        resourceTemplates: [
          {
            uriTemplate: "notebooklm://library/{id}",
            name: "Notebook by ID",
            description:
              "Access a specific notebook from your library by ID. " +
              "Provides detailed metadata about the notebook including topics, use cases, and usage statistics. " +
              "💡 Use the 'id' parameter from list_notebooks to access specific notebooks.",
            mimeType: "application/json",
          },
        ],
      };
    });

    // Read resource content
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      log.info(`📖 [MCP] read_resource request: ${uri}`);

      // Handle library resource
      if (uri === "notebooklm://library") {
        const notebooks = this.library.listNotebooks();
        const stats = this.library.getStats();
        const active = this.library.getActiveNotebook();

        const libraryData = {
          active_notebook: active
            ? {
                id: active.id,
                name: active.name,
                description: active.description,
                topics: active.topics,
              }
            : null,
          notebooks: notebooks.map((nb) => ({
            id: nb.id,
            name: nb.name,
            description: nb.description,
            topics: nb.topics,
            content_types: nb.content_types,
            use_cases: nb.use_cases,
            url: nb.url,
            use_count: nb.use_count,
            last_used: nb.last_used,
            tags: nb.tags,
          })),
          stats,
        };

        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(libraryData, null, 2),
            },
          ],
        };
      }

      // Handle individual notebook resource
      if (uri.startsWith("notebooklm://library/")) {
        const prefix = "notebooklm://library/";
        const encodedId = uri.slice(prefix.length);
        if (!encodedId) {
          throw new Error("Notebook resource requires an ID (e.g. notebooklm://library/{id})");
        }

        let id: string;
        try {
          id = decodeURIComponent(encodedId);
        } catch {
          throw new Error(`Invalid notebook identifier encoding: ${encodedId}`);
        }

        if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(id)) {
          throw new Error(
            `Invalid notebook identifier: ${encodedId}. Notebook IDs may only contain letters, numbers, and hyphens.`
          );
        }

        const notebook = this.library.getNotebook(id);

        if (!notebook) {
          throw new Error(`Notebook not found: ${id}`);
        }

        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(notebook, null, 2),
            },
          ],
        };
      }

      // Legacy metadata resource (backwards compatibility)
      if (uri === "notebooklm://metadata") {
        const active = this.library.getActiveNotebook();

        if (!active) {
          throw new Error("No active notebook. Use notebooklm://library to see all notebooks.");
        }

        const metadata = {
          description: active.description,
          topics: active.topics,
          content_types: active.content_types,
          use_cases: active.use_cases,
          notebook_url: active.url,
          notebook_id: active.id,
          last_used: active.last_used,
          use_count: active.use_count,
          note: "DEPRECATED: Use notebooklm://library or notebooklm://library/{id} instead",
        };

        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(metadata, null, 2),
            },
          ],
        };
      }

      // Helpful error so misconfigured clients (issue #15 — reporter requested
      // `mcp://notebooklm`, which never existed) learn the supported URI scheme.
      throw new Error(
        `Unknown resource: ${uri}. Supported URIs: notebooklm://library, ` +
          "notebooklm://library/{id}, notebooklm://metadata. " +
          "Call resources/list to discover the active set."
      );
    });

    // Argument completions (for prompt arguments and resource templates)
    server.setRequestHandler(CompleteRequestSchema, async (request) => {
      const { ref, argument } = request.params;
      try {
        if (ref.type === "ref/resource") {
          // The MCP SDK types `ref` as a discriminated union; the resource
          // template branch carries `uri`. Narrow then resolve.
          const uri = ref.uri;
          if (uri === "notebooklm://library/{id}" && argument.name === "id") {
            const values = this.completeNotebookIds(argument.value);
            return this.buildCompletion(values);
          }
        }
      } catch (e) {
        log.warning(`⚠️  [MCP] completion error: ${e}`);
      }
      return { completion: { values: [], total: 0 } };
    });

    // List available prompts
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      log.info("📜 [MCP] list_prompts request received");
      return { prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description })) };
    });

    // Get a specific prompt's messages
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name } = request.params;
      log.info(`📜 [MCP] get_prompt request: ${name}`);
      const prompt = PROMPTS.find((p) => p.name === name);
      if (!prompt) {
        throw new Error(
          `Unknown prompt: ${name}. Supported: ${PROMPTS.map((p) => p.name).join(", ")}. ` +
            "Call prompts/list to discover the active set."
        );
      }
      return { description: prompt.description, messages: buildPromptMessages(name) };
    });
  }

  /**
   * Return notebook IDs matching the provided input (case-insensitive contains)
   */
  private completeNotebookIds(input: unknown): string[] {
    const query = String(input ?? "").toLowerCase();
    return this.library
      .listNotebooks()
      .map((nb) => nb.id)
      .filter((id) => id.toLowerCase().includes(query))
      .slice(0, 50);
  }

  /**
   * Build a completion payload for MCP responses
   */
  private buildCompletion(values: string[]) {
    return {
      completion: {
        values,
        total: values.length,
      },
    };
  }
}
