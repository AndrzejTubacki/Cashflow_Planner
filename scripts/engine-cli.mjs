import { readFile } from "node:fs/promises";
import vm from "node:vm";

// One request per process. The JSON result alone goes to stdout; this tool never
// writes budget storage. VM limits are a test boundary, not a security sandbox.
try {
  if (process.argv.length > 3) throw new Error("Usage: node scripts/engine-cli.mjs [request.json] (or JSON on stdin)");
  const request = process.argv[2]
    ? await readFile(process.argv[2], "utf8")
    : await new Promise((resolve, reject) => {
      let text = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { text += chunk; });
      process.stdin.on("end", () => resolve(text));
      process.stdin.on("error", reject);
    });
  if (request.length > 10 * 1024 * 1024) throw new Error("Request exceeds the 10 Mi-character limit");
  const bundle = await readFile(new URL("../dist-engine/cashflow-engine.js", import.meta.url), "utf8");
  const context = vm.createContext({ request });
  vm.runInContext(bundle, context, { timeout: 5000 });
  const response = vm.runInContext("CashflowEngine.calculateProjectionJson(request)", context, { timeout: 10000 });
  process.stdout.write(response + "\n");
  if (!JSON.parse(response).ok) process.exitCode = 1;
} catch (error) {
  console.error(`Engine runner failed: ${error.message}. Build first with npm run engine:build.`);
  process.exitCode = 1;
}