import type { AddressInfo } from "node:net";
import type { LoadedConfig } from "./config.js";
import type { Connector } from "./connector.js";
import { Sealer, EnvelopeSealer, type ValueSealer } from "./sealer.js";
import { GoogleKmsWrapper } from "./google-kms.js";
import { createHttpServer } from "./server.js";
import { ConnectorService } from "./service.js";
import { Store } from "./store.js";
import { TokenVerifier } from "./tokens.js";

export interface Started {
  url: string;
  service: ConnectorService;
  close(): Promise<void>;
}

export async function start(config: LoadedConfig, connectors: Connector[]): Promise<Started> {
  if (config.encryption.provider === "development-file" && !["127.0.0.1", "::1"].includes(config.listen.host))
    throw new Error("development_encryption_requires_loopback");
  const sealer = createSealer(config);
  // Verify IAM, key state, WIF and encryption before accepting requests.
  if (config.encryption.provider === "google-cloud-kms") {
    const probe = await sealer.seal("startup-check", "ready");
    if (await sealer.open("startup-check", probe) !== "ready") throw new Error("kms_startup_check_failed");
  }
  const store = new Store(config.stateDirectory);
  const service = new ConnectorService({
    connectors, connections: config.connections, store, sealer,
    ...(config.operationTtlSeconds ? { operationTtlSeconds: config.operationTtlSeconds } : {}),
  });
  const server = createHttpServer({ service, tokens: new TokenVerifier(config.trust), ...(config.allowedHosts ? { allowedHosts: config.allowedHosts } : {}) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    service,
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        store.close();
        resolve();
      });
      server.closeAllConnections();
    }),
  };
}

export function createSealer(config: LoadedConfig): ValueSealer {
  return config.encryption.provider === "development-file" ? new Sealer(config.encryption.key) :
    new EnvelopeSealer(new GoogleKmsWrapper(config.encryption));
}
