import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { ConnectorError } from "../../connector.js";

const API = "https://api.cloudflare.com/client/v4";

export interface BrowserRunAccount { accountId: string; token: string }
export interface Cookie {
  name: string; value: string; domain: string; path: string; expires: number;
  httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None";
}
export interface PageState { url: string; title: string }
export interface PageElement { ref: string; role: string; name: string }
export interface Handoff { handoffId: string; liveViewUrl: string; expiresAt: string }
export interface HandoffState { active: boolean; handoffId?: string; success?: boolean; reason?: string }
export interface Download { name: string; mediaType: string; size: number; contentBase64: string; url: string }

/** One live remote browser tab. The connector speaks only to this interface, so tests can fake it. */
export interface BrowserSession {
  readonly id: string;
  open(url: string): Promise<PageState>;
  snapshot(maxChars: number): Promise<PageState & { text: string; elements: PageElement[] }>;
  click(ref: string): Promise<PageState>;
  type(ref: string, text: string, submit: boolean): Promise<PageState>;
  press(key: string): Promise<PageState>;
  screenshot(): Promise<{ mediaType: string; contentBase64: string }>;
  download(url: string, maxBytes: number): Promise<Download>;
  upload(ref: string, file: { name: string; mediaType: string; contentBase64: string }): Promise<PageState>;
  handoffStart(instructions: string, timeoutMs: number): Promise<Handoff>;
  handoffState(): Promise<HandoffState>;
  cookies(): Promise<Cookie[]>;
  close(): Promise<void>;
}
export interface BrowserRuntime {
  /** Reconnects to `sessionId` when it is still alive; otherwise starts a new browser with these cookies. */
  attach(account: BrowserRunAccount, sessionId: string | undefined, cookies: Cookie[], signal: AbortSignal): Promise<BrowserSession>;
}

const blocked = (url: string) => {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ConnectorError("browser_url_invalid"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new ConnectorError("browser_url_not_allowed");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  // The remote browser runs on Cloudflare; still refuse obvious private and metadata targets.
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^(::1?|f[cd]|fe80)/i.test(host))
    throw new ConnectorError("browser_url_not_allowed");
  return parsed.href;
};
export const allowedUrl = blocked;

async function request(account: BrowserRunAccount, method: string, path: string, signal: AbortSignal) {
  const response = await fetch(`${API}/accounts/${encodeURIComponent(account.accountId)}/browser-run${path}`, {
    method, redirect: "error", headers: { Authorization: `Bearer ${account.token}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  const text = await response.text();
  if (!response.ok) throw new ConnectorError(response.status === 401 || response.status === 403 ? "browser_run_unauthorized" : "browser_run_unavailable", { status: response.status });
  try { return JSON.parse(text) as Record<string, any>; } catch { throw new ConnectorError("browser_run_unavailable"); }
}

/** Cloudflare Browser Run over the official Playwright CDP client. */
export class CloudflareBrowserRun implements BrowserRuntime {
  constructor(private readonly keepAliveMs = 600_000) {}
  async attach(account: BrowserRunAccount, sessionId: string | undefined, cookies: Cookie[], signal: AbortSignal) {
    if (sessionId) {
      try { return await this.connect(account, sessionId, undefined); }
      catch (error) { if (signal.aborted) throw error; /* expired: start a fresh browser below */ }
    }
    const created = await request(account, "POST", `/devtools/browser?keep_alive=${this.keepAliveMs}`, signal);
    const id = (created.result ?? created).sessionId;
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new ConnectorError("browser_run_unavailable");
    return this.connect(account, id, cookies);
  }
  private async connect(account: BrowserRunAccount, id: string, cookies: Cookie[] | undefined) {
    const endpoint = `wss://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.accountId)}/browser-run/devtools/browser/${id}`;
    const browser = await chromium.connectOverCDP(endpoint, { headers: { Authorization: `Bearer ${account.token}` }, timeout: 30_000 });
    const context = browser.contexts()[0] ?? await browser.newContext();
    if (cookies?.length) await context.addCookies(cookies);
    const page = context.pages().find((p) => !p.isClosed()) ?? await context.newPage();
    return new RemoteSession(id, browser, context, page);
  }
}

class RemoteSession implements BrowserSession {
  private cdp?: CDPSession;
  constructor(readonly id: string, private readonly browser: Browser, private readonly context: BrowserContext, private page: Page) {}
  private state = async (): Promise<PageState> => ({ url: this.page.url(), title: (await this.page.title()).slice(0, 300) });
  private settle = async () => { await this.page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {}); await this.page.waitForTimeout(800); };
  private element(ref: string) {
    if (!/^(?:f\d{1,4})?e\d{1,6}$/.test(ref)) throw new ConnectorError("browser_ref_invalid");
    return this.page.locator(`aria-ref=${ref}`);
  }
  async open(url: string) {
    const response = await this.act(() => this.page.goto(blocked(url), { waitUntil: "domcontentloaded", timeout: 45_000 }));
    await this.page.waitForTimeout(1500);
    return { ...(await this.state()), status: response?.status() ?? 0 };
  }
  /** Playwright's AI accessibility snapshot: refs resolve through `aria-ref=` even after the page re-renders. */
  async snapshot(maxChars: number) {
    const tree = maxChars ? await this.act(() => this.page.ariaSnapshot({ mode: "ai", timeout: 20_000 })) : "";
    const elements: PageElement[] = [];
    for (const line of tree.split("\n")) {
      const match = /^\s*-\s*([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?[^\n]*?\[ref=((?:f\d{1,4})?e\d{1,6})\]/.exec(line);
      if (match && elements.length < 400) elements.push({ ref: match[3]!, role: match[1]!, name: (match[2] ?? "").slice(0, 120) });
    }
    return { ...(await this.state()), text: tree.slice(0, maxChars), elements };
  }
  /** A page-level timeout leaves the tab usable; report it instead of reconnecting the browser. */
  private async act<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (error instanceof Error && error.name === "TimeoutError") throw new ConnectorError("browser_action_timeout", { reason: error.message.split("\n")[0]!.slice(0, 200) });
      throw error;
    }
  }
  async click(ref: string) { await this.act(() => this.element(ref).click({ timeout: 10_000 })); await this.settle(); return this.state(); }
  async type(ref: string, text: string, submit: boolean) {
    const target = this.element(ref);
    // Overlays often intercept the pointer; focusing the field is what typing needs.
    await target.click({ timeout: 5_000 }).catch(() => this.act(() => target.focus({ timeout: 5_000 })));
    await target.fill("", { timeout: 5_000 }).catch(() => {});
    await this.act(() => target.pressSequentially(text, { delay: 60, timeout: 30_000 }));
    if (submit) await this.act(() => target.press("Enter", { timeout: 10_000 }));
    await this.settle();
    return this.state();
  }
  async press(key: string) { await this.act(() => this.page.keyboard.press(key)); await this.settle(); return this.state(); }
  async screenshot() {
    const bytes = await this.act(() => this.page.screenshot({ type: "png", timeout: 20_000 }));
    return { mediaType: "image/png", contentBase64: bytes.toString("base64") };
  }
  /**
   * Fetches in a separate tab of the same remote browser and captures the response with the
   * CDP Fetch domain: same cookies and egress as browsing, no page CORS rules, no local disk.
   */
  async download(url: string, maxBytes: number) {
    const target = blocked(url);
    const tab = await this.context.newPage();
    const cdp = await this.context.newCDPSession(tab) as CDPSession & { send(method: string, params?: object): Promise<any> };
    try {
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response", resourceType: "Document" }] });
      const captured = new Promise<Download>((resolveDownload, reject) => {
        const timer = setTimeout(() => reject(new ConnectorError("browser_download_failed", { reason: "timeout" })), 60_000);
        cdp.on("Fetch.requestPaused", async (event: any) => {
          try {
            const status = Number(event.responseStatusCode ?? 0);
            const headers = Object.fromEntries((event.responseHeaders ?? []).map((h: { name: string; value: string }) => [h.name.toLowerCase(), h.value]));
            if (status >= 300 && status < 400) {
              // Each redirect hop must stay a public http(s) URL.
              try { blocked(new URL(headers.location ?? "", event.request.url).href); }
              catch { await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }); throw new ConnectorError("browser_url_not_allowed"); }
              await cdp.send("Fetch.continueRequest", { requestId: event.requestId }); return;
            }
            if (status < 200 || status >= 300) throw new ConnectorError("browser_download_failed", { reason: `status_${status}` });
            if (Number(headers["content-length"] ?? "0") > maxBytes) throw new ConnectorError("browser_download_too_large");
            const body = await cdp.send("Fetch.getResponseBody", { requestId: event.requestId });
            const bytes = body.base64Encoded ? Buffer.from(body.body, "base64") : Buffer.from(body.body, "utf8");
            await cdp.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 204, body: "" }).catch(() => {});
            if (bytes.length > maxBytes) throw new ConnectorError("browser_download_too_large");
            const named = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(headers["content-disposition"] ?? "")?.[1];
            let name = named ?? new URL(event.request.url).pathname.split("/").pop() ?? "download";
            try { name = decodeURIComponent(name); } catch { /* keep the raw name */ }
            clearTimeout(timer);
            resolveDownload({ name: safeName(name), size: bytes.length, contentBase64: bytes.toString("base64"), url: event.request.url,
              mediaType: (headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim() });
          } catch (error) { clearTimeout(timer); reject(error); }
        });
      });
      void tab.goto(target, { timeout: 60_000 }).catch(() => {});
      return await captured;
    } finally {
      await cdp.detach().catch(() => {});
      await tab.close().catch(() => {});
    }
  }
  async upload(ref: string, file: { name: string; mediaType: string; contentBase64: string }) {
    const target = this.element(ref);
    const accepted = await target.evaluate((el, file) => {
      // The accessibility ref of a file control may be its button or label rather than the input.
      const isFile = (node: unknown): node is HTMLInputElement => node instanceof HTMLInputElement && node.type === "file";
      const all = Array.from(document.querySelectorAll("input[type=file]"));
      const candidates = [el, el.querySelector?.("input[type=file]"), (el.closest?.("label") as HTMLLabelElement | null)?.control,
        isFile(el.previousElementSibling) ? el.previousElementSibling : null, isFile(el.nextElementSibling) ? el.nextElementSibling : null,
        all.length === 1 ? all[0] : null];
      const input = candidates.find(isFile);
      if (!input) return false;
      el = input;
      if (!isFile(el)) return false;
      const bytes = Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], file.name, { type: file.mediaType }));
      el.files = transfer.files;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, file);
    if (!accepted) throw new ConnectorError("browser_upload_target_not_file_input");
    await this.settle();
    return this.state();
  }
  private async session() { return this.cdp ??= await this.context.newCDPSession(this.page); }
  async handoffStart(instructions: string, timeoutMs: number) {
    const cdp = await this.session() as CDPSession & { send(method: string, params?: object): Promise<any> };
    const expiresInMs = Math.min(Math.max(timeoutMs + 60_000, 60_000), 3_600_000);
    const view = await cdp.send("Cloudflare.getLiveView", { mode: "tab", expiresInMs });
    const handoff = await cdp.send("Cloudflare.handoff", { instructions, timeout: timeoutMs });
    if (typeof view?.devtoolsFrontendUrl !== "string" || typeof handoff?.handoffId !== "string") throw new Error("browser_handoff_unexpected_response");
    return { handoffId: handoff.handoffId, liveViewUrl: view.devtoolsFrontendUrl, expiresAt: new Date(Date.now() + timeoutMs).toISOString() };
  }
  async handoffState() {
    const cdp = await this.session() as CDPSession & { send(method: string, params?: object): Promise<any> };
    const state = await cdp.send("Cloudflare.getHandoffState", {});
    return { active: Boolean(state?.active), ...(typeof state?.handoffId === "string" ? { handoffId: state.handoffId } : {}) };
  }
  async cookies() { return (await this.context.cookies()) as Cookie[]; }
  /** Disconnects this client; the remote browser keeps running until its keep-alive ends. */
  async close() { await this.browser.close().catch(() => {}); }
}

export function safeName(name: string) {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").replace(/^\.+/, "_").trim().slice(0, 120);
  return cleaned || "download";
}
