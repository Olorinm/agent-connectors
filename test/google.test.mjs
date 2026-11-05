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
    const routed = remote.route?.(url, request); if (routed !== undefined) return json(routed);
    return json({ id: "created-id", ok: true });
  };
  return remote;
}

async function fixture(t, product = "gmail", extra = {}) {
  const s = await setup(); t.after(s.cleanup);
  const remote = fakeGoogle(), file = join(s.directory, "google-oauth.json");
  writeFileSync(file, JSON.stringify({ web: { client_id: "client-id", client_secret: "private-client" } }), { mode: 0o600 });
  const connection = { id: "google", kind: "google", owner: "@alice", settings: { product, clientFile: file, ...extra.settings } };
  const options = { redirectUrl: "http://127.0.0.1:18100/oauth/callback", fetch: remote.fetch, ...extra.options };
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
  gmail: { read: ["search_threads", { query: "in:inbox", pageSize: 10 }], write: ["create_draft", { to: ["reader@example.test"], subject: "主题", body: "正文" }],
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

const b64 = (text) => Buffer.from(text).toString("base64url");
const headers = (values) => Object.entries(values).map(([name, value]) => ({ name, value }));
/** A newsletter: a placeholder text part, a large HTML part, a PDF attachment and Gmail's category labels. */
function newsletter(id, html = "<style>.x{}</style><h1>November update</h1><p>26 new APIs and <a href=\"https://example.test/a\">SOC 2</a>.</p><img src=\"https://example.test/p.png\">") {
  return { id, threadId: "thread-1", snippet: "26 new APIs", internalDate: "1762300800000", labelIds: ["UNREAD", "INBOX", "CATEGORY_UPDATES", "Label_7"],
    payload: { mimeType: "multipart/mixed", headers: headers({ Subject: "November update", From: "\"Search, Team\" <news@example.test>",
      To: "Owner <owner@example.test>, other@example.test", Cc: "", Date: "Wed, 05 Nov 2025 00:00:00 +0000", Received: "x".repeat(5000) }),
    parts: [{ mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: b64("View this email in your browser") } },
      { mimeType: "text/html", body: { data: b64(html + "<p>" + "padding ".repeat(400) + "</p>") } }] },
    { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "att-1", size: 1000 } }] } };
}

test("Gmail tools follow the official MCP shape: decoded bodies, HTML fallback, addresses, visible labels", async (t) => {
  const s = await fixture(t); await s.authorize();
  s.remote.route = (url) => {
    if (url.pathname.endsWith("/threads/thread-1")) return { id: "thread-1", messages: [newsletter("m-1")] };
    if (url.pathname.endsWith("/messages/m-1")) return newsletter("m-1");
  };
  const tools = (await s.connector.discover({ connection: s.connection, credentials: s.credentials, signal: signal() })).map((tool) => tool.name);
  assert.deepEqual(tools.sort(), ["create_draft", "get_message", "get_thread", "label_message", "label_thread", "list_drafts", "list_labels", "search_threads", "unlabel_message", "unlabel_thread"]);
  const thread = (await s.call("get_thread", { threadId: "thread-1" })).result;
  const [message] = thread.messages;
  assert.equal(message.sender, "news@example.test");
  assert.deepEqual(message.toRecipients, ["owner@example.test", "other@example.test"]);
  assert.deepEqual(message.labelIds, ["UNREAD", "INBOX", "Label_7"]);
  assert.equal(message.subject, "November update");
  assert.equal(message.date, "2025-11-05T00:00:00.000Z");
  // The placeholder text part is replaced by text converted from the HTML part.
  assert.match(message.plaintextBody, /NOVEMBER UPDATE|November update/);
  assert.match(message.plaintextBody, /26 new APIs/);
  assert.doesNotMatch(message.plaintextBody, /View this email|p\.png|<style/);
  assert.match(message.htmlBody, /<h1>November update<\/h1>/);
  assert.deepEqual(message.attachments, [{ id: "att-1", mimeType: "application/pdf", filename: "report.pdf" }]);
  assert.deepEqual(message.attachmentIds, ["att-1"]);
  assert.equal(JSON.stringify(thread).includes("Received"), false);
  const request = s.remote.apiCalls.find((call) => call.url.includes("/threads/thread-1"));
  assert.equal(new URL(request.url).searchParams.get("format"), "full");
  // MINIMAL and METADATA_ONLY use Gmail's metadata format and omit what the reference omits.
  const minimal = (await s.call("get_message", { messageId: "m-1", messageFormat: "MINIMAL" })).result;
  assert.deepEqual(Object.keys(minimal).sort(), ["ccRecipients", "date", "id", "labelIds", "sender", "snippet", "subject", "toRecipients"]);
  const metadata = (await s.call("get_message", { messageId: "m-1", messageFormat: "METADATA_ONLY" })).result;
  assert.deepEqual(Object.keys(metadata).sort(), ["ccRecipients", "date", "id", "labelIds", "sender", "toRecipients"]);
  assert.equal(new URL(s.remote.apiCalls.at(-1).url).searchParams.get("format"), "metadata");
});

test("Gmail bodies are bounded per message and per thread; attachment-backed text parts are fetched", async (t) => {
  const s = await fixture(t); await s.authorize();
  const big = (id) => ({ ...newsletter(id), payload: { mimeType: "text/plain", headers: headers({ From: "a@example.test" }), body: { data: b64("y".repeat(50_000)) } } });
  const stored = { ...newsletter("m-3"), payload: { mimeType: "text/plain", headers: headers({ From: "a@example.test" }), body: { attachmentId: "body-1", size: 90_000 } } };
  s.remote.route = (url) => {
    if (url.pathname.endsWith("/threads/long")) return { id: "long", messages: [big("old-1"), big("old-2"), big("old-3"), big("m-2"), stored] };
    if (url.pathname.endsWith("/attachments/body-1")) return { data: b64("stored text body") };
  };
  const { messages } = (await s.call("get_thread", { threadId: "long" })).result;
  assert.equal(messages[4].plaintextBody, "stored text body");
  assert.ok(/^y{30000}…\[truncated: 20000 more characters\]$/.test(messages[3].plaintextBody));
  assert.ok(/^y{30000}…/.test(messages[1].plaintextBody));
  // Over the thread budget, the oldest message keeps metadata only and points to get_message.
  assert.ok(messages[0].plaintextBody === "…[body omitted: thread too long; read it with get_message old-1]", messages[0].plaintextBody.slice(0, 80));
  assert.equal(messages[0].sender, "a@example.test");
});

test("Gmail search composes the reference defaults and returns minimal messages only", async (t) => {
  const s = await fixture(t); await s.authorize();
  s.remote.route = (url) => {
    if (url.pathname.endsWith("/users/me/threads")) return { threads: [{ id: "thread-1" }], nextPageToken: "next", resultSizeEstimate: 501 };
    if (url.pathname.endsWith("/threads/thread-1")) return { id: "thread-1", messages: [newsletter("m-1")] };
  };
  const result = (await s.call("search_threads", { query: "is:unread", includeTrash: true })).result;
  const list = new URL(s.remote.apiCalls.find((call) => new URL(call.url).pathname.endsWith("/users/me/threads")).url);
  assert.equal(list.searchParams.get("q"), "is:unread -in:draft -in:spam");
  assert.equal(list.searchParams.get("maxResults"), "20");
  assert.equal(list.searchParams.get("includeSpamTrash"), "true");
  assert.equal(result.nextPageToken, "next"); assert.equal(result.resultCountEstimate, "501");
  assert.equal(result.threads[0].messages[0].plaintextBody, undefined);
  assert.equal(result.threads[0].messages[0].subject, "November update");
  assert.equal((await s.call("search_threads", { pageSize: 51 })).error, "invalid_arguments");
});

test("Gmail label and draft writes need approval; trash/spam labels and attachments are refused before any call", async (t) => {
  const s = await fixture(t); await s.authorize();
  s.remote.route = (url) => { if (url.pathname.endsWith("/messages/m-1")) return { ...newsletter("m-1"), payload: { ...newsletter("m-1").payload,
    headers: headers({ From: "news@example.test", Subject: "Hi", Date: "Wed, 05 Nov 2025", "Message-ID": "<orig@example.test>", References: "<root@example.test>" }) } }; };
  const before = s.remote.apiCalls.length;
  for (const [name, args] of [["label_thread", { threadId: "t", labelIds: ["TRASH"] }], ["label_message", { messageId: "m", labelIds: ["SPAM"] }],
    ["create_draft", { to: ["a@example.test"], attachments: [{ filename: "a.txt", content: "eA" }] }], ["create_draft", { to: ["Name a@example.test"] }]])
    assert.equal((await s.call(name, args)).error, "invalid_arguments", name);
  assert.equal(s.remote.apiCalls.length, before);
  const removal = await s.call("unlabel_thread", { threadId: "t", labelIds: ["TRASH"] });
  assert.equal(removal.status, "approval_required");
  await s.approve(removal);
  assert.deepEqual(JSON.parse(s.remote.apiCalls.at(-1).body), { removeLabelIds: ["TRASH"] });
  const draft = await s.call("create_draft", { to: ["reader@example.test"], bcc: ["hidden@example.test"], subject: "Re: Hi", body: "Thanks", htmlBody: "<p>Thanks</p>", replyToMessageId: "m-1" });
  assert.equal(draft.status, "approval_required");
  assert.deepEqual((await s.approve(draft)).result, { id: "created-id" });
  const sent = JSON.parse(s.remote.apiCalls.at(-1).body), mime = Buffer.from(sent.message.raw, "base64url").toString();
  assert.equal(sent.message.threadId, "thread-1");
  assert.match(mime, /In-Reply-To: <orig@example.test>/); assert.match(mime, /References: <root@example.test> <orig@example.test>/);
  assert.match(mime, /Bcc: hidden@example.test/); assert.match(mime, /multipart\/alternative/);
  const text = mime.split("Content-Type: text/plain")[1].split("\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, "");
  assert.match(Buffer.from(text, "base64").toString(), /^Thanks\n\nOn Wed, 05 Nov 2025, news@example.test wrote:\n> /);
});

/** A stand-in for the official gws binary: Discovery answers for a few methods, and a record of every run. */
function fakeGws() {
  const runs = [];
  const methods = {
    "gmail.users.messages.list": ["GET", ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify"]],
    "gmail.users.messages.get": ["GET", ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify"]],
    "gmail.users.messages.send": ["POST", ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.modify"]],
    "gmail.users.drafts.create": ["POST", ["https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/gmail.modify"]],
  };
  const runner = async (args, env) => {
    runs.push({ args, token: env.GOOGLE_WORKSPACE_CLI_TOKEN, home: env.HOME });
    if (args[0] === "schema") {
      const found = methods[args[1]];
      return found ? { code: 0, stdout: JSON.stringify({ httpMethod: found[0], scopes: found[1] }), stderr: "" } : { code: 3, stdout: "", stderr: "unknown method" };
    }
    if (args.includes("--help")) return { code: 0, stdout: "  +triage  [Helper] Show unread inbox summary", stderr: "" };
    if (args[1] === "+read") return { code: 0, stdout: "x".repeat(70_000), stderr: "" };
    return { code: 0, stdout: `ran ${args.join(" ")}`, stderr: "" };
  };
  return { runs, runner };
}

test("gws commands run with the access token only after credential-free classification; writes need approval", async (t) => {
  const gws = fakeGws();
  const s = await fixture(t, "gmail", { options: { gwsRunner: gws.runner } });
  await s.authorize();
  const tools = (await s.connector.discover({ connection: s.connection, credentials: s.credentials, signal: signal() })).map((tool) => [tool.name, tool.risk]);
  assert.deepEqual(tools.slice(0, 2), [["gws_read", "read"], ["gws_write", "write"]]);
  const triage = await s.call("gws_read", { args: ["gmail", "+triage", "--max", "5"] });
  assert.equal(triage.status, "completed"); assert.equal(triage.result.output, "ran gmail +triage --max 5");
  assert.deepEqual(gws.runs.map((run) => [run.args[0], run.token]), [["schema", undefined], ["gmail", "private-access"]]);
  assert.deepEqual(gws.runs[0].args, ["schema", "gmail.users.messages.list"]);
  // Every call gets its own empty configuration directory.
  assert.notEqual(gws.runs[0].home, gws.runs[1].home);
  // Help and schema need no credentials.
  gws.runs.length = 0;
  assert.equal((await s.call("gws_read", { args: ["gmail", "--help"] })).status, "completed");
  assert.equal((await s.call("gws_read", { args: ["schema", "gmail.users.messages.send"] })).status, "completed");
  assert.ok(gws.runs.every((run) => run.token === undefined));
  // A write is pointed to gws_write without running; gws_write waits for the owner.
  gws.runs.length = 0;
  const send = ["gmail", "+send", "--to", "reader@example.test", "--subject", "It's done", "--body", "hello"];
  assert.equal((await s.call("gws_read", { args: send })).error, "gws_command_requires_write_tool");
  assert.ok(gws.runs.every((run) => run.args[0] === "schema"));
  const pending = await s.call("gws_write", { args: send });
  assert.equal(pending.status, "approval_required");
  const operation = await s.service.operation(pending.operationId);
  assert.match(operation.summary, /gws gmail \+send --to reader@example.test --subject 'It'\\''s done' --body hello/);
  assert.ok(!gws.runs.some((run) => run.token));
  const done = await s.approve(pending);
  assert.equal(done.status, "completed"); assert.equal(gws.runs.at(-1).token, "private-access");
  assert.equal(gws.runs.at(-1).args[1], "+send");
  // Large output is cut with guidance.
  const read = await s.call("gws_read", { args: ["gmail", "+read", "--id", "m-1"] });
  assert.match(read.result.output, /…\[truncated: 10000 more characters; narrow the request/);
});

test("gws refuses other services, local files, streams and unknown helpers, and writes the granted scopes cannot do", async (t) => {
  const gws = fakeGws();
  const s = await fixture(t, "gmail", { options: { gwsRunner: gws.runner }, settings: { scopes: ["https://www.googleapis.com/auth/gmail.readonly"] } });
  await s.authorize();
  for (const [args, error] of [
    [["drive", "files", "list"], "gws_service_not_connected"],
    [["schema", "drive.files.list"], "gws_command_not_allowed"],
    [["gmail", "+watch"], "gws_command_not_allowed"],
    [["gmail", "+mystery"], "gws_command_not_allowed"],
    [["gmail", "+send", "--to", "a@example.test", "--subject", "s", "--body", "b", "-a", "/etc/passwd"], "gws_flag_not_allowed"],
    [["gmail", "users", "messages", "get", "--params", "{}", "--output=/tmp/x"], "gws_flag_not_allowed"],
    [["gmail", "users", "messages", "nosuch"], "gws_method_unknown"],
    // Read-only consent: a send is refused before any approval card exists.
    [["gmail", "+send", "--to", "a@example.test", "--subject", "s", "--body", "b"], "google_scope_not_granted"],
  ]) assert.equal((await s.call("gws_read", { args })).error, error, args.join(" "));
  assert.ok(gws.runs.every((run) => run.token === undefined));
  // A dry run only prints the request, so it is a read even for a sending helper.
  assert.equal((await s.call("gws_read", { args: ["gmail", "+send", "--to", "a@example.test", "--subject", "s", "--body", "b", "--dry-run"] })).error, "google_scope_not_granted");
  assert.equal((await s.call("gws_read", { args: ["gmail", "users", "messages", "list", "--params", "{\"maxResults\":3}"] })).status, "completed");
});

test("without a gws binary the Google tools are unchanged", async (t) => {
  const s = await fixture(t); await s.authorize();
  const names = (await s.connector.discover({ connection: s.connection, credentials: s.credentials, signal: signal() })).map((tool) => tool.name);
  assert.ok(!names.includes("gws_read") && names.includes("get_thread"));
});
