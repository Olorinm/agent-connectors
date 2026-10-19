import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { ConnectionConfig } from "./connector.js";
import type { Trust } from "./tokens.js";

const json: z.ZodType<import("./canonical.js").Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json)]));

const schema = z.object({
  listen: z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().min(0).max(65535) }),
  allowedHosts: z.array(z.string()).optional(),
  stateDirectory: z.string(),
  keyFile: z.string(),
  operationTtlSeconds: z.number().int().min(60).max(86_400).optional(),
  trust: z.object({ issuer: z.string().min(1), audience: z.string().min(1).default("agent-connectors"), callerKeys: z.string(), authorityKeys: z.string() }),
  connections: z.array(z.object({
    id: z.string(), kind: z.string(), owner: z.string(), label: z.string().optional(),
    settings: z.record(z.string(), json).optional(),
    autoApprove: z.array(z.object({ tool: z.string(), match: z.record(z.string(), json) })).optional(),
  })),
}).strict();

export interface LoadedConfig {
  listen: { host: string; port: number };
  allowedHosts?: string[];
  stateDirectory: string;
  sealingKey: Buffer;
  operationTtlSeconds?: number;
  trust: Trust;
  connections: ConnectionConfig[];
}

export function loadConfig(file: string): LoadedConfig {
  const base = dirname(resolve(file));
  const raw = schema.parse(JSON.parse(readFileSync(file, "utf8")));
  const at = (path: string) => resolve(base, path);
  return {
    listen: raw.listen,
    ...(raw.allowedHosts ? { allowedHosts: raw.allowedHosts } : {}),
    stateDirectory: at(raw.stateDirectory),
    sealingKey: readSealingKey(at(raw.keyFile)),
    ...(raw.operationTtlSeconds ? { operationTtlSeconds: raw.operationTtlSeconds } : {}),
    trust: {
      issuer: raw.trust.issuer, audience: raw.trust.audience,
      callerKeys: JSON.parse(readFileSync(at(raw.trust.callerKeys), "utf8")),
      authorityKeys: JSON.parse(readFileSync(at(raw.trust.authorityKeys), "utf8")),
    },
    connections: raw.connections as ConnectionConfig[],
  };
}

export function readSealingKey(file: string): Buffer {
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) throw new Error("sealing_key_file_must_be_private");
  const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error("sealing_key_must_be_32_bytes");
  return key;
}
