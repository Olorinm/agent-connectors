import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Json } from "../../canonical.js";
import { ConnectorError, type ConnectionConfig, type Connector, type ToolContext, type ToolDefinition } from "../../connector.js";
import { parseCommand, shellLine, type Command } from "./command.js";
import { CloudflareBrowserRun, agentBrowserBinary, allowedUrl, cdpEndpoint, runAgentBrowser, type AgentBrowserRunner, type BrowserRun, type BrowserRunAccount, type CliResult } from "./runtime.js";

export { CloudflareBrowserRun, agentBrowserBinary, runAgentBrowser, type AgentBrowserRunner, type BrowserRun, type CliResult } from "./runtime.js";
export { parseCommand } from "./command.js";

const MAX_FILES_BYTES = 10_000_000;
const MAX_UPLOAD_BASE64 = 14_000_000;
const MAX_HANDOFF_MS = 1_800_000;
const MAX_STORAGE_CHARS = 5_000_000;
const MAX_OUTPUT_CHARS = 200_000;
const COMMAND_TIMEOUT_MS = 90_000;
const settings = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/), tokenFile: z.string().min(1) }).strict();
const cookie = z.looseObject({ name: z.string(), value: z.string(), domain: z.string() });
/** Sealed per connection: the remote session and the browser storage (cookies, local storage) as agent-browser saves it. */
const state = z.object({ version: z.literal(1), sessionId: z.string().optional(), cookies: z.array(cookie).max(3000).default([]),
  origins: z.array(z.unknown()).max(500).default([]),
  handoff: z.object({ handoffId: z.string(), targetId: z.string().optional(), expiresAt: z.string() }).optional() }).strict();
type State = z.infer<typeof state>;
const args = z.array(z.string().max(100_000)).min(1).max(100);
const site = z.string().url().refine((value) => { const u = new URL(value); return u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash && !u.username; },
  "site must be an https origin such as https://example.com");
const file = z.object({ name: z.string().min(1).max(120).regex(/^[^/\\\u0000-\u001f]+$/),
  // Accept parameters such as "; charset=utf-8" but hand the browser only the bare type.
  mediaType: z.string().max(200).regex(/^[a-zA-Z]+\/[a-zA-Z0-9.+-]+(?:\s*;.*)?$/).transform((v) => v.split(";")[0]!.trim().toLowerCase()),
  contentBase64: z.string().min(1).max(MAX_UPLOAD_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
const writeInput = z.object({ args, site, files: z.array(file).min(1).max(10) }).strict();
type WriteInput = z.infer<typeof writeInput>;

export interface BrowserOptions {
  baseDirectory?: string;
  /** Private directory for agent-browser homes (daemon sockets, per-call files); defaults to a new temporary one. */
  directory?: string;
  /** Dependency injection for tests; production uses Cloudflare Browser Run and the pinned agent-browser binary. */
  browserRun?: BrowserRun;
  runner?: AgentBrowserRunner;
  keepAliveMs?: number;
}

interface Attached { sessionId: string; home: string; token: string; usedAt: number; verify: boolean }
interface Run { account: BrowserRunAccount; session: Attached; saved: State; context: ToolContext }

/**
 * A remote browser on Cloudflare Browser Run, outside the Agent's sandbox, driven by the official agent-browser CLI
 * running in this service. The Cloudflare token and site cookies stay here: the token reaches the CLI only through its
 * CDP header environment, and cookies are sealed as the connection's credential. Following the agreed product rule,
 * navigation, clicks and typing run directly; sending a workspace file to a site is a write needing approval.
 */
export function browserConnector(options: BrowserOptions = {}): Connector {
  const keepAliveMs = options.keepAliveMs ?? 600_000;
  const api = options.browserRun ?? new CloudflareBrowserRun(keepAliveMs);
  let root: string | undefined;
  const directory = () => root ??= options.directory ?? mkdtempSync(join(tmpdir(), "acb-"));
  const runner = options.runner ?? runAgentBrowser(() => agentBrowserBinary(directory()));
  const queues = new Map<string, Promise<unknown>>();
  const sessions = new Map<string, Attached>();
  const homes = new Map<string, string>();
  /** A short path: daemon sockets live inside and Unix socket paths are limited to about 100 bytes. */
  const homeOf = (id: string) => {
    let home = homes.get(id);
    if (!home) { home = join(directory(), String(homes.size + 1)); homes.set(id, home); }
    for (const path of [home, join(home, "work"), join(home, "calls")]) mkdirSync(path, { recursive: true, mode: 0o700 });
    // An explicit, empty configuration: no user or project config file is discovered.
    if (!existsSync(join(home, "config.json"))) writeFileSync(join(home, "config.json"), "{}\n", { mode: 0o600 });
    return home;
  };
  const account = (connection: ConnectionConfig): BrowserRunAccount => {
    const parsed = settings.safeParse(connection.settings ?? {});
    if (!parsed.success) throw new ConnectorError("browser_settings_invalid");
    const path = resolve(options.baseDirectory ?? ".", parsed.data.tokenFile);
    try {
      if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) throw new ConnectorError("browser_token_file_must_be_private");
      const token = readFileSync(path, "utf8").trim();
      if (!/^[\x21-\x7e]{20,4000}$/.test(token)) throw new ConnectorError("browser_token_file_invalid");
      return { accountId: parsed.data.accountId, token };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("browser_token_file_missing");
    }
  };
  const environment = (home: string, browser?: { account: BrowserRunAccount; sessionId: string }): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8",
    AGENT_BROWSER_CONFIG: join(home, "config.json"), AGENT_BROWSER_SESSION: "b", AGENT_BROWSER_NO_VERSION_CHECK: "1",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(keepAliveMs),
    ...Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"].flatMap((name) => process.env[name] ? [[name, process.env[name]]] : [])),
    ...(browser ? { AGENT_BROWSER_CDP: cdpEndpoint(browser.account, browser.sessionId),
      AGENT_BROWSER_CDP_HEADERS: JSON.stringify({ Authorization: `Bearer ${browser.account.token}` }) } : {}),
  });
  const cli = (run: Run, argv: string[], input?: string): Promise<CliResult> =>
    runner(argv, { cwd: join(run.session.home, "work"), env: environment(run.session.home, { account: run.account, sessionId: run.session.sessionId }),
      timeout: COMMAND_TIMEOUT_MS, signal: run.context.signal, ...(input === undefined ? {} : { input }) });
  /** Stops the local agent-browser daemon. The remote browser keeps running until its keep-alive ends. */
  const stop = async (session: Attached, signal: AbortSignal) => {
    await runner(["close"], { cwd: join(session.home, "work"), env: environment(session.home), timeout: 30_000, signal }).catch(() => undefined);
  };
  const load = async (context: ToolContext): Promise<State> => {
    const parsed = state.safeParse((await context.credentials.get()) ?? { version: 1 });
    return parsed.success ? parsed.data : { version: 1, cookies: [], origins: [] };
  };
  const save = (context: ToolContext, value: State) => context.credentials.put(value as unknown as Json);

  /** Reuses the connection's daemon, or reconnects to the saved remote browser, or starts one with the saved storage. */
  const attach = async (context: ToolContext, saved: State, current: BrowserRunAccount): Promise<Attached> => {
    const id = context.connection.id, token = createHash("sha256").update(current.token).digest("hex");
    const live = sessions.get(id);
    if (live && live.sessionId === saved.sessionId && live.token === token && !live.verify && Date.now() - live.usedAt < keepAliveMs - 60_000) return live;
    if (live) { sessions.delete(id); await stop(live, context.signal); }
    const home = homeOf(id);
    // A daemon from an earlier attachment would keep its old connection settings.
    await stop({ sessionId: "", home, token, usedAt: 0, verify: false }, context.signal);
    const reuse = saved.sessionId !== undefined && await api.alive(current, saved.sessionId, context.signal);
    const session: Attached = { sessionId: reuse ? saved.sessionId! : await api.create(current, context.signal), home, token, usedAt: Date.now(), verify: false };
    const run: Run = { account: current, session, saved, context };
    if (!reuse && (saved.cookies.length || saved.origins.length)) {
      const restore = join(home, `restore-${randomUUID()}.json`);
      writeFileSync(restore, JSON.stringify({ cookies: saved.cookies, origins: saved.origins }), { mode: 0o600, flag: "wx" });
      try {
        const loaded = await cli(run, ["state", "load", restore]);
        if (loaded.code !== 0) { await stop(session, context.signal); throw new ConnectorError("browser_session_restore_failed"); }
      } finally { rmSync(restore, { force: true }); }
    }
    // The daemon serves a local screencast by default; this service never uses it.
    const started = await cli(run, ["stream", "disable"]);
    if (started.code !== 0) { await stop(session, context.signal); throw new ConnectorError("browser_run_unavailable", { output: text(started).slice(0, 2000) }); }
    sessions.set(id, session);
    if (session.sessionId !== saved.sessionId) await save(context, { ...(await load(context)), sessionId: session.sessionId });
    return session;
  };

  /** One queue per connection: ordered commands against one daemon, consistent storage persistence. */
  const locked = <T>(context: ToolContext, work: (run: Run) => Promise<T>, inspect = false): Promise<T> => {
    const id = context.connection.id;
    const result = (queues.get(id) ?? Promise.resolve()).then(async () => {
      context.signal.throwIfAborted();
      const current = account(context.connection);
      const saved = await load(context);
      const session = await attach(context, saved, current);
      const run: Run = { account: current, session, saved, context };
      try {
        return await work(run);
      } finally {
        session.usedAt = Date.now();
        // Persist what the browser now holds (for example a sign-in the owner just completed), merged with what the tool saved.
        if (!inspect && sessions.get(id) === session) await persist(run).catch(() => { session.verify = true; });
      }
    });
    queues.set(id, result.catch(() => undefined));
    return result;
  };
  const persist = async (run: Run) => {
    const file = join(run.session.home, `state-${randomUUID()}.json`);
    try {
      const saved = await cli(run, ["state", "save", file]);
      if (saved.code !== 0 || !existsSync(file)) { run.session.verify = true; return; }
      const raw = readFileSync(file, "utf8");
      const parsed = z.object({ cookies: z.array(cookie).max(3000).default([]), origins: z.array(z.unknown()).max(500).default([]) }).safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      // Local storage is kept only while it is small; cookies always are.
      const origins = raw.length <= MAX_STORAGE_CHARS ? parsed.data.origins : [];
      await save(run.context, { ...(await load(run.context)), sessionId: run.session.sessionId, cookies: parsed.data.cookies, origins });
    } finally { rmSync(file, { force: true }); }
  };

  /** Runs a checked command with its output files placed in a private per-call directory. */
  const execute = async (run: Run, command: Command, input?: { files: WriteInput["files"]; site: string }): Promise<Json> => {
    const call = join(run.session.home, "calls", randomUUID().slice(0, 8));
    mkdirSync(call, { mode: 0o700 });
    try {
      const argv = [...command.args];
      for (const output of command.outputs) argv[output.index] = join(call, output.name);
      if (command.kind === "close") {
        await persist(run);
        sessions.delete(run.context.connection.id);
        await stop(run.session, run.context.signal);
        return { exitCode: 0, output: "Disconnected from the browser and saved its sign-ins. The next command reconnects." };
      }
      if (command.kind === "download") return await download(run, command, call);
      if (command.kind === "upload") return await upload(run, command, call, input!);
      const result = await cli(run, argv);
      const output = text(result, call);
      if (result.code !== 0) { run.session.verify = true; throw new ConnectorError("agent_browser_failed", { exitCode: result.code, output }); }
      const files = collect(call, command.outputs.map((o) => o.name));
      return { exitCode: 0, output, ...(files.length ? { files } : {}) };
    } finally { rmSync(call, { recursive: true, force: true }); }
  };
  const currentUrl = async (run: Run) => {
    const result = await cli(run, ["get", "url"]);
    if (result.code !== 0) throw new ConnectorError("agent_browser_failed", { exitCode: result.code, output: text(result) });
    return result.stdout.trim();
  };
  /**
   * Browser Run keeps a browser's downloads on its own machine, so agent-browser's `download` cannot deliver them.
   * Instead the link's URL is fetched inside the page with its cookies (same origin, or sites that allow it).
   */
  const download = async (run: Run, command: Command, call: string): Promise<Json> => {
    const href = await cli(run, ["get", "attr", command.selector!, "href"]);
    if (href.code !== 0 || !href.stdout.trim() || href.stdout.trim() === "null") throw new ConnectorError("browser_download_needs_link", { output: text(href) });
    const url = allowedUrl(new URL(href.stdout.trim(), await currentUrl(run)).href);
    const result = await cli(run, ["--json", "eval", "--stdin"], fetchScript(url, MAX_FILES_BYTES));
    const value = z.object({ data: z.object({ result: z.object({ url: z.string().optional(), type: z.string().optional(),
      base64: z.string().optional(), error: z.string().optional() }) }) }).safeParse(jsonOutput(result.stdout)).data?.data.result;
    if (result.code !== 0 || !value || value.error || value.base64 === undefined)
      throw new ConnectorError("browser_download_failed", { reason: value?.error ?? "fetch_failed" });
    allowedUrl(value.url ?? url);
    const name = command.outputs[0]!.name, bytes = Buffer.from(value.base64, "base64");
    if (bytes.length > MAX_FILES_BYTES) throw new ConnectorError("browser_download_too_large");
    writeFileSync(join(call, name), bytes, { mode: 0o600 });
    return { exitCode: 0, output: `✓ Downloaded ${name} (${bytes.length} bytes)`,
      files: collect(call, [name], (value.type ?? "").split(";")[0]!.trim() || undefined) };
  };
  /**
   * A remote browser cannot read files on this host, so agent-browser's own `upload` only selects the file input and
   * names the files; the approved bytes are then placed into that input inside the page.
   */
  const upload = async (run: Run, command: Command, call: string, input: { files: WriteInput["files"]; site: string }): Promise<Json> => {
    const current = new URL(await currentUrl(run));
    if (current.origin !== new URL(input.site).origin) throw new ConnectorError("browser_upload_site_mismatch", { current: current.origin });
    const paths = input.files.map((f) => { const path = join(call, f.name); writeFileSync(path, Buffer.from(f.contentBase64, "base64"), { mode: 0o600 }); return path; });
    const selected = await cli(run, ["upload", command.selector!, ...paths]);
    if (selected.code !== 0) throw new ConnectorError("agent_browser_failed", { exitCode: selected.code, output: text(selected, call) });
    // The file input now names the files; from here on the site may react, so failures are uncertain.
    const placed = await cli(run, ["--json", "eval", "--stdin"], uploadScript(input.files));
    const value = z.object({ data: z.object({ result: z.object({ ok: z.boolean() }) }) }).safeParse(jsonOutput(placed.stdout)).data?.data.result;
    if (placed.code !== 0 || !value?.ok) throw new Error("browser_upload_outcome_unknown");
    return { exitCode: 0, output: `✓ Uploaded ${input.files.map((f) => f.name).join(", ")} to ${current.origin}`, url: current.href };
  };

  const read: ToolDefinition<{ args: string[] }> = {
    name: "agent_browser_read", risk: "read", input: z.object({ args }).strict(),
    description: "Run an official agent-browser command (vercel-labs/agent-browser) in the owner's remote browser. Pass argument strings without " +
      "the executable or shell syntax, e.g. [\"open\",\"https://example.com\"], [\"snapshot\",\"-i\"], [\"click\",\"@e2\"], [\"fill\",\"@e3\",\"text\"]. " +
      "Navigation, reading, clicks and typing run directly. screenshot, pdf and download return files. Commands that read or change cookies, " +
      "storage or saved state, run JavaScript, intercept traffic, or select another browser, profile, proxy or file are refused, as is every " +
      "global flag except --json. upload is refused here with agent_browser_command_requires_write_tool; use agent_browser_write. " +
      "Learn the commands with [\"skills\",\"get\",\"core\"] or [\"<command>\",\"--help\"].",
    async execute(context, value) {
      const command = parseCommand(value.args);
      if (command.kind === "upload") throw new ConnectorError("agent_browser_command_requires_write_tool", { command: "upload" });
      if (command.kind === "guide") {
        account(context.connection);
        const home = homeOf(`guide:${context.connection.id}`);
        const result = await runner(command.args, { cwd: join(home, "work"), env: environment(home), timeout: 30_000, signal: context.signal });
        return { exitCode: result.code, output: text(result) };
      }
      return locked(context, (run) => execute(run, command), command.inspect);
    },
  };
  const write: ToolDefinition<WriteInput> = {
    name: "agent_browser_write", risk: "write", input: writeInput, targets: ["site"],
    description: "Send workspace files to a site with agent-browser's upload command, e.g. args [\"upload\",\"@e3\",\"cv.pdf\"]. The owner approves " +
      "the exact files and site first. site must equal the current page's origin; each file named in args is supplied in files.",
    summarize: (value) => `上传 ${value.files.map((f) => `${f.name}（${Math.ceil(f.contentBase64.length * 0.75 / 1024)} KB）`).join("、")}到 ${new URL(value.site).host}\n${shellLine(value.args)}`,
    async execute(context, value) {
      const command = parseCommand(value.args);
      if (command.kind !== "upload") throw new ConnectorError("agent_browser_write_supports_upload_only");
      const names = value.files.map((f) => f.name);
      if (names.length !== command.files!.length || command.files!.some((name, index) => name !== names[index]))
        throw new ConnectorError("agent_browser_upload_files_mismatch", { expected: command.files! });
      return locked(context, (run) => execute(run, command, value));
    },
  };

  const tools: ToolDefinition[] = [read, write,
    { name: "handoff_start", risk: "read",
      description: "Ask the owner to take over the browser (login, CAPTCHA, a choice only they can make). Returns a Live View URL of the current tab " +
        "for the owner only; never repeat it to anyone else. The owner tells you when they are done; then take a new snapshot: the page may have changed.",
      input: z.object({ instructions: z.string().min(1).max(500), timeoutSeconds: z.number().int().min(60).max(MAX_HANDOFF_MS / 1000).default(900) }).strict(),
      execute: (context, value: { instructions: string; timeoutSeconds: number }) => locked(context, async (run) => {
        const targetId = await activeTarget(run);
        const liveViewUrl = await api.liveView(run.account, run.session.sessionId, targetId, Math.min(value.timeoutSeconds * 1000 + 60_000, 3_600_000), context.signal);
        const handoff = { handoffId: randomUUID(), targetId, expiresAt: new Date(Date.now() + value.timeoutSeconds * 1000).toISOString() };
        await save(context, { ...(await load(context)), handoff });
        return { handoffId: handoff.handoffId, liveViewUrl, expiresAt: handoff.expiresAt, instructions: value.instructions };
      }) },
    { name: "handoff_status", risk: "read", description: "Check whether a handoff is still open (its tab exists and it has not expired), with the current page.",
      input: z.object({ handoffId: z.string().max(100) }).strict(),
      execute: (context, value: { handoffId: string }) => locked(context, async (run) => {
        const handoff = (await load(context)).handoff;
        if (handoff?.handoffId !== value.handoffId) throw new ConnectorError("browser_handoff_not_found");
        const expired = Date.parse(handoff.expiresAt) <= Date.now();
        const open = !expired && handoff.targetId !== undefined && await api.target(run.account, run.session.sessionId, handoff.targetId, context.signal);
        return { handoffId: value.handoffId, active: open, done: !open, ...(expired ? { reason: "expired" } : {}), url: await currentUrl(run) };
      }) },
    { name: "handoff_cancel", risk: "read",
      description: "End the current handoff: the owner's live view stops controlling the browser (its tab is replaced by a blank one).",
      input: z.object({ handoffId: z.string().max(100) }).strict(),
      execute: (context, value: { handoffId: string }) => locked(context, async (run) => {
        const { handoff, ...rest } = await load(context);
        if (handoff?.handoffId !== value.handoffId) throw new ConnectorError("browser_handoff_not_found");
        // Browser Run documents no revoke command; a Live View is bound to its tab, so close that tab.
        if (handoff.targetId) {
          const opened = await cli(run, ["tab", "new"]);
          if (opened.code !== 0) throw new ConnectorError("agent_browser_failed", { output: text(opened) });
          await cli(run, ["tab", "close", handoff.targetId]);
          if (await api.target(run.account, run.session.sessionId, handoff.targetId, context.signal)) throw new Error("browser_handoff_tab_still_open");
        }
        await save(context, rest);
        return { handoffId: value.handoffId, cancelled: true, url: await currentUrl(run) };
      }) },
  ];
  const activeTarget = async (run: Run) => {
    const result = await cli(run, ["--json", "tab", "list"]);
    const tabs = z.object({ data: z.object({ tabs: z.array(z.object({ active: z.boolean(), targetId: z.string().regex(/^[A-Za-z0-9-]{1,100}$/) }).loose()) }) })
      .safeParse(jsonOutput(result.stdout)).data?.data.tabs;
    const active = tabs?.find((tab) => tab.active);
    if (result.code !== 0 || !active) throw new ConnectorError("browser_tab_unavailable");
    return active.targetId;
  };

  return { kind: "browser", tools, account: {
    async status({ connection, credentials }) {
      try { account(connection); } catch (error) { return { status: error instanceof ConnectorError ? error.code : "browser_settings_invalid" } as Json; }
      const saved = state.safeParse((await credentials.get()) ?? { version: 1 });
      const sites = saved.success ? [...new Set(saved.data.cookies.map((c) => c.domain.replace(/^\./, "")))].slice(0, 100) : [];
      return { status: "connected", sites } as Json;
    },
    async connect({ connection }) { account(connection); return { status: "connected" }; },
    async disconnect({ connection, credentials, signal }) {
      const session = sessions.get(connection.id); sessions.delete(connection.id);
      if (session) await stop(session, signal);
      await credentials.put({ version: 1, cookies: [], origins: [] });
      return { status: "disconnected" };
    },
  } };
}

/** stdout and stderr for the caller, with this host's per-call directory removed from file paths. */
function text(result: CliResult, call?: string) {
  let value = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (call) value = value.replaceAll(`${call}/`, "").replaceAll(call, ".");
  return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated: ${value.length - MAX_OUTPUT_CHARS} more characters; use snapshot -i, -s <selector> or get text <selector>]` : value;
}

function jsonOutput(stdout: string): unknown {
  try { return JSON.parse(stdout.trim()); } catch { return undefined; }
}

function collect(call: string, names: string[], mediaType?: string): Json[] {
  const files: Json[] = [];
  let total = 0;
  for (const name of names) {
    const path = join(call, name);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    total += bytes.length;
    if (total > MAX_FILES_BYTES) throw new ConnectorError("browser_files_too_large");
    files.push({ name, mediaType: sniff(bytes) ?? mediaType ?? "application/octet-stream", size: bytes.length, contentBase64: bytes.toString("base64") });
  }
  return files;
}

function sniff(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return undefined;
}

/** Fixed page script (never Agent-supplied): fetch one URL with the page's cookies and return its bytes. */
function fetchScript(url: string, max: number) {
  return `(async () => {
  try {
    const response = await fetch(${JSON.stringify(url)}, { credentials: "include" });
    if (!response.ok) return { error: "status_" + response.status };
    if (Number(response.headers.get("content-length") || 0) > ${max}) return { error: "too_large" };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > ${max}) return { error: "too_large" };
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return { url: response.url, type: response.headers.get("content-type") || "", base64: btoa(binary) };
  } catch { return { error: "fetch_failed" }; }
})()`;
}

/** Fixed page script: replace the files agent-browser named in exactly one file input with the approved bytes. */
function uploadScript(files: WriteInput["files"]) {
  return `(() => {
  const files = ${JSON.stringify(files.map((f) => ({ name: f.name, type: f.mediaType, data: f.contentBase64 })))};
  const names = files.map((f) => f.name).join("\\n");
  const inputs = Array.from(document.querySelectorAll("input[type=file]")).filter((input) => Array.from(input.files || []).map((f) => f.name).join("\\n") === names);
  if (inputs.length !== 1) return { ok: false, count: inputs.length };
  const transfer = new DataTransfer();
  for (const f of files) transfer.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
  inputs[0].files = transfer.files;
  inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
  inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
})()`;
}
