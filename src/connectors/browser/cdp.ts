import { ConnectorError } from "../../connector.js";
import { allowedUrl, cdpEndpoint, safeName, type BrowserRunAccount } from "./runtime.js";

/**
 * A minimal Chrome DevTools Protocol client on the same Browser Run session that agent-browser drives.
 *
 * It exists for what agent-browser cannot do against a remote browser, not for compatibility:
 * - Navigation guard: every document request in the browser (typed URLs, clicks, `--new-tab`, form posts, redirects)
 *   is paused and refused when it targets a private, loopback, link-local or non-http(s) address.
 * - Downloads: Browser Run saves downloads on its own machine and blocks reading them back, so agent-browser's
 *   `download` cannot deliver the file. The guard captures the response body (links, cross-origin links, form posts)
 *   or the blob/data URL a script created, and cancels the remote download.
 * - Structured handoff: Cloudflare's `Cloudflare.handoff` banner (instructions, Done, Failed) and its state.
 * Uses Node's built-in WebSocket; the bearer token travels only in the connection's Authorization header.
 */
export interface Download { name: string; mediaType: string; size: number; contentBase64: string }
export interface HandoffState { active: boolean; handoffId?: string; success?: boolean; reason?: string }
export interface BrowserGuard {
  readonly closed: boolean;
  /** Runs `trigger` (an agent-browser click) and returns the first download it starts. */
  captureDownload(targetId: string, trigger: () => Promise<void>, options: { maxBytes: number; timeoutMs: number }): Promise<Download>;
  handoff(targetId: string, instructions: string, timeoutMs: number): Promise<string>;
  /** Cloudflare's state for the tab, with the Done/Failed outcome when its completion event was seen. */
  handoffState(targetId: string, handoffId: string): Promise<HandoffState>;
  close(): void;
}
export type GuardFactory = (account: BrowserRunAccount, sessionId: string, signal: AbortSignal) => Promise<BrowserGuard>;

interface Message { id?: number; method?: string; params?: any; result?: any; error?: { message?: string }; sessionId?: string }
type Handler = (params: any, sessionId?: string) => void;

/** The part of WebSocket this client uses; tests supply a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
}

class Cdp {
  #id = 0;
  readonly #pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  readonly #handlers = new Map<string, Set<Handler>>();
  closed = false;
  constructor(private readonly socket: SocketLike) {
    socket.addEventListener("message", (event) => {
      let message: Message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) pending?.reject(new Error(`cdp_${message.error.message ?? "error"}`)); else pending?.resolve(message.result ?? {});
        return;
      }
      for (const handler of this.#handlers.get(message.method ?? "") ?? []) handler(message.params ?? {}, message.sessionId);
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.#pending.values()) pending.reject(new Error("cdp_closed"));
      this.#pending.clear();
    });
  }
  static socket(url: string, token: string, signal: AbortSignal): Promise<SocketLike> {
    return new Promise((resolve, reject) => {
      // Node's WebSocket (undici) accepts request headers; browsers' does not, which is fine for a server.
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[]);
      const timer = setTimeout(() => { socket.close(); reject(new ConnectorError("browser_run_unavailable", { reason: "cdp_timeout" })); }, 30_000);
      const abort = () => { clearTimeout(timer); socket.close(); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(socket); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new ConnectorError("browser_run_unavailable", { reason: "cdp_connect_failed" })); }, { once: true });
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error("cdp_closed"));
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method: string, handler: Handler) {
    const set = this.#handlers.get(method) ?? new Set();
    set.add(handler); this.#handlers.set(method, set);
    return () => set.delete(handler);
  }
  close() { this.closed = true; this.socket.close(); }
}

const allowed = (url: string) => { try { allowedUrl(url); return true; } catch { return false; } };
const DOCUMENT_REQUESTS = [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }];
const DOCUMENT_RESPONSES = [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }];
/** Kept by the page hook so a script-created download is readable even after the page revokes its blob URL. */
const BLOBS = "agent-connectors.blobs";
const BLOB_HOOK = `(() => {
  const key = Symbol.for(${JSON.stringify(BLOBS)});
  if (globalThis[key]) return true;
  const kept = new Map(), create = URL.createObjectURL;
  globalThis[key] = kept;
  URL.createObjectURL = function (object) {
    const url = create.apply(this, arguments);
    if (object instanceof Blob && object.size <= 10485760) { kept.set(url, object); if (kept.size > 20) kept.delete(kept.keys().next().value); }
    return url;
  };
  return true;
})()`;
const blobReader = (url: string, max: number) => `(async () => {
  const kept = globalThis[Symbol.for(${JSON.stringify(BLOBS)})];
  let blob = kept && kept.get(${JSON.stringify(url)});
  if (!blob) { try { blob = await (await fetch(${JSON.stringify(url)})).blob(); } catch { return { error: "blob_unavailable" }; } }
  if (blob.size > ${max}) return { error: "too_large" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return { type: blob.type, base64: btoa(binary) };
})()`;

const header = (headers: Array<{ name: string; value: string }> | undefined, name: string) =>
  headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
const fileName = (disposition: string, url: string) => {
  const named = /filename\*=(?:UTF-8'')?([^;]+)|filename="?([^";]+)"?/i.exec(disposition);
  let name = (named?.[1] ?? named?.[2] ?? new URL(url).pathname.split("/").pop() ?? "").trim();
  try { name = decodeURIComponent(name); } catch { /* keep the raw name */ }
  return safeName(name);
};

class Guard implements BrowserGuard {
  #capture?: { maxBytes: number; resolve(download: Download): void; reject(error: Error): void };
  readonly #pages = new Map<string, string>();
  readonly #completed = new Map<string, { success: boolean; reason?: string }>();
  constructor(private readonly cdp: Cdp) {
    cdp.on("Fetch.requestPaused", (event) => { void this.#paused(event).catch(() => undefined); });
    cdp.on("Browser.downloadWillBegin", (event) => { void this.#download(event).catch((error) => this.#fail(error)); });
    cdp.on("Target.detachedFromTarget", (event) => { for (const [target, session] of this.#pages) if (session === event.sessionId) this.#pages.delete(target); });
    cdp.on("Cloudflare.handoffComplete", (event) => {
      if (typeof event.handoffId === "string") this.#completed.set(event.handoffId, { success: event.success === true, ...(typeof event.reason === "string" ? { reason: event.reason } : {}) });
    });
  }
  get closed() { return this.cdp.closed; }
  async start() { await this.cdp.send("Fetch.enable", { patterns: DOCUMENT_REQUESTS }); return this; }
  async #paused(event: any) {
    const { requestId, request } = event, response = event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
    if (!allowed(request.url)) { await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }); return; }
    const capture = this.#capture, status = Number(event.responseStatusCode ?? 0);
    if (response && capture) {
      if (status >= 300 && status < 400) {
        const location = header(event.responseHeaders, "location");
        if (location && !allowed(new URL(location, request.url).href)) { await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }); return; }
      }
      const type = header(event.responseHeaders, "content-type").split(";")[0]!.trim().toLowerCase();
      const disposition = header(event.responseHeaders, "content-disposition");
      // While a download is expected, a document that is an attachment or not a web page is the download.
      if (status >= 200 && status < 300 && (/^\s*attachment/i.test(disposition) || !["text/html", "application/xhtml+xml", ""].includes(type))) {
        this.#capture = undefined;
        try {
          if (Number(header(event.responseHeaders, "content-length") || 0) > capture.maxBytes) throw new ConnectorError("browser_download_too_large");
          const body = await this.cdp.send("Fetch.getResponseBody", { requestId });
          const bytes = Buffer.from(body.body ?? "", body.base64Encoded ? "base64" : "utf8");
          if (bytes.length > capture.maxBytes) throw new ConnectorError("browser_download_too_large");
          capture.resolve({ name: fileName(disposition, request.url), mediaType: type || "application/octet-stream", size: bytes.length, contentBase64: bytes.toString("base64") });
        } catch (error) { capture.reject(error as Error); }
        // The page stays where it was; nothing is saved on the remote machine.
        await this.cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 204, body: "" });
        return;
      }
    }
    await this.cdp.send("Fetch.continueRequest", { requestId });
  }
  /** Downloads that are not a document response: blob: and data: URLs a script created, or links Chrome downloads directly. */
  async #download(event: any) {
    const capture = this.#capture;
    await this.cdp.send("Browser.cancelDownload", { guid: event.guid }).catch(() => undefined);
    if (!capture) return;
    this.#capture = undefined;
    const url = String(event.url ?? ""), name = safeName(String(event.suggestedFilename ?? "download"));
    let bytes: Buffer, type = "";
    if (url.startsWith("data:")) {
      const match = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url);
      if (!match) throw new ConnectorError("browser_download_failed", { reason: "data_url_invalid" });
      type = match[1]!.split(";")[0]!;
      bytes = match[2] ? Buffer.from(match[3]!, "base64") : Buffer.from(decodeURIComponent(match[3]!), "utf8");
    } else if (url.startsWith("blob:")) {
      const session = await this.#page(String(event.frameId));
      const read = await this.cdp.send("Runtime.evaluate", { expression: blobReader(url, capture.maxBytes), awaitPromise: true, returnByValue: true }, session);
      const value = read?.result?.value;
      if (!value || value.error || typeof value.base64 !== "string") throw new ConnectorError(value?.error === "too_large" ? "browser_download_too_large" : "browser_download_failed", { reason: value?.error ?? "blob_unavailable" });
      bytes = Buffer.from(value.base64, "base64"); type = String(value.type ?? "");
    } else {
      // An http(s) download that did not pass as a document response: fetch it again in a separate tab with capture on.
      if (!allowed(url)) throw new ConnectorError("browser_url_not_allowed");
      const again = new Promise<Download>((resolve, reject) => { this.#capture = { maxBytes: capture.maxBytes, resolve, reject }; });
      const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
      try {
        await this.cdp.send("Page.navigate", { url }, await this.#page(targetId)).catch(() => undefined);
        capture.resolve({ ...(await Promise.race([again, new Promise<never>((_, reject) => setTimeout(() => reject(new ConnectorError("browser_download_failed", { reason: "timeout" })), 60_000))])), name });
      } finally { this.#capture = undefined; await this.cdp.send("Target.closeTarget", { targetId }).catch(() => undefined); }
      return;
    }
    if (bytes.length > capture.maxBytes) throw new ConnectorError("browser_download_too_large");
    capture.resolve({ name, mediaType: type || "application/octet-stream", size: bytes.length, contentBase64: bytes.toString("base64") });
  }
  #fail(error: unknown) {
    const capture = this.#capture;
    this.#capture = undefined;
    capture?.reject(error instanceof Error ? error : new Error("browser_download_failed"));
  }
  async #page(targetId: string) {
    const existing = this.#pages.get(targetId);
    if (existing) return existing;
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    this.#pages.set(targetId, sessionId);
    return sessionId as string;
  }
  async captureDownload(targetId: string, trigger: () => Promise<void>, options: { maxBytes: number; timeoutMs: number }) {
    if (this.#capture) throw new ConnectorError("browser_download_in_progress");
    const captured = new Promise<Download>((resolve, reject) => { this.#capture = { maxBytes: options.maxBytes, resolve, reject }; });
    captured.catch(() => undefined);
    try {
      const page = await this.#page(targetId);
      await this.cdp.send("Runtime.evaluate", { expression: BLOB_HOOK, returnByValue: true }, page);
      await this.cdp.send("Fetch.enable", { patterns: [...DOCUMENT_REQUESTS, ...DOCUMENT_RESPONSES] });
      await this.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp", eventsEnabled: true });
      await trigger();
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([captured, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ConnectorError("browser_download_not_started")), options.timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    } finally {
      this.#capture = undefined;
      if (!this.cdp.closed) {
        await this.cdp.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => undefined);
        await this.cdp.send("Fetch.enable", { patterns: DOCUMENT_REQUESTS }).catch(() => undefined);
      }
    }
  }
  async handoff(targetId: string, instructions: string, timeoutMs: number) {
    const result = await this.cdp.send("Cloudflare.handoff", { instructions, timeout: timeoutMs }, await this.#page(targetId));
    if (typeof result?.handoffId !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(result.handoffId)) throw new Error("browser_handoff_unexpected_response");
    return result.handoffId as string;
  }
  async handoffState(targetId: string, handoffId: string): Promise<HandoffState> {
    const state = await this.cdp.send("Cloudflare.getHandoffState", {}, await this.#page(targetId));
    const current = typeof state?.handoffId === "string" ? state.handoffId : undefined;
    const active = state?.active === true && current === handoffId, completed = this.#completed.get(handoffId);
    return { active, ...(current ? { handoffId: current } : {}), ...(!active && completed ? completed : {}) };
  }
  close() { this.cdp.close(); }
}

/** A guard over an open socket to a Browser Run session's browser endpoint. */
export async function guardOver(socket: SocketLike): Promise<BrowserGuard> {
  const cdp = new Cdp(socket);
  try { return await new Guard(cdp).start(); } catch (error) { cdp.close(); throw error instanceof ConnectorError ? error : new ConnectorError("browser_run_unavailable", { reason: "cdp_setup_failed" }); }
}

export const connectGuard: GuardFactory = async (account, sessionId, signal) =>
  guardOver(await Cdp.socket(cdpEndpoint(account, sessionId), account.token, signal));
