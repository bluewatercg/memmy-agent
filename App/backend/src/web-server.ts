import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createLocalBackend } from "./index.js";

const host = process.env.MEMMY_BACKEND_HOST ?? "0.0.0.0";
const port = parsePort(process.env.MEMMY_BACKEND_PORT ?? "18100");
const databasePath = resolve(process.env.MEMMY_BACKEND_DB ?? "/data/app.sqlite");
const configPath = resolve(process.env.MEMMY_CONFIG ?? "/config/config.yaml");
const runtimeConfigPath = resolve(process.env.MEMMY_RUNTIME_CONFIG ?? "/data/runtime.json");
const localToken = requireEnv("MEMMY_BACKEND_TOKEN");
const memoryBaseUrl = requireEnv("MEMMY_MEMORY_LAYER_URL");
const memoryToken = requireEnv("MEMMY_MEMORY_LAYER_TOKEN");

await mkdir(dirname(databasePath), { recursive: true });
await mkdir(dirname(configPath), { recursive: true });
await mkdir(dirname(runtimeConfigPath), { recursive: true });

const backend = await createLocalBackend({
  databasePath,
  memmyConfigPath: configPath,
  runtimeConfigPath,
  localToken,
  memoryBaseUrl,
  memoryToken,
  listenHost: host,
  listenPort: port,
  agentSourceAutoScanInitialDelayMs: 0
});

const close = async () => {
  await backend.close();
};
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string): number {
  const portValue = Number.parseInt(value, 10);
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return portValue;
}
