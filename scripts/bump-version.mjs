#!/usr/bin/env node

/**
 * Bumps the Cashflow version across package.json, package-lock.json, and
 * dev/openapi.yaml (when present locally), and creates the corresponding
 * local git tag (`vX.Y.Z`).
 *
 * Intentionally does NOT run git commit or git push so the operator stays in
 * full control of when changes are committed and pushed.
 *
 * Usage:
 *   npm run version:bump -- patch
 *   npm run version:bump -- minor
 *   npm run version:bump -- major
 *   npm run version:bump -- 1.2.0
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Computes the next semantic version from a current version and a target
 * specifier ("patch", "minor", "major", or an explicit "X.Y.Z" version).
 */
export function resolveNextVersion(currentVersion, targetSpec) {
  const currentMatch = String(currentVersion || "").trim().match(SEMVER_PATTERN);
  if (!currentMatch) {
    throw new Error(`Invalid current version in package.json: ${currentVersion}`);
  }

  const spec = String(targetSpec || "").trim().replace(/^v/, "");
  if (!spec) {
    throw new Error("Usage: npm run version:bump -- <patch|minor|major|X.Y.Z>");
  }

  const major = Number(currentMatch[1]);
  const minor = Number(currentMatch[2]);
  const patch = Number(currentMatch[3]);

  if (spec === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }
  if (spec === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  if (spec === "major") {
    return `${major + 1}.0.0`;
  }

  if (!SEMVER_PATTERN.test(spec)) {
    throw new Error(`Invalid target version "${targetSpec}". Expected patch, minor, major, or X.Y.Z`);
  }

  return spec;
}

/**
 * Updates the version across root package.json, package-lock.json, and
 * dev/openapi.yaml (if present in the given rootDir), and optionally creates
 * a dedicated release commit (`chore(release): vX.Y.Z`) and local `vX.Y.Z`
 * git tag.
 */
export function bumpProjectVersion(rootDir, targetSpec, { createGitTag = true, commitRelease = false } = {}) {
  const pkgPath = path.join(rootDir, "package.json");
  const lockPath = path.join(rootDir, "package-lock.json");
  const openApiPath = path.join(rootDir, "dev", "openapi.yaml");
  const hasGit = fs.existsSync(path.join(rootDir, ".git"));

  if (commitRelease && hasGit) {
    const dirtyTracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: rootDir,
      encoding: "utf8"
    }).trim();
    if (dirtyTracked) {
      throw new Error(
        "Working tree has uncommitted tracked changes. Commit your feature/fix changes first before running version:bump."
      );
    }
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const previousVersion = pkg.version;
  const nextVersion = resolveNextVersion(previousVersion, targetSpec);

  pkg.version = nextVersion;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  const updatedFiles = ["package.json"];

  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.version = nextVersion;
    if (lock.packages && lock.packages[""]) {
      lock.packages[""].version = nextVersion;
    }
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    updatedFiles.push("package-lock.json");
  }

  if (fs.existsSync(openApiPath)) {
    const openApi = fs.readFileSync(openApiPath, "utf8");
    const updatedOpenApi = openApi.replace(/^(  version:\s*)([^\r\n]+)$/m, `$1${nextVersion}`);
    fs.writeFileSync(openApiPath, updatedOpenApi, "utf8");
    updatedFiles.push("dev/openapi.yaml");
  }

  const tag = `v${nextVersion}`;
  if (hasGit) {
    try {
      execFileSync("git", ["fetch", "--tags", "--quiet", "origin"], {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      // Offline or no 'origin' remote configured (e.g., isolated test repos); proceed with local tags.
    }

    if (commitRelease) {
      const gitFiles = ["package.json"];
      if (fs.existsSync(lockPath)) gitFiles.push("package-lock.json");
      execFileSync("git", ["add", ...gitFiles], {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "pipe"]
      });
      execFileSync("git", ["commit", "-m", `chore(release): ${tag}`], {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "pipe"]
      });
    }

    if (createGitTag) {
      execFileSync("git", ["tag", "-a", "-f", tag, "-m", `Release ${tag}`], {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "pipe"]
      });
    }
  }

  return {
    previousVersion,
    nextVersion,
    tag,
    updatedFiles
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const noCommit = args.includes("--no-commit");
  const targetSpec = args.find(arg => !arg.startsWith("--"));
  try {
    const { previousVersion, nextVersion, tag, updatedFiles } = bumpProjectVersion(repoRoot, targetSpec, {
      createGitTag: true,
      commitRelease: !noCommit
    });
    console.log(`Bumped Cashflow version: ${previousVersion} -> ${nextVersion} (tagged ${tag})`);
    console.log(`Updated files: ${updatedFiles.join(", ")}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

