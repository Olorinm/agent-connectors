import type { AddressInfo } from "node:net";
import type { LoadedConfig } from "./config.js";
import type { Connector } from "./connector.js";
import { Sealer } from "./sealer.js";
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
  const store = new Store(config.stateDirectory);
  const sealer = new Sealer(config.sealingKey);
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
