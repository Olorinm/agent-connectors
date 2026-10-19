import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliResult, CliRunner } from "./account.js";

export type FeishuRisk = "read" | "write" | "high-risk-write";

/** lark-cli service domains reachable from tools. CLI management, profiles and long-running event consumers are not. */
export const SERVICES = new Set(["approval", "apps", "attendance", "base", "calendar", "contact", "docs", "drive", "im", "mail", "markdown",
  "mindnotes", "minutes", "note", "okr", "sheets", "slides", "task", "vc", "whiteboard", "wiki", "api", "application"]);
const IDENTITY_FLAGS = /^(--as|--profile|--user-open-id|--user|--config|--app-id)(=|$)/;
/** The connector places these itself; an Agent-supplied value could override them. */
const RESERVED_FLAGS = /^(--help|-h|--yes)=/;

/** Long-running consumers subscribe server-side and hold the account's command queue. */
const LONG_RUNNING = /^\+(watch|subscribe)/;

export class ArgumentsError extends Error {}

/**
 * Rejects argument lists that leave the linked owner's identity or the supported domains, run indefinitely,
 * or reach the connector host's files: `@file` expansion, stdin, absolute, home-relative and parent paths.
 * Files are exchanged only through the per-call directory.
 */
export function checkArguments(args: string[]) {
  if (!SERVICES.has(args[0]!)) throw new ArgumentsError("feishu_command_not_allowed");
  if (args.some((arg) => IDENTITY_FLAGS.test(arg))) throw new ArgumentsError("feishu_identity_flags_not_allowed");
  if (args.some((arg) => RESERVED_FLAGS.test(arg))) throw new ArgumentsError("feishu_reserved_flag_value");
  if (args.some((arg) => LONG_RUNNING.test(arg))) throw new ArgumentsError("feishu_long_running_command_not_allowed");
  args.forEach((arg, index) => {
    if (args[0] === "api" && index === 2) return; // the API path, e.g. /open-apis/calendar/v4/calendars
    const value = /^--[^=]+=/.test(arg) ? arg.slice(arg.indexOf("=") + 1) : arg;
    if (value === "-" || value.startsWith("@") || value.startsWith("/") || value.startsWith("~") || value.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value))
      throw new ArgumentsError("feishu_local_path_not_allowed");
  });
}

/**
 * Requests for usage text, schemas or embedded skills. They are answered from an unconfigured CLI;
 * the Agent's argument list itself is never executed for them.
 */
export function guidanceArgs(args: string[]): string[] | undefined {
  if (args[0] === "schema" && args.length <= 2) return args;
  if (args[0] === "skills" && ["list", "read"].includes(args[1] ?? "") && args.length <= 3) return args;
  if (SERVICES.has(args[0]!) && (args.includes("--help") || args.includes("-h"))) {
    // Only the command path: help for exactly the command the Agent asked about, with nothing else to parse.
    const end = args.findIndex((arg, index) => index > 0 && arg.startsWith("-"));
    return helpArgs(args.slice(0, end < 0 ? args.length : end));
  }
  return undefined;
}

/**
 * Flags the connector adds go directly after the domain in `--name=value` form: no preceding flag can take
 * them as its value, and the CLI still resolves the full command path from the remaining arguments.
 */
export function withFlags(args: string[], flags: string[]) {
  return [args[0]!, ...flags, ...args.slice(1)];
}

export function helpArgs(args: string[]) {
  return withFlags(args, ["--help=true"]);
}

export interface Classification {
  /** Resolved command path from the official usage line, e.g. "mail +send". */
  command: string;
  /** Undefined when the CLI declares no risk (unknown command): never treated as read. */
  risk?: FeishuRisk;
}

export function classify(help: CliResult): Classification {
  const text = `${help.stdout}\n${help.stderr}`;
  const usage = /^Usage:\s*\n\s+lark-cli ((?:[^\s[]+ ?)+)/m.exec(text)?.[1]?.trim() ?? "";
  const risk = /^Risk: (read|write|high-risk-write)\s*$/m.exec(text)?.[1] as FeishuRisk | undefined;
  return { command: usage, ...(help.code === 0 && risk ? { risk } : {}) };
}

/** POST endpoints that only read. Everything else that is not GET is treated as a write. */
const READ_POST = /\/(search|batch_get|batch_query|mget|query|fetch)$/;

export interface Plan {
  /** True only when the CLI produced a dry-run plan whose every request reads. */
  readOnly: boolean;
  requests: Array<{ method: string; url: string }>;
}

export function readPlan(result: CliResult): Plan {
  let value: any;
  try { value = JSON.parse(result.stdout); } catch { return { readOnly: false, requests: [] }; }
  const api = value?.ok === true && value?.dry_run === true && Array.isArray(value?.data?.api) ? value.data.api : undefined;
  if (!api) return { readOnly: false, requests: [] };
  const requests = api.map((item: any) => ({ method: String(item?.method ?? "").toUpperCase(), url: String(item?.url ?? "").split("?")[0]! }));
  return { readOnly: requests.every((r: { method: string; url: string }) => r.method === "GET" || (r.method === "POST" && READ_POST.test(r.url))), requests };
}

/**
 * The official CLI without the owner's identity: classification uses empty configuration; dry-run planning uses
 * a placeholder app with no user and every proxy pointed at a closed local port. An argument list that
 * unexpectedly executed could not act as anyone or reach the network.
 */
export class UnconfiguredCli {
  readonly #directory: string;
  constructor(directory: string, private readonly runner: CliRunner) {
    this.#directory = directory;
    for (const name of ["config", "data", "work", "plan-config", "plan-data"]) mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "plan-secret"), "placeholder", { mode: 0o600 });
    writeFileSync(join(directory, "plan-config", "config.json"), JSON.stringify({ apps: [{ appId: PLAN_APP,
      appSecret: { source: "file", id: join(directory, "plan-secret") }, brand: "feishu", defaultAs: "user", users: [] }] }), { mode: 0o600 });
  }
  #env(config: string, data: string): NodeJS.ProcessEnv {
    const offline = "http://127.0.0.1:9";
    return { PATH: process.env.PATH ?? "", HOME: this.#directory, LANG: process.env.LANG ?? "C.UTF-8",
      HTTPS_PROXY: offline, HTTP_PROXY: offline, ALL_PROXY: offline, https_proxy: offline, http_proxy: offline, all_proxy: offline, NO_PROXY: "", no_proxy: "",
      LARKSUITE_CLI_CONFIG_DIR: join(this.#directory, config), LARKSUITE_CLI_DATA_DIR: join(this.#directory, data),
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" };
  }
  run(args: string[], timeout = 15_000): Promise<CliResult> {
    return this.runner(args, { cwd: join(this.#directory, "work"), env: this.#env("config", "data"), timeout });
  }
  async classify(args: string[]): Promise<Classification> {
    return classify(await this.run(helpArgs(args)));
  }
  async plan(args: string[]): Promise<Plan> {
    return readPlan(await this.runner(withFlags(args, [`--profile=${PLAN_APP}`, "--as=user", "--dry-run=true"]),
      { cwd: join(this.#directory, "work"), env: this.#env("plan-config", "plan-data"), timeout: 15_000 }));
  }
}

const PLAN_APP = "cli_agent_connectors_plan";
