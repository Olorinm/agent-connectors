import type { Connector } from "../connector.js";
import { feishuConnector } from "./feishu/index.js";
import { remoteConnector } from "./remote/index.js";
import { googleConnector } from "./google/index.js";

/** Connectors available to the CLI. Relative connection paths resolve against the configuration file. */
export function builtinConnectors(options: { baseDirectory: string; stateDirectory: string; redirectUrl?: string;
  withSecretFiles?: <T>(operation: () => Promise<T>) => Promise<T> }): Connector[] {
  return [
    ...(["github", "notion"] as const).map((kind) => remoteConnector(kind, options)),
    googleConnector(options),
    feishuConnector({ baseDirectory: options.baseDirectory, withSecretFiles: options.withSecretFiles }),
  ];
}
export { feishuConnector, type FeishuOptions } from "./feishu/index.js";
export { remoteConnector } from "./remote/index.js";
export { googleConnector, type GoogleOptions } from "./google/index.js";
