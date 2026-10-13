import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresGlobalSchemaSql, POSTGRES_GLOBAL_COLUMNS } from "../../src/server/cashflow-postgres-global-schema.js";
import { createPostgresBudgetStorageSchemaSql, POSTGRES_BUDGET_COLUMNS } from "../../src/server/cashflow-postgres-budget-schema.js";

// Runs without Postgres: parses the generated DDL text itself rather than
// executing it, so it still catches a missing trailing comma between two
// column definitions (commit 4775aa6 dropped 18 of them when appending
// DEFERRABLE INITIALLY IMMEDIATE to FK columns) even in an environment with
// no database to connect to.

const STRUCTURAL_KEYWORDS = new Set(["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"]);

// Splits the text between a table's outer parentheses into its
// comma-separated column/constraint definitions, respecting nested
// parens (e.g. REFERENCES accounts(id), CHECK (x IN (...))) and single-
// quoted string literals so a comma or paren inside either is not
// mistaken for a top-level separator.
function splitTopLevelClauses(body) {
  const clauses = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      clauses.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) clauses.push(current.trim());
  return clauses;
}

function stripLineComments(sql) {
  return sql.split("\n").map(line => line.replace(/--.*$/, "")).join("\n");
}

function extractCreateTableBodies(rawSql) {
  const sql = stripLineComments(rawSql);
  const bodies = new Map();
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(/g;
  let match;
  while ((match = re.exec(sql))) {
    const tableName = match[1];
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (depth > 0 && i < sql.length) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      i++;
    }
    bodies.set(tableName, sql.slice(start, i - 1));
  }
  return bodies;
}

function assertEveryColumnStartsExactlyOneClause(tableName, body, columns) {
  const clauses = splitTopLevelClauses(body);
  const seenColumns = [];
  for (const clause of clauses) {
    const leadingWord = clause.match(/^"?(\w+)"?\s/)?.[1] || clause.match(/^"?(\w+)"?$/)?.[1];
    assert.ok(leadingWord, `${tableName}: could not read a leading identifier from clause "${clause}"`);
    if (STRUCTURAL_KEYWORDS.has(leadingWord.toUpperCase())) continue;
    seenColumns.push(leadingWord);
  }
  // A missing comma merges two definitions into one clause: the swallowed
  // column's name never starts its own clause, so it goes missing here
  // without any extra/duplicate clause appearing to hint at the merge.
  assert.deepEqual(
    seenColumns,
    columns,
    `${tableName}: parsed column-clause starts do not match POSTGRES_*_COLUMNS - a missing comma between definitions would produce exactly this symptom (a swallowed column name)`
  );
}

test("generated Postgres global schema SQL has no missing commas between column definitions", () => {
  const sql = createPostgresGlobalSchemaSql({ includeTransaction: false });
  const bodies = extractCreateTableBodies(sql);
  assert.ok(bodies.size > 0, "expected at least one CREATE TABLE statement");
  for (const [tableName, columns] of Object.entries(POSTGRES_GLOBAL_COLUMNS)) {
    const body = bodies.get(tableName);
    assert.ok(body, `expected a CREATE TABLE IF NOT EXISTS ${tableName} statement in the generated SQL`);
    assertEveryColumnStartsExactlyOneClause(tableName, body, columns);
  }
});

test("generated Postgres budget schema SQL has no missing commas between column definitions", () => {
  const sql = createPostgresBudgetStorageSchemaSql({ includeTransaction: false });
  const bodies = extractCreateTableBodies(sql);
  assert.ok(bodies.size > 0, "expected at least one CREATE TABLE statement");
  for (const [tableName, columns] of Object.entries(POSTGRES_BUDGET_COLUMNS)) {
    const body = bodies.get(tableName);
    assert.ok(body, `expected a CREATE TABLE IF NOT EXISTS ${tableName} statement in the generated SQL`);
    assertEveryColumnStartsExactlyOneClause(tableName, body, columns);
  }
});
