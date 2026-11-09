import assert from "node:assert/strict";
import test from "node:test";
import { guardOver } from "../dist/connectors/browser/cdp.js";

/** Fake CDP socket: answers commands (optionally per method) and lets the test emit events. */
function fakeSocket(answers = {}) {
  const listeners = new Map(), sent = [];
  const emit = (type, event) => { for (const listener of listeners.get(type) ?? []) listener(event); };
  const socket = {
    send(data) {
      const message = JSON.parse(data); sent.push(message);
      const answer = answers[message.method];
      const result = typeof answer === "function" ? answer(message.params) : answer ?? {};
      queueMicrotask(() => emit("message", { data: JSON.stringify({ id: message.id, result }) }));
    },
    close() { emit("close", {}); },
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
  };
  const event = (method, params, sessionId) => emit("message", { data: JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { socket, sent, event, settle, methods: () => sent.map((m) => m.method) };
}
const paused = (url, extra = {}) => ({ requestId: `r-${url}`, request: { url, method: "GET" }, resourceType: "Document", ...extra });

test("every document request is checked: private, loopback, metadata and non-http targets are failed; others continue", async () => {
  const f = fakeSocket();
  const guard = await guardOver(f.socket);
  assert.deepEqual(f.sent[0], { id: 1, method: "Fetch.enable", params: { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] } });
  for (const url of ["http://169.254.169.254/latest", "http://127.0.0.1:8080/", "http://10.0.0.5/", "http://localhost/", "http://[::1]/", "ftp://example.com/", "https://u:p@example.com/"])
    f.event("Fetch.requestPaused", paused(url));
  // A redirect hop to a private address is paused as its own request and refused too.
  f.event("Fetch.requestPaused", paused("http://192.168.1.1/", { redirectedRequestId: "r0" }));
  f.event("Fetch.requestPaused", paused("https://example.com/next"));
  await f.settle();
  const decisions = f.sent.slice(1).map((m) => [m.method, m.params.requestId, m.params.errorReason]);
  assert.deepEqual(decisions.filter(([method]) => method === "Fetch.failRequest").length, 8);
  assert.ok(decisions.every(([method, id, reason]) => id === "r-https://example.com/next" ? method === "Fetch.continueRequest" : method === "Fetch.failRequest" && reason === "BlockedByClient"));
  guard.close();
  assert.equal(guard.closed, true);
});

test("a download is captured from the document response (links, cross-origin, form posts) and the page stays", async () => {
  const f = fakeSocket({ "Target.attachToTarget": { sessionId: "S1" }, "Fetch.getResponseBody": { body: Buffer.from("csv,data").toString("base64"), base64Encoded: true } });
  const guard = await guardOver(f.socket);
  const file = await guard.captureDownload("T1", async () => {
    // An ordinary page during the click continues untouched; the attachment is the download.
    f.event("Fetch.requestPaused", paused("https://example.com/page", { responseStatusCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }] }));
    f.event("Fetch.requestPaused", { ...paused("https://files.example.net/export", { responseStatusCode: 200, responseHeaders: [
      { name: "Content-Type", value: "text/csv; charset=utf-8" }, { name: "Content-Disposition", value: 'attachment; filename="report.csv"' }] }), request: { url: "https://files.example.net/export", method: "POST" } });
  }, { maxBytes: 1000, timeoutMs: 1000 });
  assert.deepEqual(file, { name: "report.csv", mediaType: "text/csv", size: 8, contentBase64: Buffer.from("csv,data").toString("base64") });
  await f.settle();
  const methods = f.methods();
  assert.deepEqual(methods.slice(1, 5), ["Target.attachToTarget", "Runtime.evaluate", "Fetch.enable", "Browser.setDownloadBehavior"]);
  assert.deepEqual(f.sent.find((m) => m.method === "Fetch.fulfillRequest").params, { requestId: "r-https://files.example.net/export", responseCode: 204, body: "" });
  assert.equal(f.sent.find((m) => m.method === "Fetch.continueRequest").params.requestId, "r-https://example.com/page");
  // Afterwards responses are no longer intercepted and downloads return to the browser default.
  assert.deepEqual(f.sent.filter((m) => m.method === "Browser.setDownloadBehavior").map((m) => m.params.behavior), ["allow", "default"]);
  assert.equal(f.sent.filter((m) => m.method === "Fetch.enable").at(-1).params.patterns.length, 1);
});

test("download redirects to private addresses, oversized files and no download at all are refused", async () => {
  const f = fakeSocket({ "Target.attachToTarget": { sessionId: "S1" } });
  const guard = await guardOver(f.socket);
  const redirect = guard.captureDownload("T1", async () => {
    f.event("Fetch.requestPaused", paused("https://example.com/dl", { responseStatusCode: 302, responseHeaders: [{ name: "Location", value: "http://169.254.169.254/x" }] }));
    f.event("Fetch.requestPaused", paused("https://example.com/big", { responseStatusCode: 200, responseHeaders: [{ name: "content-type", value: "application/zip" }, { name: "content-length", value: "5000" }] }));
  }, { maxBytes: 1000, timeoutMs: 1000 });
  await assert.rejects(redirect, { code: "browser_download_too_large" });
  await f.settle();
  assert.equal(f.sent.find((m) => m.method === "Fetch.failRequest").params.requestId, "r-https://example.com/dl");
  await assert.rejects(guard.captureDownload("T1", async () => {}, { maxBytes: 1000, timeoutMs: 50 }), { code: "browser_download_not_started" });
});

test("script-created downloads are read from the page's blob or decoded from data URLs; the remote download is cancelled", async () => {
  const f = fakeSocket({ "Target.attachToTarget": { sessionId: "S1" },
    "Runtime.evaluate": (params) => params.awaitPromise ? { result: { value: { type: "application/json", base64: Buffer.from("{}").toString("base64") } } } : { result: { value: true } } });
  const guard = await guardOver(f.socket);
  const blob = await guard.captureDownload("T1", async () => {
    f.event("Browser.downloadWillBegin", { frameId: "T1", guid: "g1", url: "blob:https://example.com/1234", suggestedFilename: "data.json" });
  }, { maxBytes: 1000, timeoutMs: 1000 });
  assert.deepEqual(blob, { name: "data.json", mediaType: "application/json", size: 2, contentBase64: Buffer.from("{}").toString("base64") });
  assert.match(f.sent.find((m) => m.method === "Runtime.evaluate" && !m.params.awaitPromise).params.expression, /URL\.createObjectURL = function/, "the hook keeps blobs a page revokes right away");
  assert.ok(f.sent.find((m) => m.method === "Runtime.evaluate" && m.params.awaitPromise).params.expression.includes("blob:https://example.com/1234"));
  assert.deepEqual(f.sent.find((m) => m.method === "Browser.cancelDownload").params, { guid: "g1" });
  const data = await guard.captureDownload("T1", async () => {
    f.event("Browser.downloadWillBegin", { frameId: "T1", guid: "g2", url: "data:text/plain;base64,aGk=", suggestedFilename: "hi.txt" });
  }, { maxBytes: 1000, timeoutMs: 1000 });
  assert.deepEqual(data, { name: "hi.txt", mediaType: "text/plain", size: 2, contentBase64: "aGk=" });
});

test("structured handoff: banner on the tab, Done reported from Cloudflare's completion event", async () => {
  let active = true;
  const f = fakeSocket({ "Target.attachToTarget": { sessionId: "S1" }, "Cloudflare.handoff": { handoffId: "h-9", targetId: "T1" },
    "Cloudflare.getHandoffState": () => active ? { targetId: "T1", active: true, handoffId: "h-9" } : { targetId: "T1", active: false } });
  const guard = await guardOver(f.socket);
  assert.equal(await guard.handoff("T1", "Please sign in", 60_000), "h-9");
  const sent = f.sent.find((m) => m.method === "Cloudflare.handoff");
  assert.deepEqual([sent.params, sent.sessionId], [{ instructions: "Please sign in", timeout: 60_000 }, "S1"]);
  assert.deepEqual(await guard.handoffState("T1", "h-9"), { active: true, handoffId: "h-9" });
  assert.deepEqual(await guard.handoffState("T1", "other"), { active: false, handoffId: "h-9" }, "another handoff on the tab is not this one");
  active = false;
  f.event("Cloudflare.handoffComplete", { handoffId: "h-9", success: true }, "S1");
  assert.deepEqual(await guard.handoffState("T1", "h-9"), { active: false, success: true });
});
