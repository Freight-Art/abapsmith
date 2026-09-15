/**
 * The MCP Streamable HTTP transport (`ABAP_MCP_TRANSPORT=http`): one Node
 * `http` listener, one MCP session per `Mcp-Session-Id`, all sessions
 * sharing the one ADT session pool and the one journal of the process
 * (`src/server.ts`'s `createServer` closes every per-session `McpServer`
 * over those process-wide collaborators).
 *
 * This is NOT a TLS terminator, and the bearer token this module checks
 * authenticates callers to abapsmith only — it does not, and cannot, imply
 * anything about SAP-side authorization. The SAP authorizations of the
 * `ABAP_USER` this process logs on as remain the real security boundary; a
 * caller who passes the bearer check gets exactly what that SAP user can
 * do.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { HttpToken } from "./config.js";
import { verifyBearer } from "./mcp-http-auth.js";
import { runInMcpSession, type McpSessionContext } from "./mcp-session.js";

export interface McpHttpOptions {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly tokens: readonly HttpToken[];
  /** Builds a fresh `McpServer` (full tool surface) bound to one MCP session. */
  readonly createMcpServer: (ctx: McpSessionContext) => McpServer;
  readonly log: (msg: string) => void;
}

export interface McpHttpServer {
  /** The address actually bound — resolves `port: 0` to the port the OS chose. */
  readonly address: { host: string; port: number };
  /** Live MCP sessions right now. */
  readonly sessionCount: number;
  /** Closes every live session and the listener. Never throws. */
  close(): Promise<void>;
}

export const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;

interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  readonly mcp: McpServer;
  readonly ctx: McpSessionContext;
}

interface JsonRpcErrorBody {
  readonly jsonrpc: "2.0";
  readonly error: { readonly code: number; readonly message: string };
  readonly id: null;
}

function jsonRpcError(code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...(extraHeaders ?? {}) });
  res.end(payload);
}

function remoteAddr(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Reads the request body up to {@link MAX_HTTP_BODY_BYTES}. Only ever called
 * after `verifyBearer` has already passed — but the body's SIZE is still
 * entirely caller-controlled regardless of who the caller is, so it is
 * capped here too: once the cap is exceeded the socket is destroyed and the
 * read rejects, rather than buffering an unbounded amount.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > MAX_HTTP_BODY_BYTES) {
        done = true;
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

export async function startMcpHttpServer(opts: McpHttpOptions): Promise<McpHttpServer> {
  const sessions = new Map<string, SessionEntry>();
  const sockets = new Set<Socket>();

  async function createSession(caller: string | undefined): Promise<SessionEntry> {
    // `ctx` is built first, mutably, because the session id does not exist
    // until the SDK mints it (inside `handleRequest`, via
    // `sessionIdGenerator`) — `onsessioninitialized` is what fills it in,
    // and `entry` is only registered into `sessions` at that point, not
    // eagerly here, for the same reason: there is no id to key it by yet.
    const ctx: McpSessionContext = {};
    if (caller !== undefined) ctx.caller = caller;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        ctx.sessionId = sessionId;
        sessions.set(sessionId, entry);
      },
    });
    const mcp = opts.createMcpServer(ctx);
    const entry: SessionEntry = { transport, mcp, ctx };
    transport.onclose = () => {
      if (ctx.sessionId) sessions.delete(ctx.sessionId);
      void mcp.close().catch(() => {});
    };
    // Wires the SDK's request dispatcher to this transport: `connect()`
    // calls `transport.start()` (a documented no-op here — this transport
    // manages connections per-request, not per-socket) and sets
    // `transport.onmessage` to route through this session's `McpServer`.
    // Without this, the listener still accepts requests and mints a
    // session id, but never answers them — an `initialize` POST gets 200 +
    // `mcp-session-id` and then the stream hangs forever.
    try {
      await mcp.connect(transport);
    } catch (e) {
      try {
        await transport.close();
      } catch {
        // Already failing; the connect() error is the one that matters.
      }
      throw e;
    }
    return entry;
  }

  /**
   * The whole attribution mechanism for a Streamable HTTP session: the SDK
   * invokes `onmessage` (and therefore the tool handler, and therefore
   * `Journal.begin()`) inside the promise chain rooted in
   * `transport.handleRequest`, and `AsyncLocalStorage` propagates across
   * every `await` in that chain — so `Journal.begin()` (src/journal.ts) can
   * read `currentMcpSession()` and get the RIGHT session's identity with no
   * per-session `Journal` instance and no per-call plumbing through every
   * tool handler.
   */
  async function delegate(entry: SessionEntry, req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    await runInMcpSession(entry.ctx, () => entry.transport.handleRequest(req, res, parsedBody));
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== opts.path) {
      sendJson(res, 404, jsonRpcError(-32601, `Not found — abapsmith serves MCP on ${opts.path} only`));
      return;
    }

    const verdict = verifyBearer(req.headers.authorization, opts.tokens);
    if (!verdict.ok) {
      const message =
        verdict.reason === "missing"
          ? "missing Authorization: Bearer <token> header"
          : verdict.reason === "malformed"
            ? "Authorization header is not a Bearer token"
            : "bearer token not recognised";
      opts.log(`[abapsmith] HTTP MCP request rejected (${verdict.reason}) from ${remoteAddr(req)}`);
      sendJson(res, 401, jsonRpcError(-32001, message), { "www-authenticate": "Bearer" });
      return;
    }

    const method = req.method ?? "";

    if (method === "GET" || method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"];
      const id = typeof sessionId === "string" ? sessionId : undefined;
      const entry = id !== undefined ? sessions.get(id) : undefined;
      if (!entry) {
        sendJson(res, 404, jsonRpcError(-32001, "unknown or expired MCP session"));
        return;
      }
      await delegate(entry, req, res);
      return;
    }

    if (method === "POST") {
      let raw: Buffer;
      try {
        raw = await readBody(req);
      } catch {
        if (!res.headersSent) sendJson(res, 413, jsonRpcError(-32001, "request body exceeds the size limit"));
        return;
      }
      let body: unknown;
      try {
        body = raw.length === 0 ? undefined : JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(res, 400, jsonRpcError(-32700, "request body is not valid JSON"));
        return;
      }

      const sessionIdHeader = req.headers["mcp-session-id"];
      const id = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
      const existing = id !== undefined ? sessions.get(id) : undefined;
      if (existing) {
        await delegate(existing, req, res, body);
        return;
      }
      if (isInitializeRequest(body)) {
        let entry: SessionEntry;
        try {
          entry = await createSession(verdict.caller);
        } catch (e) {
          opts.log(
            `[abapsmith] HTTP MCP session setup failed: ${e instanceof Error ? e.message : String(e)}`,
          );
          if (!res.headersSent) sendJson(res, 500, jsonRpcError(-32603, "failed to establish MCP session"));
          return;
        }
        await delegate(entry, req, res, body);
        return;
      }
      sendJson(res, 400, jsonRpcError(-32000, "no valid MCP session id, and this is not an initialize request"));
      return;
    }

    res.writeHead(405, { allow: "GET, POST, DELETE" });
    res.end();
  }

  const server: Server = createHttpServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      opts.log(`[abapsmith] HTTP MCP request handler threw: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) {
        sendJson(res, 500, jsonRpcError(-32603, "internal error"));
      } else {
        res.end();
      }
    });
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    server.once("error", onError);
    server.listen(opts.port, opts.host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = addr !== null && typeof addr === "object" ? addr.port : opts.port;

  return {
    address: { host: opts.host, port: boundPort },
    get sessionCount() {
      return sessions.size;
    },
    async close() {
      const entries = [...sessions.values()];
      sessions.clear();
      for (const entry of entries) {
        // Guarded per entry, same rule as `AdtSessionPool.shutdown`: one
        // stuck session must not block the next, or the listener close
        // below.
        try {
          await entry.transport.close();
        } catch {
          // ignore
        }
        try {
          await entry.mcp.close();
        } catch {
          // ignore
        }
      }
      // `server.close()` stops accepting new connections but its callback
      // fires only once every EXISTING connection has ended on its own — a
      // keep-alive client socket or a parked SSE stream left open would
      // otherwise keep this pending forever, so `stop()` would never
      // return and the process would not exit on SIGINT. Start the close,
      // THEN destroy the tracked sockets (unblocking it), THEN await.
      const closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await closed;
    },
  };
}
