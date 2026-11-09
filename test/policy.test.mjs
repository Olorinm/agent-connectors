import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { ConnectorService, Sealer, loadConfig, start } from "../dist/index.js";
import { setup, signal } from "./fixture.mjs";

const owner = { agentId: "agent-a", owner: "@alice", connections: ["alice-notes"], tokenId: "t" };
const readOnly = { ...owner, readOnly: true };
const names = (service, caller) => service.tools(caller).map((tool) => tool.name);
const ops = (view) => Object.fromEntries(view.groups.flatMap((group) => group.operations).map((o) => [o.id, o.setting]));

test("policy: defaults, partial updates, unknown operations, reset, persistence across restart and disconnect", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const initial = await s.service.policy("alice-notes", signal());
  assert.deepEqual(initial, { groups: [{ id: "general", label: "Operations", labelZh: "操作", operations: [
    { id: "read", label: "Read", labelZh: "读取", risk: "read", setting: "allow", default: "allow", available: true },
    { id: "write", label: "Write", labelZh: "写入", risk: "write", setting: "ask", default: "ask", available: true },
  ] }] });
  assert.deepEqual(ops(await s.service.setPolicy("alice-notes", { settings: { write: "allow" } }, signal())), { read: "allow", write: "allow" });
  assert.deepEqual(ops(await s.service.setPolicy("alice-notes", { settings: { read: "deny" } }, signal())), { read: "deny", write: "allow" });
  for (const input of [{ settings: { send: "allow" } }, { settings: { read: "maybe" } }, { settings: {}, extra: 1 }, null])
    await assert.rejects(s.service.setPolicy("alice-notes", input, signal()), (error) => /^policy_/.test(error.code) && error.status === 400);
  await assert.rejects(s.service.policy("nobody", signal()), { code: "connection_not_found" });
  // Only choices that differ from the defaults are stored, per connection.
  assert.deepEqual(s.store.policy("alice-notes"), { read: "deny", write: "allow" });
  assert.deepEqual(s.store.policy("bob-notes"), {});
  // A new service on the same store (restart) keeps the settings.
  const restarted = new ConnectorService({ connectors: [s.connector], connections: s.connections, store: s.store, sealer: new Sealer(s.sealingKey) });
  assert.deepEqual(ops(await restarted.policy("alice-notes", signal())), { read: "deny", write: "allow" });
  assert.deepEqual(ops(await s.service.setPolicy("alice-notes", { settings: { write: "ask" } }, signal())), { read: "deny", write: "ask" });
  assert.deepEqual(s.store.policy("alice-notes"), { read: "deny" });
  assert.deepEqual(ops(await s.service.resetPolicy("alice-notes", signal())), { read: "allow", write: "ask" });
  assert.deepEqual(s.store.policy("alice-notes"), {});
});

test("policy enforcement: allow, ask and deny for reads and writes, for owner and read-only callers", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const set = (settings) => s.service.setPolicy("alice-notes", { settings }, signal());
  const list = (caller) => s.service.call(caller, "alice_notes__list", {}, signal());
  const send = (caller, to = "carol") => s.service.call(caller, "alice_notes__send", { to, text: "hi" }, signal());
  const approve = async (pending) => s.service.approve(await s.verifier.grant(await s.grant(await s.service.operation(pending.operationId))), signal());

  // Defaults: reads run, writes ask; read-only callers never see writes.
  assert.equal((await list(owner)).status, "completed");
  assert.equal((await send(owner)).status, "approval_required");
  assert.equal((await list(readOnly)).status, "completed");
  assert.deepEqual(await send(readOnly), { status: "failed", error: "tool_not_available" });
  assert.deepEqual(names(s.service, readOnly), ["alice_notes__list", "operation_status"]);

  // Write allowed: runs at once for the owner, recorded as an operation; still never for read-only callers.
  await set({ write: "allow" });
  const sent = await send(owner);
  assert.equal(sent.status, "completed"); assert.deepEqual(sent.result, { sent: true }); assert.ok(sent.operationId);
  assert.equal((await s.service.operation(sent.operationId)).status, "completed");
  assert.deepEqual(await send(readOnly), { status: "failed", error: "tool_not_available" });
  assert.ok(!names(s.service, readOnly).includes("alice_notes__send"));
  // The description no longer promises an approval for an allowed write; name and schema are unchanged.
  const tool = s.service.tools(owner).find((candidate) => candidate.name === "alice_notes__send");
  assert.doesNotMatch(tool.description, /approval/);
  assert.deepEqual(tool.inputSchema.required, ["to", "text"]);
  // An earlier write with an unknown outcome is never repeated without the owner, even when allowed.
  assert.equal((await send(owner, "crash")).status, "uncertain");
  assert.equal((await send(owner, "crash")).status, "approval_required");

  // Write denied: hidden and refused, even with a matching pre-approval rule.
  await set({ write: "deny" });
  assert.ok(!names(s.service, owner).includes("alice_notes__send") && !names(s.service, owner).includes("alice_notes__subject"));
  const denied = await send(owner, "invoice-table");
  assert.equal(denied.error, "connector_operation_denied"); assert.equal(denied.detail.operation, "write");

  // Read ask: the owner approves each read; read-only callers are told approval cannot happen there.
  await set({ write: "ask", read: "ask" });
  const pendingRead = await list(owner);
  assert.equal(pendingRead.status, "approval_required");
  assert.match(s.service.tools(owner).find((candidate) => candidate.name === "alice_notes__list").description, /Needs the owner's approval/);
  const read = await approve(pendingRead);
  assert.equal(read.status, "completed"); assert.deepEqual(read.result.notes, ["a"]);
  const refused = await list(readOnly);
  assert.equal(refused.error, "connector_operation_requires_approval"); assert.match(refused.detail.instruction, /cannot be given in this context/);
  assert.deepEqual(names(s.service, readOnly), ["operation_status"]);

  // Read denied: hidden and refused for everyone.
  await set({ read: "deny" });
  assert.ok(!names(s.service, owner).includes("alice_notes__list"));
  for (const caller of [owner, readOnly]) assert.equal((await list(caller)).error, "connector_operation_denied");

  // Changing to deny after a request was shown refuses its approval.
  await set({ read: "allow", write: "ask" });
  const pending = await send(owner, "dave");
  await set({ write: "deny" });
  await assert.rejects(approve(pending), { message: "connector_operation_denied" });
  assert.equal((await s.service.operation(pending.operationId)).status, "denied");
  assert.deepEqual(s.effects.map((effect) => effect.to), ["carol"]);
});

test("policy over HTTP needs the service token and validates its input", async (t) => {
  const s = await setup();
  const file = (name, value, mode) => writeFileSync(join(s.directory, name), value, mode ? { mode } : undefined);
  file("sealing.key", randomBytes(32).toString("base64"), 0o600);
  file("caller.jwks.json", JSON.stringify(s.trust.callerKeys));
  file("authority.jwks.json", JSON.stringify(s.trust.authorityKeys));
  file("config.json", JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, stateDirectory: "http-state",
    encryption: { provider: "development-file", keyFile: "sealing.key" },
    trust: { issuer: s.trust.issuer, audience: s.trust.audience, callerKeys: "caller.jwks.json", authorityKeys: "authority.jwks.json" },
    connections: s.connections }));
  const started = await start(loadConfig(join(s.directory, "config.json")), [s.connector]);
  t.after(async () => { await started.close(); s.cleanup(); });
  const request = async (method, path, body, token) => fetch(`${started.url}/v1/connections/alice-notes/${path}`, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const token = await s.serviceToken();
  assert.equal((await request("GET", "policy")).status, 401);
  assert.equal((await request("GET", "policy", undefined, await s.callerToken())).status, 401, "an Agent cannot read or change its policy");
  assert.equal((await request("PUT", "policy", { settings: { write: "allow" } }, await s.callerToken())).status, 401);
  assert.equal((await (await request("GET", "policy", undefined, token)).json()).groups[0].operations[1].setting, "ask");
  const put = await request("PUT", "policy", { settings: { write: "allow" } }, token);
  assert.equal(put.status, 200); assert.equal((await put.json()).groups[0].operations[1].setting, "allow");
  assert.deepEqual(await (await request("PUT", "policy", { settings: { nope: "allow" } }, token)).json(), { error: "policy_operation_unknown" });
  assert.equal((await request("PUT", "policy", { settings: { write: "allow" } }, token)).status, 200);
  const reset = await request("POST", "policy/reset", undefined, token);
  assert.equal((await reset.json()).groups[0].operations[1].setting, "ask");
  assert.equal((await fetch(`${started.url}/v1/connections/missing/policy`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
});

test("policy is per connection: one owner's settings do not affect another connection", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  await s.service.setPolicy("alice-notes", { settings: { read: "deny" } }, signal());
  const bob = { agentId: "agent-b", owner: "@bob", connections: ["bob-notes"], tokenId: "t" };
  assert.equal((await s.service.call(bob, "bob_notes__list", {}, signal())).status, "completed");
  assert.equal((await s.service.call(owner, "alice_notes__list", {}, signal())).error, "connector_operation_denied");
});

test("every built-in tool names operations from its connector's catalog", async () => {
  const { builtinConnectors } = await import("../dist/index.js");
  const { googleTools } = await import("../dist/connectors/google/tools.js");
  const { gmailToolOperation, gmailMethodOperation, googleCatalog } = await import("../dist/connectors/google/operations.js");
  for (const connector of builtinConnectors({ baseDirectory: ".", stateDirectory: "." })) {
    if (!connector.operations) continue;
    const settings = connector.kind === "google" ? { product: "gmail" } : {};
    const ids = new Set(connector.operations({ id: "x", kind: connector.kind, owner: "@o", settings }).operations.map((o) => o.id));
    for (const tool of connector.tools) {
      assert.ok(tool.operations, `${connector.kind}:${tool.name} declares its operations`);
      for (const id of tool.operations) assert.ok(ids.has(id), `${connector.kind}:${tool.name} -> ${id}`);
    }
  }
  const gmail = new Set(googleCatalog("gmail").operations.map((o) => o.id));
  for (const tool of googleTools("gmail")) assert.ok(gmail.has(gmailToolOperation[tool.name]), tool.name);
  for (const [method, read, expected] of [
    ["gmail.users.messages.list", true, "gmail.messages.read"], ["gmail.users.messages.attachments.get", true, "gmail.messages.read"],
    ["gmail.users.drafts.get", true, "gmail.drafts.read"], ["gmail.users.labels.list", true, "gmail.labels.read"],
    ["gmail.users.settings.filters.list", true, "gmail.labels.read"], ["gmail.users.messages.send", false, "gmail.send"],
    ["gmail.users.drafts.send", false, "gmail.send"], ["gmail.users.drafts.update", false, "gmail.drafts.write"],
    ["gmail.users.labels.create", false, "gmail.labels.manage"], ["gmail.users.messages.batchModify", false, "gmail.messages.modify"],
    ["gmail.users.threads.modify", false, "gmail.messages.modify"], ["gmail.users.messages.import", false, "gmail.messages.import"],
    ["gmail.users.threads.untrash", false, "gmail.messages.trash"], ["gmail.users.messages.batchDelete", false, "gmail.messages.delete"],
    ["gmail.users.settings.filters.create", false, "gmail.settings.write"], ["gmail.users.watch", false, "gmail.other.write"],
  ]) assert.equal(gmailMethodOperation(method, read), expected, method);
  assert.equal(googleCatalog("drive"), undefined);
});
