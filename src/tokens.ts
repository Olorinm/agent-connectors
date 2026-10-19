import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { z } from "zod";

/** Distinct JWT types; a token of one kind is never accepted as another. */
export const TOKEN_TYPES = {
  caller: "agent-connectors.caller+jwt",
  service: "agent-connectors.service+jwt",
  grant: "agent-connectors.grant+jwt",
} as const;

export interface Trust {
  issuer: string;
  audience: string;
  /** Keys that sign per-Agent caller tokens. */
  callerKeys: JSONWebKeySet;
  /** Keys that sign service tokens and approval grants. Must not overlap with callerKeys. */
  authorityKeys: JSONWebKeySet;
}

export const LIMITS = { callerSeconds: 3600, serviceSeconds: 300, grantSeconds: 600 } as const;

export interface Caller {
  agentId: string;
  owner: string;
  connections: string[];
  tokenId: string;
}

export interface Grant {
  tokenId: string;
  owner: string;
  operationId: string;
  digest: string;
  approver?: string;
  expiresAt: Date;
}

export class TokenError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const id = z.string().min(1).max(256);
const callerClaims = z.object({ sub: id, owner: id, connections: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).max(64), jti: id });
const serviceClaims = z.object({ sub: id, jti: id });
const grantClaims = z.object({ sub: id, op: id, dig: z.string().regex(/^[0-9a-f]{64}$/), apv: id.optional(), jti: id });

export class TokenVerifier {
  readonly #caller;
  readonly #authority;
  constructor(readonly trust: Trust) {
    const callerIds = new Set(trust.callerKeys.keys.map((key) => key.kid));
    if (trust.callerKeys.keys.length === 0 || trust.authorityKeys.keys.length === 0) throw new Error("trust_keys_required");
    for (const key of [...trust.callerKeys.keys, ...trust.authorityKeys.keys])
      if (!key.kid || key.kty !== "OKP" || key.crv !== "Ed25519" || "d" in key) throw new Error("trust_keys_must_be_public_ed25519_with_kid");
    if (trust.authorityKeys.keys.some((key) => callerIds.has(key.kid) || trust.callerKeys.keys.some((other) => other.x === key.x)))
      throw new Error("trust_caller_and_authority_keys_must_differ");
    this.#caller = createLocalJWKSet(trust.callerKeys);
    this.#authority = createLocalJWKSet(trust.authorityKeys);
  }
  async caller(token: string, now = new Date()): Promise<Caller> {
    const payload = await this.#verify(token, "caller", now);
    const claims = parse(callerClaims, payload);
    return { agentId: claims.sub, owner: claims.owner, connections: claims.connections, tokenId: claims.jti };
  }
  async service(token: string, now = new Date()): Promise<{ service: string }> {
    return { service: parse(serviceClaims, await this.#verify(token, "service", now)).sub };
  }
  async grant(token: string, now = new Date()): Promise<Grant> {
    const payload = await this.#verify(token, "grant", now);
    const claims = parse(grantClaims, payload);
    return {
      tokenId: claims.jti, owner: claims.sub, operationId: claims.op, digest: claims.dig, expiresAt: new Date(payload.exp! * 1000),
      ...(claims.apv ? { approver: claims.apv } : {}),
    };
  }
  async #verify(token: string, kind: keyof typeof TOKEN_TYPES, now: Date): Promise<JWTPayload> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, kind === "caller" ? this.#caller : this.#authority, {
        algorithms: ["EdDSA"], typ: TOKEN_TYPES[kind], issuer: this.trust.issuer, audience: this.trust.audience,
        requiredClaims: ["exp", "iat", "jti", "sub"], currentDate: now, clockTolerance: 30,
      }));
    } catch {
      throw new TokenError(`${kind}_token_invalid`);
    }
    if (payload.exp! - payload.iat! > LIMITS[`${kind}Seconds`]) throw new TokenError(`${kind}_token_lifetime_too_long`);
    if (payload.iat! * 1000 > now.getTime() + 30_000) throw new TokenError(`${kind}_token_not_yet_valid`);
    return payload;
  }
}

function parse<T>(schema: z.ZodType<T>, payload: JWTPayload): T {
  const result = schema.safeParse(payload);
  if (!result.success) throw new TokenError("token_claims_invalid");
  return result.data;
}
