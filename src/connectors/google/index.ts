import { z } from "zod";
import { digest, type Json } from "../../canonical.js";
import { ConnectorError, type Connector, type ToolContext } from "../../connector.js";
import { GoogleAccount, type GoogleOptions } from "./account.js";
import { googleTools } from "./tools.js";

/** Official Google APIs underneath the same local MCP and approval boundary. */
export function googleConnector(options: GoogleOptions = {}): Connector {
  const queues = new Map<string, Promise<unknown>>();
  const locked = <T>(context: ToolContext, work: (account: GoogleAccount) => Promise<T>): Promise<T> => {
    const run = (queues.get(context.connection.id) ?? Promise.resolve()).then(async () => {
      context.signal.throwIfAborted();
      return work(await GoogleAccount.load(context, options));
    });
    queues.set(context.connection.id, run.catch(() => undefined));
    return run;
  };
  const status = (context: ToolContext) => locked(context, (account) => account.status());
  return {
    kind: "google",
    tools: [{ name: "connection_status", description: "Check Google application configuration and OAuth authorization. No credentials are returned.",
      risk: "read", input: z.object({}).strict(), execute: status }],
    account: {
      status,
      connect: (context) => locked(context, (account) => account.begin()),
      disconnect: (context) => locked(context, async (account) => account.disconnect()),
      callback: async (context, state, code) => {
        const saved = await context.credentials.get() as { pending?: { state?: string } } | undefined;
        if (saved?.pending?.state !== state) return Promise.resolve(false);
        return locked(context, (account) => account.complete(state, code));
      },
    },
    discover: (context) => locked(context, async (account) => {
      await account.accessToken();
      return googleTools(account.settings.product).map((tool) => {
        const schema = z.toJSONSchema(tool.input, { io: "input" });
        return { ...tool, version: digest({ revision: "google-api-v1", binding: account.state.binding,
          generation: account.state.generation, name: tool.name, risk: tool.risk, schema }),
        summarize: (_input: unknown, connection: ToolContext["connection"]) =>
          `Google ${account.settings.product}: ${tool.name} on ${connection.label ?? connection.id}. Review all arguments below.`,
        execute: (execution: ToolContext, input: unknown) => locked(execution, async (current) => {
          if (current.state.generation !== account.state.generation || current.state.binding !== account.state.binding)
            throw new ConnectorError("connection_changed");
          const auth = await current.businessClient();
          try {
            const result = await tool.execute(auth, input, execution.signal);
            return result === undefined || result === "" ? { ok: true } : JSON.parse(JSON.stringify(result)) as Json;
          } catch (error) {
            // Even 4xx/5xx may follow a partial write. Never report a write as safe to retry.
            if (tool.risk === "write") throw new Error("google_write_outcome_unknown");
            const status = (error as { response?: { status?: number } }).response?.status;
            throw new ConnectorError(status === 401 ? "authorization_required" : status === 403 ? "google_api_access_denied" : "google_api_request_failed");
          }
        }) };
      });
    }),
  };
}
export type { GoogleOptions } from "./account.js";
