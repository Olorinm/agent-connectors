#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { generateSigningKey, signServiceToken } from "./issuer.js";
import { createSealer } from "./start.js";
import { Store } from "./store.js";
import { SecretFiles } from "./secret-files.js";
import { startConfigured } from "./start-configured.js";

const usage = `agent-connectors serve --config <file>
agent-connectors init --out <new-directory> --owner <owner-id> [--redirect-url <url>]
agent-connectors connection <status|connect|disconnect> [id] --config <file> --authority-key <private.jwk.json> [--url <service-url>]
agent-connectors init-key <file>                      create the 32-byte sealing key (0600)
agent-connectors keygen --kid <id> --out <directory>  Ed25519 pair for Router: private.jwk.json (0600) + public.jwks.json
agent-connectors credential set <connectionId> --config <file>   read JSON credentials from stdin
agent-connectors import-secret-files --config <file> --directory <private-source>   import an encrypted application/CLI file bundle`;

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required\n\n${usage}`);
  return value;
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "serve": {
    const started = await startConfigured(option(args, "--config"));
    console.log(JSON.stringify({ event: "listening", url: started.url }));
    const stop = () => void started.close().then(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    break;
  }
  case "import-secret-files": {
    const config = loadConfig(option(args, "--config"));
    if (!config.secretFiles) throw new Error("secret_files_configuration_required");
    await SecretFiles.import(resolve(option(args, "--directory")), config.secretFiles.file, createSealer(config));
    console.log(JSON.stringify({ status: "imported" }));
    break;
  }
  case "init-key": {
    const file = args[0];
    if (!file) throw new Error(usage);
    mkdirSync(dirname(resolve(file)), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    break;
  }
  case "init": {
    const out = resolve(option(args, "--out")), owner = option(args, "--owner");
    // An existing directory is deliberately refused: setup must never overwrite keys or accounts.
    mkdirSync(out, { mode: 0o700 });
    for (const directory of ["state", "secrets", "keys/caller", "keys/authority"])
      mkdirSync(join(out, directory), { recursive: true, mode: 0o700 });
    writeFileSync(join(out, "state/sealing.key"), `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    for (const kind of ["caller", "authority"]) {
      const { privateJwk, publicJwk } = await generateSigningKey(`${kind}-1`);
      writeFileSync(join(out, `keys/${kind}/private.jwk.json`), JSON.stringify(privateJwk), { mode: 0o600, flag: "wx" });
      writeFileSync(join(out, `keys/${kind}/public.jwks.json`), JSON.stringify({ keys: [publicJwk] }, null, 2), { flag: "wx" });
    }
    const redirectUrl = args.includes("--redirect-url") ? option(args, "--redirect-url") : "http://127.0.0.1:18100/oauth/callback";
    const config = {
      listen: { host: "127.0.0.1", port: 18100 }, allowedHosts: ["127.0.0.1:18100"], stateDirectory: "state",
      encryption: { provider: "development-file", keyFile: "state/sealing.key" },
      oauthRedirectUrl: redirectUrl,
      trust: { issuer: "https://router.example", callerKeys: "keys/caller/public.jwks.json", authorityKeys: "keys/authority/public.jwks.json" },
      connections: [
        { id: "github", kind: "github", owner, settings: { clientFile: "secrets/github-oauth.json" } },
        ...["gmail", "drive", "docs", "sheets", "slides", "calendar"].map((product) =>
          ({ id: `google-${product}`, kind: "google", owner, settings: { product, clientFile: "secrets/google-oauth.json" } })),
        { id: "feishu", kind: "feishu", owner, settings: { directory: "state/feishu" } },
        { id: "notion", kind: "notion", owner },
      ],
    };
    writeFileSync(join(out, "connectors.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    writeFileSync(join(out, ".gitignore"), "*\n", { flag: "wx" });
    console.log(JSON.stringify({ status: "created", config: join(out, "connectors.json"), next: "Configure OAuth applications, then serve and use connection connect." }));
    break;
  }
  case "connection": {
    const [action, candidateId] = args;
    if (!["status", "connect", "disconnect"].includes(action ?? "")) throw new Error(usage);
    const id = candidateId?.startsWith("--") ? undefined : candidateId;
    if (action !== "status" && !id) throw new Error("connection_id_required");
    const config = loadConfig(option(args, "--config"));
    if (id && !config.connections.some((c) => c.id === id)) throw new Error("connection_unknown");
    const keyFile = option(args, "--authority-key");
    if (process.platform !== "win32" && (statSync(keyFile).mode & 0o077) !== 0) throw new Error("authority_key_file_must_be_private");
    const privateJwk = JSON.parse(readFileSync(keyFile, "utf8"));
    const token = await signServiceToken({ key: { kid: privateJwk.kid, privateJwk }, issuer: config.trust.issuer,
      audience: config.trust.audience ?? "agent-connectors", service: "connector-cli" });
    const base = args.includes("--url") ? option(args, "--url") : `http://127.0.0.1:${config.listen.port}`;
    const url = new URL(`/v1/connections${id ? `/${encodeURIComponent(id)}` : ""}${action === "status" ? "" : `/${action}`}`, base);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
      throw new Error("service_url_must_be_https_or_loopback");
    const response = await fetch(url, { method: action === "status" ? "GET" : "POST", headers: { Authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(65_000) });
    console.log(JSON.stringify(await response.json(), null, 2));
    if (!response.ok) process.exitCode = 1;
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
    const connection = config.connections.find((c) => c.id === connectionId);
    if (!connection) throw new Error(`unknown connection ${connectionId}`);
    if (["github", "google", "notion"].includes(connection.kind)) throw new Error("use_connection_connect_for_oauth");
    const value = JSON.parse(readFileSync(0, "utf8"));
    const store = new Store(config.stateDirectory);
    store.putCredential(connectionId, await createSealer(config).seal(`credential:${connectionId}`, JSON.stringify(value)), new Date());
    store.close();
    break;
  }
  default:
    console.error(usage);
    process.exit(command ? 2 : 0);
}
