import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConnectorError, ConnectorService, Sealer, Store, browserConnector } from "../dist/index.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const alice = { agentId: "agent-a", owner: "@alice", connections: ["web"], tokenId: "t" };

/** Fake remote browser: a page with one file input, recording every action. */
function fakeRuntime() {
  const log = [];
  let url = "about:blank", cookies = [], attaches = 0;
  const session = (id) => ({
    id,
    open: async (target) => { log.push(["open", target]); url = target; return { url, title: "Page", status: 200 }; },
    snapshot: async () => ({ url, title: "Page", text: "hello", elements: [{ ref: "e1", role: "input:file", name: "Upload" }] }),
    click: async (ref) => { log.push(["click", ref]); return { url, title: "Page" }; },
    type: async (ref, text, submit) => { log.push(["type", ref, text, submit]); cookies = [{ name: "sid", value: "s", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }]; return { url, title: "Page" }; },
    press: async (key) => { log.push(["press", key]); return { url, title: "Page" }; },
    screenshot: async () => ({ mediaType: "image/png", contentBase64: "iVBORw0KGgo=" }),
    download: async (target, max) => { log.push(["download", target, max]); return { name: "a.pdf", mediaType: "application/pdf", size: 3, contentBase64: "YWJj", url: target }; },
    upload: async (ref, file) => { log.push(["upload", ref, file.name]); return { url, title: "Uploaded" }; },
    handoffStart: async (instructions, ms) => { log.push(["handoff", instructions, ms]); return { handoffId: "h1", liveViewUrl: "https://live.browser.run/ui/view?jwt=secret", expiresAt: new Date(Date.now() + ms).toISOString() }; },
    handoffState: async () => ({ active: false }),
    cookies: async () => cookies,
    close: async () => { log.push(["close"]); },
  });
  return { log, get attaches() { return attaches; }, runtime: { attach: async (account, sessionId, restored) => {
    attaches++; log.push(["attach", account.accountId, account.token, sessionId ?? null, restored.length]);
    if (restored.length) cookies = restored;
    return session(sessionId ?? `s${attaches}`);
  } } };
}

function setup({ tokenMode = 0o600, token = "cf_token_0123456789abcdefghij" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-connectors-browser-"));
  writeFileSync(join(directory, "cf-token"), token); chmodSync(join(directory, "cf-token"), tokenMode);
  const fake = fakeRuntime();
  const store = new Store(join(directory, "state"));
  const connections = [{ id: "web", kind: "browser", owner: "@alice", settings: { accountId: ACCOUNT, tokenFile: "cf-token" } }];
  const service = new ConnectorService({ connectors: [browserConnector({ baseDirectory: directory, runtime: fake.runtime })], connections, store, sealer: new Sealer(Buffer.alloc(32, 7)) });
  return { ...fake, service, store, cleanup: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const call = (service, tool, input, caller = alice) => service.call(caller, `web__${tool}`, input, new AbortController().signal);

test("reads run directly and persist cookies sealed in the connection credential", async (t) => {
  const s = setup(); t.after(s.cleanup);
  assert.equal((await call(s.service, "open", { url: "https://example.com/search?q=hotel" })).status, "completed");
  assert.equal((await call(s.service, "type", { ref: "e1", text: "Seoul", submit: true })).status, "completed");
  const snap = await call(s.service, "snapshot", {});
  assert.equal(snap.result.elements[0].ref, "e1");
  assert.equal(s.log.filter((e) => e[0] === "attach").length, 1, "one browser per connection is reused across calls");
  assert.deepEqual(s.log.find((e) => e[0] === "attach"), ["attach", ACCOUNT, "cf_token_0123456789abcdefghij", null, 0]);
  const raw = s.store.credential("web");
  assert.ok(raw && !raw.toString().includes("sid"), "cookies are stored sealed, never in plaintext");
});

test("cookies are restored into a fresh browser after close", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await call(s.service, "type", { ref: "e1", text: "x", submit: false });
  assert.equal((await call(s.service, "close", {})).status, "completed");
  await call(s.service, "snapshot", {});
  const attaches = s.log.filter((e) => e[0] === "attach");
  assert.equal(attaches.length, 2);
  assert.equal(attaches[1][3], "s1", "reconnects to the saved session id");
  assert.equal(attaches[1][4], 1, "and supplies the saved cookies");
});

test("private, local and non-http URLs are refused before reaching the browser", async (t) => {
  const s = setup(); t.after(s.cleanup);
  for (const url of ["http://127.0.0.1:8080/", "http://localhost/", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "file:///etc/passwd", "chrome://version", "https://user:pw@example.com/", "http://[::1]/"]) {
    const result = await call(s.service, "open", { url });
    assert.equal(result.status, "failed", url);
    assert.equal(result.error, "browser_url_not_allowed", url);
  }
  assert.equal((await call(s.service, "download", { url: "http://192.168.1.1/x" })).error, "browser_url_not_allowed");
  assert.ok(!s.log.some((e) => ["open", "download", "attach"].includes(e[0])), "a refused URL never starts a browser");
  assert.equal((await call(s.service, "click", { ref: "#submit" })).error, "invalid_arguments");
});

test("upload needs an owner grant, shows the file and site, and only then runs", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await call(s.service, "open", { url: "https://upload.example.com/form" });
  const pending = await call(s.service, "upload", { site: "https://upload.example.com", ref: "e1", file: { name: "a.pdf", mediaType: "application/pdf", contentBase64: "YWJj" } });
  assert.equal(pending.status, "approval_required");
  assert.match(pending.summary, /上传 a\.pdf（1 KB）到 upload\.example\.com/);
  assert.ok(!s.log.some((e) => e[0] === "upload"), "nothing is uploaded before approval");
  const tools = s.service.tools(alice).map((tool) => tool.name);
  assert.ok(tools.includes("web__upload") && tools.includes("web__open"));
  assert.ok(!s.service.tools({ ...alice, readOnly: true }).some((tool) => tool.name === "web__upload"), "read-only callers never see upload");
  const view = await s.service.operation(pending.operationId);
  const grant = { tokenId: "g1", owner: "@alice", operationId: pending.operationId, digest: view.digest, expiresAt: new Date(Date.now() + 60_000) };
  await assert.rejects(s.service.approve({ ...grant, owner: "@bob" }, new AbortController().signal), /grant_does_not_match_operation/);
  assert.ok(!s.log.some((e) => e[0] === "upload"), "a grant for another owner uploads nothing");
  const done = await s.service.approve(grant, new AbortController().signal);
  assert.equal(done.status, "completed");
  assert.deepEqual(s.log.filter((e) => e[0] === "upload"), [["upload", "e1", "a.pdf"]]);
  await assert.rejects(s.service.approve({ ...grant, tokenId: "g2" }, new AbortController().signal), /operation_completed/);
  assert.equal(s.log.filter((e) => e[0] === "upload").length, 1, "an approval runs the upload exactly once");
});

test("upload refuses a site that is not the current page and rejects non-origin sites", async (t) => {
  const s = setup(); t.after(s.cleanup);
  await call(s.service, "open", { url: "https://other.example.net/" });
  const tool = (await import("../dist/index.js")).browserConnector({ runtime: s.runtime, baseDirectory: "/nonexistent" }).tools.find((x) => x.name === "upload");
  assert.equal(tool.input.safeParse({ site: "https://upload.example.com/path", ref: "e1", file: { name: "a", mediaType: "text/plain", contentBase64: "YQ==" } }).success, false);
  assert.equal(tool.input.safeParse({ site: "http://upload.example.com", ref: "e1", file: { name: "a", mediaType: "text/plain", contentBase64: "YQ==" } }).success, false);
  assert.equal(tool.input.safeParse({ site: "https://upload.example.com", ref: "e1", file: { name: "../a", mediaType: "text/plain", contentBase64: "YQ==" } }).success, false);
  // Executing directly (as the service does after approval) refuses a mismatched page.
  const context = { connection: { id: "web", kind: "browser", owner: "@alice", settings: { accountId: ACCOUNT, tokenFile: "x" } },
    credentials: { get: () => ({ version: 1, cookies: [], sessionId: "s1" }), put: () => {} }, signal: new AbortController().signal };
  const live = browserConnector({ runtime: { attach: async () => ({ ...(await s.runtime.attach({ accountId: ACCOUNT, token: "t" }, "s1", [])),
    snapshot: async () => ({ url: "https://other.example.net/", title: "x", text: "", elements: [] }) }) } });
  await assert.rejects(live.tools.find((x) => x.name === "upload").execute(context, { site: "https://upload.example.com", ref: "e1", file: { name: "a", mediaType: "text/plain", contentBase64: "YQ==" } }),
    (error) => error instanceof ConnectorError && ["browser_upload_site_mismatch", "browser_token_file_missing"].includes(error.code));
});

test("handoff returns the live view URL and tracks completion by id", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const started = await call(s.service, "handoff_start", { instructions: "Please log in", timeoutSeconds: 120 });
  assert.equal(started.status, "completed");
  assert.equal(started.result.handoffId, "h1");
  assert.match(started.result.liveViewUrl, /^https:\/\/live\.browser\.run\//);
  const done = await call(s.service, "handoff_status", { handoffId: "h1" });
  assert.equal(done.result.done, true);
  assert.equal((await call(s.service, "handoff_status", { handoffId: "other" })).error, "browser_handoff_not_found");
});

test("token file must be private and well formed", async (t) => {
  const open = setup({ tokenMode: 0o644 }); t.after(open.cleanup);
  assert.equal((await call(open.service, "snapshot", {})).error, "browser_token_file_must_be_private");
  assert.equal(open.log.filter((e) => e[0] === "attach").length, 0);
  const bad = setup({ token: "has space in it 0123456789" }); t.after(bad.cleanup);
  assert.equal((await call(bad.service, "snapshot", {})).error, "browser_token_file_invalid");
});

test("download is bounded and returns base64 for the composer to store", async (t) => {
  const s = setup(); t.after(s.cleanup);
  const result = await call(s.service, "download", { url: "https://example.com/a.pdf" });
  assert.equal(result.result.contentBase64, "YWJj");
  assert.deepEqual(s.log.find((e) => e[0] === "download"), ["download", "https://example.com/a.pdf", 10_000_000]);
});
