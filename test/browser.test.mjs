import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConnectorError, ConnectorService, Sealer, Store, browserConnector } from "../dist/index.js";
import { parseCommand } from "../dist/connectors/browser/command.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf_token_0123456789abcdefghij";
const alice = { agentId: "agent-a", owner: "@alice", connections: ["web"], tokenId: "t" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Fake agent-browser: one remote page per session, recording every invocation with its environment. */
function fakeCli() {
  const calls = [];
  const browser = { url: "about:blank", cookies: [], tabs: [{ tabId: "t1", targetId: "TARGET1", active: true }], uploads: [] };
  const runner = async (args, { cwd, env, input }) => {
    calls.push({ args, cwd, env, input });
    const json = (data) => ({ code: 0, stdout: JSON.stringify({ success: true, data, error: null }), stderr: "" });
    const [command, ...rest] = args[0] === "--json" ? args.slice(1) : args;
    if (command === "--help" || args.includes("--help")) return { code: 0, stdout: `Usage: agent-browser ${args[0]}`, stderr: "" };
    if (command === "skills") return { code: 0, stdout: "# agent-browser core skill", stderr: "" };
    if (command === "close" || (command === "stream" && rest[0] === "disable")) return { code: 0, stdout: "✓", stderr: "" };
    if (command === "state" && rest[0] === "load") { browser.cookies = JSON.parse(readFileSync(rest[1], "utf8")).cookies; return { code: 0, stdout: "✓", stderr: "" }; }
    if (command === "state" && rest[0] === "save") { writeFileSync(rest[1], JSON.stringify({ cookies: browser.cookies, origins: [] })); return { code: 0, stdout: "✓", stderr: "" }; }
    if (command === "open") { browser.url = rest[0]; return { code: 0, stdout: `✓ Page\n  ${rest[0]}`, stderr: "" }; }
    if (command === "get" && rest[0] === "url") return { code: 0, stdout: `${browser.url}\n`, stderr: "" };
    if (command === "get" && rest[0] === "attr") return { code: 0, stdout: rest[1] === "@private" ? "http://10.0.0.5/x.pdf\n" : "/files/a.pdf\n", stderr: "" };
    if (command === "snapshot") return { code: 0, stdout: '- textbox "Email" [ref=e1]', stderr: "" };
    if (command === "fill") { browser.cookies = [{ name: "sid", value: "secret-cookie", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true }]; return { code: 0, stdout: "✓ Done", stderr: "" }; }
    if (command === "click") return rest[0] === "#missing" ? { code: 1, stdout: "", stderr: "✗ Element not found: #missing" } : { code: 0, stdout: "✓ Done", stderr: "" };
    if (command === "screenshot" || command === "pdf") {
      const path = rest.filter((arg) => !arg.startsWith("-")).at(-1);
      writeFileSync(path, command === "pdf" ? Buffer.from("%PDF-1.7") : PNG);
      return { code: 0, stdout: `✓ Saved to ${path}`, stderr: "" };
    }
    if (command === "upload") { browser.uploads.push({ selector: rest[0], files: rest.slice(1).map((p) => ({ path: p, exists: existsSync(p) })) }); return { code: 0, stdout: "✓ Done", stderr: "" }; }
    if (command === "eval" && input.includes("DataTransfer")) { browser.uploads.push({ placed: input.includes("YWJj") }); return json({ result: { ok: true } }); }
    if (command === "tab" && rest[0] === "list") return json({ tabs: browser.tabs });
    if (command === "tab" && rest[0] === "new") { browser.tabs = [...browser.tabs.map((t) => ({ ...t, active: false })), { tabId: "t2", targetId: "TARGET2", active: true }]; return { code: 0, stdout: "✓", stderr: "" }; }
    if (command === "tab" && rest[0] === "close") { browser.tabs = browser.tabs.filter((t) => t.targetId !== rest[1]); return { code: 0, stdout: "✓", stderr: "" }; }
    return { code: 0, stdout: "✓ Done", stderr: "" };
  };
  return { calls, browser, runner };
}

function fakeBrowserRun(browser) {
  const log = [];
  const alive = new Set();
  let created = 0;
  return { log, alive, api: {
    create: async (account) => { log.push(["create", account.accountId, account.token]); const id = `session-${++created}`; alive.add(id); return id; },
    alive: async (_account, id) => { log.push(["alive", id]); return alive.has(id); },
    liveView: async (_account, id, target, ms) => { log.push(["liveView", id, target, ms]); return `https://live.browser.run/ui/view?mode=tab&jwt=secret-${target}`; },
    target: async (_account, _id, target) => browser.tabs.some((tab) => tab.targetId === target),
  } };
}

/** Fake CDP guard: records captures and handoffs; `closed` can be flipped to simulate a dropped connection. */
function fakeGuards() {
  const log = [];
  const state = { handoff: { active: true }, download: { name: "a.pdf", mediaType: "application/pdf", size: 6, contentBase64: Buffer.from("%PDF-x").toString("base64") } };
  let created = 0;
  const factory = async (account, sessionId) => {
    const guard = { closed: false, id: ++created,
      captureDownload: async (targetId, trigger, options) => { log.push(["capture", guard.id, targetId, options.maxBytes]); await trigger(); return state.download; },
      handoff: async (targetId, instructions, ms) => { log.push(["handoff", targetId, instructions, ms]); return "cf-handoff-1"; },
      handoffState: async (targetId, handoffId) => { log.push(["handoffState", targetId, handoffId]); return state.handoff; },
      close: () => { guard.closed = true; log.push(["close", guard.id]); } };
    log.push(["connect", guard.id, sessionId, account.token === TOKEN]);
    state.current = guard;
    return guard;
  };
  return { log, state, factory };
}

function setup({ tokenMode = 0o600, token = TOKEN } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-connectors-browser-"));
  writeFileSync(join(directory, "cf-token"), token); chmodSync(join(directory, "cf-token"), tokenMode);
  const cli = fakeCli(), run = fakeBrowserRun(cli.browser), guards = fakeGuards();
  const store = new Store(join(directory, "state"));
  const connections = [{ id: "web", kind: "browser", owner: "@alice", settings: { accountId: ACCOUNT, tokenFile: "cf-token" } }];
  const options = { baseDirectory: directory, directory: join(directory, "homes"), browserRun: run.api, runner: cli.runner, guard: guards.factory };
  const service = new ConnectorService({ connectors: [browserConnector(options)], connections, store, sealer: new Sealer(Buffer.alloc(32, 7)) });
  return { ...cli, run, guards, service, store, directory, options, connections,
    cleanup: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const call = (service, tool, input, caller = alice) => service.call(caller, `web__${tool}`, input, new AbortController().signal);
const ab = (service, ...args) => call(service, "agent_browser_read", { args });
const commands = (s) => s.calls.map((c) => c.args.join(" "));

test("commands run directly against the connection's Browser Run session; the token reaches the CLI only as a CDP header", async (t) => {
  const s = setup(); t.after(s.cleanup);
  assert.equal((await ab(s.service, "open", "https://example.com/login")).status, "completed");
  const snap = await ab(s.service, "snapshot", "-i");
  assert.equal(snap.status, "completed");
  assert.match(snap.result.output, /\[ref=e1\]/);
  assert.equal((await ab(s.service, "fill", "@e1", "a@example.com")).status, "completed");
  assert.deepEqual(s.run.log.filter((e) => e[0] === "create"), [["create", ACCOUNT, TOKEN]], "one remote browser per connection, reused across calls");
  for (const c of s.calls) assert.ok(!c.args.some((arg) => arg.includes(TOKEN)), "the token is never an argument");
  const browserCall = s.calls.find((c) => c.args[0] === "open");
  assert.equal(browserCall.env.AGENT_BROWSER_CDP_HEADERS, JSON.stringify({ Authorization: `Bearer ${TOKEN}` }));
  assert.equal(browserCall.env.AGENT_BROWSER_CDP, `wss://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser/session-1`);
  assert.equal(browserCall.env.AGENT_BROWSER_SESSION, "b");
  assert.ok(browserCall.env.AGENT_BROWSER_CONFIG.endsWith("config.json"), "an explicit empty configuration, never discovery");
  assert.equal(browserCall.env.HOME, browserCall.cwd.replace(/\/work$/, ""), "a private home per connection");
  assert.equal(statSync(browserCall.env.HOME).mode & 0o777, 0o700);
  assert.ok(commands(s).includes("stream disable"), "the daemon's local screencast is turned off");
  // Storage is saved after every command, sealed; the plaintext cookie value never reaches the store.
  assert.equal(commands(s).filter((line) => line.startsWith("state save")).length, 2, "after open and fill; a snapshot only inspects");
  const raw = s.store.credential("web");
  assert.ok(raw && !raw.toString().includes("secret-cookie"));
  const status = await s.service.connections(new AbortController().signal);
  assert.deepEqual(status[0].account, { status: "connected", sites: ["example.com"] });
});

test("only allowlisted commands and flags run; anything touching credentials, scripts, traffic or other browsers is refused first", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const refused = [
    [["cookies"], "agent_browser_command_not_allowed"], [["cookies", "get"], "agent_browser_command_not_allowed"], [["cookies", "set", "a", "b"], "agent_browser_command_not_allowed"],
    [["storage", "local"], "agent_browser_command_not_allowed"], [["state", "save", "x.json"], "agent_browser_command_not_allowed"],
    [["state", "load", "x.json"], "agent_browser_command_not_allowed"], [["eval", "document.cookie"], "agent_browser_command_not_allowed"],
    [["network", "route", "*"], "agent_browser_command_not_allowed"], [["network", "requests"], "agent_browser_command_not_allowed"],
    [["connect", "9222"], "agent_browser_command_not_allowed"], [["install"], "agent_browser_command_not_allowed"], [["upgrade"], "agent_browser_command_not_allowed"],
    [["auth", "list"], "agent_browser_command_not_allowed"], [["batch", "open https://x.com"], "agent_browser_command_not_allowed"],
    [["stream", "enable"], "agent_browser_command_not_allowed"], [["dashboard", "start"], "agent_browser_command_not_allowed"],
    [["addinitscript", "x"], "agent_browser_command_not_allowed"], [["plugin", "add", "x"], "agent_browser_command_not_allowed"],
    [["set", "headers", "{}"], "agent_browser_command_not_allowed"], [["set", "credentials", "u", "p"], "agent_browser_command_not_allowed"],
    [["get", "cdp-url"], "agent_browser_command_not_allowed"], [["diff", "url", "a", "b"], "agent_browser_command_not_allowed"],
    [["close", "--all"], "agent_browser_flag_not_allowed"], [["wait", "--fn", "window.x"], "agent_browser_flag_not_allowed"],
    [["wait", "--download", "x"], "agent_browser_flag_not_allowed"], [["read", "https://example.com"], "agent_browser_arguments_invalid"],
    [["read", "--llms", "full"], "agent_browser_flag_not_allowed"], [["skills", "path"], "agent_browser_command_not_allowed"],
    [["--cdp", "ws://127.0.0.1:9222", "snapshot"], "agent_browser_flag_not_allowed"], [["snapshot", "--cdp-headers", "{}"], "agent_browser_flag_not_allowed"],
    [["--profile", "Default", "open", "https://x.com"], "agent_browser_flag_not_allowed"], [["--state", "auth.json", "wait", "1"], "agent_browser_flag_not_allowed"],
    [["--session", "other", "snapshot"], "agent_browser_flag_not_allowed"], [["open", "https://x.com", "--proxy", "http://p"], "agent_browser_flag_not_allowed"],
    [["--executable-path", "/bin/sh", "open"], "agent_browser_flag_not_allowed"], [["--extension", "/tmp/x", "open"], "agent_browser_flag_not_allowed"],
    [["--config", "x.json", "snapshot"], "agent_browser_flag_not_allowed"], [["open", "https://x.com", "--init-script", "a.js"], "agent_browser_flag_not_allowed"],
    [["open", "https://x.com", "--headers", "{}"], "agent_browser_flag_not_allowed"], [["screenshot", "--screenshot-dir", "/tmp"], "agent_browser_flag_not_allowed"],
    [["--download-path", "/tmp", "click", "@e1"], "agent_browser_flag_not_allowed"], [["-p", "browserbase", "open"], "agent_browser_flag_not_allowed"],
    [["--allow-file-access", "open", "file:///etc/passwd"], "agent_browser_flag_not_allowed"], [["--json=true", "snapshot"], "agent_browser_arguments_invalid"],
    [["snapshot", "-d", "--cdp"], "agent_browser_arguments_invalid"], [["wait", "@e1", "--state", "./auth.json"], "agent_browser_arguments_invalid"],
    [["fill", "@e1"], "agent_browser_arguments_invalid"], [["--json"], "agent_browser_command_required"], [["frobnicate"], "agent_browser_command_not_allowed"],
  ];
  for (const [args, error] of refused) {
    const result = await ab(s.service, ...args);
    assert.equal(result.status, "failed", args.join(" "));
    assert.equal(result.error, error, args.join(" "));
  }
  assert.equal((await ab(s.service, "cookies")).detail.reason, "credentials");
  assert.equal(s.calls.length, 0, "no refused command starts a CLI process");
  assert.equal(s.run.log.length, 0, "or attaches a browser");
  for (const args of [["--json", "snapshot", "-i", "-c", "-d", "3"], ["click", "@e1", "--new-tab"], ["wait", "--load", "networkidle"], ["wait", "@e1", "--state", "hidden"],
    ["find", "role", "button", "click", "--name", "Submit"], ["get", "text", "@e1"], ["is", "visible", "@e1"], ["press", "Enter"], ["scroll", "down", "500"],
    ["tab", "list"], ["tab", "t2"], ["dialog", "accept"], ["set", "viewport", "1280", "800"], ["read", "--filter", "Pricing"], ["select", "@e2", "a", "b"], ["back"]])
    assert.equal((await ab(s.service, ...args)).status, "completed", args.join(" "));
});

test("navigation targets are checked: bare hosts get https://, private and non-http URLs are refused before a browser starts", async (t) => {
  const s = setup(); t.after(s.cleanup);
  for (const args of [["open", "http://127.0.0.1:8080/"], ["open", "localhost:3000"], ["goto", "http://169.254.169.254/latest/meta-data"], ["navigate", "http://10.0.0.5/"],
    ["open", "file:///etc/passwd"], ["open", "chrome://version"], ["open", "https://user:pw@example.com/"], ["open", "http://[::1]/"], ["tab", "new", "http://192.168.1.1/"],
    ["open", "data:text/html,<p>"], ["open", "javascript:alert(1)"]]) {
    const result = await ab(s.service, ...args);
    assert.equal(result.status, "failed", args.join(" "));
    assert.match(result.error, /^browser_url_(not_allowed|invalid)$/, args.join(" "));
  }
  assert.equal(s.calls.length, 0);
  assert.equal((await ab(s.service, "open", "example.com/search?q=hotel")).status, "completed");
  assert.ok(commands(s).includes("open https://example.com/search?q=hotel"), "the checked URL is the one passed on");
  assert.equal((await ab(s.service, "tab", "new", "https://docs.example.com")).status, "completed");
});

test("screenshots and PDFs are written to a private per-call directory and returned as files; the Agent's path names only the file", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const shot = await ab(s.service, "screenshot", "--full", "../../etc/evil.png");
  assert.equal(shot.status, "completed");
  assert.deepEqual(shot.result.files.map(({ contentBase64: _, ...f }) => f), [{ name: "evil.png", mediaType: "image/png", size: PNG.length }]);
  const ran = s.calls.find((c) => c.args[0] === "screenshot");
  const path = ran.args.at(-1);
  assert.ok(path.startsWith(join(s.options.directory, "1", "calls")) && path.endsWith("/evil.png"), "the CLI writes inside the connection's call directory");
  assert.ok(!existsSync(path), "and the call directory is removed afterwards");
  assert.equal(shot.result.output, "✓ Saved to evil.png", "local paths are not reported");
  const plain = await ab(s.service, "screenshot", "@e1");
  assert.equal(plain.result.files[0].name, "screenshot.png", "a selector-only screenshot still gets a private output path");
  assert.deepEqual(s.calls.filter((c) => c.args[0] === "screenshot").at(-1).args.slice(0, 2), ["screenshot", "@e1"]);
  const pdf = await ab(s.service, "pdf", "report");
  assert.deepEqual([pdf.result.files[0].name, pdf.result.files[0].mediaType], ["report.pdf", "application/pdf"]);
});

test("download clicks with agent-browser while the CDP guard captures the file; it is returned under the requested name", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await ab(s.service, "open", "https://example.com/account");
  const result = await ab(s.service, "download", "@e5", "../invoice.pdf");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.result.files.map(({ contentBase64, ...f }) => ({ ...f, text: Buffer.from(contentBase64, "base64").toString() })),
    [{ name: "invoice.pdf", mediaType: "application/pdf", size: 6, text: "%PDF-x" }]);
  assert.deepEqual(s.guards.log.find((e) => e[0] === "capture"), ["capture", 1, "TARGET1", 10_000_000]);
  assert.ok(commands(s).includes("click @e5"), "the element is clicked by agent-browser");
  assert.ok(!commands(s).some((line) => line.startsWith("download")), "agent-browser's own download is not used");
  s.guards.state.current.closed = true;
  const failed = await ab(s.service, "download", "@e5", "x.pdf");
  assert.equal(failed.status, "completed", "a dropped guard is reconnected before the command runs");
  assert.deepEqual(s.guards.log.filter((e) => e[0] === "connect").map((e) => e.slice(0, 3)), [["connect", 1, "session-1"], ["connect", 2, "session-1"]]);
});

test("no command runs when the CDP guard cannot connect", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const service = new ConnectorService({ connectors: [browserConnector({ ...s.options, guard: async () => { throw new ConnectorError("browser_run_unavailable", { reason: "cdp_connect_failed" }); } })],
    connections: s.connections, store: s.store, sealer: new Sealer(Buffer.alloc(32, 7)) });
  const result = await ab(service, "open", "https://example.com/");
  assert.deepEqual([result.status, result.error], ["failed", "browser_run_unavailable"]);
  assert.ok(!commands(s).some((line) => line.startsWith("open")), "the navigation never ran unguarded");
});

test("upload is refused as a read, needs the owner's grant as a write, and places exactly the approved bytes", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await ab(s.service, "open", "https://upload.example.com/form");
  const asRead = await ab(s.service, "upload", "@e3", "cv.pdf");
  assert.deepEqual([asRead.status, asRead.error], ["failed", "agent_browser_command_requires_write_tool"]);
  const input = { args: ["upload", "@e3", "cv.pdf"], site: "https://upload.example.com", files: [{ name: "cv.pdf", mediaType: "application/pdf", contentBase64: "YWJj" }] };
  const pending = await call(s.service, "agent_browser_write", input);
  assert.equal(pending.status, "approval_required");
  assert.equal(pending.summary, "上传 cv.pdf（1 KB）到 upload.example.com\nagent-browser upload @e3 cv.pdf");
  assert.equal(s.browser.uploads.length, 0, "nothing is sent before approval");
  assert.ok(!s.service.tools({ ...alice, readOnly: true }).some((tool) => tool.name === "web__agent_browser_write"), "read-only callers never see the write tool");
  const view = await s.service.operation(pending.operationId);
  const grant = { tokenId: "g1", owner: "@alice", operationId: pending.operationId, digest: view.digest, expiresAt: new Date(Date.now() + 60_000) };
  await assert.rejects(s.service.approve({ ...grant, owner: "@bob" }, new AbortController().signal), /grant_does_not_match_operation/);
  const done = await s.service.approve(grant, new AbortController().signal);
  assert.equal(done.status, "completed");
  const [selected, placed] = s.browser.uploads;
  assert.equal(selected.selector, "@e3");
  assert.ok(selected.files[0].exists && selected.files[0].path.endsWith("/cv.pdf"), "agent-browser selects the input with the file's name");
  assert.deepEqual(placed, { placed: true }, "the approved bytes are placed by the fixed page script");
  await assert.rejects(s.service.approve({ ...grant, tokenId: "g2" }, new AbortController().signal), /operation_completed/);
  assert.equal(s.browser.uploads.length, 2, "an approval uploads exactly once");
});

test("upload refuses another site, mismatched files and non-upload commands", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await ab(s.service, "open", "https://other.example.net/");
  const connector = browserConnector(s.options), tool = connector.tools.find((x) => x.name === "agent_browser_write");
  const context = { connection: s.connections[0], credentials: { get: () => ({ version: 1 }), put: () => {} }, signal: new AbortController().signal };
  const file = { name: "cv.pdf", mediaType: "application/pdf", contentBase64: "YWJj" };
  await assert.rejects(tool.execute(context, { args: ["upload", "@e3", "cv.pdf"], site: "https://upload.example.com", files: [file] }), { code: "browser_upload_site_mismatch" });
  await assert.rejects(tool.execute(context, { args: ["upload", "@e3", "other.pdf"], site: "https://other.example.net", files: [file] }), { code: "agent_browser_upload_files_mismatch" });
  await assert.rejects(tool.execute(context, { args: ["click", "@e3"], site: "https://other.example.net", files: [file] }), { code: "agent_browser_write_supports_upload_only" });
  for (const bad of [{ site: "https://upload.example.com/path" }, { site: "http://upload.example.com" }, { files: [{ ...file, name: "../a" }] }, { files: [{ ...file, mediaType: "not a type" }] }])
    assert.equal(tool.input.safeParse({ args: ["upload", "@e3", "cv.pdf"], site: "https://upload.example.com", files: [file], ...bad }).success, false);
  assert.equal(s.browser.uploads.length, 0);
});

test("a failed command is reported with its output and the session is checked again before the next command", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const failed = await ab(s.service, "click", "#missing");
  assert.deepEqual([failed.status, failed.error, failed.detail.output], ["failed", "agent_browser_failed", "✗ Element not found: #missing"]);
  await ab(s.service, "snapshot");
  assert.deepEqual(s.run.log.filter((e) => e[0] !== "liveView").map((e) => e[0]), ["create", "alive"], "the saved session is verified, then reused");
});

test("close saves the sign-ins and disconnects; a lapsed remote browser is replaced and the saved storage restored", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await ab(s.service, "fill", "@e1", "x");
  assert.equal((await ab(s.service, "close")).status, "completed");
  await ab(s.service, "snapshot");
  assert.deepEqual(s.run.log.map((e) => e.slice(0, 2)), [["create", ACCOUNT], ["alive", "session-1"]], "an alive session is reattached without a new browser");
  assert.ok(!commands(s).some((line) => line.startsWith("state load")), "and keeps its own cookies");
  s.run.alive.clear();
  await ab(s.service, "close");
  s.browser.cookies = [];
  await ab(s.service, "snapshot");
  assert.equal(s.run.log.filter((e) => e[0] === "create").length, 2);
  assert.ok(commands(s).some((line) => line.startsWith("state load")), "a new browser receives the sealed storage");
  assert.equal(s.browser.cookies[0].value, "secret-cookie");
  const files = s.calls.filter((c) => c.args[0] === "state").map((c) => c.args[2]);
  assert.ok(files.every((path) => !existsSync(path)), "storage files never outlive the command");
});

test("handoff uses Cloudflare's structured handoff on the current tab, reports Done, and is revoked by replacing the tab", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const started = await call(s.service, "handoff_start", { instructions: "Please log in", timeoutSeconds: 120 });
  assert.equal(started.status, "completed");
  assert.equal(started.result.handoffId, "cf-handoff-1", "the id is Cloudflare's handoff id");
  assert.equal(started.result.instructions, "Please log in");
  assert.match(started.result.liveViewUrl, /^https:\/\/live\.browser\.run\/.*TARGET1/);
  assert.deepEqual(s.run.log.find((e) => e[0] === "liveView"), ["liveView", "session-1", "TARGET1", 180_000]);
  assert.deepEqual(s.guards.log.find((e) => e[0] === "handoff"), ["handoff", "TARGET1", "Please log in", 120_000]);
  const open = await call(s.service, "handoff_status", { handoffId: "cf-handoff-1" });
  assert.deepEqual([open.result.active, open.result.done], [true, false]);
  s.guards.state.handoff = { active: false, success: true };
  const done = await call(s.service, "handoff_status", { handoffId: "cf-handoff-1" });
  assert.deepEqual([done.result.active, done.result.done, done.result.success], [false, true, true], "Done in the live view completes it");
  assert.equal((await call(s.service, "handoff_status", { handoffId: "other" })).error, "browser_handoff_not_found");
  assert.equal((await call(s.service, "handoff_cancel", { handoffId: "other" })).error, "browser_handoff_not_found");
  assert.ok(!commands(s).some((line) => line.startsWith("tab close")), "an unknown handoff id closes nothing");
  assert.equal((await call(s.service, "handoff_cancel", { handoffId: "cf-handoff-1" })).result.cancelled, true);
  assert.deepEqual(commands(s).filter((line) => line.startsWith("tab ") && !line.includes("list")), ["tab new", "tab close TARGET1"]);
  assert.equal((await call(s.service, "handoff_status", { handoffId: "cf-handoff-1" })).error, "browser_handoff_not_found", "a cancelled handoff is forgotten");
});

test("help and the CLI's own skills run without a browser", async (t) => {
  const s = setup(); t.after(s.cleanup);
  assert.match((await ab(s.service, "skills", "get", "core")).result.output, /core skill/);
  assert.equal((await ab(s.service, "click", "@e1", "--help")).result.output, "Usage: agent-browser click");
  assert.deepEqual(s.calls.map((c) => c.args), [["skills", "get", "core"], ["click", "--help"]]);
  assert.ok(s.calls.every((c) => !c.env.AGENT_BROWSER_CDP && !c.env.AGENT_BROWSER_CDP_HEADERS));
  assert.equal(s.run.log.length, 0);
  assert.equal((await ab(s.service, "cookies", "--help")).error, "agent_browser_command_not_allowed");
});

test("token file must be private and well formed", async (t) => {
  const open = setup({ tokenMode: 0o644 }); t.after(open.cleanup);
  assert.equal((await ab(open.service, "snapshot")).error, "browser_token_file_must_be_private");
  assert.equal(open.run.log.length, 0);
  const bad = setup({ token: "has space in it 0123456789" }); t.after(bad.cleanup);
  assert.equal((await ab(bad.service, "snapshot")).error, "browser_token_file_invalid");
});

test("parseCommand keeps agent-browser syntax and marks file outputs", () => {
  assert.deepEqual(parseCommand(["--json", "screenshot", "shot.jpg"]).outputs, [{ index: 2, name: "shot.jpg" }]);
  assert.deepEqual(parseCommand(["screenshot", "#main", "a/b/c"]).outputs, [{ index: 2, name: "c.png" }]);
  assert.deepEqual(parseCommand(["upload", "input[type=file]", "a.pdf", "dir/b.png"]).files, ["a.pdf", "b.png"]);
  assert.equal(parseCommand(["quit"]).kind, "close");
  assert.equal(parseCommand(["--version"]).kind, "guide");
  assert.equal(parseCommand(["fill", "@e1", "-5"]).kind, "browser", "negative numbers are values, not flags");
  assert.throws(() => parseCommand(["fill", "@e1", "--x"]), { code: "agent_browser_flag_not_allowed" });
  assert.throws(() => parseCommand(["upload", "@e1", "a.pdf", "x/a.pdf"]), { code: "agent_browser_upload_duplicate_file" });
});
