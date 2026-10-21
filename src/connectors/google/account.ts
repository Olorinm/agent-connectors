import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { OAuth2Client, CodeChallengeMethod, type Credentials } from "google-auth-library";
// Match google-auth-library's CommonJS Gaxios instance and nominal private-field types.
import gaxios = require("gaxios");
import { z } from "zod";
import { digest, type Json } from "../../canonical.js";
import { ConnectorError, type ToolContext } from "../../connector.js";

export const googleSettings = z.object({
  product: z.enum(["gmail", "drive", "docs", "sheets", "slides", "calendar"]),
  clientFile: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1).max(200)).min(1).max(30).optional(),
}).strict();
export type GoogleProduct = z.infer<typeof googleSettings>["product"];
export interface GoogleOptions {
  baseDirectory?: string;
  redirectUrl?: string;
  /** Test injection, not a user/Agent-controlled endpoint setting. */
  fetch?: typeof fetch;
}
const scopes: Record<GoogleProduct, string[]> = {
  gmail: ["gmail.modify"],
  drive: ["drive.readonly", "drive.file"],
  docs: ["documents"],
  sheets: ["spreadsheets"],
  slides: ["presentations"],
  calendar: ["calendar.calendarlist.readonly", "calendar.events"],
};
const application = z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) });
interface AccountState {
  version: "google-api-v1";
  binding: string;
  generation: string;
  tokens?: Credentials;
  pending?: { state: string; verifier: string; expiresAt: number; consumed?: boolean };
}

/** Used only under the connector's per-account lock. Google SDK owns the OAuth protocol. */
export class GoogleAccount {
  readonly settings: z.infer<typeof googleSettings>;
  readonly scopes: string[];
  readonly state: AccountState;
  static async load(context: ToolContext, options: GoogleOptions) {
    return new GoogleAccount(context, options, await context.credentials.get() as unknown as AccountState | undefined);
  }
  constructor(readonly context: ToolContext, readonly options: GoogleOptions, saved?: AccountState) {
    const parsed = googleSettings.safeParse(context.connection.settings ?? {});
    if (!parsed.success) throw new ConnectorError("google_settings_invalid");
    this.settings = parsed.data;
    this.scopes = this.settings.scopes ?? scopes[this.settings.product].map((scope) => `https://www.googleapis.com/auth/${scope}`);
    const binding = digest({ owner: context.connection.owner, backend: "google-api-v1", settings: this.settings,
      redirectUrl: options.redirectUrl ?? "" });
    this.state = saved?.version === "google-api-v1" && saved.binding === binding ? saved :
      { version: "google-api-v1", binding, generation: randomUUID() };
  }
  private async save() { await this.context.credentials.put(JSON.parse(JSON.stringify(this.state)) as Json); }
  private redirectUrl() {
    if (!this.options.redirectUrl) throw new ConnectorError("oauth_callback_not_configured");
    const url = new URL(this.options.redirectUrl);
    if (url.pathname !== "/oauth/callback" || url.search || url.hash || url.username || url.password ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))))
      throw new ConnectorError("oauth_callback_invalid");
    return url.href;
  }
  private clientInfo() {
    if (!this.settings.clientFile) throw new ConnectorError("oauth_client_not_configured");
    try {
      const file = resolve(this.options.baseDirectory ?? ".", this.settings.clientFile);
      if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0)
        throw new ConnectorError("oauth_client_file_must_be_private");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      return application.parse(raw.web ?? raw);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("oauth_client_file_missing_or_invalid");
    }
  }
  private transporter(origins: string[]) {
    // Keep the SDK's transport for multipart streams, proxy support and download limits.
    const transport = new gaxios.Gaxios({ retry: false, timeout: 30_000, maxRedirects: 0,
      ...(this.options.fetch ? { fetchImplementation: this.options.fetch } : {}) });
    transport.interceptors.request.add({ resolved: async (request) => {
      const url = new URL(String(request.url));
      if (url.username || url.password || url.protocol !== "https:" || !origins.includes(url.origin))
        throw new ConnectorError("upstream_origin_not_allowed");
      request.retry = false;
      request.redirect = "error";
      request.maxRedirects = 0;
      request.follow = 0;
      request.signal = AbortSignal.any([this.context.signal, request.signal ?? AbortSignal.timeout(30_000)]);
      return request;
    } });
    return transport;
  }
  private oauthClient() {
    const client = this.clientInfo();
    return new OAuth2Client({ clientId: client.client_id, clientSecret: client.client_secret, redirectUri: this.redirectUrl(),
      transporter: this.transporter(["https://oauth2.googleapis.com"]), forceRefreshOnFailure: false });
  }
  localStatus(): Json {
    try {
      this.oauthClient();
      return { status: this.state.tokens ? "authorized_unverified" :
        this.state.pending && !this.state.pending.consumed && this.state.pending.expiresAt > Date.now() ? "authorization_pending" : "authorization_required",
      backend: "google-api", product: this.settings.product };
    } catch (error) {
      return { status: error instanceof ConnectorError ? error.code : "configuration_invalid", backend: "google-api", product: this.settings.product };
    }
  }
  async begin(): Promise<Json> {
    const client = this.oauthClient();
    const pkce = await client.generateCodeVerifierAsync();
    const state = randomBytes(32).toString("base64url");
    this.state.generation = randomUUID();
    delete this.state.tokens;
    this.state.pending = { state, verifier: pkce.codeVerifier, expiresAt: Date.now() + 600_000 };
    await this.save();
    return { status: "authorization_required", authorizationUrl: client.generateAuthUrl({
      access_type: "offline", prompt: "consent", scope: this.scopes, state,
      code_challenge: pkce.codeChallenge, code_challenge_method: CodeChallengeMethod.S256,
    }), expiresAt: new Date(this.state.pending.expiresAt).toISOString() };
  }
  async complete(state: string, code?: string): Promise<boolean> {
    const pending = this.state.pending;
    if (!pending || pending.state !== state || pending.consumed || pending.expiresAt <= Date.now()) return false;
    pending.consumed = true; await this.save();
    try {
      if (code) {
        const { tokens } = await this.oauthClient().getToken({ code, codeVerifier: pending.verifier });
        if (!tokens.access_token) throw new ConnectorError("oauth_token_missing");
        this.state.tokens = tokens;
      }
      return true;
    } catch { throw new ConnectorError("oauth_authorization_failed"); }
    finally { delete this.state.pending; await this.save(); }
  }
  async accessToken(): Promise<string> {
    const saved = this.state.tokens;
    if (!saved?.access_token) throw new ConnectorError("authorization_required");
    if (!saved.expiry_date || saved.expiry_date <= Date.now() + 60_000) {
      if (!saved.refresh_token) throw new ConnectorError("authorization_required");
      const client = this.oauthClient(); client.setCredentials(saved);
      try {
        const { credentials } = await client.refreshAccessToken();
        if (!credentials.access_token) throw new Error("token_missing");
        this.state.tokens = { ...credentials, refresh_token: credentials.refresh_token ?? saved.refresh_token };
        await this.save();
      } catch (error) {
        if ((error as { response?: { data?: { error?: string } } }).response?.data?.error === "invalid_grant") {
          delete this.state.tokens; await this.save();
          throw new ConnectorError("authorization_required");
        }
        throw new ConnectorError("oauth_refresh_failed");
      }
    }
    return this.state.tokens!.access_token!;
  }
  async status(): Promise<Json> {
    const local = this.localStatus() as Record<string, Json>;
    if (local.status !== "authorized_unverified") return local;
    try {
      const info = await this.oauthClient().getTokenInfo(await this.accessToken());
      return { ...local, status: "connected", verification: "oauth", apiAccess: "checked_on_use", scopes: info.scopes };
    } catch (error) {
      return { ...local, status: error instanceof ConnectorError ? error.code : "google_authorization_check_failed" };
    }
  }
  async disconnect(): Promise<Json> {
    delete this.state.tokens; delete this.state.pending; this.state.generation = randomUUID(); await this.save();
    return { status: "disconnected", providerRevocation: "Remove this application's access in your Google Account to revoke upstream consent." };
  }
  /** The business client has no refresh token, so the SDK cannot replay a write after a 401/403. */
  async businessClient() {
    const access = await this.accessToken();
    const client = new OAuth2Client({ transporter: this.transporter([
      "https://gmail.googleapis.com", "https://www.googleapis.com", "https://docs.googleapis.com",
      "https://sheets.googleapis.com", "https://slides.googleapis.com",
    ]), forceRefreshOnFailure: false });
    client.setCredentials({ access_token: access, token_type: "Bearer" });
    return client;
  }
}
