import { readFileSync, statSync } from "node:fs";
import type { KeyWrapper } from "./sealer.js";

export interface CloudflareSecretsConfig {
  provider: "cloudflare-worker-secrets";
  url: string;
  keyId: string;
  tokenFile: string;
}

/** Remote envelope-key wrapping. Worker Secrets are managed secrets, not non-exportable KMS keys. */
export class CloudflareSecretsWrapper implements KeyWrapper {
  readonly keyId: string;
  private readonly url: string;
  private readonly token: string;
  constructor(config: CloudflareSecretsConfig) {
    const url = new URL(config.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("wrapping_endpoint_invalid");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(config.keyId)) throw new Error("wrapping_key_id_invalid");
    if (statSync(config.tokenFile).mode & 0o077) throw new Error("wrapping_token_must_be_private");
    this.token = readFileSync(config.tokenFile, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(this.token)) throw new Error("wrapping_token_invalid");
    this.url = url.origin;
    this.keyId = "cloudflare-worker-secrets:" + config.keyId;
  }
  private async request(action: "wrap" | "unwrap", context: string, value: string): Promise<string> {
    try {
      if (!/^[0-9a-f]{64}$/.test(context) || value.length > 512) throw new Error();
      const response = await fetch(`${this.url}/v1/${action}`, { method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ keyId: this.keyId, context, value }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(); let raw = "";
      const decoder = new TextDecoder();
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break;
          raw += decoder.decode(value, { stream: true }); if (raw.length > 2048) throw new Error(); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const data = JSON.parse(raw);
      if (data.keyId !== this.keyId || typeof data.value !== "string" || data.value.length > 512) throw new Error();
      return data.value;
    } catch { throw new Error("remote_key_wrapping_unavailable"); }
  }
  async wrap(key: Buffer, context: string) {
    if (key.length !== 32) throw new Error("data_key_invalid");
    return this.request("wrap", context, key.toString("base64url"));
  }
  async unwrap(wrapped: string, context: string) {
    const value = await this.request("unwrap", context, wrapped), key = Buffer.from(value, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== value) { key.fill(0); throw new Error("data_key_invalid"); }
    return key;
  }
}
