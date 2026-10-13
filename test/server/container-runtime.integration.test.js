import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    // The entrypoint starts as root to fix a fresh bind mount's ownership and
    // then drops to node via setpriv - that handoff itself needs CHOWN,
    // SETUID and SETGID, so a hardened deployment adds those three back
    // instead of a bare --cap-drop=ALL. They are not available to the final
    // long-running process: the kernel clears a process's capabilities on a
    // root -> non-root UID transition unless it explicitly asks to keep them
    // (setpriv does not), which the probe below confirms by exercising an
    // operation (chown) that capability would allow if it had leaked through.
    await docker('run', '-d', '--name', name, '--read-only',
      '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=SETUID', '--cap-add=SETGID',
      '--security-opt=no-new-privileges',
      '--mount', `type=volume,source=${dataVolume},target=/app/data`,
      '--mount', `type=volume,source=${logVolume},target=/app/logs`,
      '-e', 'CASHFLOW_DB_BACKEND=sqlite', '-e', 'CASHFLOW_RUNTIME_LOCK_BACKEND=none',
      '-e', 'CASHFLOW_MIRROR_LOGS_TO_STDOUT=1', name);
    containerCreated = true;
    const inspection = JSON.parse((await docker('inspect', name)).stdout)[0];
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    // The image declares no USER: it starts as root so docker-entrypoint.sh
    // can chown a fresh bind-mounted volume (Docker creates an absent host
    // directory as root:root before the container starts), then drops to
    // node via setpriv before exec-ing the real command. The probe below
    // confirms PID 1 actually ends up running as uid/gid 1000.
    assert.equal(inspection.Config.User, '');
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
        // CHOWN/SETUID/SETGID were only added back for the entrypoint's
        // root-to-node handoff; confirm they did not leak into the final
        // process's effective/permitted sets after that UID transition.
        assert.match(serverIdentity, /^CapEff:\\s+0+$/m);
        assert.match(serverIdentity, /^CapPrm:\\s+0+$/m);
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
    // Without an explicit --user, docker exec would run this probe as root
    // (the container's default now that the image declares no USER) even
    // though PID 1 correctly dropped to node — pin it the same way a real
    // operational exec into the container would need to.
    await docker('exec', '--user', 'node', name, 'node', '-e', probe);
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

// A named Docker volume (used above) is pre-chowned by Docker to the image's
// declared owner, so it can never reproduce the bug this test targets. A
// fresh bind-mount host directory is created as root:root instead, which a
// non-root entrypoint could never chown. This is the exact `docker run -v
// ./data:/app/data` / docker-compose pattern operators actually use.
test('runtime image fixes ownership of a fresh root-owned bind mount instead of crash-looping', {
  skip: process.env.CASHFLOW_ENABLE_CONTAINER_TESTS !== '1' && 'run npm run test:container',
  timeout: 600_000
}, async t => {
  const name = `cashflow-bindmount-${crypto.randomUUID()}`;
  const hostRoot = path.join(os.tmpdir(), name);
  const dataDir = path.join(hostRoot, 'data');
  const logsDir = path.join(hostRoot, 'logs');
  let containerCreated = false;
  try {
    await docker('build', '--target', 'runtime', '-t', name, '.');
    // Let Docker create these directories itself (do not mkdir them first) -
    // that is what makes Docker own them as root:root, reproducing the
    // original bug. CASHFLOW_ENABLE_CONTAINER_TESTS=1 is an explicit opt-in
    // for an environment where the current user can run Docker directly.
    await docker('run', '-d', '--name', name,
      '-v', `${dataDir}:/app/data`, '-v', `${logsDir}:/app/logs`,
      '-e', 'CASHFLOW_DB_BACKEND=sqlite', '-e', 'CASHFLOW_RUNTIME_LOCK_BACKEND=none', name);
    containerCreated = true;
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch('http://127.0.0.1:3000/healthz')).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    const { stdout: pidUser } = await docker('exec', name, 'sh', '-c', 'cat /proc/1/status');
    assert.match(pidUser, /^Uid:\s+1000\s+1000/m);
    assert.match(pidUser, /^Gid:\s+1000\s+1000/m);
    const stat = await fs.promises.stat(dataDir);
    assert.equal(stat.uid, 1000, 'host-visible ownership of the bind mount should be fixed to uid 1000');
    const logs = await docker('logs', name);
    assert.doesNotMatch(logs.stdout + logs.stderr, /EACCES|EPERM|Permission denied/);
    t.diagnostic('fresh root-owned bind mount: entrypoint fixed ownership, PID 1 runs as uid/gid 1000.');
  } catch (error) {
    if (containerCreated) {
      const logs = await docker('logs', name).catch(() => null);
      if (logs) t.diagnostic(logs.stdout + logs.stderr);
    }
    throw error;
  } finally {
    if (containerCreated) await docker('rm', '-f', name);
    await docker('image', 'rm', name).catch(() => {});
    await fs.promises.rm(hostRoot, { recursive: true, force: true }).catch(() => {});
  }
});
