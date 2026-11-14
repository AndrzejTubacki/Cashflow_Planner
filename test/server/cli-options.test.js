import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArgs } from '../../scripts/lib/cli.mjs';
import { verifyPostgresMigrationCli } from '../../scripts/verify-postgres-migration.mjs';

/** Migration --apply must actually apply, while an explicit final --dry-run
 * must prevent writes. Real guarded migration CLI tests cover the database. */
test('migration CLI mode flags keep apply and dryRun consistent with the last explicit choice', () => {
  const config = { boolean: ['--apply'], string: ['--input'], defaults: { apply: false, dryRun: true, input: '' } };
  for (const [args, apply] of [[[], false], [['--apply'], true], [['--dry-run'], false],
    [['--apply', '--dry-run'], false], [['--dry-run', '--apply'], true]]) {
    const actual = parseCliArgs(args, config);
    assert.equal(actual.apply, apply);
    assert.equal(actual.dryRun, !apply);
  }
  assert.deepEqual(config.defaults, { apply: false, dryRun: true, input: '' });
  assert.throws(() => parseCliArgs(['--force-unchecked'], config), /Unknown argument/);
});

/** The documented flags must reach path validation before a database can be
 * used. A missing URL refuses without opening either a file or a connection. */
test('PostgreSQL verifier CLI maps documented export flags to its programmatic paths', async () => {
  await assert.rejects(verifyPostgresMigrationCli({ globalExport: '/owned-fixture/global.json',
    budgetExport: '/owned-fixture/budget.json', globalExportPath: '', budgetExportPath: '',
    databaseUrl: '' }), /CASHFLOW_DATABASE_URL is required/);
});
