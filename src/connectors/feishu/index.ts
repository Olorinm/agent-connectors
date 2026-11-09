import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Json } from "../../canonical.js";
import { ConnectorError, type ConnectionConfig, type Connector, type OperationCatalog, type ToolDefinition } from "../../connector.js";
import { FeishuAccount, feishuApplicationSchema, installFeishuApplication, loadFeishuCredentials, runOfficialCli, type CliResult, type CliRunner } from "./account.js";
import { ArgumentsError, UnconfiguredCli, checkArguments, guidanceArgs, withFlags, type Classification } from "./classify.js";

const MAX_FILES_BYTES = 20_000_000;
const MAX_ARTIFACT_BYTES = 10_000_000;
const fileName = /^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿._ -]{0,127}$/;

const input = z.object({
  args: z.array(z.string().max(100_000)).min(1).max(100),
  files: z.array(z.object({ name: z.string().regex(fileName), contentBase64: z.string().max(28_000_000) }).strict()).max(10).optional(),
}).strict();
type Input = z.infer<typeof input>;

const settings = z.object({ directory: z.string().min(1) }).strict();

/** Error types the CLI reports before any request takes effect. */
const NO_EFFECT = new Set(["validation", "authentication", "authorization", "confirmation_required"]);

/** Owner-adjustable operations: one read and one write per group of lark-cli domains. */
const GROUPS = [
  { id: "docs", label: "Docs, wiki and drive", labelZh: "文档、知识库和云空间",
    domains: ["docs", "wiki", "drive", "sheets", "slides", "base", "mindnotes", "markdown", "whiteboard", "note"],
    read: ["Read docs, wikis, sheets and files", "读取文档、知识库、表格和文件"], write: ["Create and edit docs, wikis, sheets and files", "创建和编辑文档、知识库、表格和文件"] },
  { id: "calendar", label: "Calendar and meetings", labelZh: "日历和会议", domains: ["calendar", "vc", "minutes"],
    read: ["View calendars, events and meeting records", "查看日程和会议记录"], write: ["Create and change events and meetings", "创建和修改日程与会议"] },
  { id: "im", label: "Messages and mail", labelZh: "消息和邮件", domains: ["im", "mail"],
    read: ["Read chats and mail", "读取聊天记录和邮件"], write: ["Send messages and mail", "发送消息和邮件"] },
  { id: "other", label: "Other", labelZh: "其他", domains: [] as string[],
    read: ["Read contacts, tasks, approvals and other data", "读取通讯录、任务、审批等其他数据"],
    write: ["Change tasks, approvals and other data", "修改任务、审批等其他数据"] },
];
const feishuCatalog: OperationCatalog = {
  groups: GROUPS.map(({ id, label, labelZh }) => ({ id, label, labelZh })),
  operations: GROUPS.flatMap((group) => (["read", "write"] as const).map((risk) => ({
    id: `feishu.${group.id}.${risk}`, group: group.id, label: group[risk][0]!, labelZh: group[risk][1]!, risk }))),
};
/** The operation of an argument list: its lark-cli domain decides the group, the tool decides read or write. */
export function feishuOperation(args: string[], risk: "read" | "write") {
  const group = GROUPS.find((candidate) => candidate.domains.includes(args[0] ?? "")) ?? GROUPS.at(-1)!;
  return `feishu.${group.id}.${risk}`;
}
const operationsOf = (risk: "read" | "write") => GROUPS.map((group) => `feishu.${group.id}.${risk}`);

export interface FeishuOptions {
  runner?: CliRunner;
  /** Resolves connection.settings.directory; defaults to the process working directory. */
  baseDirectory?: string;
  /** Private directory for the unconfigured CLI used to classify commands; defaults to a temporary one. */
  classifierDirectory?: string;
  /** Serialize and persist official CLI files in the encrypted runtime file store. */
  withSecretFiles?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * Feishu/Lark through the official lark-cli, as the linked owner's user identity.
 * Risk comes from the CLI's own per-command declaration: only commands it marks `read` run without approval.
 */
export function feishuConnector(options: FeishuOptions = {}): Connector {
  const withSecrets = options.withSecretFiles ?? (<T>(operation: () => Promise<T>) => operation());
  const accounts = new Map<string, FeishuAccount>();
  const directoryOf = (connection: ConnectionConfig) => resolve(options.baseDirectory ?? ".", settings.parse(connection.settings ?? {}).directory);
  const account = (connection: ConnectionConfig) => {
    let existing = accounts.get(connection.id);
    if (!existing) {
      const loaded = loadFeishuCredentials(join(directoryOf(connection), "credentials.json"));
      existing = new FeishuAccount(loaded.credentials, loaded.directory, options.runner ?? runOfficialCli);
      accounts.set(connection.id, existing);
    }
    return existing;
  };
  let unconfigured: UnconfiguredCli | undefined;
  const cli = () => (unconfigured ??= new UnconfiguredCli(options.classifierDirectory ?? mkdtempSync(join(tmpdir(), "agent-connectors-lark-")), options.runner ?? runOfficialCli));
  // A command's declared risk depends only on its arguments; the policy check and the run ask the CLI once.
  const classified = new Map<string, Promise<Classification>>();
  const classify = (args: string[]) => {
    const key = JSON.stringify(args);
    let result = classified.get(key);
    if (!result) {
      if (classified.size >= 200) classified.delete(classified.keys().next().value!);
      result = cli().classify(args);
      classified.set(key, result);
      result.catch(() => classified.delete(key));
    }
    return result;
  };

  const read: ToolDefinition<Input> = {
    name: "cli_read", risk: "read", input, operations: operationsOf("read"),
    // Guidance (skills, schema, --help) runs on an unconfigured CLI and reads nothing of the owner's. A command the CLI
    // does not declare read is the group's write: refused here pointing to cli_write, unless that write is denied.
    operation: async (_context, value) => {
      if (guidanceArgs(value.args)) return null;
      check(value.args);
      return feishuOperation(value.args, (await classify(value.args)).risk === "read" ? "read" : "write");
    },
    description: "Run an official lark-cli command for the owner's Feishu that only reads (declared Risk: read, and every request in its dry-run plan reads), or guidance: " +
      "`skills read <name>`, `schema <service.resource.method>`, `<domain> --help`. Pass argument strings without the executable or shell syntax. " +
      "Commands the CLI marks write or high-risk-write are refused here; use cli_write. Do not pass --as or --profile. " +
      "For help, include --help; the help text is returned and the command is not run.",
    async execute({ connection }, value) {
      const guidance = guidanceArgs(value.args);
      if (guidance) {
        const result = await cli().run(guidance);
        return { output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").slice(0, 500_000) };
      }
      check(value.args);
      // Two independent checks: the CLI's declared risk, and the requests its dry-run would send.
      const { risk, command } = await classify(value.args);
      if (risk !== "read") throw new ConnectorError("feishu_command_requires_write_tool", { command, risk: risk ?? "unknown" });
      const plan = await cli().plan(value.args);
      if (!plan.readOnly) throw new ConnectorError("feishu_command_requires_write_tool", { command, risk, requests: plan.requests });
      return withSecrets(() => run(account(connection), value, { write: false }));
    },
  };
  const write: ToolDefinition<Input> = {
    name: "cli_write", risk: "write", input, operations: operationsOf("write"),
    operation: (_context, value) => feishuOperation(value.args, "write"),
    description: "Run an official lark-cli command that changes the owner's Feishu (send mail or messages, create or edit documents, records, events, approvals). " +
      "The exact arguments are shown to the owner for approval before anything runs; high-risk confirmation is added after approval, so do not pass --yes. " +
      "Attach local files through `files` and refer to them by name in args.",
    summarize: (value) => summary(value),
    async execute({ connection }, value) {
      check(value.args);
      // The owner approved these exact arguments, so a high-risk command receives its confirmation here.
      const { risk } = await classify(value.args);
      const flags = risk === "high-risk-write" && !value.args.includes("--yes") ? ["--yes=true"] : [];
      return withSecrets(() => run(account(connection), value, { write: true, flags }));
    },
  };
  const report = async (feishu: FeishuAccount): Promise<Json> => {
    const status = await feishu.status(true), pending = feishu.pending();
    const { status: cliStatus, state, ...rest } = status;
    // A pending re-authorization keeps the reason it was needed.
    const current = state !== "connected" && pending ? "authorization_pending" : state;
    return { ...rest, status: current, cliStatus, ownerPrivate: true, ...(rest.userName ? { accountName: rest.userName } : {}),
      ...(current === "authorization_pending" ? { authorizationUrl: pending!.verificationUrl, expiresAt: pending!.expiresAt } : {}) };
  };
  return { kind: "feishu", usage: "owner_private", tools: [read, write], operations: () => feishuCatalog, account: {
    async status({ connection }): Promise<Json> {
      return withSecrets(async (): Promise<Json> => {
      let feishu: FeishuAccount;
      try { feishu = account(connection); }
      catch { return { status: "feishu_configuration_required", reason: "application_not_provided", ownerPrivate: true,
        required: ["directory/credentials.json", "appSecretFile", "ownerOpenId"] }; }
      await feishu.pollAuthorization();
      return report(feishu);
      });
    },
    async complete({ connection }): Promise<Json> {
      return withSecrets(async (): Promise<Json> => {
        let feishu: FeishuAccount;
        try { feishu = account(connection); }
        catch { throw new ConnectorError("feishu_configuration_required"); }
        try { await feishu.complete(); }
        catch (error) {
          // Not confirmed yet, no pending flow, or a lapsed device code: the status below says which.
          if (error instanceof Error && error.message === "feishu_authorized_wrong_owner") throw new ConnectorError(error.message);
        }
        return report(feishu);
      });
    },
    async configure({ connection }, value): Promise<Json> {
      const parsed = feishuApplicationSchema.safeParse(value);
      if (!parsed.success) throw new ConnectorError("feishu_application_invalid");
      return withSecrets(async (): Promise<Json> => {
        let directory: string;
        try { directory = directoryOf(connection); }
        catch { throw new ConnectorError("feishu_configuration_required"); }
        const { changed } = installFeishuApplication(directory, parsed.data);
        accounts.delete(connection.id);
        return { ...(await report(account(connection)) as Record<string, Json>), applicationChanged: changed };
      });
    },
    async connect({ connection }) {
      return withSecrets(async () => {
      let feishu: FeishuAccount;
      try { feishu = account(connection); }
      catch { throw new ConnectorError("feishu_configuration_required"); }
      const result = await feishu.begin();
      return { status: "authorization_required", authorizationUrl: result.verificationUrl, expiresAt: result.expiresAt };
      });
    },
    async disconnect({ connection }) { return withSecrets(() => account(connection).disconnect()); },
  } };
}

function check(args: string[]) {
  try {
    checkArguments(args);
  } catch (error) {
    if (error instanceof ArgumentsError) throw new ConnectorError(error.message);
    throw error;
  }
}

/**
 * Missing or lapsed personal authorization is reported, never hidden: the result names the state and the action that
 * restores it (the official consent link, or 飞书 → 重新授权 in the product).
 */
async function authorizationRequired(feishu: FeishuAccount, scopes: string[] = [], extra: Record<string, Json> = {}): Promise<never> {
  const status = await feishu.status().catch(() => undefined);
  const state = scopes.length && status?.authorized ? "scope_required" : status?.state === "expired" || existsSync(feishu.markerFile) ? "expired" : "authorization_required";
  throw new ConnectorError("feishu_personal_authorization_required", {
    state, ...(state === "expired" && status?.reason ? { reason: status.reason } : {}),
    message: state === "expired" ? "飞书个人权限已过期，需要重新授权。" : state === "scope_required" ? "飞书个人权限缺少此操作所需的权限，需要重新授权。"
      : "飞书个人权限尚未授权，需要授权后才能使用。",
    action: "reauthorize", authorizationUrl: await feishu.authorizationLink(scopes), ...extra,
    instruction: "Tell the owner 需要重新授权: send this exact authorization URL to the owner (or ask them to open 飞书 → 重新授权 in Mau's connectors), " +
      "then retry after they confirm. Never ask for tokens in chat.",
  });
}

async function run(feishu: FeishuAccount, value: Input, { write, flags = [] }: { write: boolean; flags?: string[] }): Promise<Json> {
  await feishu.pollAuthorization();
  if (!(await feishu.status()).authorized) await authorizationRequired(feishu);
  mkdirSync(feishu.workspace, { recursive: true, mode: 0o700 });
  const cwd = mkdtempSync(join(feishu.workspace, "call-"));
  try {
    writeFiles(cwd, value.files ?? []);
    let result: CliResult;
    try {
      result = await feishu.command(withFlags(value.args, ["--as=user", ...flags]), 60_000, cwd);
    } catch (error) {
      // Interrupted or unstartable: a write may already have been sent.
      if (!write) throw new ConnectorError("lark_cli_execution_failed");
      throw error;
    }
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").slice(0, 500_000);
    if (result.code !== 0) {
      const error = officialError(result);
      if ((error?.type === "authentication" || (error?.type === "authorization" && error.subtype === "missing_scope"))) {
        const scopes = z.array(z.string().regex(/^[a-zA-Z0-9_:.-]{1,128}$/)).max(100).safeParse(error.missing_scopes ?? []);
        await authorizationRequired(feishu, scopes.success ? scopes.data : [], { officialOutput: output.slice(0, 20_000),
          retry: "Do not replay automatically; inspect partial results before retrying any write." });
      }
      if (!write || result.code === 10 || NO_EFFECT.has(error?.type ?? "")) throw new ConnectorError("lark_cli_failed", { exitCode: result.code, output });
      throw new Error("lark_cli_write_outcome_unknown");
    }
    return { output, attachments: artifacts(cwd, result.stdout) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function officialError(result: CliResult): { type?: string; subtype?: string; missing_scopes?: unknown } | undefined {
  for (const text of [result.stderr.trim(), result.stdout.trim()]) {
    try {
      const error = JSON.parse(text)?.error;
      if (error && typeof error === "object") return error;
    } catch { /* Not the JSON envelope. */ }
  }
  return undefined;
}

function writeFiles(cwd: string, files: NonNullable<Input["files"]>) {
  let total = 0;
  const names = new Set<string>();
  for (const file of files) {
    const content = Buffer.from(file.contentBase64, "base64");
    total += content.length;
    if (total > MAX_FILES_BYTES) throw new ConnectorError("feishu_files_too_large");
    if (names.has(file.name)) throw new ConnectorError("feishu_file_name_duplicate");
    names.add(file.name);
    writeFileSync(join(cwd, file.name), content, { mode: 0o600, flag: "wx" });
  }
}

/** Files the CLI reports saving inside this call's directory are returned to the Agent. */
function artifacts(cwd: string, stdout: string): Json[] {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return []; }
  const paths = new Set<string>();
  const visit = (item: unknown, depth = 0) => {
    if (depth > 10 || !item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (["saved_path", "output_path", "file_path", "path"].includes(key) && typeof child === "string") paths.add(child);
      else visit(child, depth + 1);
    }
  };
  visit(value);
  const root = realpathSync(cwd), found: Json[] = [];
  let total = 0;
  for (const file of [...paths].slice(0, 10)) {
    let path: string;
    try { path = realpathSync(resolve(root, file)); } catch { continue; }
    const rel = relative(root, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).some((part) => part.startsWith("."))) continue;
    const stat = statSync(path);
    if (!stat.isFile() || total + stat.size > MAX_ARTIFACT_BYTES) continue;
    total += stat.size;
    found.push({ name: basename(path), mediaType: MEDIA[extname(path).toLowerCase()] ?? "application/octet-stream", size: stat.size, contentBase64: readFileSync(path).toString("base64") });
  }
  return found;
}

const MEDIA: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf",
  ".ofd": "application/ofd", ".xml": "application/xml", ".csv": "text/csv", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
};

/** Owner-facing text: every argument, long values shortened, and attached files with sizes. */
function summary(value: Input) {
  const quote = (arg: string) => {
    const shown = arg.length > 300 ? `${arg.slice(0, 300)}…(${arg.length} chars)` : arg;
    // Control and invisible formatting characters (bidi overrides, zero-width) are shown as escapes.
    const escaped = JSON.stringify(shown).replace(/[\p{Cc}\p{Cf}]/gu, (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`);
    return /^[\w@%+=:,./-]+$/u.test(shown) ? shown : escaped;
  };
  const files = (value.files ?? []).map((f) => `${f.name} (${Math.floor((f.contentBase64.length * 3) / 4)} bytes)`);
  return `Feishu: lark-cli ${value.args.map(quote).join(" ")}${files.length ? `\nFiles: ${files.join(", ")}` : ""}`;
}
