import { z } from "zod";
import { digest, type Json } from "../../canonical.js";
import { ConnectorError, type Connector, type ToolContext } from "../../connector.js";
import { GoogleAccount, googleSettings, type GoogleOptions } from "./account.js";
import { GMAIL_READ_OPERATIONS, GMAIL_WRITE_OPERATIONS, gmailMethodOperation, gmailToolOperation, googleCatalog } from "./operations.js";
import { googleTools } from "./tools.js";
import { classifyGws, gwsBinary, gwsEnvironment, gwsInput, gwsOutput, runGws, shellLine, type GwsPlan, type GwsResult } from "./gws.js";
import { GENERIC_CATALOG as GENERIC } from "../../policy.js";

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
  // Discovery answers are the same for every call; classification asks gws once per method.
  const schemas = new Map<string, GwsResult>();
  return {
    kind: "google",
    tools: [{ name: "connection_status", description: "Check Google application configuration and OAuth authorization. No credentials are returned.",
      risk: "read", operations: [], input: z.object({}).strict(), execute: status }],
    operations: (connection) => {
      const parsed = googleSettings.safeParse(connection.settings ?? {});
      return parsed.success ? googleCatalog(parsed.data.product) ?? GENERIC : GENERIC;
    },
    account: {
      status,
      connect: (context, input) => locked(context, (account) => account.begin(input?.scopes ?? [])),
      scopes: (context) => locked(context, async (account) => account.grantedScopes()),
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
      const gmail = account.settings.product === "gmail";
      const classify = (args: string[], execution: ToolContext) => classifyGws(args, account.settings.product, async (schemaArgs) => {
        const key = schemaArgs.join(" "), known = schemas.get(key);
        if (known) return known;
        const environment = gwsEnvironment();
        try {
          const result = await runner!(schemaArgs, environment.env, 60_000, execution.signal);
          if (result.code === 0 && schemas.size < 1000) schemas.set(key, result);
          return result;
        } finally { environment.dispose(); }
      });
      const gws = runner ? (["read", "write"] as const).map((mode) => ({
        name: `gws_${mode}`, description: gwsDescription[mode], risk: mode, input: gwsInput,
        operations: gmail ? mode === "read" ? GMAIL_READ_OPERATIONS : GMAIL_WRITE_OPERATIONS : [mode],
        // Help, schema and dry runs have no effect; everything else is the operation of the method it calls.
        operation: async (execution: ToolContext, input: { args: string[] }) => {
          const plan = await classify(input.args, execution);
          if (plan.kind === "guide" || (plan.kind === "read" && input.args.includes("--dry-run"))) return null;
          return gmail ? gmailMethodOperation(plan.method ?? "", plan.kind === "read") : plan.kind;
        },
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
          const plan: GwsPlan = await classify(input.args, execution);
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
        operations: [gmail ? gmailToolOperation[tool.name] ?? (tool.risk === "read" ? "gmail.messages.read" : "gmail.other.write") : tool.risk],
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
