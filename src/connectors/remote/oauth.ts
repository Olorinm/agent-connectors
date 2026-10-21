import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthClientInformationSchema, type OAuthClientInformationMixed, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ConnectorError, type ToolContext } from "../../connector.js";
import { digest, type Json } from "../../canonical.js";
import { remoteSettings, type RemoteSpec } from "./catalog.js";

interface State {
  version: 1;
  binding: string;
  generation: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
  pending?: { state: string; expiresAt: number; verifier?: string; consumed?: boolean };
}
export interface RemoteOptions {
  baseDirectory?: string;
  redirectUrl?: string;
  /** Dependency injection for deterministic protocol tests, never a connection setting. */
  fetch?: typeof fetch;
}

/** No redirects or arbitrary destinations for requests carrying credentials. */
export function restrictedFetch(origins: string[], upstream: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.username || url.password || url.protocol !== "https:" || !origins.includes(url.origin))
      throw new ConnectorError("upstream_origin_not_allowed");
    const response = await upstream(input, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400) throw new ConnectorError("upstream_redirect_refused");
    return response;
  };
}

/** Created inside the connection's serialization lock; all persisted values remain sealed. */
export class RemoteOAuth implements OAuthClientProvider {
  readonly stateValue: State;
  readonly fetch: typeof fetch;
  authorizationUrl?: string;
  private interactive = false;
  static async load(context: ToolContext, spec: RemoteSpec, options: RemoteOptions) {
    return new RemoteOAuth(context, spec, options, await context.credentials.get() as unknown as State | undefined);
  }
  constructor(readonly context: ToolContext, readonly spec: RemoteSpec, readonly options: RemoteOptions, saved?: State) {
    const binding = digest({ owner: context.connection.owner, kind: context.connection.kind, endpoint: spec.endpoint,
      settings: context.connection.settings ?? {}, redirectUrl: options.redirectUrl ?? "" });
    this.stateValue = saved?.version === 1 && saved.binding === binding ? saved : { version: 1, binding, generation: randomUUID() };
    this.fetch = restrictedFetch(spec.authOrigins, options.fetch);
  }
  get redirectUrl() {
    const value = this.options.redirectUrl;
    if (!value) throw new ConnectorError("oauth_callback_not_configured");
    const url = new URL(value);
    if (url.pathname !== "/oauth/callback" || url.search || url.hash || url.username || url.password ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))))
      throw new ConnectorError("oauth_callback_invalid");
    return value;
  }
  get clientMetadata() {
    return {
      client_name: "Mau Agent Connectors", redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: this.spec.requiresClient ? "client_secret_post" : "none",
      ...(this.spec.scopes.length ? { scope: this.spec.scopes.join(" ") } : {}),
    };
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    if (!this.spec.requiresClient && this.stateValue.client) return this.stateValue.client;
    const file = remoteSettings.parse(this.context.connection.settings ?? {}).clientFile;
    if (!file) {
      if (this.spec.requiresClient) throw new ConnectorError("oauth_client_not_configured");
      return undefined;
    }
    try {
      const path = resolve(this.options.baseDirectory ?? ".", file);
      if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0)
        throw new ConnectorError("oauth_client_file_must_be_private");
      const value = JSON.parse(readFileSync(path, "utf8"));
      const client = OAuthClientInformationSchema.parse(value);
      if (this.spec.requiresClient && (!client.client_id || !client.client_secret))
        throw new ConnectorError("oauth_client_file_missing_or_invalid");
      return { ...client, ...(this.spec.discovery ? { issuer: String(this.spec.discovery.authorizationServerUrl) } : {}) };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("oauth_client_file_missing_or_invalid");
    }
  }
  async saveClientInformation(client: OAuthClientInformationMixed) { this.stateValue.client = client; await this.save(); }
  tokens() { return this.stateValue.tokens; }
  async saveTokens(tokens: OAuthTokens) {
    this.stateValue.tokens = { ...tokens, refresh_token: tokens.refresh_token ?? this.stateValue.tokens?.refresh_token };
    this.stateValue.expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
    await this.save();
  }
  state() {
    if (!this.interactive || !this.stateValue.pending) throw new ConnectorError("authorization_required");
    return this.stateValue.pending.state;
  }
  async saveCodeVerifier(verifier: string) {
    if (!this.interactive || !this.stateValue.pending) throw new ConnectorError("authorization_required");
    this.stateValue.pending.verifier = verifier; await this.save();
  }
  codeVerifier() {
    const verifier = this.stateValue.pending?.verifier;
    if (!verifier) throw new ConnectorError("oauth_verifier_missing");
    return verifier;
  }
  redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new ConnectorError("authorization_required");
    if (!this.spec.authorizationOrigins.includes(url.origin) || url.protocol !== "https:" || url.username || url.password)
      throw new ConnectorError("authorization_origin_not_allowed");
    this.authorizationUrl = url.href;
  }
  discoveryState() { return this.spec.discovery ?? this.stateValue.discovery; }
  async saveDiscoveryState(state: OAuthDiscoveryState) { this.stateValue.discovery = state; await this.save(); }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") delete this.stateValue.client;
    if (scope === "all" || scope === "tokens") { delete this.stateValue.tokens; delete this.stateValue.expiresAt; }
    if (scope === "all" || scope === "verifier") delete this.stateValue.pending;
    if (scope === "all" || scope === "discovery") delete this.stateValue.discovery;
    await this.save();
  }
  private async save() { await this.context.credentials.put(JSON.parse(JSON.stringify(this.stateValue)) as Json); }
  private async authorize(code?: string) {
    try {
      return await auth(this, { serverUrl: this.spec.endpoint, fetchFn: this.fetch,
        ...(this.spec.scopes.length ? { scope: this.spec.scopes.join(" ") } : {}),
        ...(code !== undefined ? { authorizationCode: code } : {}) });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      // Do not include upstream responses, codes, tokens, or client metadata in error output.
      throw new ConnectorError("oauth_authorization_failed");
    }
  }
  async begin(): Promise<Json> {
    void this.redirectUrl; this.clientInformation();
    this.interactive = true;
    this.stateValue.generation = randomUUID();
    delete this.stateValue.tokens; delete this.stateValue.expiresAt;
    this.stateValue.pending = { state: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 600_000 };
    await this.save();
    await this.authorize();
    if (!this.authorizationUrl) throw new ConnectorError("oauth_authorization_url_missing");
    return { status: "authorization_required", authorizationUrl: this.authorizationUrl,
      expiresAt: new Date(this.stateValue.pending!.expiresAt).toISOString(), ...(this.spec.note ? { note: this.spec.note } : {}) };
  }
  async complete(state: string, code?: string): Promise<boolean> {
    const pending = this.stateValue.pending;
    if (!pending || pending.consumed || pending.state !== state || pending.expiresAt <= Date.now()) return false;
    // Consume before any network await, including writes made by SDK token/client callbacks.
    pending.consumed = true; await this.save();
    if (!code) { delete this.stateValue.pending; await this.save(); return true; }
    try { await this.authorize(code); }
    finally { delete this.stateValue.pending; await this.save(); }
    return true;
  }
  async accessToken(): Promise<string> {
    const tokens = this.stateValue.tokens;
    if (!tokens) throw new ConnectorError("authorization_required");
    if (this.stateValue.expiresAt !== undefined && this.stateValue.expiresAt <= Date.now() + 60_000) {
      if (!tokens.refresh_token) throw new ConnectorError("authorization_required");
      await this.authorize();
    }
    const token = this.stateValue.tokens?.access_token;
    if (!token) throw new ConnectorError("authorization_required");
    return token;
  }
  async disconnect(): Promise<Json> {
    this.stateValue.generation = randomUUID();
    await this.invalidateCredentials("tokens"); delete this.stateValue.pending; await this.save();
    return { status: "disconnected", providerRevocation: "Revoke the grant in the provider account settings to remove it there as well." };
  }
  status(): Json {
    let status: string;
    try {
      void this.redirectUrl; this.clientInformation();
      status = this.stateValue.tokens ? "authorized_unverified" :
        this.stateValue.pending && this.stateValue.pending.expiresAt > Date.now() ? "authorization_pending" : "authorization_required";
    } catch (error) { status = error instanceof ConnectorError ? error.code : "configuration_invalid"; }
    return { status, endpoint: this.spec.endpoint, ...(this.spec.note ? { note: this.spec.note } : {}) };
  }
}
