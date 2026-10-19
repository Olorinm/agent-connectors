import { join } from "node:path";
import type { Connector } from "../connector.js";
import { feishuConnector } from "./feishu/index.js";

/** Connectors available to the CLI. Relative connection paths resolve against the configuration file. */
export function builtinConnectors(options: { baseDirectory: string; stateDirectory: string }): Connector[] {
  return [feishuConnector({ baseDirectory: options.baseDirectory, classifierDirectory: join(options.stateDirectory, "lark-classifier") })];
}
export { feishuConnector, type FeishuOptions } from "./feishu/index.js";
