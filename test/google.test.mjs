import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { ConnectorService, Sealer, builtinConnectors, googleConnector } from "../dist/index.js";
import { GoogleAccount } from "../dist/connectors/google/account.js";
import { googleTools } from "../dist/connectors/google/tools.js";
import { setup, signal } from "./fixture.mjs";

/** Exercise actual Google SDK request construction and OAuth against a deterministic transport. */
function fakeGoogle() {
  const remote = { requests: [], apiCalls: [], exchanges: 0, refreshes: 0, failApi: 0, dropApi: false, scopes: "", failRefresh: false };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  remote.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    let body = init.body;
    if (body && typeof body !== "string" && !(body instanceof URLSearchParams)) {
      if (body[Symbol.asyncIterator]) { let text = ""; for await (const chunk of body) text += chunk; body = text; }
    }
    const request = { url: url.href, method: init.method ?? "GET", body: String(body ?? ""), headers: new Headers(init.headers) };
    assert.equal(init.redirect, "error");
    assert.equal(init.follow, 0);
    assert.equal(init.retry, false);
    remote.requests.push(request);
    assert.ok(!url.hostname.includes("mcp") && !url.pathname.includes(".well-known"), "formal API must not contact MCP endpoints");
    if (url.href === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(request.body);
      if (params.get("grant_type") === "refresh_token") {
        remote.refreshes++;
        if (remote.failRefresh) return json({ error: "invalid_grant" }, 400);
        await new Promise((r) => setTimeout(r, 5));
        // Google refresh often omits refresh_token; the original must remain durable.
        return json({ access_token: "private-access", token_type: "Bearer", expires_in: 3600 });
      }
      remote.exchanges++; remote.verifier = params.get("code_verifier");
      assert.equal(params.get("code"), "valid-code");
      assert.equal(params.get("client_secret"), "private-client");
      return json({ access_token: "private-access", refresh_token: "private-refresh", token_type: "Bearer", expires_in: 3600 });
    }
    assert.equal(request.headers.get("authorization"), "Bearer private-access");
    if (url.href === "https://oauth2.googleapis.com/tokeninfo") return json({ scope: remote.scopes, expires_in: 3600, aud: "client-id" });
    remote.apiCalls.push(request);
    if (remote.dropApi) throw new Error("connection lost with private-access in internal diagnostics");
    if (remote.failApi) return json({ error: { message: "private-access must not leak", code: remote.failApi } }, remote.failApi);
    if (url.searchParams.get("alt") === "media") return new Response("example content");
    return json({ id: "created-id", ok: true });
  };
  return remote;
}

async function fixture(t, product = "gmail") {
  const s = await setup(); t.after(s.cleanup);
  const remote = fakeGoogle(), file = join(s.directory, "google-oauth.json");
  writeFileSync(file, JSON.stringify({ web: { client_id: "client-id", client_secret: "private-client" } }), { mode: 0o600 });
  const connection = { id: "google", kind: "google", owner: "@alice", settings: { product, clientFile: file } };
  const options = { redirectUrl: "http://127.0.0.1:18100/oauth/callback", fetch: remote.fetch };
  const connector = googleConnector(options), sealer = new Sealer(s.sealingKey);
  const service = new ConnectorService({ connectors: [connector], connections: [connection], store: s.store, sealer });
  const credentials = {
    get: () => { const value = s.store.credential("google"); return value ? JSON.parse(sealer.open("credential:google", value)) : undefined; },
    put: (value) => s.store.putCredential("google", sealer.seal("credential:google", JSON.stringify(value)), new Date()),
  };
  const caller = await s.verifier.caller(await s.callerToken({ connections: ["google"] }));
  const authorize = async () => {
    const begin = await service.account("google", "connect", signal());
    assert.equal(begin.status, "authorization_required");
    const url = new URL(begin.authorizationUrl);
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    remote.scopes = url.searchParams.get("scope");
    await service.oauthCallback(url.searchParams.get("state"), "valid-code", signal());
    assert.equal(createHash("sha256").update(remote.verifier).digest("base64url"), url.searchParams.get("code_challenge"));
    return url;
  };
  const call = (name, args = {}) => service.call(caller, `google__${name}`, args, signal());
  const approve = async (pending) => service.approve({
    owner: "@alice", operationId: pending.operationId, digest: (await service.operation(pending.operationId)).digest,
    tokenId: pending.operationId, expiresAt: new Date(Date.now() + 60_000),
  }, signal());
  return { ...s, service, remote, file, connection, connector, options, credentials, caller, authorize, call, approve };
}

const products = {
  gmail: { read: ["search_threads", { q: "in:inbox", maxResults: 10 }], write: ["create_draft", { to: ["reader@example.test"], subject: "主题", body: "正文" }],
    method: "POST", path: "/gmail/v1/users/me/drafts" },
  drive: { read: ["search_files", { q: "trashed = false" }], write: ["create_file", { name: "sample.txt", content: "hello" }],
    method: "POST", path: "/upload/drive/v3/files" },
  docs: { read: ["read_doc", { documentId: "doc-id" }], write: ["append_text", { documentId: "doc-id", text: "append", tabId: "tab-id" }],
    method: "POST", path: "/v1/documents/doc-id:batchUpdate" },
  sheets: { read: ["get_values", { spreadsheetId: "sheet-id", range: "Sheet1!A1:B2" }], write: ["update_values", { spreadsheetId: "sheet-id", range: "Sheet1!A1:B1", values: [["literal", 7]] }],
    method: "PUT", path: "/v4/spreadsheets/sheet-id/values/" },
  slides: { read: ["read_presentation", { presentationId: "slides-id" }], write: ["replace_text", { presentationId: "slides-id", find: "before", replaceWith: "after" }],
    method: "POST", path: "/v1/presentations/slides-id:batchUpdate" },
  calendar: { read: ["list_events", {}], write: ["create_event", { summary: "Meeting", start: { dateTime: "2026-10-21T10:00:00+08:00" }, end: { dateTime: "2026-10-21T11:00:00+08:00" } }],
    method: "POST", path: "/calendar/v3/calendars/primary/events" },
};

for (const [product, example] of Object.entries(products)) {
  test(`Google ${product}: SDK reads and approved writes use the formal API`, async (t) => {
    const s = await fixture(t, product);
    assert.equal((await s.service.account("google", "status", signal())).status, "authorization_required");
    assert.equal((await s.call(...example.read)).error, "authorization_required");
    await s.authorize();
    const status = await s.service.account("google", "status", signal());
    assert.equal(status.status, "connected"); assert.equal(status.backend, "google-api");
    assert.equal(status.apiAccess, "checked_on_use");
    const read = await s.call(...example.read); assert.equal(read.status, "completed");
    const before = s.remote.apiCalls.length, pending = await s.call(...example.write);
    assert.equal(pending.status, "approval_required"); assert.equal(s.remote.apiCalls.length, before);
    const result = await s.approve(pending); assert.equal(result.status, "completed");
    const request = s.remote.apiCalls.at(-1);
    assert.equal(request.method, example.method); assert.ok(new URL(request.url).pathname.startsWith(example.path), request.url);
    if (product === "gmail") {
      const mime = Buffer.from(JSON.parse(request.body).message.raw, "base64url").toString();
      assert.match(mime, /To: reader@example.test\r\n/);
      assert.match(mime, /Content-Transfer-Encoding: base64/);
    }
    if (product === "sheets") {
      assert.equal(new URL(request.url).searchParams.get("valueInputOption"), "RAW");
      assert.deepEqual(JSON.parse(request.body).values, [["literal", 7]]);
    }
    if (product === "calendar") assert.equal(new URL(request.url).searchParams.get("sendUpdates"), "none");
    assert.equal(JSON.stringify([read, pending, result, status]).includes("private-"), false);
    const db = readFileSync(join(s.directory, "state/connectors.sqlite"));
    for (const secret of ["private-access", "private-refresh", "private-client"]) assert.equal(db.includes(secret), false);
    await assert.rejects(() => s.approve(pending), /operation_completed/);
  });
}

test("Google OAuth rejects stale, foreign and replayed states; cancelled consent stores no token", async (t) => {
  const s = await fixture(t);
  const begin = await s.service.account("google", "connect", signal());
  const state = new URL(begin.authorizationUrl).searchParams.get("state");
  await assert.rejects(() => s.service.oauthCallback("wrong", "valid-code", signal()), /oauth_state_invalid/);
  await s.service.oauthCallback(state, undefined, signal());
  assert.equal(s.credentials.get().tokens, undefined);
  await assert.rejects(() => s.service.oauthCallback(state, "valid-code", signal()), /oauth_state_invalid/);
  const expired = await s.service.account("google", "connect", signal());
  const saved = s.credentials.get(); saved.pending.expiresAt = Date.now() - 1; s.credentials.put(saved);
  await assert.rejects(() => s.service.oauthCallback(new URL(expired.authorizationUrl).searchParams.get("state"), "valid-code", signal()), /oauth_state_invalid/);
  const good = await s.authorize();
  await assert.rejects(() => s.service.oauthCallback(good.searchParams.get("state"), "valid-code", signal()), /oauth_state_invalid/);
  assert.equal(s.remote.exchanges, 1);
});

test("Google refresh is serialized, survives restart and preserves the omitted refresh token", async (t) => {
  const s = await fixture(t); await s.authorize();
  const saved = s.credentials.get(); saved.tokens.expiry_date = Date.now() - 1; s.credentials.put(saved);
  const results = await Promise.all(Array.from({ length: 5 }, () => s.call("search_threads")));
  assert.ok(results.every((result) => result.status === "completed")); assert.equal(s.remote.refreshes, 1);
  assert.equal(s.credentials.get().tokens.refresh_token, "private-refresh");
  const account = await GoogleAccount.load({ connection: s.connection, credentials: s.credentials, signal: signal() }, s.options);
  assert.equal(await account.accessToken(), "private-access"); assert.equal(s.remote.refreshes, 1);
  const expired = s.credentials.get(); expired.tokens.expiry_date = 1; s.credentials.put(expired);
  s.remote.failRefresh = true;
  assert.equal((await s.call("search_threads")).error, "authorization_required");
  assert.equal(s.credentials.get().tokens, undefined);
});

test("Google writes are not retried after 401, 503 or an ambiguous network failure", async (t) => {
  const s = await fixture(t, "sheets"); await s.authorize();
  for (const status of [401, 503, 0]) {
    s.remote.failApi = status; s.remote.dropApi = status === 0;
    const pending = await s.call(...products.sheets.write), before = s.remote.apiCalls.length;
    const result = await s.approve(pending);
    assert.equal(result.status, "uncertain");
    assert.equal(s.remote.apiCalls.length, before + 1);
    assert.equal(s.remote.refreshes, 0);
    assert.equal(JSON.stringify(result).includes("private-"), false);
    await assert.rejects(() => s.approve(pending), /operation_uncertain/);
  }
});

test("Google authorization and typed argument boundaries prevent unintended requests", async (t) => {
  const s = await fixture(t); await s.authorize();
  const before = s.remote.requests.length;
  const stranger = { ...s.caller, owner: "@bob" };
  await s.service.prepare(stranger, signal());
  assert.equal((await s.service.call(stranger, "google__search_threads", {}, signal())).error, "tool_not_available");
  assert.equal(s.remote.requests.length, before);
  for (const [name, args] of [
    ["get_message", { messageId: "../other-user" }],
    ["search_threads", { userId: "someone-else" }],
    ["create_draft", { to: ["reader@example.test"], subject: "ok\r\nBcc: hidden@example.test", body: "x" }],
    ["create_draft", { to: ["reader@example.test\r\nBcc: hidden@example.test"], subject: "x", body: "x" }],
  ]) assert.equal((await s.call(name, args)).error, "invalid_arguments");
  assert.equal(s.remote.apiCalls.length, 0);
  const context = { connection: s.connection, credentials: s.credentials, signal: signal() };
  const old = (await s.connector.discover(context)).find((tool) => tool.risk === "write");
  const pending = await s.call(...products.gmail.write);
  await s.service.account("google", "disconnect", signal()); await s.authorize();
  assert.equal((await s.service.operation(pending.operationId)).status, "denied");
  await assert.rejects(() => old.execute(context, products.gmail.write[1]), /connection_changed/);
});

test("Google settings, callback and application files are checked; preview tokens are not reused", async (t) => {
  const s = await fixture(t);
  const context = { connection: s.connection, credentials: s.credentials, signal: signal() };
  chmodSync(s.file, 0o644);
  assert.equal((await s.service.account("google", "status", signal())).status, "oauth_client_file_must_be_private");
  chmodSync(s.file, 0o600);
  assert.equal(new GoogleAccount(context, { ...s.options, redirectUrl: "http://public.test/oauth/callback" }).localStatus().status, "oauth_callback_invalid");
  assert.equal(new GoogleAccount(context, {}).localStatus().status, "oauth_callback_not_configured");
  const missing = { ...context, connection: { ...s.connection, settings: { product: "gmail" } } };
  assert.equal(new GoogleAccount(missing, s.options).localStatus().status, "oauth_client_not_configured");
  s.credentials.put({ version: 1, binding: "old-mcp-binding", tokens: { access_token: "old-preview-token" } });
  assert.equal((await s.service.account("google", "status", signal())).status, "authorization_required");
  assert.equal(s.remote.requests.length, 0);
  const builtins = builtinConnectors({ baseDirectory: s.directory, stateDirectory: join(s.directory, "state"), redirectUrl: s.options.redirectUrl });
  assert.equal(builtins.filter((connector) => connector.kind === "google").length, 1);
  for (const product of Object.keys(products)) {
    const tools = googleTools(product);
    assert.ok(tools.some((tool) => tool.risk === "read"));
    assert.ok(tools.some((tool) => tool.risk === "write"));
    assert.ok(tools.every((tool) => !["api", "request", "fetch"].includes(tool.name)));
  }
});

test("Google credentials cannot be sent to an arbitrary host or a non-HTTPS endpoint", async (t) => {
  const s = await fixture(t); await s.authorize();
  const account = await GoogleAccount.load({ connection: s.connection, credentials: s.credentials, signal: signal() }, s.options);
  const client = await account.businessClient(), before = s.remote.requests.length;
  for (const url of ["https://evil.test/", "http://gmail.googleapis.com/", "https://user:password@gmail.googleapis.com/"])
    await assert.rejects(() => client.request({ url }), /upstream_origin_not_allowed/);
  assert.equal(s.remote.requests.length, before);
});
