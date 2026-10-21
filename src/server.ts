import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ServiceError, type CallOutcome, type ConnectorService } from "./service.js";
import { TokenError, type Caller, type TokenVerifier } from "./tokens.js";
import { ConnectorError } from "./connector.js";

export interface HttpOptions {
  service: ConnectorService;
  tokens: TokenVerifier;
  /** Host header values to accept (DNS rebinding protection). */
  allowedHosts?: string[];
  version?: string;
}

const MAX_BODY = 1_000_000;

/**
 * Routes:
 *   POST /mcp                          Agent tools (caller token)
 *   GET  /v1/operations                pending operations (service token)
 *   GET  /v1/operations/:id            one operation, for the approval screen (service token)
 *   POST /v1/operations/:id/approve    {grant} — the grant itself authorizes execution
 *   POST /v1/operations/:id/deny       (service token)
 *   GET  /v1/health
 */
export function createHttpServer(options: HttpOptions): HttpServer {
  return createServer((request, response) => {
    handle(options, request, response).catch((error) => {
      const status = error instanceof ServiceError ? error.status : error instanceof TokenError ? 401 : error instanceof HttpError ? error.status : error instanceof ConnectorError ? 400 : 500;
      const code = error instanceof ServiceError || error instanceof TokenError || error instanceof HttpError || error instanceof ConnectorError ? error.message : "internal_error";
      if (!response.headersSent) reply(response, status, { error: code });
      else response.end();
    });
  });
}

async function handle(options: HttpOptions, request: IncomingMessage, response: ServerResponse) {
  // Browsers are never legitimate callers; refuse cross-origin and unexpected Host headers.
  if (request.headers.origin !== undefined) throw new HttpError(403, "origin_not_allowed");
  if (options.allowedHosts && !options.allowedHosts.includes(request.headers.host ?? "")) throw new HttpError(403, "host_not_allowed");
  const url = new URL(request.url ?? "/", "http://connectors.invalid");
  const path = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/oauth/callback" && request.method === "GET") {
    const state = url.searchParams.get("state"), code = url.searchParams.get("code");
    if (!state || state.length > 256 || (code && code.length > 4096) ||
      url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1 ||
      (!code && !url.searchParams.has("error"))) throw new HttpError(400, "oauth_callback_invalid");
    response.setHeader("Referrer-Policy", "no-referrer");
    await options.service.oauthCallback(state, code ?? undefined, AbortSignal.timeout(60_000));
    return reply(response, 200, { status: code ? "authorized" : "authorization_cancelled", message: "Return to Mau and check the connection status." });
  }
  if (url.pathname === "/v1/health" && request.method === "GET") return reply(response, 200, { ok: true });
  if (path[0] === "v1" && path[1] === "connections") {
    await options.tokens.service(bearer(request));
    const signal = AbortSignal.timeout(60_000);
    if (path.length === 2 && request.method === "GET") return reply(response, 200, { connections: await options.service.connections(signal) });
    if (path.length === 3 && request.method === "GET") return reply(response, 200, await options.service.account(path[2]!, "status", signal));
    if (path.length === 4 && request.method === "POST" && ["connect", "disconnect"].includes(path[3]!))
      return reply(response, 200, await options.service.account(path[2]!, path[3] as "connect" | "disconnect", signal));
  }
  if (url.pathname === "/mcp") {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const caller = await options.tokens.caller(bearer(request));
    return mcp(options, caller, request, response, await body(request));
  }
  if (path[0] === "v1" && path[1] === "operations") {
    const id = path[2];
    if (path.length === 4 && path[3] === "approve" && request.method === "POST") {
      const { grant } = (await body(request)) as { grant?: unknown };
      if (typeof grant !== "string") throw new HttpError(400, "grant_required");
      const verified = await options.tokens.grant(grant);
      if (verified.operationId !== id) throw new ServiceError("grant_does_not_match_operation", 403);
      // A started write is not aborted when the approver disconnects; the outcome stays queryable.
      return reply(response, 200, await options.service.approve(verified, AbortSignal.timeout(120_000)));
    }
    await options.tokens.service(bearer(request));
    if (path.length === 2 && request.method === "GET") return reply(response, 200, { operations: await options.service.pending() });
    if (path.length === 3 && request.method === "GET") {
      const view = await options.service.operation(id!);
      if (!view) throw new ServiceError("operation_not_found", 404);
      return reply(response, 200, view);
    }
    if (path.length === 4 && path[3] === "deny" && request.method === "POST") {
      options.service.deny(id!);
      return reply(response, 200, { ok: true });
    }
  }
  throw new HttpError(404, "not_found");
}

async function mcp(options: HttpOptions, caller: Caller, request: IncomingMessage, response: ServerResponse, parsed: unknown) {
  const server = new Server({ name: "agent-connectors", version: options.version ?? "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    await options.service.prepare(caller, extra.signal);
    return { tools: options.service.tools(caller).map((tool) => ({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema as { type: "object" },
      annotations: tool.risk === "read" ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true },
    })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
    // Internal errors reach the Agent only as a code, never as a message.
    const outcome = await options.service.call(caller, call.params.name, call.params.arguments, extra.signal)
      .catch((error): CallOutcome => ({ status: "failed", error: error instanceof ServiceError ? error.code : "internal_error" }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
      structuredContent: outcome as unknown as Record<string, unknown>,
      isError: outcome.status === "failed" || outcome.status === "uncertain",
    };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, parsed);
}

class HttpError extends Error {
  constructor(readonly status: number, code: string) {
    super(code);
  }
}

function bearer(request: IncomingMessage) {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(request.headers.authorization ?? "");
  if (!match) throw new TokenError("bearer_token_required");
  return match[1]!;
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body_too_large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function reply(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
}
