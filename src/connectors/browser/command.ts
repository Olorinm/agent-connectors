import { ConnectorError } from "../../connector.js";
import { allowedUrl, safeName } from "./runtime.js";

/**
 * The agent-browser commands an Agent may run, in agent-browser's own syntax. Everything not listed here is refused
 * before a browser is attached; in particular everything that reads or replaces credentials or session data
 * (`cookies`, `storage`, `state`, `auth`), runs page JavaScript (`eval`, `wait --fn`, init scripts), intercepts or
 * rewrites traffic (`network`, `set headers|credentials`), points the CLI at another browser, profile, proxy, file or
 * configuration (`connect`, every global flag except `--json`), or manages the installation (`install`, `upgrade`).
 */
export type CommandKind = "guide" | "browser" | "close" | "download" | "upload";
export interface Command {
  kind: CommandKind;
  /** Canonical command path, e.g. "get text", for messages and approvals. */
  name: string;
  /** Arguments to run. Entries listed in `outputs` are replaced by a path in the call's private directory. */
  args: string[];
  outputs: Array<{ index: number; name: string }>;
  /** Only inspects the page, so the browser's storage is not saved again afterwards. */
  inspect?: boolean;
  /** download: the element selector. upload: the selector and the file names. */
  selector?: string;
  files?: string[];
}

interface Spec {
  /** Flags this command accepts; true when the flag takes a value. */
  flags?: Record<string, boolean>;
  /** Allowed first positional (subcommand) values, when the command has subcommands. */
  sub?: readonly string[];
  min?: number;
  max?: number;
}

const SELECTOR: Spec = { min: 1, max: 1 };
const NO_ARGS: Spec = { max: 0 };
const NAVIGATION = new Set(["open", "goto", "navigate"]);
const SPECS: Record<string, Spec> = {
  open: { max: 1 }, goto: { min: 1, max: 1 }, navigate: { min: 1, max: 1 },
  back: NO_ARGS, forward: NO_ARGS, reload: NO_ARGS,
  snapshot: { max: 0, flags: { "-i": false, "--interactive": false, "-u": false, "--urls": false, "-c": false, "--compact": false,
    "-d": true, "--depth": true, "-s": true, "--selector": true, "--delta": false, "--full": false } },
  read: { max: 0, flags: { "--filter": true, "--outline": false } },
  click: { min: 1, max: 1, flags: { "--new-tab": false } }, dblclick: SELECTOR, focus: SELECTOR, hover: SELECTOR,
  check: SELECTOR, uncheck: SELECTOR, scrollintoview: SELECTOR, scrollinto: SELECTOR,
  fill: { min: 2, max: 2 }, type: { min: 2, max: 2 }, press: { min: 1, max: 1 }, key: { min: 1, max: 1 },
  keydown: { min: 1, max: 1 }, keyup: { min: 1, max: 1 },
  keyboard: { sub: ["type", "inserttext"], min: 2, max: 2 },
  select: { min: 2, max: 20 }, drag: { min: 2, max: 2 }, scroll: { max: 2 },
  mouse: { sub: ["move", "down", "up", "wheel"], min: 1, max: 3, flags: { "--duration": true, "--steps": true, "--human": false, "--seed": true } },
  wait: { max: 1, flags: { "--url": true, "-u": true, "--load": true, "-l": true, "--text": true, "-t": true, "--state": true, "--timeout": true } },
  get: { sub: ["text", "html", "value", "attr", "title", "url", "count", "box", "styles"], min: 1, max: 3 },
  is: { sub: ["visible", "enabled", "checked"], min: 2, max: 2 },
  find: { sub: ["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last", "nth"], min: 2, max: 5,
    flags: { "--name": true, "--exact": false } },
  frame: SELECTOR,
  dialog: { sub: ["accept", "dismiss", "status"], min: 1, max: 2 },
  tab: { max: 2, flags: { "--label": true } },
  set: { sub: ["viewport", "device", "media", "geo", "geolocation", "offline"], min: 2, max: 4 },
  diff: { sub: ["snapshot"], min: 1, max: 1 },
  screenshot: { max: 2, flags: { "--full": false, "-f": false, "--annotate": false, "--if-changed": false, "--threshold": true,
    "--screenshot-format": true, "--screenshot-quality": true } },
  pdf: { min: 1, max: 1 },
  download: { min: 2, max: 2 },
  upload: { min: 2, max: 11 },
  close: NO_ARGS, quit: NO_ARGS, exit: NO_ARGS,
  skills: { sub: ["list", "get"], max: 2, flags: { "--full": false, "--ref": true } },
};
/** Global flags allowed anywhere. All others (--cdp, --profile, --state, --session, --proxy, --config, …) are refused. */
const GLOBAL: Record<string, boolean> = { "--json": false };
const DENIED_REASON: Record<string, string> = {
  cookies: "credentials", storage: "credentials", state: "credentials", auth: "credentials", eval: "page_javascript",
  addinitscript: "page_javascript", removeinitscript: "page_javascript", network: "traffic_interception", connect: "browser_selection",
  install: "installation", upgrade: "installation", doctor: "installation", profiles: "browser_selection", session: "browser_selection",
  plugin: "installation", mcp: "installation", chat: "installation", dashboard: "live_control", stream: "live_control",
  inspect: "live_control", batch: "unchecked_commands",
};

/** Flags whose values are checked; the others take free text such as selectors or patterns. */
const FLAG_VALUES: Record<string, RegExp> = {
  "--state": /^(visible|hidden|attached|detached)$/, "--load": /^(load|domcontentloaded|networkidle)$/, "-l": /^(load|domcontentloaded|networkidle)$/,
  "--screenshot-format": /^(png|jpeg)$/, "--screenshot-quality": /^\d{1,3}$/, "--threshold": /^(0(\.\d+)?|1(\.0+)?)$/,
  "-d": /^\d{1,3}$/, "--depth": /^\d{1,3}$/, "--timeout": /^\d{1,6}$/, "--duration": /^\d{1,5}$/, "--steps": /^\d{1,4}$/, "--seed": /^\d{1,10}$/,
};
const INSPECT = new Set(["snapshot", "read", "get", "is", "screenshot", "pdf", "diff"]);
const IMAGE = /\.(png|jpe?g|webp)$/i;
const isFlag = (arg: string) => arg.startsWith("-") && !/^-\d/.test(arg);

/** Parses and checks an Agent's argument list. Throws ConnectorError before anything runs. */
export function parseCommand(input: string[]): Command {
  const args = [...input];
  if (args.some((arg) => arg.includes("\u0000"))) throw new ConnectorError("agent_browser_arguments_invalid");
  if (args.length === 1 && ["--version", "-V"].includes(args[0]!)) return { kind: "guide", name: "version", args: ["--version"], outputs: [] };
  if (args.includes("--help") || args.includes("-h")) {
    // Help for exactly the command path the Agent asked about, with nothing else to parse.
    const path = args.filter((arg) => !isFlag(arg)).slice(0, 2);
    if (path.length && !SPECS[path[0]!]) throw new ConnectorError("agent_browser_command_not_allowed", { command: path[0]!, reason: DENIED_REASON[path[0]!] ?? "not_supported" });
    return { kind: "guide", name: "help", args: [...path.slice(0, 1), "--help"], outputs: [] };
  }
  const positionals: number[] = [];
  let command: string | undefined, spec: Spec | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!isFlag(arg)) {
      if (command === undefined) {
        command = arg; spec = SPECS[arg];
        if (!spec) throw new ConnectorError("agent_browser_command_not_allowed", { command: arg, reason: DENIED_REASON[arg] ?? "not_supported" });
      } else positionals.push(index);
      continue;
    }
    const name = arg.split("=")[0]!;
    const takesValue = GLOBAL[name] ?? spec?.flags?.[name];
    if (takesValue === undefined) throw new ConnectorError("agent_browser_flag_not_allowed", { flag: name });
    if (!takesValue && arg.includes("=")) throw new ConnectorError("agent_browser_arguments_invalid", { flag: name });
    if (takesValue) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
      if (value === undefined || value.startsWith("--") || (FLAG_VALUES[name] && !FLAG_VALUES[name]!.test(value)))
        throw new ConnectorError("agent_browser_arguments_invalid", { flag: name });
    }
  }
  if (!command || !spec) throw new ConnectorError("agent_browser_command_required");
  const values = positionals.map((index) => args[index]!);
  if (spec.sub && (values.length === 0 || !spec.sub.includes(values[0]!)))
    throw new ConnectorError("agent_browser_command_not_allowed", { command: `${command} ${values[0] ?? ""}`.trim(), allowed: [...spec.sub] });
  if (values.length < (spec.min ?? 0) || values.length > (spec.max ?? 100)) throw new ConnectorError("agent_browser_arguments_invalid", { command });
  const name = spec.sub ? `${command} ${values[0]}` : command;
  const result: Command = { kind: "browser", name, args, outputs: [], ...(INSPECT.has(command) ? { inspect: true } : {}) };

  if (NAVIGATION.has(command) && values.length) args[positionals[0]!] = navigable(values[0]!);
  if (command === "tab") {
    // tab [list|new [url]|close [ref]|<ref>]
    if (values[0] === "new" && values.length === 2) args[positionals[1]!] = navigable(values[1]!);
    else if (values.length === 2 && values[0] !== "close") throw new ConnectorError("agent_browser_arguments_invalid", { command });
  }
  if (command === "wait" && args.some((arg) => /^--state=?/.test(arg)) && !values.length)
    throw new ConnectorError("agent_browser_arguments_invalid", { command });
  if (command === "skills") {
    if (values[0] === "get" && values.length !== 2) throw new ConnectorError("agent_browser_arguments_invalid", { command });
    return { ...result, kind: "guide" };
  }
  if (["close", "quit", "exit"].includes(command)) return { ...result, kind: "close", name: "close" };
  if (command === "screenshot") {
    // screenshot [selector] [path]: a lone positional is the path when it looks like one.
    const last = values.at(-1);
    if (values.length === 2 || (last !== undefined && (IMAGE.test(last) || last.includes("/")))) {
      result.outputs.push({ index: positionals.at(-1)!, name: outputName(last!, ".png") });
    } else {
      args.push("screenshot.png");
      result.outputs.push({ index: args.length - 1, name: "screenshot.png" });
    }
  }
  if (command === "pdf") result.outputs.push({ index: positionals[0]!, name: outputName(values[0]!, ".pdf") });
  if (command === "download") return { ...result, kind: "download", selector: values[0]!, outputs: [{ index: positionals[1]!, name: outputName(values[1]!, "") }] };
  if (command === "upload") {
    const files = values.slice(1).map((value) => outputName(value, ""));
    if (new Set(files).size !== files.length) throw new ConnectorError("agent_browser_upload_duplicate_file");
    return { ...result, kind: "upload", selector: values[0]!, files };
  }
  return result;
}

/** agent-browser prepends https:// to a bare host; the same URL is checked and then passed on explicitly. */
function navigable(value: string) {
  return allowedUrl(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[^/:]+:\d+(\/|$)/.test(value) ? value : `https://${value}`);
}

/** Only the requested file's name is kept; the file is written to the call's private directory. */
function outputName(requested: string, extension: string) {
  const base = safeName(requested.split(/[\\/]/).pop() ?? "");
  return extension && !base.toLowerCase().endsWith(extension) && !(extension === ".png" && IMAGE.test(base)) ? `${base}${extension}` : base;
}

/** Arguments for display, quoted like a shell line. */
export function shellLine(args: string[]) {
  return ["agent-browser", ...args].map((arg) => {
    const shown = arg.length > 300 ? `${arg.slice(0, 300)}…(${arg.length} chars)` : arg;
    if (/^[\w@%+=:,./#-]+$/u.test(shown)) return shown;
    return JSON.stringify(shown).replace(/[\p{Cc}\p{Cf}]/gu, (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  }).join(" ");
}
