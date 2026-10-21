import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { ConnectorService, Sealer, remoteConnector, start } from "../dist/index.js";
import { RemoteOAuth, restrictedFetch } from "../dist/connectors/remote/oauth.js";
import { remoteSpec } from "../dist/connectors/remote/catalog.js";
import { setup, signal } from "./fixture.mjs";

const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };

/** The real MCP/OAuth SDK talks to a fake HTTPS upstream. No test uses real accounts. */
function upstream(kind) {
  const names = kind === "github" ? ["get_me", "issue_write"] : ["notion-search", "notion-create-pages"];
  const state = { names, effects: [], requests: [], registrations: 0, exchanges: 0, refreshes: 0, failCall: false, schema: structuredClone(schema), failInitialize: 0 };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  state.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    state.requests.push({ url: url.href, method });
    if (url.pathname.includes("oauth-protected-resource"))
      return kind === "notion" ? json({ resource: "https://mcp.notion.com", authorization_servers: ["https://mcp.notion.com"], scopes_supported: ["default"] }) : json({}, 404);
    if (url.pathname.includes("oauth-authorization-server")) return json({
      issuer: "https://mcp.notion.com", authorization_endpoint: "https://mcp.notion.com/authorize",
      token_endpoint: "https://mcp.notion.com/token", registration_endpoint: "https://mcp.notion.com/register",
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    });
    if (url.pathname === "/register") {
      state.registrations++;
      return json({ ...JSON.parse(init.body), client_id: "dynamic-client" }, 201);
    }
    if (url.pathname.endsWith("/token") || url.pathname.endsWith("/access_token")) {
      const form = new URLSearchParams(init.body);
      if (form.get("grant_type") === "refresh_token") {
        state.refreshes++;
        await new Promise((r) => setTimeout(r, 10));
      } else {
        state.exchanges++;
        assert.equal(form.get("code"), "test-code");
        assert.ok(form.get("code_verifier")?.length >= 43);
        state.verifier = form.get("code_verifier");
      }
      return json({ access_token: "secret-access-token", refresh_token: `secret-refresh-${state.refreshes}`, token_type: "Bearer", expires_in: 3600 });
    }
    if (method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(init.body);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer secret-access-token");
    if (message.method === "initialize" && state.failInitialize) return json({ secret: "must-not-leak" }, state.failInitialize);
    if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-03-26", serverInfo: { name: "fake-official-provider", version: "1" }, capabilities: { tools: {} },
    } });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") return json({ jsonrpc: "2.0", id: message.id, result: { tools: [
      ...names.map((name) => ({ name, description: name, inputSchema: state.schema, annotations: { readOnlyHint: true } })),
      { name: "unreviewed_delete_everything", inputSchema: schema, annotations: { readOnlyHint: true } },
    ] } });
    if (message.method === "tools/call") {
      state.effects.push(message.params);
      if (state.failCall) throw new Error("network failed; secret-access-token must-not-leak");
      return json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } });
    }
    throw new Error(`Unexpected request ${message.method}`);
  };
  return state;
}

async function fixture(t, kind = "notion") {
  const s = await setup(); t.after(s.cleanup);
  const remote = upstream(kind), file = join(s.directory, "oauth.json");
  writeFileSync(file, JSON.stringify({ client_id: "configured-client", client_secret: "secret-client" }), { mode: 0o600 });
  const connection = { id: "work", kind, owner: "@alice", settings: kind === "github" ? { clientFile: file } : {} };
  const options = { redirectUrl: "http://127.0.0.1:18100/oauth/callback", fetch: remote.fetch };
  const connector = remoteConnector(kind, options);
  const sealer = new Sealer(s.sealingKey);
  const service = new ConnectorService({ connectors: [connector], connections: [connection], store: s.store, sealer });
  const caller = await s.verifier.caller(await s.callerToken({ connections: ["work"] }));
  const credentials = {
    get: () => { const value = s.store.credential("work"); return value ? JSON.parse(sealer.open("credential:work", value)) : undefined; },
    put: (value) => s.store.putCredential("work", sealer.seal("credential:work", JSON.stringify(value)), new Date()),
  };
  const authorize = async () => {
    const begin = await service.account("work", "connect", signal());
    assert.equal(begin.status, "authorization_required");
    const url = new URL(begin.authorizationUrl);
    await service.oauthCallback(url.searchParams.get("state"), "test-code", signal());
    assert.equal(createHash("sha256").update(remote.verifier).digest("base64url"), url.searchParams.get("code_challenge"));
    return url;
  };
  const approve = async (operationId) => service.approve(await s.verifier.grant(await s.grant((await service.operation(operationId)))), signal());
  return { ...s, service, connection, connector, caller, remote, options, credentials, authorize, approve, file };
}

for (const kind of ["github", "notion"]) {
  test(`${kind}: official SDK OAuth, typed tools and approval-bound writes`, async (t) => {
    const s = await fixture(t, kind);
    assert.equal((await s.service.account("work", "status", signal())).status, "authorization_required");
    await s.service.prepare(s.caller, signal());
    assert.deepEqual(s.service.tools(s.caller).map((tool) => tool.name), ["work__connection_status", "operation_status"]);
    await s.authorize();
    assert.equal((await s.service.account("work", "status", signal())).status, "connected");
    await s.service.prepare(s.caller, signal());
    const tools = s.service.tools(s.caller);
    assert.ok(!tools.some((tool) => tool.name.includes("unreviewed")));
    assert.deepEqual(tools.find((tool) => tool.name === `work__${s.remote.names[0]}`).inputSchema, schema);
    assert.equal(tools.find((tool) => tool.name === `work__${s.remote.names[1]}`).risk, "write");
    assert.equal((await s.service.call(s.caller, `work__${s.remote.names[0]}`, {}, signal())).error, "invalid_arguments");
    assert.equal(s.remote.effects.length, 0);
    const read = await s.service.call(s.caller, `work__${s.remote.names[0]}`, { text: "read" }, signal());
    assert.equal(read.status, "completed");
    const pending = await s.service.call(s.caller, `work__${s.remote.names[1]}`, { text: "exact approved input" }, signal());
    assert.equal(pending.status, "approval_required"); assert.equal(s.remote.effects.length, 1);
    assert.equal((await s.approve(pending.operationId)).status, "completed");
    assert.deepEqual(s.remote.effects[1].arguments, { text: "exact approved input" });
    await assert.rejects(() => s.approve(pending.operationId), /operation_completed/);
    const stored = readFileSync(join(s.directory, "state/connectors.sqlite"));
    for (const secret of ["secret-access-token", "secret-refresh", "secret-client", "exact approved input"])
      assert.equal(stored.includes(Buffer.from(secret)), false);
    assert.equal(JSON.stringify([tools, read, pending, await s.service.account("work", "status", signal())]).includes("secret-"), false);
  });
}

test("OAuth states are single use, expire and cannot authorize another connection", async (t) => {
  const s = await fixture(t);
  const begin = await s.service.account("work", "connect", signal()), state = new URL(begin.authorizationUrl).searchParams.get("state");
  await assert.rejects(() => s.service.oauthCallback("attacker-state", "test-code", signal()), /oauth_state_invalid/);
  assert.equal(s.remote.exchanges, 0);
  await s.service.oauthCallback(state, "test-code", signal());
  await assert.rejects(() => s.service.oauthCallback(state, "test-code", signal()), /oauth_state_invalid/);
  const next = await s.service.account("work", "connect", signal());
  const saved = s.credentials.get(); saved.pending.expiresAt = Date.now() - 1; s.credentials.put(saved);
  await assert.rejects(() => s.service.oauthCallback(new URL(next.authorizationUrl).searchParams.get("state"), "test-code", signal()), /oauth_state_invalid/);
  assert.equal(s.remote.exchanges, 1);
});

test("Notion registration persists and concurrent token refresh happens once", async (t) => {
  const s = await fixture(t); await s.authorize();
  const saved = s.credentials.get(); saved.expiresAt = Date.now() - 1; s.credentials.put(saved);
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => s.service.account("work", "status", signal())));
  assert.ok(outcomes.every((o) => o.status === "connected")); assert.equal(s.remote.refreshes, 1);
  assert.equal(s.credentials.get().tokens.refresh_token, "secret-refresh-1");
  const restarted = new ConnectorService({ connectors: [remoteConnector("notion", s.options)], connections: [s.connection],
    store: s.store, sealer: new Sealer(s.sealingKey) });
  assert.equal((await restarted.account("work", "status", signal())).status, "connected");
  await restarted.account("work", "disconnect", signal());
  await restarted.account("work", "connect", signal());
  assert.equal(s.remote.registrations, 1);
});

test("only authorized owners discover tools; owner and settings changes invalidate tokens", async (t) => {
  const s = await fixture(t); await s.authorize();
  const before = s.remote.requests.length;
  const stranger = { ...s.caller, owner: "@bob" };
  await s.service.prepare(stranger, signal());
  assert.deepEqual(s.service.tools(stranger).map((tool) => tool.name), ["operation_status"]);
  assert.equal((await s.service.call(stranger, "work__notion-search", { text: "x" }, signal())).error, "tool_not_available");
  assert.equal(s.remote.requests.length, before);
  for (const connection of [{ ...s.connection, owner: "@bob" }, { ...s.connection, settings: { scopes: ["new-scope"] } }]) {
    const changed = new ConnectorService({ connectors: [remoteConnector("notion", s.options)], connections: [connection],
      store: s.store, sealer: new Sealer(s.sealingKey) });
    assert.equal((await changed.account("work", "status", signal())).status, "authorization_required");
  }
});

test("schema changes and disconnect invalidate pending approvals", async (t) => {
  const s = await fixture(t); await s.authorize();
  const pending = await s.service.call(s.caller, "work__notion-create-pages", { text: "before" }, signal());
  s.remote.schema.properties.extra = { type: "string" };
  await assert.rejects(() => s.approve(pending.operationId), /tool_or_account_changed/);
  assert.equal(s.remote.effects.length, 0);
  await s.service.account("work", "disconnect", signal());
  assert.equal((await s.service.operation(pending.operationId)).status, "denied");
  assert.equal((await s.service.call(s.caller, "work__notion-search", { text: "x" }, signal())).error, "authorization_required");
  await s.authorize();
  await assert.rejects(() => s.approve(pending.operationId), /operation_denied/);
  assert.equal(s.remote.effects.length, 0);
});

test("unknown write failures stay uncertain, do not leak secrets and are never retried", async (t) => {
  const s = await fixture(t); await s.authorize();
  const pending = await s.service.call(s.caller, "work__notion-create-pages", { text: "create" }, signal());
  s.remote.failCall = true;
  const result = await s.approve(pending.operationId);
  assert.equal(result.status, "uncertain"); assert.equal(s.remote.effects.length, 1);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  await assert.rejects(() => s.approve(pending.operationId), /operation_uncertain/);
  assert.equal(s.remote.effects.length, 1);
});

test("provider refusal is reported safely before business dispatch", async (t) => {
  const s = await fixture(t); await s.authorize();
  s.remote.failInitialize = 403;
  const status = await s.service.account("work", "status", signal());
  assert.equal(status.status, "upstream_access_denied");
  s.remote.failInitialize = 401;
  assert.equal((await s.service.account("work", "status", signal())).status, "authorization_required");
  assert.equal(s.credentials.get().tokens, undefined);
  assert.equal(s.remote.effects.length, 0);
});

test("configuration errors and credential destination checks fail closed", async (t) => {
  const s = await fixture(t, "github");
  chmodSync(s.file, 0o644);
  assert.equal((await s.service.account("work", "status", signal())).status, "oauth_client_file_must_be_private");
  assert.equal((await s.service.account("work", "connect", signal())).status, "oauth_client_file_must_be_private");
  assert.equal(s.remote.requests.length, 0);
  const missing = new RemoteOAuth({ connection: { ...s.connection, settings: {} }, credentials: { get: () => undefined, put: () => {} }, signal: signal() },
    remoteSpec({ ...s.connection, settings: {} }), s.options);
  assert.equal(missing.status().status, "oauth_client_not_configured");
  for (const redirectUrl of ["http://public.test/oauth/callback", "https://safe.test/other-path", "https://u:p@safe.test/oauth/callback", "https://safe.test/oauth/callback?x=1"]) {
    const invalid = new RemoteOAuth(missing.context, missing.spec, { ...s.options, redirectUrl });
    assert.equal(invalid.status().status, "oauth_callback_invalid");
  }
  const missingCallback = new RemoteOAuth(missing.context, missing.spec, {});
  assert.equal(missingCallback.status().status, "oauth_callback_not_configured");
  const call = restrictedFetch(["https://mcp.notion.com"], async () => new Response("ok"));
  assert.equal((await call("https://mcp.notion.com/mcp")).status, 200);
  for (const url of ["https://evil.test", "http://mcp.notion.com", "https://user:pass@mcp.notion.com"])
    await assert.rejects(() => call(url), /upstream_origin_not_allowed/);
  await assert.rejects(() => restrictedFetch(["https://mcp.notion.com"], async () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } }))("https://mcp.notion.com"), /upstream_redirect_refused/);
});

test("an old discovered tool cannot execute with a newly authorized account", async (t) => {
  const s = await fixture(t); await s.authorize();
  const context = { connection: s.connection, credentials: s.credentials, signal: signal() };
  const tools = await s.connector.discover(context);
  const oldWrite = tools.find((tool) => tool.risk === "write");
  await s.authorize();
  await assert.rejects(() => oldWrite.execute(context, { text: "stale" }), /connection_changed/);
  assert.equal(s.remote.effects.length, 0);
});

test("HTTP account management requires authority; public callback only accepts bound state", async (t) => {
  const s = await fixture(t);
  const server = await start({ listen: { host: "127.0.0.1", port: 0 }, stateDirectory: join(s.directory, "http-state"),
    encryption: { provider: "development-file", key: s.sealingKey }, trust: s.trust, connections: [s.connection] }, [s.connector]);
  t.after(() => server.close());
  const callerHeaders = { Authorization: `Bearer ${await s.callerToken({ connections: ["work"] })}` };
  const authority = { Authorization: `Bearer ${await s.serviceToken()}` };
  for (const [path, method] of [["/v1/connections", "GET"], ["/v1/connections/work", "GET"], ["/v1/connections/work/connect", "POST"], ["/v1/connections/work/disconnect", "POST"]])
    assert.equal((await fetch(server.url + path, { method, headers: callerHeaders })).status, 401);
  assert.equal((await fetch(server.url + "/v1/connections", { headers: authority })).status, 200);
  const begin = await (await fetch(server.url + "/v1/connections/work/connect", { method: "POST", headers: authority })).json();
  const state = new URL(begin.authorizationUrl).searchParams.get("state");
  assert.equal((await fetch(`${server.url}/oauth/callback?state=wrong&code=test-code`)).status, 400);
  assert.equal((await fetch(`${server.url}/oauth/callback?state=${state}&code=test-code`, { headers: { Origin: "https://evil.test" } })).status, 403);
  const callback = await fetch(`${server.url}/oauth/callback?state=${state}&code=test-code`);
  assert.equal(callback.status, 200); assert.equal((await callback.json()).status, "authorized");
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await fetch(`${server.url}/oauth/callback?state=${state}&code=test-code`)).status, 400);
  const status = await (await fetch(server.url + "/v1/connections/work", { headers: authority })).json();
  assert.equal(status.status, "connected"); assert.equal(JSON.stringify(status).includes("secret"), false);
});
