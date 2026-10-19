#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { builtinConnectors } from "./connectors/index.js";
import { generateSigningKey } from "./issuer.js";
import { Sealer } from "./sealer.js";
import { start } from "./start.js";
import { Store } from "./store.js";

const usage = `agent-connectors serve --config <file>
agent-connectors init-key <file>                      create the 32-byte sealing key (0600)
agent-connectors keygen --kid <id> --out <directory>  Ed25519 pair for Router: private.jwk.json (0600) + public.jwks.json
agent-connectors credential set <connectionId> --config <file>   read JSON credentials from stdin`;

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required\n\n${usage}`);
  return value;
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "serve": {
    const started = await start(loadConfig(option(args, "--config")), builtinConnectors);
    console.log(JSON.stringify({ event: "listening", url: started.url }));
    const stop = () => void started.close().then(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    break;
  }
  case "init-key": {
    const file = args[0];
    if (!file) throw new Error(usage);
    writeFileSync(file, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    break;
  }
  case "keygen": {
    const out = option(args, "--out");
    const { privateJwk, publicJwk } = await generateSigningKey(option(args, "--kid"));
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeFileSync(join(out, "private.jwk.json"), JSON.stringify(privateJwk), { mode: 0o600, flag: "wx" });
    writeFileSync(join(out, "public.jwks.json"), JSON.stringify({ keys: [publicJwk] }, null, 2), { flag: "wx" });
    break;
  }
  case "credential": {
    const [action, connectionId] = args;
    if (action !== "set" || !connectionId) throw new Error(usage);
    const config = loadConfig(option(args, "--config"));
    if (!config.connections.some((c) => c.id === connectionId)) throw new Error(`unknown connection ${connectionId}`);
    const value = JSON.parse(readFileSync(0, "utf8"));
    const store = new Store(config.stateDirectory);
    store.putCredential(connectionId, new Sealer(config.sealingKey).seal(`credential:${connectionId}`, JSON.stringify(value)), new Date());
    store.close();
    break;
  }
  default:
    console.error(usage);
    process.exit(command ? 2 : 0);
}
