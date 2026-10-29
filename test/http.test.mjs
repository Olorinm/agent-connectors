import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, start, startConfigured } from "../dist/index.js";
import { setup } from "./fixture.mjs";

async function boot(t) {
  const s = await setup();
  const file = (name, value, mode) => writeFileSync(join(s.directory, name), value, mode ? { mode } : undefined);
  file("sealing.key", randomBytes(32).toString("base64"), 0o600);
  file("caller.jwks.json", JSON.stringify(s.trust.callerKeys));
  file("authority.jwks.json", JSON.stringify(s.trust.authorityKeys));
  file("config.json", JSON.stringify({
    listen: { host: "127.0.0.1", port: 0 }, stateDirectory: "http-state", encryption: { provider: "development-file", keyFile: "sealing.key" },
    trust: { issuer: s.trust.issuer, audience: s.trust.audience, callerKeys: "caller.jwks.json", authorityKeys: "authority.jwks.json" },
    connections: s.connections,
  }));
  const started = await start(loadConfig(join(s.directory, "config.json")), [s.connector]);
  t.after(async () => { await started.close(); s.cleanup(); });
  return { ...s, url: started.url };
}

async function connect(url, token) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

test("MCP: tools, direct reads and approval-bound writes over HTTP", async (t) => {
  const s = await boot(t);
  const client = await connect(s.url, await s.callerToken({ connections: ["alice-notes"] }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]), [["alice_notes__list", true], ["alice_notes__subject", false], ["alice_notes__send", false], ["operation_status", true]]);
  assert.equal((await client.callTool({ name: "alice_notes__list", arguments: {} })).structuredContent.status, "completed");
  const pending = (await client.callTool({ name: "alice_notes__send", arguments: { to: "carol", text: "invoice" } })).structuredContent;
  assert.equal(pending.status, "approval_required");
  assert.equal(s.effects.length, 0);

  const service = { Authorization: `Bearer ${await s.serviceToken()}` };
  const listed = await (await fetch(`${s.url}/v1/operations`, { headers: service })).json();
  assert.deepEqual(listed.operations.map((op) => op.id), [pending.operationId]);
  const view = await (await fetch(`${s.url}/v1/operations/${pending.operationId}`, { headers: service })).json();
  assert.equal(view.summary, 'Send "invoice" to carol');

  const approve = async (grant, id = view.id) => fetch(`${s.url}/v1/operations/${id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant }) });
  const grant = await s.grant(view);
  const done = await approve(grant);
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { status: "completed", result: { sent: true }, operationId: view.id });
  assert.equal((await approve(grant)).status, 409);
  assert.deepEqual(s.effects, [{ to: "carol", text: "invoice" }]);
  const status = (await client.callTool({ name: "operation_status", arguments: { operationId: view.id } })).structuredContent;
  assert.equal(status.result.status, "completed");
  await client.close();
});

test("HTTP: callers cannot reach service routes, approve, or call without a valid token", async (t) => {
  const s = await boot(t);
  const callerToken = await s.callerToken();
  const client = await connect(s.url, callerToken);
  const pending = (await client.callTool({ name: "alice_notes__send", arguments: { to: "carol", text: "x" } })).structuredContent;
  await client.close();
  const asCaller = { Authorization: `Bearer ${callerToken}` };
  assert.equal((await fetch(`${s.url}/v1/operations`, { headers: asCaller })).status, 401);
  assert.equal((await fetch(`${s.url}/v1/operations/${pending.operationId}/deny`, { method: "POST", headers: asCaller })).status, 401);
  const selfGrant = await fetch(`${s.url}/v1/operations/${pending.operationId}/approve`, { method: "POST", body: JSON.stringify({ grant: callerToken }) });
  assert.equal(selfGrant.status, 401);
  const mcp = (headers) => fetch(`${s.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal((await mcp({})).status, 401);
  assert.equal((await mcp({ Authorization: `Bearer ${await s.serviceToken()}` })).status, 401);
  assert.equal((await mcp({ ...asCaller, Origin: "https://evil.test" })).status, 403);
  assert.equal(s.effects.length, 0);
});

test("config refuses a sealing key readable by other users", async (t) => {
  if (process.platform === "win32") return t.skip();
  const s = await setup(); t.after(s.cleanup);
  writeFileSync(join(s.directory, "loose.key"), randomBytes(32).toString("base64"), { mode: 0o644 });
  const { readSealingKey } = await import("../dist/index.js");
  assert.throws(() => readSealingKey(join(s.directory, "loose.key")), /sealing_key_file_must_be_private/);
});

test("configured composition starts and closes built-ins and requires encrypted production application files", async t => {
  const s = await setup(); t.after(s.cleanup);
  writeFileSync(join(s.directory, "key"), randomBytes(32).toString("base64"), { mode: 0o600 });
  writeFileSync(join(s.directory, "caller.json"), JSON.stringify(s.trust.callerKeys));
  writeFileSync(join(s.directory, "authority.json"), JSON.stringify(s.trust.authorityKeys));
  const config = { listen: { host: "127.0.0.1", port: 0 }, stateDirectory: "configured", encryption: { provider: "development-file", keyFile: "key" },
    trust: { issuer: s.trust.issuer, callerKeys: "caller.json", authorityKeys: "authority.json" }, connections: [] };
  const file = join(s.directory, "configured.json");
  writeFileSync(file, JSON.stringify(config));
  const started = await startConfigured(file);
  assert.equal((await fetch(started.url + "/v1/health")).status, 200);
  await started.close();
  await assert.rejects(fetch(started.url + "/v1/health"));
  config.encryption = { provider: "cloudflare-worker-secrets", url: "https://vault.example/", keyId: "key1", tokenFile: "token" };
  config.connections = [{ id: "gmail", kind: "google", owner: "alice", settings: { product: "gmail", clientFile: "app.json" } }];
  writeFileSync(file, JSON.stringify(config));
  await assert.rejects(startConfigured(file), /application_files_require_encrypted_store/);
});
