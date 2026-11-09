import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { OAuth2Client, CodeChallengeMethod, type Credentials } from "google-auth-library";
// Match google-auth-library's CommonJS Gaxios instance and nominal private-field types.
import gaxios = require("gaxios");
import { gmail as gmailClient } from "@googleapis/gmail";
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
  /** Path of the pinned official `gws` binary; defaults to AGENT_CONNECTORS_GWS_BINARY. */
  gwsBinary?: string;
  /** Test injection for the gws process. */
  gwsRunner?: import("./gws.js").GwsRunner;
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
  /** The authorized mailbox address (Gmail profile), shown to its owner. */
  email?: string;
  pending?: { state: string; verifier: string; expiresAt: number; consumed?: boolean; authorizationUrl?: string; scopes?: string[] };
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
      const pending = this.state.pending && !this.state.pending.consumed && this.state.pending.expiresAt > Date.now() ? this.state.pending : undefined;
      if (this.state.tokens) return { status: "authorized_unverified", backend: "google-api", product: this.settings.product };
      // The consent link stays available while it is valid, so a reloaded page can show it again.
      return pending ? { status: "authorization_pending", backend: "google-api", product: this.settings.product,
        ...(pending.authorizationUrl ? { authorizationUrl: pending.authorizationUrl } : {}), expiresAt: new Date(pending.expiresAt).toISOString() }
        : { status: "authorization_required", backend: "google-api", product: this.settings.product };
    } catch (error) {
      return { status: error instanceof ConnectorError ? error.code : "configuration_invalid", backend: "google-api", product: this.settings.product };
    }
  }
  /** Scopes the current authorization holds; before authorization, those a connect would request. */
  grantedScopes(): string[] {
    const granted = this.state.tokens?.scope?.split(/\s+/).filter(Boolean);
    return granted?.length ? granted : this.scopes;
  }
  /**
   * Starts consent. With `added`, the configured scopes plus those already granted and the added ones are requested
   * (incremental consent); the existing authorization keeps working until the new one completes.
   */
  async begin(added: string[] = []): Promise<Json> {
    const client = this.oauthClient();
    const pkce = await client.generateCodeVerifierAsync();
    const state = randomBytes(32).toString("base64url");
    const incremental = added.length > 0 && !!this.state.tokens;
    const requested = [...new Set([...this.scopes, ...(incremental ? this.grantedScopes() : []), ...added])];
    this.state.generation = randomUUID();
    if (!incremental) { delete this.state.tokens; delete this.state.email; }
    const expiresAt = Date.now() + 600_000;
    const authorizationUrl = client.generateAuthUrl({
      access_type: "offline", prompt: "consent", scope: requested, state,
      ...(incremental ? { include_granted_scopes: true, ...(this.state.email ? { login_hint: this.state.email } : {}) } : {}),
      code_challenge: pkce.codeChallenge, code_challenge_method: CodeChallengeMethod.S256,
    });
    this.state.pending = { state, verifier: pkce.codeVerifier, expiresAt, authorizationUrl, scopes: requested };
    await this.save();
    return { status: "authorization_required", authorizationUrl, expiresAt: new Date(expiresAt).toISOString() };
  }
  async complete(state: string, code?: string): Promise<boolean> {
    const pending = this.state.pending;
    if (!pending || pending.state !== state || pending.consumed || pending.expiresAt <= Date.now()) return false;
    pending.consumed = true; await this.save();
    try {
      if (code) {
        const { tokens } = await this.oauthClient().getToken({ code, codeVerifier: pending.verifier });
        if (!tokens.access_token) throw new ConnectorError("oauth_token_missing");
        // A new authorization may belong to another account: approvals and the cached address do not carry over.
        this.state.tokens = { ...tokens, ...(tokens.scope ? {} : pending.scopes ? { scope: pending.scopes.join(" ") } : {}) };
        this.state.generation = randomUUID();
        delete this.state.email;
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
      return { ...local, status: "connected", verification: "oauth", apiAccess: "checked_on_use", scopes: info.scopes,
        ...(await this.accountEmail(info.email) ? { accountEmail: this.state.email! } : {}) };
    } catch (error) {
      return { ...local, status: error instanceof ConnectorError ? error.code : "google_authorization_check_failed" };
    }
  }
  /** Gmail's profile names the authorized address; it is read once per authorization and kept with it. */
  private async accountEmail(fromToken?: string): Promise<boolean> {
    if (this.state.email) return true;
    let email = fromToken;
    if (!email && this.settings.product === "gmail") {
      try {
        const profile = await gmailClient({ version: "v1", auth: await this.businessClient() }).users.getProfile({ userId: "me" },
          { signal: this.context.signal, retry: false, timeout: 30_000, maxRedirects: 0 });
        email = profile.data.emailAddress ?? undefined;
      } catch { return false; }
    }
    if (!email || !z.email().max(254).safeParse(email).success) return false;
    this.state.email = email; await this.save();
    return true;
  }
  async disconnect(): Promise<Json> {
    delete this.state.tokens; delete this.state.pending; delete this.state.email; this.state.generation = randomUUID(); await this.save();
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
