import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ConnectorError, ConnectorService, Sealer, Store, TokenVerifier } from "../dist/index.js";
import { generateSigningKey, signCallerToken, signGrant, signServiceToken } from "../dist/issuer.js";

export const ISSUER = "https://router.test";
export const AUDIENCE = "agent-connectors";

/** A connector that records every side effect, so tests can prove a write did or did not happen. */
export function recordingConnector() {
  const effects = [];
  return {
    effects,
    connector: {
      kind: "notes",
      tools: [
        { name: "list", description: "List notes.", risk: "read", input: z.object({}).strict(),
          execute: async ({ credentials }) => ({ notes: ["a"], token: credentials.get()?.token ?? null }) },
        { name: "subject", description: "Write with a transforming schema.", risk: "write",
          input: z.object({ subject: z.string().overwrite((v) => `Re: ${v}`) }).strict(),
          execute: async (_context, input) => { effects.push(input); return { ok: true }; } },
        { name: "send", description: "Send a note.", risk: "write", targets: ["to"],
          input: z.object({ to: z.string(), text: z.string() }).strict(),
          summarize: (input) => `Send "${input.text}" to ${input.to}`,
          execute: async (_context, input) => {
            if (input.to === "fail") throw new ConnectorError("recipient_rejected");
            if (input.to === "crash" || input.to === "invoice-crash") throw new Error("socket hang up");
            effects.push(input);
            return { sent: true };
          } },
      ],
    },
  };
}

export async function setup({ now, ttl } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-connectors-"));
  const caller = await generateSigningKey("caller-1");
  const authority = await generateSigningKey("authority-1");
  const trust = { issuer: ISSUER, audience: AUDIENCE, callerKeys: { keys: [caller.publicJwk] }, authorityKeys: { keys: [authority.publicJwk] } };
  const { connector, effects } = recordingConnector();
  const connections = [
    { id: "alice-notes", kind: "notes", owner: "@alice", autoApprove: [{ tool: "send", match: { to: "invoice-table" } }, { tool: "send", match: { to: "invoice-crash" } }] },
    { id: "bob-notes", kind: "notes", owner: "@bob" },
  ];
  const store = new Store(join(directory, "state"));
  const sealingKey = randomBytes(32);
  const service = new ConnectorService({ connectors: [connector], connections, store, sealer: new Sealer(sealingKey), ...(now ? { now } : {}), ...(ttl ? { operationTtlSeconds: ttl } : {}) });
  const common = { issuer: ISSUER, audience: AUDIENCE };
  return {
    directory, store, service, effects, trust, sealingKey, connections, connector,
    verifier: new TokenVerifier(trust),
    callerKey: { kid: "caller-1", privateJwk: caller.privateJwk },
    authorityKey: { kid: "authority-1", privateJwk: authority.privateJwk },
    callerToken: (claims = {}) => signCallerToken({ ...common, key: { kid: "caller-1", privateJwk: caller.privateJwk }, agentId: "agent-a", owner: "@alice", connections: ["alice-notes", "bob-notes"], ...claims }),
    serviceToken: (claims = {}) => signServiceToken({ ...common, key: { kid: "authority-1", privateJwk: authority.privateJwk }, service: "router", ...claims }),
    grant: (operation, claims = {}) => signGrant({ ...common, key: { kid: "authority-1", privateJwk: authority.privateJwk }, owner: operation.owner, operationId: operation.id, digest: operation.digest, approver: "phone-1", ...claims }),
    cleanup: () => { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

export const signal = () => new AbortController().signal;
