import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "../../src/engine/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Build a host-independent IIFE using the Vite toolchain already used by this checkout. */
export async function buildEngine(outDir = path.join(root, "dist-engine")) {
  const { build } = await import("../../frontend-beta/node_modules/vite/dist/node/index.js");
  await mkdir(outDir, { recursive: true });
  await build({
    configFile: false, root, publicDir: false, logLevel: "silent",
    build: {
      outDir, emptyOutDir: false, minify: false, target: "es2022",
      lib: { entry: path.join(root, "src/engine/app-entry.js"), name: "CashflowEngine",
        formats: ["iife"], fileName: () => "cashflow-engine.js" }
    }
  });
  const artifact = await readFile(path.join(outDir, "cashflow-engine.js"));
  const manifest = { engineVersion: ENGINE_VERSION, protocolVersion: ENGINE_PROTOCOL_VERSION,
    format: "iife", globalName: "CashflowEngine", target: "es2022",
    file: "cashflow-engine.js", bytes: artifact.length,
    sha256: createHash("sha256").update(artifact).digest("hex") };
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}