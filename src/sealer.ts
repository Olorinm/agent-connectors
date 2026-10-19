import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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
