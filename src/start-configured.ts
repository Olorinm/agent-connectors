import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { builtinConnectors } from "./connectors/index.js";
import { SecretFiles, secretPath } from "./secret-files.js";
import { createSealer, start, type Started } from "./start.js";

/** Public composition entrypoint: same encrypted application-file handling as the CLI. */
export async function startConfigured(file: string): Promise<Started> {
  const config = loadConfig(file);
  for (const connection of config.connections) {
    const path = connection.settings?.[connection.kind === "feishu" ? "directory" : "clientFile"];
    if (typeof path !== "string") continue;
    if (config.encryption.provider !== "development-file" && !config.secretFiles) throw new Error("application_files_require_encrypted_store");
    if (config.secretFiles) secretPath(path);
  }
  const files = config.secretFiles ? await SecretFiles.open(config.secretFiles.file, config.secretFiles.runtimeDirectory,
    createSealer(config), config.encryption.provider !== "development-file") : undefined;
  try {
    const started = await start(config, builtinConnectors({ baseDirectory: files?.directory ?? dirname(resolve(file)),
      stateDirectory: config.stateDirectory, redirectUrl: config.oauthRedirectUrl,
      ...(files ? { withSecretFiles: <T>(operation: () => Promise<T>) => files.run(operation) } : {}),
    }));
    return { ...started, close: async () => { try { await started.close(); } finally { await files?.close(); } } };
  } catch (error) { await files?.close(); throw error; }
}
