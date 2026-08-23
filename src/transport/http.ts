/**
 * HTTP transport for the MCP server (issue #4).
 *
 * Built on the v2 SDK's `createMcpHandler`, which is one of the two entry
 * points that actually put protocol revision **2026-07-28** on the wire (the
 * other is `serveStdio`). Constructing a `Server` by hand and attaching a
 * transport — what this file used to do — serves the 2025 era only.
 *
 * `createMcpHandler` also owns instance lifetime: it builds an instance from
 * the factory per exchange, which removes the session bookkeeping this file
 * used to hand-roll — including the bug where every HTTP session after the
 * first crashed with "already connected", because one `Server` instance was
 * being connected to every transport.
 *
 * Routes:
 *   POST   /mcp     — JSON-RPC requests/responses (both eras)
 *   GET    /mcp     — SSE stream (2025-era sessions; 405 under the stateless
 *                     legacy fallback)
 *   DELETE /mcp     — session termination (same caveat)
 *   GET    /healthz — liveness probe
 *
 * SECURITY: this transport has NO authentication and performs NO Host or
 * Origin validation. Bind it to localhost, or put it behind a proxy that
 * authenticates — anything that can reach the port can drive the signed-in
 * browser this server automates.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import {
  createMcpHandler,
  type McpHttpHandler,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { log } from "../utils/logger.js";

export interface HttpTransportOptions {
  port: number;
  host?: string;
  /** Builds one MCP server instance. Called per exchange by the SDK handler. */
  factory: McpServerFactory;
}

export interface HttpTransportHandle {
  server: HttpServer;
  close: () => Promise<void>;
}

export async function startHttpTransport(opts: HttpTransportOptions): Promise<HttpTransportHandle> {
  const handler: McpHttpHandler = createMcpHandler(opts.factory, {
    // Keep serving 2025-era clients: this server is registered in clients that
    // have not moved to the new revision yet, and dropping them buys nothing.
    legacy: "stateless",
    onerror: (error) => log.warning(`⚠️  [HTTP] ${error.message}`),
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res, handler).catch((err) => {
      log.error(`❌ [HTTP] Unhandled request error: ${err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      log.success(
        `🌐 HTTP transport listening on http://${opts.host ?? "127.0.0.1"}:${opts.port}/mcp`
      );
      log.warning("  ⚠️  No authentication and no Host/Origin checks — keep this on localhost.");
      resolve();
    });
  });

  return {
    server,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handler: McpHttpHandler
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", protocol: "mcp-streamable-http" }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found", expected: "/mcp" }));
    return;
  }

  const response = await handler.fetch(await toWebRequest(req, url));
  await writeWebResponse(res, response);
}

/** Adapt a `node:http` request to the web-standard `Request` the SDK takes. */
async function toWebRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;

  return new Request(url.toString(), {
    method,
    headers,
    ...(body !== undefined && body.length > 0 ? { body: new Uint8Array(body) } : {}),
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Stream a web `Response` back out through the `node:http` response. */
async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  // An SSE response streams indefinitely; piping chunk-by-chunk keeps it live
  // instead of buffering a body that never completes.
  const reader = response.body.getReader();

  // A client that walks away must not leave the pump (and the SDK stream
  // behind it) running forever.
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    void reader.cancel().catch(() => undefined);
  };
  res.on("close", onClose);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || clientGone) break;
      if (!value) continue;
      // Respect backpressure: without this a slow consumer buffers the whole
      // stream in this process's memory.
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } finally {
    res.off("close", onClose);
    res.end();
  }
}
