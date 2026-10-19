import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { ConnectorService, Sealer } from "../dist/index.js";
import { setup, signal } from "./fixture.mjs";

const alice = { agentId: "agent-a", owner: "@alice", connections: ["alice-notes", "bob-notes"], tokenId: "t" };

test("caller sees and calls only connections its owner holds", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const names = s.service.tools(alice).map((tool) => tool.name);
  assert.deepEqual(names, ["alice_notes__list", "alice_notes__subject", "alice_notes__send", "operation_status"]);
  assert.deepEqual(await s.service.call(alice, "bob_notes__list", {}, signal()), { status: "failed", error: "tool_not_available" });
  const narrow = { ...alice, connections: [] };
  assert.deepEqual(await s.service.call(narrow, "alice_notes__list", {}, signal()), { status: "failed", error: "tool_not_available" });
});

test("reads run directly; writes wait for a grant and run exactly once", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  assert.equal((await s.service.call(alice, "alice_notes__list", {}, signal())).status, "completed");
  const pending = await s.service.call(alice, "alice_notes__send", { to: "carol", text: "hi" }, signal());
  assert.equal(pending.status, "approval_required");
  assert.equal(pending.summary, 'Send "hi" to carol');
  assert.equal(s.effects.length, 0);
  const view = s.service.operation(pending.operationId);
  assert.deepEqual(view.input, { text: "hi", to: "carol" });
  const grant = await s.verifier.grant(await s.grant(view));
  assert.deepEqual(await s.service.approve(grant, signal()), { status: "completed", result: { sent: true }, operationId: view.id });
  assert.deepEqual(s.effects, [{ to: "carol", text: "hi" }]);
  await assert.rejects(s.service.approve(grant, signal()), { message: "operation_completed" });
  const second = await s.verifier.grant(await s.grant(view));
  await assert.rejects(s.service.approve(second, signal()), { message: "operation_completed" });
  assert.equal(s.effects.length, 1);
  const status = await s.service.call(alice, "operation_status", { operationId: view.id }, signal());
  assert.equal(status.result.status, "completed");
  assert.equal(status.result.input, undefined);
});

test("a grant must match the operation's owner and digest, and is single use", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const pending = await s.service.call(alice, "alice_notes__send", { to: "carol", text: "hi" }, signal());
  const view = s.service.operation(pending.operationId);
  const wrongDigest = await s.verifier.grant(await s.grant({ ...view, digest: "0".repeat(64) }));
  await assert.rejects(s.service.approve(wrongDigest, signal()), { message: "grant_does_not_match_operation" });
  const wrongOwner = await s.verifier.grant(await s.grant({ ...view, owner: "@bob" }));
  await assert.rejects(s.service.approve(wrongOwner, signal()), { message: "grant_does_not_match_operation" });
  const other = await s.service.call(alice, "alice_notes__send", { to: "dave", text: "x" }, signal());
  const forOther = await s.verifier.grant(await s.grant(view));
  await assert.rejects(s.service.approve({ ...forOther, operationId: other.operationId }, signal()), { message: "grant_does_not_match_operation" });
  assert.equal(s.effects.length, 0);
});

test("token kinds and keys are not interchangeable", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const caller = await s.verifier.caller(await s.callerToken());
  assert.equal(caller.owner, "@alice");
  const pending = await s.service.call(caller, "alice_notes__send", { to: "carol", text: "hi" }, signal());
  const view = s.service.operation(pending.operationId);
  // A grant signed with the caller key (the key closest to Agents) is rejected.
  const forged = await s.grant(view, { key: s.callerKey });
  await assert.rejects(s.verifier.grant(forged), { message: "grant_token_invalid" });
  await assert.rejects(s.verifier.caller(await s.grant(view)), { message: "caller_token_invalid" });
  await assert.rejects(s.verifier.service(await s.callerToken()), { message: "service_token_invalid" });
  await assert.rejects(s.verifier.caller(await s.callerToken({ audience: "other" })), { message: "caller_token_invalid" });
  await assert.rejects(s.verifier.caller(await s.callerToken({ issuer: "https://evil.test" })), { message: "caller_token_invalid" });
  const expired = await s.callerToken({ now: new Date(Date.now() - 7200_000), ttlSeconds: 60 });
  await assert.rejects(s.verifier.caller(expired), { message: "caller_token_invalid" });
});

test("auto-approval matches exact argument values only", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  assert.equal((await s.service.call(alice, "alice_notes__send", { to: "invoice-table", text: "row" }, signal())).status, "completed");
  assert.equal((await s.service.call(alice, "alice_notes__send", { to: "invoice-table2", text: "row" }, signal())).status, "approval_required");
  assert.deepEqual(s.effects, [{ to: "invoice-table", text: "row" }]);
});

test("invalid auto-approval rules are refused at startup", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const make = (autoApprove) => new ConnectorService({ connectors: [s.connector], store: s.store, sealer: new Sealer(s.sealingKey),
    connections: [{ id: "x", kind: "notes", owner: "@a", autoApprove }] });
  assert.throws(() => make([{ tool: "list", match: { a: 1 } }]), /auto_approve_rule_invalid/);
  assert.throws(() => make([{ tool: "send", match: {} }]), /auto_approve_rule_invalid/);
  assert.throws(() => make([{ tool: "send", match: { text: "x" } }]), /auto_approve_rule_invalid/, "must pin every target");
  assert.throws(() => make([{ tool: "subject", match: { subject: "x" } }]), /auto_approve_rule_invalid/, "tool without targets");
  assert.throws(() => make([{ tool: "send", match: JSON.parse('{"to":"a","__proto__":{}}') }]), /auto_approve_rule_invalid/);
});

test("pending operations expire and can be denied", async (t) => {
  let clock = Date.parse("2026-10-19T00:00:00Z");
  const s = await setup({ now: () => new Date(clock), ttl: 60 }); t.after(s.cleanup);
  const first = await s.service.call(alice, "alice_notes__send", { to: "carol", text: "1" }, signal());
  const view = s.service.operation(first.operationId);
  const grant = await s.verifier.grant(await s.grant(view));
  clock += 61_000;
  await assert.rejects(s.service.approve(grant, signal()), { message: "operation_expired" });
  const second = await s.service.call(alice, "alice_notes__send", { to: "carol", text: "2" }, signal());
  s.service.deny(second.operationId);
  assert.equal(s.service.operation(second.operationId).status, "denied");
  assert.deepEqual(s.service.pending(), []);
  assert.equal(s.effects.length, 0);
});

test("known failures fail; unknown write failures are uncertain and survive restart as such", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const approve = async (input) => {
    const pending = await s.service.call(alice, "alice_notes__send", input, signal());
    const view = s.service.operation(pending.operationId);
    return s.service.approve(await s.verifier.grant(await s.grant(view)), signal());
  };
  assert.partialDeepStrictEqual(await approve({ to: "fail", text: "x" }), { status: "failed", error: "recipient_rejected" });
  assert.partialDeepStrictEqual(await approve({ to: "crash", text: "x" }), { status: "uncertain", error: "connector_unexpected_error" });
  const pending = await s.service.call(alice, "alice_notes__send", { to: "carol", text: "x" }, signal());
  s.store.transition(pending.operationId, "pending", "executing", new Date());
  new ConnectorService({ connectors: [s.connector], connections: s.connections, store: s.store, sealer: new Sealer(s.sealingKey) });
  assert.equal(s.store.operation(pending.operationId).status, "uncertain");
});

test("credentials and operation contents are encrypted at rest with private file modes", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  await s.service.call(alice, "alice_notes__send", { to: "carol", text: "secret-body-123" }, signal());
  const credentials = { token: "oauth-refresh-xyz" };
  s.store.putCredential("alice-notes", new Sealer(s.sealingKey).seal("credential:alice-notes", JSON.stringify(credentials)), new Date());
  assert.deepEqual((await s.service.call(alice, "alice_notes__list", {}, signal())).result.token, "oauth-refresh-xyz");
  const file = join(s.directory, "state", "connectors.sqlite");
  const raw = readFileSync(file).toString("latin1");
  assert.ok(!raw.includes("oauth-refresh-xyz") && !raw.includes("secret-body-123"));
  if (process.platform !== "win32") {
    const { statSync, readdirSync } = await import("node:fs");
    for (const name of readdirSync(join(s.directory, "state"))) assert.equal(statSync(join(s.directory, "state", name)).mode & 0o077, 0, name);
  }
  // A credential sealed for one connection cannot be replayed into another.
  const db = new DatabaseSync(file);
  const sealed = db.prepare("SELECT sealed FROM credentials WHERE connection_id = 'alice-notes'").get().sealed;
  db.prepare("INSERT INTO credentials VALUES ('bob-notes', ?, '')").run(sealed);
  db.close();
  const bob = { agentId: "agent-b", owner: "@bob", connections: ["bob-notes"], tokenId: "t" };
  assert.deepEqual(await s.service.call(bob, "bob_notes__list", {}, signal()), { status: "failed", error: "connector_unexpected_error" });
  assert.throws(() => new Sealer(Buffer.alloc(31)), /32_bytes/);
});

test("auto-approved writes are recorded, and an uncertain one is not repeated without the owner", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const first = await s.service.call(alice, "alice_notes__send", { to: "invoice-crash", text: "row" }, signal());
  assert.equal(first.status, "uncertain");
  assert.equal(s.service.operation(first.operationId).status, "uncertain");
  const again = await s.service.call(alice, "alice_notes__send", { to: "invoice-crash", text: "row" }, signal());
  assert.equal(again.status, "approval_required");
  const ok = await s.service.call(alice, "alice_notes__send", { to: "invoice-table", text: "row" }, signal());
  assert.equal(s.service.operation(ok.operationId).status, "completed");
});

test("what executes is exactly what was approved, even with transforming schemas", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const pending = await s.service.call(alice, "alice_notes__subject", { subject: "Hi" }, signal());
  const view = s.service.operation(pending.operationId);
  assert.deepEqual(view.input, { subject: "Re: Hi" });
  await s.service.approve(await s.verifier.grant(await s.grant(view)), signal());
  assert.deepEqual(s.effects, [{ subject: "Re: Hi" }]);
  const dated = { kind: "dated", tools: [{ name: "when", description: "", risk: "read", input: z.object({ at: z.date() }), execute: async () => ({}) }] };
  assert.throws(() => new ConnectorService({ connectors: [dated], connections: [{ id: "d", kind: "dated", owner: "@a" }], store: s.store, sealer: new Sealer(s.sealingKey) }), /tool_schema_invalid/);
});

test("tampering with any stored operation column blocks execution", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  for (const [column, value] of [["connection_id", "bob-notes"], ["tool", "subject"], ["agent_id", "agent-x"], ["owner", "@bob"]]) {
    const pending = await s.service.call(alice, "alice_notes__send", { to: "carol", text: column }, signal());
    const view = s.service.operation(pending.operationId);
    const grant = await s.verifier.grant(await s.grant(view));
    s.store.db.prepare(`UPDATE operations SET ${column} = ? WHERE id = ?`).run(value, view.id);
    await assert.rejects(s.service.approve(grant, signal()), (error) => ["operation_integrity_failed", "grant_does_not_match_operation"].includes(error.message), column);
  }
  assert.equal(s.effects.length, 0);
});

test("a pending write cannot run after its connection moved to another owner", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const pending = await s.service.call(alice, "alice_notes__send", { to: "carol", text: "x" }, signal());
  const view = s.service.operation(pending.operationId);
  const moved = s.connections.map((c) => c.id === "alice-notes" ? { ...c, owner: "@bob" } : c);
  const service = new ConnectorService({ connectors: [s.connector], connections: moved, store: s.store, sealer: new Sealer(s.sealingKey) });
  await assert.rejects(service.approve(await s.verifier.grant(await s.grant(view)), signal()), { message: "connection_unavailable" });
  assert.equal(s.effects.length, 0);
});
