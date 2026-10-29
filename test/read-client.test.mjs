import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHttpServer } from "../dist/index.js";
import { ConnectorReadClient } from "../dist/read-client.js";
import { setup } from "./fixture.mjs";

async function boot(t) {
  const f = await setup();
  const server = createHttpServer({ service: f.service, tokens: f.verifier });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); f.cleanup(); });
  const key = join(f.directory, "caller.json");
  writeFileSync(key, JSON.stringify(f.callerKey.privateJwk), { mode: 0o600 });
  const config = { url: `http://127.0.0.1:${server.address().port}`, issuer: f.trust.issuer, audience: f.trust.audience, callerKeyFile: key };
  return { ...f, config, client: new ConnectorReadClient(config), principal: { agentId: "agent-a", owner: "@alice", connections: ["alice-notes", "bob-notes"] } };
}

test("trusted read client uses real MCP and excludes cross-owner and pre-approved writes", async t => {
  const f = await boot(t);
  assert.deepEqual((await f.client.tools(f.principal)).map(t => t.name), ["alice_notes__list"]);
  assert.equal((await f.client.call(f.principal, "alice_notes__list", {})).status, "completed");
  for (const name of ["alice_notes__send", "bob_notes__list", "operation_status"])
    assert.deepEqual(await f.client.call(f.principal, name, { to: "invoice-table", text: "forbidden" }), { status: "failed", error: "tool_not_available" });
  assert.equal(f.effects.length, 0);
  assert.deepEqual(await f.service.pending(), []);
  assert.deepEqual(await f.client.tools({ ...f.principal, owner: "@mallory" }), []);
});

test("read client rejects non-private keys, insecure or variable endpoints and oversized responses", async t => {
  const f = await boot(t);
  for (const url of ["http://example.test", "https://user:password@example.test/", "https://example.test/path", "https://example.test/?x=y"])
    assert.throws(() => new ConnectorReadClient({ ...f.config, url }), /connector_read_endpoint_invalid/);
  chmodSync(f.config.callerKeyFile, 0o644);
  assert.throws(() => new ConnectorReadClient(f.config), /connector_caller_key_must_be_private/);
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("x".repeat(2_100_001)); };
  try { await assert.rejects(f.client.tools(f.principal), /connector_read_unavailable/); }
  finally { globalThis.fetch = fetch; }
  assert.equal(calls, 1);
});
