import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const exec = promisify(execFile);
const docker = (...args) => exec(process.env.CASHFLOW_CONTAINER_ENGINE || 'docker', args, { maxBuffer: 8 * 1024 * 1024 });

// This is deliberately an actual image test, not a Dockerfile text assertion.
// Opt-in execution fails (rather than skips) if no engine/daemon is available.
test('runtime image initializes as non-root with only data/log volumes writable', {
  skip: process.env.CASHFLOW_ENABLE_CONTAINER_TESTS !== '1' && 'run npm run test:container',
  timeout: 600_000
}, async t => {
  const name = `cashflow-readonly-${crypto.randomUUID()}`;
  const dataVolume = `${name}-data`;
  const logVolume = `${name}-logs`;
  let containerCreated = false;
  try {
    await docker('build', '--target', 'runtime', '-t', name, '.');
    await docker('run', '-d', '--name', name, '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--mount', `type=volume,source=${dataVolume},target=/app/data`,
      '--mount', `type=volume,source=${logVolume},target=/app/logs`,
      '-e', 'CASHFLOW_DB_BACKEND=sqlite', '-e', 'CASHFLOW_RUNTIME_LOCK_BACKEND=none',
      '-e', 'CASHFLOW_MIRROR_LOGS_TO_STDOUT=1', name);
    containerCreated = true;
    const inspection = JSON.parse((await docker('inspect', name)).stdout)[0];
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspection.Config.User, 'node');
    assert.deepEqual(inspection.Mounts.filter(mount => mount.RW).map(mount => mount.Destination).sort(),
      ['/app/data', '/app/logs']);
    // Exercise networking from inside the actual immutable container; no host
    // port reservation or privileged host ownership changes are necessary.
    const probe = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      (async () => {
        assert.equal(process.getuid(), 1000);
        assert.equal(process.getgid(), 1000);
        const serverIdentity = fs.readFileSync('/proc/1/status', 'utf8');
        assert.match(serverIdentity, /^Uid:\\s+1000\\s+1000/m);
        assert.match(serverIdentity, /^Gid:\\s+1000\\s+1000/m);
        // /tmp is normally world-writable: require EROFS, not a permission
        // denial that could also happen with an accidentally writable root.
        assert.throws(() => fs.writeFileSync('/tmp/cashflow-read-only-proof', 'x'),
          error => error.code === 'EROFS');
        const tempProof = process.env.TMPDIR + '/cashflow-write-proof';
        fs.writeFileSync(tempProof, 'ok');
        fs.unlinkSync(tempProof);
        for (let n = 0; n < 100; n++) {
          try { if ((await fetch('http://127.0.0.1:3000/healthz')).ok) break; } catch {}
          await new Promise(r => setTimeout(r, 100));
        }
        for (const route of ['/healthz', '/readyz', '/api/system']) {
          const res = await fetch('http://127.0.0.1:3000' + route);
          assert.equal(res.status, 200, route);
        }
        const created = await fetch('http://127.0.0.1:3000/api/users', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({userId: 'container_test', displayName: 'Container Test'})
        });
        const user = await created.json();
        assert.ok(created.ok, JSON.stringify(user));
        const cookie = created.headers.getSetCookie()[0].split(';')[0];
        const setup = await fetch('http://127.0.0.1:3000/api/setup', {
          method: 'POST', headers: { 'content-type': 'application/json', cookie,
            'x-cashflow-csrf-token': user.csrfToken },
          body: JSON.stringify({ currency: 'PLN', opening_balance: 1000,
            income_enabled: true, income_name: 'Salary', income_amount: 5000,
            income_anchor_day: 10, future_periods: 6, timezone: 'Europe/Warsaw',
            holiday_country: 'PL', locale: 'en' })
        });
        const initialized = await setup.json();
        assert.equal(setup.status, 200, JSON.stringify(initialized));
        assert.equal(initialized.setup.ok, true);
        assert.equal(initialized.setup._projection.projection_ok, true);
        assert.equal((await fetch('http://127.0.0.1:3000/api', {headers:{cookie}})).status, 200);
        assert.equal((await fetch('http://127.0.0.1:3000/readyz')).status, 200);
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    await docker('exec', name, 'node', '-e', probe);
    await docker('stop', '--time', '15', name);
    const { stdout } = await docker('inspect', '--format', '{{.State.ExitCode}}', name);
    assert.equal(stdout.trim(), '0');
    const logs = await docker('logs', name);
    assert.doesNotMatch(logs.stdout + logs.stderr, /server_shutdown_failed|server_shutdown_timeout|EACCES|EROFS/);
    assert.match(logs.stdout, /server_shutdown_complete/);
    t.diagnostic('UID/GID 1000; PID 1 non-root; root writes return EROFS; only data/log mounts writable; budget setup/projection, health/readiness/API and graceful shutdown passed.');
  } catch (error) {
    // Preserve disposable-container startup failures before cleanup removes it.
    if (containerCreated) {
      const logs = await docker('logs', name).catch(() => null);
      if (logs) t.diagnostic(logs.stdout + logs.stderr);
    }
    throw error;
  } finally {
    if (containerCreated) await docker('rm', '-f', name);
    await docker('volume', 'rm', dataVolume, logVolume).catch(() => {});
    await docker('image', 'rm', name).catch(() => {});
  }
});
