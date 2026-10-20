import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import en from "../../public/app/cashflow/locales/en.js";
import pl from "../../public/app/cashflow/locales/pl.js";
import * as sharedUtilities from "../../public/app/utils.js";
import { bumpProjectVersion, resolveNextVersion } from "../../scripts/bump-version.mjs";
import { buildReleaseNotes } from "../../scripts/generate-release-notes.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const publishedRouteFiles = [
  path.join(repoRoot, "server.mjs"),
  path.join(repoRoot, "src/server/cashflow-routes.js")
];
// dev/ holds the technical/developer docs (API reference, OpenAPI spec,
// architecture notes) and is gitignored — private working reference, not
// part of the published repository. These contract checks only run when it
// exists locally (skip gracefully on a fresh checkout that never had it).
const devDocsDir = path.join(repoRoot, "dev");
const devDocsPresent = fs.existsSync(devDocsDir);
const devDocsSkipReason = "dev/ is gitignored and not present in this checkout";
const openApiPath = path.join(devDocsDir, "openapi.yaml");
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

test("OpenAPI covers every published route with scope metadata", { skip: devDocsPresent ? false : devDocsSkipReason }, () => {
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

test("OpenAPI version follows package.json", { skip: devDocsPresent ? false : devDocsSkipReason }, () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const source = fs.readFileSync(openApiPath, "utf8");
  const version = source.match(/^  version: ([^\s]+)$/m)?.[1];

  assert.equal(version, packageJson.version);
});

test("private deployment routes are documented outside the published contract", { skip: devDocsPresent ? false : devDocsSkipReason }, () => {
  const apiGuide = fs.readFileSync(path.join(devDocsDir, "api.md"), "utf8");

  for (const route of privateRoutes) {
    assert.match(apiGuide, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("documentation links resolve", () => {
  const markdownFiles = [
    path.join(repoRoot, "README.md"),
    ...fs.readdirSync(path.join(repoRoot, "docs"))
      .filter(name => name.endsWith(".md") && !name.includes("sync-conflict"))
      .map(name => path.join(repoRoot, "docs", name)),
    // dev/ is gitignored and may not exist in every checkout, but check its
    // own internal links too whenever it is present locally.
    ...(devDocsPresent
      ? fs.readdirSync(devDocsDir)
        .filter(name => name.endsWith(".md") && !name.includes("sync-conflict"))
        .map(name => path.join(devDocsDir, name))
      : [])
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

// Enforces the PolyForm-Noncommercial-1.0.0 licensing policy across root and
// frontend-beta manifests, lockfiles, and LICENSE / THIRD_PARTY_NOTICES.md.
const allowedRuntimeLicenses = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "BlueOak-1.0.0",
  "(BSD-2-Clause OR MIT OR Apache-2.0)",
  "(MIT OR WTFPL)"
]);

test("project and runtime dependencies comply with PolyForm-Noncommercial-1.0.0 licensing policy", () => {
  const licenseText = fs.readFileSync(path.join(repoRoot, "LICENSE"), "utf8");
  assert.match(licenseText, /SPDX-License-Identifier: PolyForm-Noncommercial-1\.0\.0/);
  assert.match(licenseText, /## Acceptance/);
  assert.match(licenseText, /## Distribution License/);

  assert.equal(fs.existsSync(path.join(repoRoot, "THIRD_PARTY_NOTICES.md")), true);

  for (const relDir of ["", "frontend-beta"]) {
    const dir = path.join(repoRoot, relDir);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"));

    assert.equal(pkg.license, "PolyForm-Noncommercial-1.0.0", `${relDir || "root"}/package.json`);
    assert.equal(lock.packages?.[""]?.license, "PolyForm-Noncommercial-1.0.0", `${relDir || "root"}/package-lock.json`);

    for (const [pkgPath, info] of Object.entries(lock.packages || {})) {
      if (!pkgPath || info.dev) continue;
      let lic = info.license;
      if (!lic) {
        const diskPkgPath = path.join(dir, pkgPath, "package.json");
        if (fs.existsSync(diskPkgPath)) {
          lic = JSON.parse(fs.readFileSync(diskPkgPath, "utf8")).license;
        }
      }
      assert.equal(
        allowedRuntimeLicenses.has(lic),
        true,
        `Disallowed or missing runtime dependency license in ${relDir || "root"}: ${pkgPath} (${lic || "unspecified"})`
      );
    }
  }
});

test("GitHub automation workflows and Dependabot configuration stay present and valid", () => {
  const workflowFiles = [
    ".github/workflows/ci.yml",
    ".github/workflows/security.yml",
    ".github/workflows/release.yml",
    ".github/dependabot.yml"
  ];

  for (const relPath of workflowFiles) {
    const fullPath = path.join(repoRoot, relPath);
    assert.equal(fs.existsSync(fullPath), true, `Missing ${relPath}`);
    const content = fs.readFileSync(fullPath, "utf8");
    assert.ok(content.trim().length > 0, `Empty ${relPath}`);
  }

  const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /npm run test:node/);
  assert.match(ci, /npm run test:postgres/);
  assert.match(ci, /npm run test:browser/);
  assert.match(ci, /npm run test:container/);
});

test("version:bump updates package.json, package-lock.json, and dev/openapi.yaml and creates local git tag", () => {
  assert.equal(resolveNextVersion("1.1.5", "patch"), "1.1.6");
  assert.equal(resolveNextVersion("1.1.5", "minor"), "1.2.0");
  assert.equal(resolveNextVersion("1.1.5", "major"), "2.0.0");
  assert.equal(resolveNextVersion("1.1.5", "v1.4.2"), "1.4.2");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-version-bump-"));
  try {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDir, stdio: "ignore" });
    fs.mkdirSync(path.join(tempDir, "dev"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "cashflow", version: "1.1.5" }, null, 2));
    fs.writeFileSync(
      path.join(tempDir, "package-lock.json"),
      JSON.stringify({ name: "cashflow", version: "1.1.5", packages: { "": { name: "cashflow", version: "1.1.5" } } }, null, 2)
    );
    fs.writeFileSync(path.join(tempDir, "dev", "openapi.yaml"), "openapi: 3.1.0\ninfo:\n  title: Cashflow API\n  version: 1.1.5\n");
    execFileSync("git", ["add", "package.json"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tempDir, stdio: "ignore" });

    const result = bumpProjectVersion(tempDir, "patch");
    assert.equal(result.previousVersion, "1.1.5");
    assert.equal(result.nextVersion, "1.1.6");
    assert.equal(result.tag, "v1.1.6");
    assert.deepEqual(result.updatedFiles, ["package.json", "package-lock.json", "dev/openapi.yaml"]);

    assert.equal(JSON.parse(fs.readFileSync(path.join(tempDir, "package.json"), "utf8")).version, "1.1.6");
    const lock = JSON.parse(fs.readFileSync(path.join(tempDir, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "1.1.6");
    assert.equal(lock.packages[""].version, "1.1.6");
    assert.match(fs.readFileSync(path.join(tempDir, "dev", "openapi.yaml"), "utf8"), /^  version: 1\.1\.6$/m);
    const tags = execFileSync("git", ["tag", "-l"], { cwd: tempDir, encoding: "utf8" }).trim();
    assert.equal(tags, "v1.1.6");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("release:notes formats Conventional Commits and container pull instructions", () => {
  const markdown = buildReleaseNotes({
    version: "1.1.5",
    tag: "v1.1.5",
    previousTag: "v1.1.4",
    repository: "AndrzejTubacki/Cashflow_Planner",
    commits: [
      {
        sha: "96e9dca1234567890",
        subject: "feat: add optional end month for recurring expenses and incomes",
        body: "- Introduced `end_month_year` field\n- Updated frontend forms"
      },
      {
        sha: "70092ad1234567890",
        subject: "fix(security): harden notification destination validation",
        body: ""
      }
    ]
  });

  assert.match(markdown, /### Features/);
  assert.match(markdown, /- add optional end month for recurring expenses and incomes \(\[96e9dca\]/);
  assert.match(markdown, /  - Introduced `end_month_year` field/);
  assert.match(markdown, /### Bug Fixes & Security/);
  assert.match(markdown, /- \*\*security\*\*: harden notification destination validation/);
  assert.match(markdown, /docker pull ghcr\.io\/andrzejtubacki\/cashflow_planner:1\.1\.5/);
  assert.match(markdown, /\*\*Full Changelog\*\*: https:\/\/github\.com\/AndrzejTubacki\/Cashflow_Planner\/compare\/v1\.1\.4\.\.\.v1\.1\.5/);
});
