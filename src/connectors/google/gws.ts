import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Json } from "../../canonical.js";
import { ConnectorError } from "../../connector.js";
import type { GoogleProduct } from "./account.js";

/**
 * The official Google Workspace CLI (`gws`, googleworkspace/cli, Apache-2.0) as a connector
 * backend. It builds its commands from Google's Discovery documents, so a raw method's
 * HTTP verb and OAuth scopes classify it: GET reads, anything else writes. Helper commands
 * (`+triage`, `+send`, …) are mapped to the method they call. The access token reaches the
 * process through GOOGLE_WORKSPACE_CLI_TOKEN only; it is never written or shown to the Agent.
 */
export type GwsResult = { code: number; stdout: string; stderr: string };
export type GwsRunner = (args: string[], env: NodeJS.ProcessEnv, timeout: number, signal: AbortSignal) => Promise<GwsResult>;

export const gwsOutputLimit = 60_000;
const services: Record<GoogleProduct, string> = { gmail: "gmail", drive: "drive", docs: "docs", sheets: "sheets", slides: "slides", calendar: "calendar" };
// Helper commands and the Discovery method each one calls.
const helpers: Record<string, Record<string, string>> = {
  gmail: { "+triage": "users.messages.list", "+read": "users.messages.get", "+send": "users.messages.send",
    "+reply": "users.messages.send", "+reply-all": "users.messages.send", "+forward": "users.messages.send" },
  calendar: { "+agenda": "events.list", "+insert": "events.insert" },
  drive: { "+upload": "files.create" },
  sheets: { "+read": "spreadsheets.values.get", "+append": "spreadsheets.values.append" },
  docs: { "+write": "documents.batchUpdate" },
};
// Local files, long-lived streams and response screening are not available through the connector.
const refusedFlags = new Set(["--upload", "-a", "--attach", "-o", "--output", "--sanitize", "--upload-content-type"]);
const refusedHelpers = new Set(["+watch", "+upload"]);

export const gwsInput = z.object({ args: z.array(z.string().max(100_000)).min(1).max(100) }).strict();

export function gwsBinary(configured?: string) {
  const path = configured ?? process.env.AGENT_CONNECTORS_GWS_BINARY;
  return path && existsSync(path) ? path : undefined;
}

export function runGws(binary: string): GwsRunner {
  return (args, env, timeout, signal) => new Promise((resolve, reject) => {
    // The pinned binary with an argument array: no shell, no user-wide configuration.
    const child = execFile(binary, args, { env, timeout, signal, maxBuffer: 4_000_000, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(new Error(error.killed ? "gws_execution_interrupted" : "gws_execution_failed")); return; }
      resolve({ code: (error?.code as number | undefined) ?? 0, stdout, stderr });
    });
    child.stdin?.end();
  });
}

export interface GwsPlan { kind: "guide" | "read" | "write"; method?: string; scopes?: string[] }

/** Classifies a command without credentials; Discovery schemas come from Google. */
export async function classifyGws(args: string[], product: GoogleProduct, run: (args: string[]) => Promise<GwsResult>): Promise<GwsPlan> {
  const service = services[product];
  if (args[0] === "schema") {
    if (args.length !== 2 || !args[1]!.startsWith(`${service}.`)) throw new ConnectorError("gws_command_not_allowed", { allowed: `${service}.*` });
    return { kind: "guide" };
  }
  if (args[0] !== service) throw new ConnectorError("gws_service_not_connected", { connected: service });
  for (const arg of args) {
    const flag = arg.split("=")[0]!;
    if (refusedFlags.has(flag)) throw new ConnectorError("gws_flag_not_allowed", { flag });
  }
  if (args.includes("--help") || args.includes("-h") || args.length === 1) return { kind: "guide" };
  const dryRun = args.includes("--dry-run");
  let method: string;
  if (args[1]!.startsWith("+")) {
    if (refusedHelpers.has(args[1]!)) throw new ConnectorError("gws_command_not_allowed", { command: args[1]! });
    const mapped = helpers[service]?.[args[1]!];
    if (!mapped) throw new ConnectorError("gws_command_not_allowed", { command: args[1]! });
    method = args[1] === "+send" && args.includes("--draft") ? "users.drafts.create" : mapped;
  } else {
    const path: string[] = [];
    for (const arg of args.slice(1)) { if (arg.startsWith("-")) break; path.push(arg); }
    if (!path.length || path.some((part) => !/^[A-Za-z][A-Za-z0-9]*$/.test(part))) throw new ConnectorError("gws_method_unknown");
    method = path.join(".");
  }
  const schema = await run(["schema", `${service}.${method}`]);
  let parsed: { httpMethod?: string; scopes?: string[] };
  try { parsed = JSON.parse(schema.stdout); } catch { throw new ConnectorError("gws_method_unknown", { method: `${service}.${method}` }); }
  if (schema.code !== 0 || typeof parsed.httpMethod !== "string") throw new ConnectorError("gws_method_unknown", { method: `${service}.${method}` });
  // A dry run only prints the request it would send.
  return { kind: dryRun || parsed.httpMethod === "GET" ? "read" : "write", method: `${service}.${method}`, scopes: parsed.scopes ?? [] };
}

export function shellLine(args: string[]) {
  return ["gws", ...args].map((arg) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

export function gwsOutput(result: GwsResult): Json {
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  const output = text.length > gwsOutputLimit
    ? `${text.slice(0, gwsOutputLimit)}\n…[truncated: ${text.length - gwsOutputLimit} more characters; narrow the request, e.g. --params maxResults or +read]`
    : text;
  return { exitCode: result.code, output };
}

/** A private, empty configuration per call; Discovery is fetched again rather than cached with credentials. */
export function gwsEnvironment(token?: string) {
  const home = mkdtempSync(join(tmpdir(), "gws-"));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: join(home, "config"),
    GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file", ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(token ? { GOOGLE_WORKSPACE_CLI_TOKEN: token } : {}) };
  return { env, dispose: () => rmSync(home, { recursive: true, force: true }) };
}
