import path from "node:path";
import { fileURLToPath } from "node:url";

export const sandboxRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Pin the development process to this checkout's own SQLite storage, not inherited deployment settings. */
export function sandboxEnvironment(env = process.env) {
  const port = env.CASHFLOW_SANDBOX_PORT || "3301";
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
    throw new Error("CASHFLOW_SANDBOX_PORT must be an integer from 1024 to 65535");
  }
  return {
    ...env,
    PORT: port,
    CASHFLOW_BIND_HOST: "127.0.0.1",
    DATA_DIR: path.join(sandboxRoot, ".sandbox-runtime", "data"),
    LOGS_DIR: path.join(sandboxRoot, ".sandbox-runtime", "logs"),
    CASHFLOW_DB_BACKEND: "sqlite",
    CASHFLOW_DATABASE_URL: "",
    CASHFLOW_RUNTIME_LOCK_BACKEND: "none",
    CASHFLOW_RUNTIME_LOCK_DATABASE_URL: "",
    CASHFLOW_ENABLE_POSTGRES_TESTS: "0",
    CASHFLOW_MIRROR_LOGS_TO_STDOUT: "1"
  };
}