import { buildEngine } from "./lib/engine-build.mjs";

try {
  console.log(JSON.stringify(await buildEngine(), null, 2));
} catch (error) {
  console.error(`Engine build failed: ${error.message}`);
  console.error("Install the locked frontend toolchain with: npm --prefix frontend-beta ci --legacy-peer-deps");
  process.exitCode = 1;
}