import fs from "node:fs";
import path from "node:path";

export function isMainModule(fileUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(new URL(fileUrl).pathname);
}

export function parseCliArgs(argv, config) {
  const options = { ...config.defaults, help: false };
  const booleanFlags = config.boolean || [];
  const stringFlags = config.string || [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run" && booleanFlags.includes("--apply")) {
      options.apply = false;
    } else if (booleanFlags.includes(arg)) {
      const key = arg.slice(2).replace(/-([a-z])/g, g => g[1].toUpperCase());
      options[key] = true;
    } else if (stringFlags.includes(arg)) {
      const key = arg.slice(2).replace(/-([a-z])/g, g => g[1].toUpperCase());
      options[key] = argv[index + 1] || "";
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}
