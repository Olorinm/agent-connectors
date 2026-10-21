import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { digest, type Json } from "../../canonical.js";
import { ConnectorError, type Connector, type ToolContext, type ToolDefinition } from "../../connector.js";
import { remoteSpec, type RemoteSpec } from "./catalog.js";
import { RemoteOAuth, restrictedFetch, type RemoteOptions } from "./oauth.js";

/** One serialization queue per connection also protects rotating refresh tokens. */
export function remoteConnector(kind: "github" | "notion", options: RemoteOptions = {}): Connector {
  const queues = new Map<string, Promise<unknown>>();
  const locked = <T>(context: ToolContext, work: (oauth: RemoteOAuth, spec: RemoteSpec) => Promise<T>): Promise<T> => {
    const run = (queues.get(context.connection.id) ?? Promise.resolve()).then(async () => {
      context.signal.throwIfAborted();
      const spec = remoteSpec(context.connection);
      return work(await RemoteOAuth.load(context, spec, options), spec);
    });
    queues.set(context.connection.id, run.catch(() => undefined));
    return run;
  };
  const status = (context: ToolContext) => locked(context, async (oauth, spec) => {
    const local = oauth.status() as Record<string, Json>;
    if (local.status !== "authorized_unverified") return local;
    try {
      const count = await session(oauth, async (client) => (await list(client, context.signal)).filter((t) => Object.hasOwn(spec.risks, t.name)).length);
      return { ...local, status: "connected", tools: count };
    } catch (error) {
      return { ...local, status: error instanceof ConnectorError ? error.code : "upstream_unavailable" };
    }
  });
  return {
    kind,
    tools: [{ name: "connection_status", description: "Check this connection's configuration and authorization. Does not return credentials.",
      risk: "read", input: z.object({}).strict(), execute: status }],
    account: {
      status,
      connect: (context) => locked(context, (oauth) => oauth.begin()),
      disconnect: (context) => locked(context, async (oauth) => oauth.disconnect()),
      callback: async (context, state, code) => {
        const stored = await context.credentials.get() as { pending?: { state?: string } } | undefined;
        if (stored?.pending?.state !== state) return Promise.resolve(false);
        return locked(context, (oauth) => oauth.complete(state, code));
      },
    },
    discover: (context) => locked(context, async (oauth, spec) => {
      const tools = await session(oauth, (client) => list(client, context.signal));
      return tools.filter((tool) => Object.hasOwn(spec.risks, tool.name)).flatMap((tool): ToolDefinition[] => {
        const risk = spec.risks[tool.name]!;
        const version = fingerprint(oauth, tool, risk);
        // A separate validator avoids upstream $id collisions across tools and accounts.
        let validate: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
        try { validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema); }
        catch { return []; } // Unsupported schemas never become unvalidated calls.
        return [{
          name: tool.name.replaceAll(".", "_"), risk, version,
          description: tool.description ?? tool.name, inputSchema: tool.inputSchema,
          input: z.record(z.string(), z.json()).superRefine((value, ctx) => {
            if (!validate(value).valid) ctx.addIssue({ code: "custom", message: "Arguments do not match the provider's tool schema." });
          }),
          summarize: (_input, connection) => `${kind}: ${tool.name} on ${connection.label ?? connection.id}. Review all arguments below.`,
          execute: (execution, input) => locked(execution, async (current) => {
            if (current.stateValue.generation !== oauth.stateValue.generation) throw new ConnectorError("connection_changed");
            return session(current, async (client) => {
              const latest = (await list(client, execution.signal)).find((candidate) => candidate.name === tool.name);
              if (!latest || fingerprint(current, latest, risk) !== version) throw new ConnectorError("upstream_tool_changed");
              if (!validate(input).valid) throw new ConnectorError("invalid_arguments");
              // From this point on, any error can be a partial write. Do not translate it to ConnectorError or retry.
              let result;
              try { result = await client.callTool({ name: tool.name, arguments: input }, undefined, { signal: execution.signal, timeout: 60_000 }); }
              catch { throw new Error("upstream_call_outcome_unknown"); }
              if (result.isError) throw new Error("upstream_call_outcome_unknown");
              return JSON.parse(JSON.stringify(result)) as Json;
            });
          }),
        }];
      });
    }),
  };
}

function fingerprint(oauth: RemoteOAuth, tool: Tool, risk: string) {
  return digest({ generation: oauth.stateValue.generation, binding: oauth.stateValue.binding,
    name: tool.name, schema: tool.inputSchema, risk });
}

async function list(client: Client, signal: AbortSignal): Promise<Tool[]> {
  const tools: Tool[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 30_000 });
    tools.push(...page.tools); cursor = page.nextCursor;
    if (tools.length > 1000 || (cursor && cursors.has(cursor))) throw new ConnectorError("upstream_tool_list_invalid");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tools;
}

async function session<T>(oauth: RemoteOAuth, work: (client: Client) => Promise<T>): Promise<T> {
  const token = await oauth.accessToken();
  const client = new Client({ name: "mau-agent-connectors", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(oauth.spec.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: restrictedFetch([new URL(oauth.spec.endpoint).origin], oauth.options.fetch),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    // Auth is completed before dispatch, so the transport cannot replay a write after reauthorization.
  });
  try {
    try { await client.connect(transport, { signal: oauth.context.signal, timeout: 30_000 }); }
    catch (error) {
      if (error instanceof StreamableHTTPError && error.code === 401) {
        await oauth.invalidateCredentials("tokens"); throw new ConnectorError("authorization_required");
      }
      if (error instanceof StreamableHTTPError && error.code === 403) throw new ConnectorError("upstream_access_denied");
      throw new ConnectorError("upstream_unavailable");
    }
    return await work(client);
  } finally { await client.close().catch(() => undefined); }
}
