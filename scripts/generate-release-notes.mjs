#!/usr/bin/env node

/**
 * Generates Markdown release notes from git commits between the previous
 * semver tag (v*.*.*) and the specified target ref/tag.
 *
 * Groups commits by Conventional Commit prefix (feat, fix, refactor/perf,
 * docs, ci/chore/build/test, and other), includes commit body bullet points,
 * and appends GHCR container pull instructions and the compare link.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

function git(...args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export function parseConventionalCommit(subject) {
  const match = String(subject || "").trim().match(/^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (!match) {
    return {
      type: "other",
      scope: null,
      breaking: false,
      description: String(subject || "").trim()
    };
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2] || null,
    breaking: Boolean(match[3]),
    description: match[4].trim()
  };
}

export function categoryForType(type) {
  switch (type) {
    case "feat":
      return "features";
    case "fix":
    case "security":
      return "fixes";
    case "refactor":
    case "perf":
      return "improvements";
    case "docs":
      return "docs";
    case "ci":
    case "build":
    case "chore":
    case "test":
      return "maintenance";
    default:
      return "other";
  }
}

export function formatCommitEntry(commit, repoUrl) {
  const parsed = parseConventionalCommit(commit.subject);
  const shortSha = commit.sha.slice(0, 7);
  const shaLink = repoUrl ? `[${shortSha}](${repoUrl}/commit/${commit.sha})` : `\`${shortSha}\``;
  const scopePrefix = parsed.scope ? `**${parsed.scope}**: ` : "";
  const breakingBadge = parsed.breaking ? "**BREAKING**: " : "";
  const header = `- ${breakingBadge}${scopePrefix}${parsed.description} (${shaLink})`;

  const bodyLines = String(commit.body || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^co-authored-by:/i.test(line));

  if (bodyLines.length === 0) {
    return header;
  }

  const formattedBody = bodyLines.map(line => {
    if (line.startsWith("- ") || line.startsWith("* ")) {
      return `  ${line}`;
    }
    return `  - ${line}`;
  });

  return [header, ...formattedBody].join("\n");
}

export function buildReleaseNotes({
  version,
  tag,
  previousTag,
  commits,
  repository = "AndrzejTubacki/Cashflow_Planner"
}) {
  const repoUrl = repository ? `https://github.com/${repository}` : "";
  const imageRepo = repository ? `ghcr.io/${repository.toLowerCase()}` : "ghcr.io/andrzejtubacki/cashflow_planner";
  const cleanVersion = String(version || tag || "").replace(/^v/, "");

  const sections = [
    { key: "features", title: "### Features", items: [] },
    { key: "fixes", title: "### Bug Fixes & Security", items: [] },
    { key: "improvements", title: "### Refactoring & Improvements", items: [] },
    { key: "docs", title: "### Documentation", items: [] },
    { key: "maintenance", title: "### Maintenance & CI", items: [] },
    { key: "other", title: "### Other Changes", items: [] }
  ];
  const byKey = Object.fromEntries(sections.map(section => [section.key, section]));

  for (const commit of commits) {
    const parsed = parseConventionalCommit(commit.subject);
    if (parsed.type === "chore" && parsed.scope === "release" && /^v?\d+\.\d+\.\d+/.test(parsed.description)) {
      continue;
    }
    const key = categoryForType(parsed.type);
    byKey[key].items.push(formatCommitEntry(commit, repoUrl));
  }

  const lines = ["## What's Changed", ""];
  const populated = sections.filter(section => section.items.length > 0);

  if (populated.length === 0) {
    lines.push(`- Release ${tag || `v${cleanVersion}`}`);
    lines.push("");
  } else {
    for (const section of populated) {
      lines.push(section.title);
      lines.push(...section.items);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("### Container Image");
  lines.push("```sh");
  lines.push(`docker pull ${imageRepo}:${cleanVersion || "latest"}`);
  lines.push("```");

  if (repoUrl && previousTag && tag) {
    lines.push("");
    lines.push(`**Full Changelog**: ${repoUrl}/compare/${previousTag}...${tag}`);
  }

  return `${lines.join("\n").trim()}\n`;
}

function getVersionTags() {
  const raw = git("tag", "--list", "v*.*.*", "--sort=version:refname");
  return raw ? raw.split(/\r?\n/).map(item => item.trim()).filter(Boolean) : [];
}

function resolvePreviousTag(targetRef) {
  const tags = getVersionTags();
  if (tags.length === 0) return null;

  const targetIndex = tags.indexOf(targetRef);
  if (targetIndex > 0) {
    return tags[targetIndex - 1];
  }
  if (targetIndex === 0) {
    return null;
  }

  try {
    const described = git("describe", "--tags", "--abbrev=0", "--match", "v*.*.*", `${targetRef}^`);
    if (described) return described;
  } catch {
    // Fallback to latest version tag when targetRef has no parent tag match.
  }

  return tags[tags.length - 1] || null;
}

function readGitCommits(rangeSpec) {
  const recordSep = "\x1e";
  const fieldSep = "\x1f";
  const format = `${recordSep}%H${fieldSep}%s${fieldSep}%b`;
  const args = ["log", "--no-merges", `--pretty=format:${format}`];
  if (rangeSpec) args.push(rangeSpec);

  const raw = git(...args);
  if (!raw) return [];

  return raw
    .split(recordSep)
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map(chunk => {
      const [sha = "", subject = "", body = ""] = chunk.split(fieldSep);
      return {
        sha: sha.trim(),
        subject: subject.trim(),
        body: body.trim()
      };
    })
    .filter(commit => Boolean(commit.sha));
}

function parseCliArgs(argv) {
  const options = {
    tag: "",
    from: "",
    to: "HEAD",
    output: "",
    repository: process.env.GITHUB_REPOSITORY || "AndrzejTubacki/Cashflow_Planner"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag" && argv[i + 1]) {
      options.tag = argv[++i];
    } else if (arg === "--from" && argv[i + 1]) {
      options.from = argv[++i];
    } else if (arg === "--to" && argv[i + 1]) {
      options.to = argv[++i];
    } else if (arg === "--output" && argv[i + 1]) {
      options.output = argv[++i];
    } else if (arg === "--repo" && argv[i + 1]) {
      options.repository = argv[++i];
    }
  }

  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseCliArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const tag = options.tag || process.env.GITHUB_REF_NAME || `v${pkg.version}`;

  if (!process.env.GITHUB_ACTIONS) {
    try {
      git("fetch", "--tags", "--quiet", "origin");
    } catch {
      // Offline or no origin remote reachable; proceed with local git history.
    }
  }

  let targetRef = options.to;
  try {
    git("rev-parse", "--verify", tag);
    if (!options.to || options.to === "HEAD") {
      targetRef = tag;
    }
  } catch {
    // Tag does not exist yet locally; compare up to HEAD.
  }

  const previousTag = options.from || resolvePreviousTag(targetRef);
  const rangeSpec = previousTag ? `${previousTag}..${targetRef}` : targetRef;
  const commits = readGitCommits(rangeSpec);

  const markdown = buildReleaseNotes({
    version: tag.replace(/^v/, ""),
    tag,
    previousTag,
    commits,
    repository: options.repository
  });

  if (options.output) {
    fs.writeFileSync(path.resolve(options.output), markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
}
