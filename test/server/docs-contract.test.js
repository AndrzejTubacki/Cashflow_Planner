import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import en from "../../public/app/cashflow/locales/en.js";
import pl from "../../public/app/cashflow/locales/pl.js";
import * as sharedUtilities from "../../public/app/utils.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const publishedRouteFiles = [
  path.join(repoRoot, "server.mjs"),
  path.join(repoRoot, "src/server/cashflow-routes.js")
];
const openApiPath = path.join(repoRoot, "docs/openapi.yaml");
const privateRoutes = [
  "POST /api/restart",
  "POST /api/local/tests/run",
  "GET /api/local/tests/latest"
];
const obsoleteLocaleKeys = [
  "Fixed ledger currency - backend does not allow changing it.",
  "Only PLN transactions can project without supplied rates.",
  "Target in PLN",
  "Only PLN ledger currency is supported"
];

function expressRoutes(files) {
  const routes = new Set();
  const routePattern = /app\.(get|post|put|delete|patch)\("([^"]+)"/g;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(routePattern)) {
      const route = match[2].replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      routes.add(`${match[1].toUpperCase()} ${route}`);
    }
  }

  return routes;
}

function openApiOperations(source) {
  const lines = source.split(/\r?\n/);
  const operations = new Map();
  let currentPath = null;
  let currentOperation = null;

  for (const line of lines) {
    const pathMatch = line.match(/^  (\/[^:]+(?:\{[^}]+\}[^:]*)?):$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentOperation = null;
      continue;
    }

    const methodMatch = line.match(/^    (get|post|put|delete|patch):$/);
    if (currentPath && methodMatch) {
      currentOperation = `${methodMatch[1].toUpperCase()} ${currentPath}`;
      operations.set(currentOperation, "");
      continue;
    }

    if (currentOperation && /^      /.test(line)) {
      operations.set(currentOperation, `${operations.get(currentOperation)}\n${line}`);
    } else if (currentOperation && line.trim()) {
      currentOperation = null;
    }
  }

  return operations;
}

test("OpenAPI covers every published route with scope metadata", () => {
  const published = expressRoutes(publishedRouteFiles);
  const source = fs.readFileSync(openApiPath, "utf8");
  const operations = openApiOperations(source);

  assert.deepEqual([...operations.keys()].sort(), [...published].sort());

  for (const [operation, block] of operations) {
    assert.match(block, /x-cashflow-scope: (global-unscoped|user-scoped|admin-user-scoped|admin-global)/, operation);
    assert.match(block, /x-cashflow-mutating: (true|false)/, operation);
    assert.match(block, /x-cashflow-download-only: (true|false)/, operation);
  }

  for (const route of privateRoutes) {
    assert.equal(operations.has(route), false, route);
  }
});

test("OpenAPI version follows package.json", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const source = fs.readFileSync(openApiPath, "utf8");
  const version = source.match(/^  version: ([^\s]+)$/m)?.[1];

  assert.equal(version, packageJson.version);
});

test("private deployment routes are documented outside the published contract", () => {
  const apiGuide = fs.readFileSync(path.join(repoRoot, "docs/api.md"), "utf8");

  for (const route of privateRoutes) {
    assert.match(apiGuide, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("documentation links resolve", () => {
  const markdownFiles = [
    path.join(repoRoot, "README.md"),
    ...fs.readdirSync(path.join(repoRoot, "docs"))
      .filter(name => name.endsWith(".md") && !name.includes("sync-conflict"))
      .map(name => path.join(repoRoot, "docs", name))
  ];
  const missing = [];

  for (const file of markdownFiles) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0].trim();
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (!fs.existsSync(resolved)) missing.push(`${path.relative(repoRoot, file)} -> ${target}`);
    }
  }

  assert.deepEqual(missing, []);
});

test("locales stay in parity and omit obsolete PLN-only keys", () => {
  assert.deepEqual(Object.keys(pl.strings).sort(), Object.keys(en.strings).sort());

  for (const key of obsoleteLocaleKeys) {
    assert.equal(Object.hasOwn(en.strings, key), false, key);
    assert.equal(Object.hasOwn(pl.strings, key), false, key);
  }
});

test("shared frontend utilities contain no Dashboard-era helpers", () => {
  assert.deepEqual(Object.keys(sharedUtilities), ["escapeHtml"]);
});
