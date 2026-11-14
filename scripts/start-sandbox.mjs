import { spawn } from "node:child_process";
import { sandboxEnvironment, sandboxRoot } from "./lib/sandbox-runtime.mjs";

// No automatic account creation or destructive resets: the user owns this sandbox.
const env = sandboxEnvironment();
console.log(`Cashflow sandbox: http://127.0.0.1:${env.PORT}/`);
console.log(`SQLite data: ${env.DATA_DIR}`);
const child = spawn(process.execPath, ["server.mjs"], { cwd: sandboxRoot, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { if (!child.killed) child.kill(signal); });
}
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });