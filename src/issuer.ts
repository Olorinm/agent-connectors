import { randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { LIMITS, TOKEN_TYPES } from "./tokens.js";

/**
 * Token issuance for the trusted service (Router). Keep private keys outside every
 * Agent environment: caller keys may sit with Router's delivery path, authority keys
 * only with the component that presents approvals to the owner.
 */
export interface SigningKey {
  kid: string;
  privateJwk: JWK;
}

export async function generateSigningKey(kid: string): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: "EdDSA" };
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA" };
  return { privateJwk, publicJwk };
}

interface Common {
  key: SigningKey;
  issuer: string;
  audience: string;
  ttlSeconds?: number;
  now?: Date;
}

async function sign(kind: keyof typeof TOKEN_TYPES, claims: Record<string, unknown>, subject: string, options: Common, limit: number) {
  const ttl = options.ttlSeconds ?? limit;
  if (!(ttl > 0 && ttl <= limit)) throw new Error(`${kind}_ttl_out_of_range`);
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", typ: TOKEN_TYPES[kind], kid: options.key.kid })
    .setIssuer(options.issuer).setAudience(options.audience).setSubject(subject)
    .setIssuedAt(iat).setExpirationTime(iat + ttl).setJti(randomUUID())
    .sign(await importJWK(options.key.privateJwk, "EdDSA"));
}

/** Short-lived identity for one Agent, limited to the listed connections. */
export function signCallerToken(options: Common & { agentId: string; owner: string; connections: string[]; readOnly?: boolean }) {
  return sign("caller", { owner: options.owner, connections: options.connections, ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}) }, options.agentId, options, LIMITS.callerSeconds);
}

export function signServiceToken(options: Common & { service: string }) {
  return sign("service", {}, options.service, options, LIMITS.serviceSeconds);
}

/** Issue only after the owner confirmed this exact operation (ID and digest from the connector). */
export function signGrant(options: Common & { owner: string; operationId: string; digest: string; approver?: string }) {
  return sign("grant", { op: options.operationId, dig: options.digest, ...(options.approver ? { apv: options.approver } : {}) },
    options.owner, options, LIMITS.grantSeconds);
}
