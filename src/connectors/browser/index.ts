import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Json } from "../../canonical.js";
import { ConnectorError, type ConnectionConfig, type Connector, type ToolContext, type ToolDefinition } from "../../connector.js";
import { CloudflareBrowserRun, allowedUrl, type BrowserRuntime, type BrowserSession, type Cookie } from "./runtime.js";

export { CloudflareBrowserRun, type BrowserRuntime, type BrowserSession } from "./runtime.js";

const MAX_DOWNLOAD_BYTES = 10_000_000;
const MAX_UPLOAD_BASE64 = 14_000_000;
const MAX_HANDOFF_MS = 1_800_000;
const settings = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/), tokenFile: z.string().min(1) }).strict();
const cookie = z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(),
  httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]) }).strip();
const state = z.object({ version: z.literal(1), sessionId: z.string().optional(), cookies: z.array(cookie).max(3000).default([]),
  handoff: z.object({ handoffId: z.string(), expiresAt: z.string() }).optional() }).strict();
type State = z.infer<typeof state>;
const ref = z.string().regex(/^(?:f\d{1,4})?e\d{1,6}$/);
const site = z.string().url().refine((value) => { const u = new URL(value); return u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash && !u.username; },
  "site must be an https origin such as https://example.com");

export interface BrowserOptions {
  baseDirectory?: string;
  /** Dependency injection for tests; production uses Cloudflare Browser Run. */
  runtime?: BrowserRuntime;
}

/**
 * A remote browser on Cloudflare Browser Run, outside the Agent's sandbox. Cookies are the
 * connection's credential and stay sealed here. Following the agreed product rule, navigation,
 * clicks and typing run directly; sending a workspace file to a site is a write needing approval.
 */
export function browserConnector(options: BrowserOptions = {}): Connector {
  const runtime = options.runtime ?? new CloudflareBrowserRun();
  const queues = new Map<string, Promise<unknown>>();
  const live = new Map<string, BrowserSession>();
  const account = (connection: ConnectionConfig) => {
    const parsed = settings.safeParse(connection.settings ?? {});
    if (!parsed.success) throw new ConnectorError("browser_settings_invalid");
    const file = resolve(options.baseDirectory ?? ".", parsed.data.tokenFile);
    try {
      if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) throw new ConnectorError("browser_token_file_must_be_private");
      const token = readFileSync(file, "utf8").trim();
      if (!/^[\x21-\x7e]{20,4000}$/.test(token)) throw new ConnectorError("browser_token_file_invalid");
      return { accountId: parsed.data.accountId, token };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("browser_token_file_missing");
    }
  };
  const load = async (context: ToolContext): Promise<State> => {
    const stored = await context.credentials.get();
    const parsed = state.safeParse(stored ?? { version: 1 });
    return parsed.success ? parsed.data : { version: 1, cookies: [] };
  };
  const save = (context: ToolContext, value: State) => context.credentials.put(value as unknown as Json);
  /** One queue per connection: one tab, ordered actions, consistent cookie persistence. */
  const locked = <T>(context: ToolContext, work: (session: BrowserSession, value: State) => Promise<T>): Promise<T> => {
    const id = context.connection.id;
    const run = (queues.get(id) ?? Promise.resolve()).then(async () => {
      context.signal.throwIfAborted();
      const value = await load(context);
      let session = live.get(id);
      if (!session) {
        session = await runtime.attach(account(context.connection), value.sessionId, value.cookies, context.signal);
        live.set(id, session);
      }
      try {
        const result = await work(session, value);
        // Merge with what the tool itself saved (for example a handoff id) instead of the pre-call state.
        // close() already saved and disconnected; there is no browser left to read.
        if (live.get(id) === session) await save(context, { ...(await load(context)), sessionId: session.id, cookies: await session.cookies() as Cookie[] });
        return result;
      } catch (error) {
        // A broken connection is reattached on the next call; known page errors keep the session.
        if (!(error instanceof ConnectorError)) { live.delete(id); await session.close().catch(() => {}); }
        throw error;
      }
    });
    queues.set(id, run.catch(() => undefined));
    return run;
  };
  const read = <I>(name: string, description: string, input: z.ZodType<I>,
    work: (session: BrowserSession, value: I, saved: State, context: ToolContext) => Promise<Json>,
    precheck?: (value: I) => void): ToolDefinition<I> => ({
    name, description, risk: "read", input,
    // Refusals that need no browser happen before one is attached.
    execute: async (context, value) => { precheck?.(value); return locked(context, (session, saved) => work(session, value, saved, context)); },
  });
  const checkUrl = (value: { url: string }) => { allowedUrl(value.url); };
  const page = (value: { url: string; title: string; status?: number }): { [key: string]: Json } => ({ url: value.url, title: value.title, ...(value.status ? { status: value.status } : {}) });

  const upload: ToolDefinition<{ site: string; ref: string; file: { name: string; mediaType: string; contentBase64: string } }> = {
    name: "upload", risk: "write", targets: ["site"],
    description: "Attach a file to a file input on the current page. The owner approves the exact file and site first. " +
      "site must equal the current page's origin; ref comes from the latest snapshot.",
    input: z.object({ site, ref, file: z.object({ name: z.string().min(1).max(120).regex(/^[^/\\\u0000-\u001f]+$/),
      // Accept parameters such as "; charset=utf-8" but hand the browser only the bare type.
      mediaType: z.string().max(200).regex(/^[a-zA-Z]+\/[a-zA-Z0-9.+-]+(?:\s*;.*)?$/).transform((v) => v.split(";")[0]!.trim().toLowerCase()), contentBase64: z.string().min(1).max(MAX_UPLOAD_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict() }).strict(),
    summarize: (value) => `上传 ${value.file.name}（${Math.ceil(value.file.contentBase64.length * 0.75 / 1024)} KB）到 ${new URL(value.site).host}`,
    execute: (context, value) => locked(context, async (session) => {
      const current = new URL((await session.snapshot(0)).url);
      if (current.origin !== new URL(value.site).origin) throw new ConnectorError("browser_upload_site_mismatch", { current: current.origin });
      return page(await session.upload(value.ref, value.file));
    }),
  };

  const tools: ToolDefinition[] = [
    read("open", "Open an http(s) URL in the remote browser. Prefer URLs that already carry search parameters. Private and local addresses are refused.",
      z.object({ url: z.string().max(4000) }).strict(), async (session, value) => page(await session.open(allowedUrl(value.url))), checkUrl),
    read("snapshot", "Return the current page's visible text and numbered interactive elements (ref) for click/type/upload.",
      z.object({ maxChars: z.number().int().min(1000).max(200_000).default(40_000) }).strict(),
      async (session, value) => { const s = await session.snapshot(value.maxChars); return { ...page(s), text: s.text, elements: s.elements as unknown as Json }; }),
    read("click", "Click an element by ref from the latest snapshot. Take a new snapshot afterwards; refs change when the page changes.",
      z.object({ ref }).strict(), async (session, value) => page(await session.click(value.ref))),
    read("type", "Type text into an element by ref, replacing its value; submit presses Enter.",
      z.object({ ref, text: z.string().max(5000), submit: z.boolean().default(false) }).strict(),
      async (session, value) => page(await session.type(value.ref, value.text, value.submit))),
    read("press", "Press one keyboard key such as Enter, Escape, Tab or ArrowDown.",
      z.object({ key: z.string().regex(/^(Enter|Escape|Tab|Backspace|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|Space)$/) }).strict(),
      async (session, value) => page(await session.press(value.key))),
    read("screenshot", "Capture the visible page as PNG.", z.object({}).strict(), async (session) => await session.screenshot() as unknown as Json),
    read("download", "Download a file using the browser's current cookies (at most 10 MB). Returns the file bytes in base64.",
      z.object({ url: z.string().max(4000) }).strict(), async (session, value) => await session.download(allowedUrl(value.url), MAX_DOWNLOAD_BYTES) as unknown as Json, checkUrl),
    read("handoff_start", "Ask the owner to take over the browser (login, CAPTCHA, a choice only they can make). Returns a Live View URL for the owner only; " +
      "never repeat it to anyone else. Poll handoff_status, then take a new snapshot: the owner may have changed the page.",
      z.object({ instructions: z.string().min(1).max(500), timeoutSeconds: z.number().int().min(60).max(MAX_HANDOFF_MS / 1000).default(900) }).strict(),
      async (session, value, saved, context) => {
        const handoff = await session.handoffStart(value.instructions, value.timeoutSeconds * 1000);
        await save(context, { ...saved, handoff: { handoffId: handoff.handoffId, expiresAt: handoff.expiresAt } });
        return handoff as unknown as Json;
      }),
    read("handoff_status", "Check whether the owner has finished the current handoff.", z.object({ handoffId: z.string().max(100) }).strict(),
      async (session, value, saved) => {
        if (saved.handoff?.handoffId !== value.handoffId) throw new ConnectorError("browser_handoff_not_found");
        const s = await session.handoffState();
        const expired = Date.parse(saved.handoff.expiresAt) <= Date.now();
        const active = s.active && s.handoffId === value.handoffId && !expired;
        const current = await session.snapshot(0);
        return { handoffId: value.handoffId, active, done: !active, ...(expired ? { reason: "expired" } : {}), ...page(current) };
      }),
    read("handoff_cancel", "End the current handoff: the owner's live view stops controlling the browser (its tab is replaced by a blank one).",
      z.object({ handoffId: z.string().max(100) }).strict(), async (session, value, saved, context) => {
        if (saved.handoff?.handoffId !== value.handoffId) throw new ConnectorError("browser_handoff_not_found");
        const current = await session.handoffCancel();
        const { handoff: _handoff, ...rest } = await load(context);
        await save(context, rest);
        return { handoffId: value.handoffId, cancelled: true, ...page(current) };
      }),
    read("close", "Disconnect from the browser and save cookies. The next call reconnects or starts a new browser with the saved cookies.",
      z.object({}).strict(), async (session, _value, _saved, context) => {
        await save(context, { ...(await load(context)), sessionId: session.id, cookies: await session.cookies() as Cookie[] });
        live.delete(context.connection.id);
        await session.close();
        return { closed: true };
      }),
    upload,
  ];

  return { kind: "browser", tools, account: {
    async status({ connection, credentials }) {
      try { account(connection); } catch (error) { return { status: error instanceof ConnectorError ? error.code : "browser_settings_invalid" } as Json; }
      const saved = state.safeParse((await credentials.get()) ?? { version: 1 });
      const sites = saved.success ? [...new Set(saved.data.cookies.map((c) => c.domain.replace(/^\./, "")))].slice(0, 100) : [];
      return { status: "connected", sites } as Json;
    },
    async connect({ connection }) { account(connection); return { status: "connected" }; },
    async disconnect({ connection, credentials }) {
      const session = live.get(connection.id); live.delete(connection.id); await session?.close();
      await credentials.put({ version: 1, cookies: [] });
      return { status: "disconnected" };
    },
  } };
}
