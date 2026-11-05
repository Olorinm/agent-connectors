import { z } from "zod";
import { digest, type Json } from "../../canonical.js";
import { ConnectorError, type Connector, type ToolContext } from "../../connector.js";
import { GoogleAccount, type GoogleOptions } from "./account.js";
import { googleTools } from "./tools.js";
import { classifyGws, gwsBinary, gwsEnvironment, gwsInput, gwsOutput, runGws, shellLine, type GwsPlan } from "./gws.js";

const gwsDescription = {
  read: "Run an official Google Workspace CLI (gws) command on the owner's Google account that only reads: GET methods, helper reads such as +triage and +read, " +
    "--dry-run, `<service> --help` and `schema <service.resource.method>`. Pass argument strings without the executable or shell syntax. " +
    "Writes are refused here with gws_command_requires_write_tool; use gws_write.",
  write: "Run an official Google Workspace CLI (gws) command that changes the owner's Google data (send, draft, modify, insert, delete). " +
    "The owner approves the exact command first. Pass argument strings without the executable or shell syntax.",
};

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
      const binary = gwsBinary(options.gwsBinary), runner = options.gwsRunner ?? (binary ? runGws(binary) : undefined);
      const versioned = (name: string, risk: string, schema: unknown) => digest({ revision: "google-api-v1", binding: account.state.binding,
        generation: account.state.generation, name, risk, schema });
      const gws = runner ? (["read", "write"] as const).map((mode) => ({
        name: `gws_${mode}`, description: gwsDescription[mode], risk: mode, input: gwsInput,
        version: versioned(`gws_${mode}`, mode, z.toJSONSchema(gwsInput, { io: "input" })),
        summarize: (input: { args: string[] }) => `Google ${account.settings.product}: ${shellLine(input.args)}`,
        execute: (execution: ToolContext, input: { args: string[] }) => locked(execution, async (current) => {
          if (current.state.generation !== account.state.generation || current.state.binding !== account.state.binding)
            throw new ConnectorError("connection_changed");
          const call = async (args: string[], token?: string) => {
            const environment = gwsEnvironment(token);
            try { return await runner(args, environment.env, 60_000, execution.signal); } finally { environment.dispose(); }
          };
          // Classification and help need no credentials.
          const plan: GwsPlan = await classifyGws(input.args, current.settings.product, (args) => call(args));
          if (plan.kind === "guide") return gwsOutput(await call(input.args));
          // An operation the granted scopes cannot perform is refused before any approval.
          if (plan.scopes?.length && !plan.scopes.some((scope) => current.scopes.includes(scope)))
            throw new ConnectorError("google_scope_not_granted", { method: plan.method ?? null, grantOneOf: plan.scopes });
          if (plan.kind === "write" && mode === "read") throw new ConnectorError("gws_command_requires_write_tool", { method: plan.method ?? null });
          const { token } = await (await current.businessClient()).getAccessToken();
          if (!token) throw new ConnectorError("authorization_required");
          try { return gwsOutput(await call(input.args, token)); }
          catch (error) {
            if (mode === "write") throw new Error("google_write_outcome_unknown");
            throw error instanceof ConnectorError ? error : new ConnectorError("google_api_request_failed");
          }
        }),
      })) : [];
      return [...gws, ...googleTools(account.settings.product).map((tool) => {
        const schema = z.toJSONSchema(tool.input, { io: "input" });
        return { ...tool, version: versioned(tool.name, tool.risk, schema),
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
            if (error instanceof ConnectorError) throw error;
            // Even 4xx/5xx may follow a partial write. Never report a write as safe to retry.
            if (tool.risk === "write") throw new Error("google_write_outcome_unknown");
            const status = (error as { response?: { status?: number } }).response?.status;
            throw new ConnectorError(status === 401 ? "authorization_required" : status === 403 ? "google_api_access_denied" : "google_api_request_failed");
          }
        }) };
      })];
    }),
  };
}
export type { GoogleOptions } from "./account.js";
