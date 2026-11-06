import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ConnectorService, Sealer, feishuConnector, loadConfig, start } from "../dist/index.js";
import { UnconfiguredCli } from "../dist/connectors/feishu/classify.js";
import { runOfficialCli } from "../dist/connectors/feishu/account.js";
import { setup, signal } from "./fixture.mjs";

const RISK = { "mail +triage": "read", "drive +download": "read", "base +record-share-link-create": "read", "mail +send": "write", "mail +fail": "write", "mail +boom": "write", "mail +message-trash": "high-risk-write" };
const alice = { agentId: "agent-a", owner: "@alice", connections: ["work-feishu"], tokenId: "t" };

/** Fake lark-cli: answers --help=true from the risk table and records every other invocation. */
function fakeCli({ authorized = true } = {}) {
  const calls = [];
  // Mutable account state: "valid", "missing" (never logged in), "expired" (refresh token lapsed); `consent` completes a device flow.
  const auth = { user: authorized ? "valid" : "missing", consent: false, appId: "cli_app", ownerOpenId: "ou_owner" };
  const runner = async (args, { cwd, env }) => {
    const call = { args, cwd, configDir: env.LARKSUITE_CLI_CONFIG_DIR, files: existsSync(cwd) ? readdirSync(cwd) : [] };
    calls.push(call);
    if (args.includes("--dry-run=true")) {
      const command = args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ");
      const api = command === "base +record-share-link-create" ? [{ method: "POST", url: "/open-apis/base/v3/bases/b/tables/t/records/share_links/batch" }]
        : command === "mail +triage" ? [{ method: "POST", url: "/open-apis/mail/v1/user_mailboxes/me/search" }] : [{ method: "GET", url: "/open-apis/x" }];
      return { code: 0, stdout: JSON.stringify({ ok: true, dry_run: true, data: { api } }), stderr: "" };
    }
    if (args.includes("--help=true")) {
      const command = args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ");
      if (args.at(-1) === "--body") return { code: 2, stdout: "", stderr: '{"ok":false,"error":{"type":"validation"}}' };
      return RISK[command] ? { code: 0, stdout: `Usage:\n  lark-cli ${command} [flags]\n\nRisk: ${RISK[command]}\n`, stderr: "" } : { code: 0, stdout: "Usage:\n  lark-cli mail [flags]\n", stderr: "" };
    }
    if (args[0] === "skills") return { code: 0, stdout: "skill text", stderr: "" };
    const words = args.filter((a) => !a.startsWith("-"));
    if (words[0] === "auth" && words[1] === "status") {
      const profile = args.find((a) => a.startsWith("--profile="))?.slice(10);
      const user = auth.user === "valid" ? { status: "ready", openId: auth.ownerOpenId, userName: "Alice", available: true, tokenStatus: "valid", verified: true, scope: "mail:read" }
        : auth.user === "expired" ? { status: "missing", available: false, message: "User identity: missing (refresh token expired)" }
        : { status: "missing", available: false, message: "User identity: missing (no user logged in)" };
      return { code: 0, stdout: JSON.stringify({ appId: profile, identities: { user }, ...(args.includes("--verify") && auth.user === "valid" ? { verified: true } : {}) }), stderr: "" };
    }
    if (words[0] === "auth" && words[1] === "login" && args.includes("--device-code")) {
      if (!auth.consent) return { code: 1, stdout: "", stderr: '{"ok":false,"error":{"type":"authorization_pending"}}' };
      auth.user = "valid"; return { code: 0, stdout: '{"ok":true}', stderr: "" };
    }
    if (words[0] === "auth" && words[1] === "login") return { code: 0, stdout: JSON.stringify({ device_code: "dc", verification_url: "https://open.feishu.cn/consent", expires_in: 600 }), stderr: "" };
    if (words[0] === "auth" && words[1] === "logout") { auth.user = "missing"; return { code: 0, stdout: '{"ok":true}', stderr: "" }; }
    const command = args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ");
    if (command === "drive +download") {
      writeFileSync(join(cwd, "invoice.pdf"), "%PDF-1.7 fake");
      return { code: 0, stdout: JSON.stringify({ ok: true, data: { saved_path: "invoice.pdf", other: { path: "../../credentials.json" } } }), stderr: "" };
    }
    if (command === "mail +fail") return { code: 2, stdout: "", stderr: '{"ok":false,"error":{"type":"validation","subtype":"invalid_argument"}}' };
    if (command === "mail +boom") return { code: 1, stdout: "", stderr: '{"ok":false,"error":{"type":"api_error"}}' };
    return { code: 0, stdout: '{"ok":true}', stderr: "" };
  };
  return { calls, runner, auth, executed: () => calls.filter((c) => !c.args.includes("--help=true") && !c.args.includes("--dry-run=true") && c.args[0] !== "auth") };
}

async function feishu(t, options) {
  const s = await setup(); t.after(s.cleanup);
  const directory = join(s.directory, "feishu");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "app-secret"), "secret-value", { mode: 0o600 });
  writeFileSync(join(directory, "credentials.json"), JSON.stringify({ version: 1, appId: "cli_app", appSecretFile: "app-secret", domain: "feishu", ownerOpenId: "ou_owner" }), { mode: 0o600 });
  const cli = fakeCli(options);
  const connector = feishuConnector({ runner: cli.runner, baseDirectory: s.directory, classifierDirectory: join(s.directory, "classifier") });
  const service = new ConnectorService({ connectors: [connector], store: s.store, sealer: new Sealer(s.sealingKey),
    connections: [{ id: "work-feishu", kind: "feishu", owner: "@alice", settings: { directory: "feishu" } }] });
  const call = (tool, args, files) => service.call(alice, `work_feishu__${tool}`, { args, ...(files ? { files } : {}) }, signal());
  const approve = async (pending) => service.approve(await s.verifier.grant(await s.grant((await service.operation(pending.operationId)))), signal());
  return { ...s, cli, service, call, approve, accountConfig: join(directory, "lark-cli") };
}

test("reads run as the owner, classified by an unconfigured CLI, in a temporary directory", async (t) => {
  const f = await feishu(t);
  const result = await f.call("cli_read", ["mail", "+triage", "--query", "发票"]);
  assert.equal(result.status, "completed");
  const help = f.cli.calls.find((c) => c.args.includes("--help=true") && c.args[0] === "mail");
  assert.deepEqual(help.args, ["mail", "--help=true", "+triage", "--query", "发票"]);
  assert.notEqual(help.configDir, f.accountConfig, "classification never sees the owner's configuration");
  const plan = f.cli.calls.find((c) => c.args.includes("--dry-run=true"));
  assert.deepEqual(plan.args, ["mail", "--profile=cli_agent_connectors_plan", "--as=user", "--dry-run=true", "+triage", "--query", "发票"]);
  assert.notEqual(plan.configDir, f.accountConfig, "planning never sees the owner's configuration");
  const [run] = f.cli.executed();
  assert.deepEqual(run.args, ["mail", "--profile=cli_app", "--as=user", "+triage", "--query", "发票"]);
  assert.equal(run.configDir, f.accountConfig);
  assert.ok(!existsSync(run.cwd), "per-call directory is removed");
});

test("Feishu account management uses the official device flow and cancels pending writes on disconnect", async (t) => {
  const f = await feishu(t, { authorized: false });
  const linked = await f.service.account("work-feishu", "connect", signal());
  assert.equal(linked.status, "authorization_required");
  assert.equal(linked.authorizationUrl, "https://open.feishu.cn/consent");
  const pending = await f.call("cli_write", ["mail", "+send", "--to", "a@b.c", "--confirm-send"]);
  assert.equal(pending.status, "approval_required");
  assert.equal((await f.service.account("work-feishu", "disconnect", signal())).status, "disconnected");
  assert.equal((await f.service.operation(pending.operationId)).status, "denied");
  assert.ok(f.cli.calls.some((call) => call.args[0] === "auth" && call.args.includes("logout")));
  assert.equal(existsSync(join(f.directory, "feishu", "authorization.json")), false);
  assert.deepEqual(f.cli.executed(), []);
});

test("the read tool refuses write, high-risk and unknown commands without running them", async (t) => {
  const f = await feishu(t);
  for (const [args, risk] of [[["mail", "+send", "--to", "a@b.c", "--confirm-send"], "write"], [["mail", "+message-trash", "--message-ids", "1"], "high-risk-write"],
    [["mail", "+nonexistent"], "unknown"], [["mail", "+send", "--to", "a", "--confirm-send", "--body"], "unknown"]]) {
    const result = await f.call("cli_read", args);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "feishu_command_requires_write_tool");
    assert.equal(result.detail.risk, risk);
  }
  assert.deepEqual(f.cli.executed(), []);
});

test("help requests are answered without executing the Agent's arguments", async (t) => {
  const f = await feishu(t);
  // "-h" here could be read as the value of --body; the command must still not run.
  const result = await f.call("cli_read", ["mail", "+send", "--to", "a@b.c", "--confirm-send", "--body", "-h"]);
  assert.equal(result.status, "completed");
  assert.match(result.result.output, /Risk: write/);
  assert.equal((await f.call("cli_read", ["skills", "read", "lark-mail"])).result.output, "skill text");
  assert.deepEqual(f.cli.executed().filter((c) => c.configDir === f.accountConfig), []);
});

test("identity, reserved and management arguments are refused", async (t) => {
  const f = await feishu(t);
  for (const args of [["mail", "+triage", "--as", "bot"], ["mail", "+triage", "--profile=x"], ["mail", "+triage", "--help=false"], ["mail", "+send", "--yes=true"],
    ["auth", "logout"], ["config", "show"], ["event", "+subscribe"], ["profile", "list"], ["skills", "install", "x"]]) {
    for (const tool of ["cli_read", "cli_write"]) {
      const result = await f.call(tool, args);
      assert.equal(result.status, tool === "cli_write" ? "approval_required" : "failed", `${tool} ${args.join(" ")}`);
      if (tool === "cli_write") {
        const outcome = await f.approve(result);
        assert.equal(outcome.status, "failed", args.join(" "));
      }
    }
  }
  assert.deepEqual(f.cli.executed().filter((c) => c.configDir === f.accountConfig), []);
});

test("writes wait for approval, show every argument, and high-risk commands get confirmation only after it", async (t) => {
  const f = await feishu(t);
  const pending = await f.call("cli_write", ["mail", "+send", "--to", "finance@example.com", "--subject", "发票", "--attach", "invoice.pdf", "--confirm-send"],
    [{ name: "invoice.pdf", contentBase64: Buffer.from("%PDF").toString("base64") }]);
  assert.equal(pending.status, "approval_required");
  assert.equal(pending.summary, 'Feishu: lark-cli mail +send --to finance@example.com --subject "发票" --attach invoice.pdf --confirm-send\nFiles: invoice.pdf (6 bytes)');
  assert.deepEqual(f.cli.executed(), []);
  assert.equal((await f.approve(pending)).status, "completed");
  const [sent] = f.cli.executed();
  assert.deepEqual(sent.args, ["mail", "--profile=cli_app", "--as=user", "+send", "--to", "finance@example.com", "--subject", "发票", "--attach", "invoice.pdf", "--confirm-send"]);
  assert.deepEqual(sent.files, ["invoice.pdf"]);

  const trash = await f.call("cli_write", ["mail", "+message-trash", "--message-ids", "m1"]);
  assert.ok(!trash.summary.includes("--yes"));
  await f.approve(trash);
  assert.deepEqual(f.cli.executed()[1].args, ["mail", "--profile=cli_app", "--as=user", "--yes=true", "+message-trash", "--message-ids", "m1"]);
});

test("known pre-flight errors fail; other write errors are uncertain", async (t) => {
  const f = await feishu(t);
  assert.equal((await f.approve(await f.call("cli_write", ["mail", "+fail"]))).status, "failed");
  assert.equal((await f.approve(await f.call("cli_write", ["mail", "+boom"]))).status, "uncertain");
});

test("downloaded files inside the call directory are returned; paths outside are ignored", async (t) => {
  const f = await feishu(t);
  const result = await f.call("cli_read", ["drive", "+download", "--file-token", "box1"]);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.result.attachments.map((a) => [a.name, a.mediaType, Buffer.from(a.contentBase64, "base64").toString()]), [["invoice.pdf", "application/pdf", "%PDF-1.7 fake"]]);
  assert.ok(!JSON.stringify(result).includes("secret-value"));
});

test("an unauthorized owner gets the official consent link and nothing runs", async (t) => {
  const f = await feishu(t, { authorized: false });
  const result = await f.call("cli_read", ["mail", "+triage"]);
  assert.equal(result.error, "feishu_personal_authorization_required");
  assert.equal(result.detail.authorizationUrl, "https://open.feishu.cn/consent");
  assert.deepEqual(f.cli.executed().filter((c) => c.args[0] === "mail"), []);
});

test("official lark-cli: risk declarations and resolution of hostile argument lists", async (t) => {
  let cli;
  try {
    cli = new UnconfiguredCli(join((await setup()).directory, "real"), runOfficialCli);
    await cli.run(["--version"]);
  } catch {
    return t.skip("official lark-cli binary not installed");
  }
  const risk = async (args) => (await cli.classify(args)).risk;
  assert.equal(await risk(["mail", "+triage", "--query", "x"]), "read");
  assert.equal(await risk(["mail", "user_mailbox.messages", "list", "--user-mailbox-id", "me"]), "read");
  assert.equal(await risk(["mail", "+send", "--to", "a@b.c", "--confirm-send"]), "write");
  assert.equal(await risk(["im", "+messages-send", "--chat-id", "x", "--text", "hi"]), "write");
  assert.equal(await risk(["api", "GET", "/open-apis/calendar/v4/calendars"]), "write");
  assert.equal(await risk(["mail", "+message-trash", "--message-ids", "1"]), "high-risk-write");
  assert.equal(await risk(["mail", "+send", "--to", "a", "--confirm-send", "--body"]), undefined, "a dangling flag cannot swallow --help");
  assert.equal(await risk(["mail", "+nonexistent"]), undefined);
  assert.equal((await cli.classify(["mail", "+triage", "+send"])).command, "mail +triage", "extra tokens do not change the resolved command");
  const reads = async (args) => (await cli.plan(args)).readOnly;
  assert.equal(await reads(["mail", "+triage", "--query", "x"]), true);
  assert.equal(await reads(["mail", "user_mailbox.messages", "list", "--user-mailbox-id", "me", "--page-size", "5"]), true);
  assert.equal(await reads(["docs", "+fetch", "--doc", "doxcn1"]), true);
  assert.equal(await reads(["base", "+record-share-link-create", "--base-token", "b", "--table-id", "t", "--record-id", "r"]), false, "declared read, plans a share");
  assert.equal(await reads(["drive", "+export", "--token", "d", "--doc-type", "docx", "--file-extension", "pdf"]), false);
  assert.equal(await reads(["vc", "+meeting-screenshot", "--meeting-id", "1"]), false);
});

test("a command declared read whose planned requests write needs the write tool", async (t) => {
  const f = await feishu(t);
  const result = await f.call("cli_read", ["base", "+record-share-link-create", "--base-token", "b", "--table-id", "t", "--record-id", "r"]);
  assert.equal(result.error, "feishu_command_requires_write_tool");
  assert.deepEqual(result.detail.requests, [{ method: "POST", url: "/open-apis/base/v3/bases/b/tables/t/records/share_links/batch" }]);
  assert.deepEqual(f.cli.executed(), []);
});

test("arguments cannot reach the connector host's files, read stdin or run indefinitely", async (t) => {
  const f = await feishu(t);
  for (const args of [["mail", "user_mailbox.messages", "list", "--params", "@/tmp/keys/private.jwk.json"], ["docs", "+script", "--content", "-"],
    ["drive", "+download", "--file-token", "x", "--output", "/tmp/acct/app-secret"], ["drive", "+download", "--file-token", "x", "--output=../credentials.json"],
    ["drive", "+download", "--output", "~/files/x"], ["drive", "+download", "--output", "a/../../b"], ["mail", "+watch"], ["mail", "+watch-start"]]) {
    for (const tool of ["cli_read", "cli_write"]) {
      let result = await f.call(tool, args);
      if (result.status === "approval_required") result = await f.approve(result);
      assert.equal(result.status, "failed", `${tool} ${args.join(" ")}`);
      assert.match(result.error, /^feishu_(local_path|long_running_command)_not_allowed$/);
    }
  }
  assert.equal((await f.approve(await f.call("cli_write", ["api", "POST", "/open-apis/im/v1/messages", "--data", '{"a":1}']))).status, "completed");
  assert.deepEqual(f.cli.executed().map((c) => c.args[0]), ["api"]);
});

test("the approval summary shows invisible characters as escapes", async (t) => {
  const f = await feishu(t);
  const pending = await f.call("cli_write", ["im", "+messages-send", "--text", "pay \u202Eevil\u200B"]);
  assert.ok(pending.summary.includes("\\u202e") && pending.summary.includes("\\u200b") && !/[\u202E\u200B]/.test(pending.summary), pending.summary);
});

/** A connection configured without an application: the product hands over the app its chat bot already uses. */
async function handover(t) {
  const s = await setup(); t.after(s.cleanup);
  const cli = fakeCli({ authorized: false });
  const connector = feishuConnector({ runner: cli.runner, baseDirectory: s.directory, classifierDirectory: join(s.directory, "classifier") });
  const service = new ConnectorService({ connectors: [connector], store: s.store, sealer: new Sealer(s.sealingKey),
    connections: [{ id: "owner-feishu", kind: "feishu", owner: "@alice", settings: { directory: "feishu/alice" } }] });
  const account = (action, input) => service.account("owner-feishu", action, signal(), input);
  const call = (tool, args) => service.call({ ...alice, connections: ["owner-feishu"] }, `owner_feishu__${tool}`, { args }, signal());
  return { ...s, cli, service, account, call, directory: join(s.directory, "feishu", "alice") };
}
const application = { appId: "cli_app", appSecret: "bot-secret-value", domain: "feishu", ownerOpenId: "ou_owner" };

test("a product-provided app: owner-private metadata, device authorization, expiry with reason and re-authorization", async (t) => {
  const f = await handover(t);
  const [listed] = await f.service.connections(signal());
  assert.equal(listed.usage, "owner_private", "products learn that these tools act as the owner");
  assert.equal(listed.account.status, "feishu_configuration_required");
  assert.equal(listed.account.reason, "application_not_provided");

  assert.equal((await f.account("configure", { ...application, appSecret: "" })).status, "feishu_application_invalid");
  assert.equal((await f.account("configure", { ...application, extra: 1 })).status, "feishu_application_invalid");
  assert.equal(existsSync(join(f.directory, "credentials.json")), false);

  const installed = await f.account("configure", application);
  assert.equal(installed.status, "authorization_required");
  assert.equal(installed.applicationChanged, true);
  assert.ok(!JSON.stringify(installed).includes("bot-secret-value"), "the secret is accepted, never returned");
  assert.equal(readFileSync(join(f.directory, "app-secret"), "utf8"), "bot-secret-value");
  assert.equal(statSync(join(f.directory, "app-secret")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory, "credentials.json"), "utf8")),
    { version: 1, appId: "cli_app", appSecretFile: "app-secret", domain: "feishu", ownerOpenId: "ou_owner" });

  const begun = await f.account("connect");
  assert.equal(begun.authorizationUrl, "https://open.feishu.cn/consent");
  const waiting = await f.account("complete");
  assert.equal(waiting.status, "authorization_pending", "not confirmed yet");
  assert.equal(waiting.authorizationUrl, "https://open.feishu.cn/consent");
  f.cli.auth.consent = true;
  const done = await f.account("complete");
  assert.equal(done.status, "connected");
  assert.equal(done.userName, "Alice");
  assert.equal((await f.call("cli_read", ["mail", "+triage"])).status, "completed");

  // The refresh token lapses (the CLI refreshes access tokens itself until then).
  f.cli.auth.user = "expired"; f.cli.auth.consent = false;
  const expired = await f.account("status");
  assert.equal(expired.status, "expired");
  assert.equal(expired.reason, "refresh_token_expired");
  const refused = await f.call("cli_read", ["mail", "+triage"]);
  assert.equal(refused.status, "failed");
  assert.equal(refused.error, "feishu_personal_authorization_required");
  assert.equal(refused.detail.state, "expired");
  assert.equal(refused.detail.reason, "refresh_token_expired");
  assert.equal(refused.detail.action, "reauthorize");
  assert.match(refused.detail.message, /重新授权/);
  assert.equal(refused.detail.authorizationUrl, "https://open.feishu.cn/consent");
  assert.equal((await f.service.tools({ ...alice, connections: ["owner-feishu"] })).filter((tool) => tool.name.startsWith("owner_feishu__")).length, 2,
    "tools stay listed while authorization is missing");
  const reauthorizing = await f.account("status");
  assert.equal(reauthorizing.status, "authorization_pending", "the tool result started the re-authorization");
  f.cli.auth.consent = true;
  assert.equal((await f.account("complete")).status, "connected");
});

test("handing over the same app keeps the owner's authorization; another app or owner resets it", async (t) => {
  const f = await handover(t);
  await f.account("configure", application);
  f.cli.auth.user = "valid";
  assert.equal((await f.account("status")).status, "connected");
  const again = await f.account("configure", { ...application, appSecret: "rotated-secret" });
  assert.equal(again.applicationChanged, false);
  assert.equal(again.status, "connected");
  assert.equal(readFileSync(join(f.directory, "app-secret"), "utf8"), "rotated-secret");
  mkdirSync(join(f.directory, "cli-data"), { recursive: true });
  writeFileSync(join(f.directory, "cli-data", "token"), "old-user-token");
  f.cli.auth.user = "missing";
  const other = await f.account("configure", { ...application, appId: "cli_other" });
  assert.equal(other.applicationChanged, true);
  assert.equal(other.status, "authorization_required", "a new app is never reported as an expired old one");
  assert.equal(existsSync(join(f.directory, "cli-data", "token")), false, "the previous identity's tokens are removed");
  assert.equal(JSON.parse(readFileSync(join(f.directory, "lark-cli", "config.json"), "utf8")).apps[0].appId, "cli_other");
});

test("hand-over and completion over HTTP require the service token", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const cli = fakeCli({ authorized: false });
  const file = (name, value, mode) => writeFileSync(join(s.directory, name), value, mode ? { mode } : undefined);
  file("sealing.key", Buffer.from(s.sealingKey).toString("base64"), 0o600);
  file("caller.jwks.json", JSON.stringify(s.trust.callerKeys));
  file("authority.jwks.json", JSON.stringify(s.trust.authorityKeys));
  file("config.json", JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, stateDirectory: "http-state",
    encryption: { provider: "development-file", keyFile: "sealing.key" },
    trust: { issuer: s.trust.issuer, audience: s.trust.audience, callerKeys: "caller.jwks.json", authorityKeys: "authority.jwks.json" },
    connections: [{ id: "owner-feishu", kind: "feishu", owner: "@alice", settings: { directory: "feishu/alice" } }] }));
  const started = await start(loadConfig(join(s.directory, "config.json")),
    [feishuConnector({ runner: cli.runner, baseDirectory: s.directory, classifierDirectory: join(s.directory, "classifier") })]);
  t.after(() => started.close());
  const post = async (path, body, token) => fetch(`${started.url}/v1/connections/owner-feishu/${path}`, { method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  assert.equal((await post("application", application)).status, 401);
  assert.equal((await post("application", application, await s.callerToken())).status, 401, "an Agent's caller token cannot hand over apps");
  assert.equal(existsSync(join(s.directory, "feishu", "alice", "credentials.json")), false);
  const token = await s.serviceToken();
  assert.equal((await (await post("application", application, token)).json()).status, "authorization_required");
  assert.equal((await (await post("connect", {}, token)).json()).authorizationUrl, "https://open.feishu.cn/consent");
  cli.auth.consent = true;
  assert.equal((await (await post("complete", {}, token)).json()).status, "connected");
  const listed = await (await fetch(`${started.url}/v1/connections`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(listed.connections[0].usage, "owner_private");
});
