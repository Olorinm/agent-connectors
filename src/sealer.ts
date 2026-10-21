import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** KMS providers are async; local test implementations can be synchronous. */
export interface ValueSealer {
  seal(context: string, plaintext: string): string | Promise<string>;
  open(context: string, sealed: string): string | Promise<string>;
}

/** A provider wraps a fresh 256-bit data key. It never exposes its master key. */
export interface KeyWrapper {
  readonly keyId: string;
  wrap(key: Buffer, context: string): Promise<string>;
  unwrap(wrapped: string, context: string): Promise<Buffer>;
}

const envelopeVersion = "kms-v2";

/** Per-value envelope encryption. No plaintext key cache and no legacy fallback. */
export class EnvelopeSealer implements ValueSealer {
  constructor(private readonly wrapper: KeyWrapper) {
    if (!wrapper.keyId) throw new Error("wrapping_key_id_required");
  }

  async seal(context: string, plaintext: string): Promise<string> {
    const key = randomBytes(32);
    try {
      const bound = this.#binding(context);
      const wrapped = await this.wrapper.wrap(key, bound);
      if (!wrapped) throw new Error("wrapping_failed");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(bound));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return JSON.stringify({
        version: envelopeVersion, keyId: this.wrapper.keyId, wrapped,
        iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"),
        body: body.toString("base64url"),
      });
    } catch {
      // SDK errors may contain request bodies, auth headers, or decrypted key material.
      throw new Error("credential_encryption_unavailable");
    } finally {
      key.fill(0);
    }
  }

  async open(context: string, sealed: string): Promise<string> {
    let key: Buffer | undefined;
    try {
      const value = JSON.parse(sealed);
      if (!value || Object.keys(value).sort().join(",") !== "body,iv,keyId,tag,version,wrapped" ||
        value.version !== envelopeVersion || value.keyId !== this.wrapper.keyId ||
        typeof value.wrapped !== "string" || !value.wrapped || value.wrapped.length > 65536)
        throw new Error("invalid_envelope");
      const decode = (input: unknown, length?: number) => {
        if (typeof input !== "string" || !/^[A-Za-z0-9_-]*$/.test(input)) throw new Error("invalid_encoding");
        const bytes = Buffer.from(input, "base64url");
        if (bytes.toString("base64url") !== input || (length !== undefined && bytes.length !== length))
          throw new Error("invalid_encoding");
        return bytes;
      };
      const iv = decode(value.iv, 12), tag = decode(value.tag, 16), body = decode(value.body);
      const bound = this.#binding(context);
      key = await this.wrapper.unwrap(value.wrapped, bound);
      if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("invalid_data_key");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(bound));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("credential_decryption_unavailable");
    } finally {
      key?.fill(0);
    }
  }

  #binding(context: string) {
    return createHash("sha256").update(JSON.stringify({
      service: "agent-connectors", version: envelopeVersion, keyId: this.wrapper.keyId, context,
    })).digest("hex");
  }
}

const VERSION = "v1";

/** AES-256-GCM with a caller-supplied context bound as associated data. */
export class Sealer {
  readonly #key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("sealer_key_must_be_32_bytes");
    this.#key = Buffer.from(key);
  }
  seal(context: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(`agent-connectors:${VERSION}:${context}`));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }
  open(context: string, sealed: string): string {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== VERSION || !iv || !tag || body === undefined) throw new Error("sealed_value_invalid");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(`agent-connectors:${VERSION}:${context}`));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }
}
