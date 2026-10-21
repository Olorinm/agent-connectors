import { KeyManagementServiceClient } from "@google-cloud/kms";
import { IdentityPoolClient } from "google-auth-library";
import type { KeyWrapper } from "./sealer.js";

export interface GoogleKmsConfig {
  provider: "google-cloud-kms";
  keyName: string;
  workloadIdentity: { audience: string; tokenFile: string };
}

/** CRC32C is a transport-integrity check; AES-GCM provides authentication. */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function googleKmsClient(config: GoogleKmsConfig): KeyManagementServiceClient {
  // Construct only file-sourced WIF. Never fall back to developer ADC, metadata, or a private key.
  const authClient = new IdentityPoolClient({
    type: "external_account",
    audience: config.workloadIdentity.audience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    credential_source: { file: config.workloadIdentity.tokenFile, format: { type: "text" } },
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return new KeyManagementServiceClient({
    authClient, fallback: true, apiEndpoint: "cloudkms.googleapis.com",
  });
}

/** Only the data key goes to KMS; mail, arguments and results stay in the connector. */
export class GoogleKmsWrapper implements KeyWrapper {
  readonly keyId: string;
  constructor(config: GoogleKmsConfig, private readonly client = googleKmsClient(config)) {
    this.keyId = config.keyName;
  }
  async wrap(key: Buffer, context: string): Promise<string> {
    try {
      const aad = Buffer.from(context);
      const [result] = await this.client.encrypt({
        name: this.keyId, plaintext: key, additionalAuthenticatedData: aad,
        plaintextCrc32c: { value: crc32c(key) }, additionalAuthenticatedDataCrc32c: { value: crc32c(aad) },
      }, { timeout: 15_000, retry: null });
      const ciphertext = bytes(result.ciphertext);
      if (!result.name?.startsWith(`${this.keyId}/cryptoKeyVersions/`) ||
        !result.verifiedPlaintextCrc32c || !result.verifiedAdditionalAuthenticatedDataCrc32c ||
        crc32c(ciphertext) !== Number(result.ciphertextCrc32c?.value))
        throw new Error("kms_integrity");
      return ciphertext.toString("base64");
    } catch {
      throw new Error("kms_encrypt_failed");
    }
  }
  async unwrap(wrapped: string, context: string): Promise<Buffer> {
    let plaintext: Buffer | undefined;
    try {
      const ciphertext = Buffer.from(wrapped, "base64"), aad = Buffer.from(context);
      if (!ciphertext.length || ciphertext.toString("base64") !== wrapped) throw new Error("kms_ciphertext_invalid");
      const [result] = await this.client.decrypt({
        name: this.keyId, ciphertext, additionalAuthenticatedData: aad,
        ciphertextCrc32c: { value: crc32c(ciphertext) }, additionalAuthenticatedDataCrc32c: { value: crc32c(aad) },
      }, { timeout: 15_000, retry: null });
      plaintext = bytes(result.plaintext);
      if (plaintext.length !== 32 || crc32c(plaintext) !== Number(result.plaintextCrc32c?.value))
        throw new Error("kms_integrity");
      return plaintext;
    } catch {
      plaintext?.fill(0);
      throw new Error("kms_decrypt_failed");
    }
  }
}

function bytes(value: Uint8Array | string | null | undefined): Buffer {
  if (typeof value === "string") return Buffer.from(value, "base64");
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("kms_response_invalid");
}
