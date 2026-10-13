import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import dotenv from "dotenv";

import { createSecretStore, normalizeStorableSecret } from "../../src/server/cashflow-secret-store.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-secret-store-"));
}

function fakeServiceAccount(dir, { namespace = "money", serviceAccount = "cashflow-sa" } = {}) {
  const payload = Buffer.from(JSON.stringify({ "kubernetes.io": { namespace, serviceaccount: { name: serviceAccount } } })).toString("base64url");
  fs.writeFileSync(path.join(dir, "token"), `header.${payload}.signature`);
  fs.writeFileSync(path.join(dir, "namespace"), namespace);
  fs.writeFileSync(path.join(dir, "ca.crt"), "");
}

test("only Cashflow *_SECRET names and single-line values can be stored", () => {
  for (const name of ["CASHFLOW_DATABASE_URL", "NODE_OPTIONS", "cashflow_google_client_secret", "CASHFLOW__SECRET", "PATH"]) {
    assert.throws(() => normalizeStorableSecret(name, "x"), error => error.status === 400, name);
  }
  for (const value of ["", "line\nbreak", "nul\u0000", "a".repeat(4097)]) {
    assert.throws(() => normalizeStorableSecret("CASHFLOW_GOOGLE_CLIENT_SECRET", value), error => error.status === 400);
  }
  assert.deepEqual(normalizeStorableSecret(" CASHFLOW_GOOGLE_CLIENT_SECRET ", "s3cr$t#1"), {
    name: "CASHFLOW_GOOGLE_CLIENT_SECRET",
    value: "s3cr$t#1"
  });
});

test("a writable .env gets the secret added or replaced, keeps its other lines, and the value is live at once", async () => {
  const dir = tempDir();
  const envFilePath = path.join(dir, ".env");
  fs.writeFileSync(envFilePath, "PORT=3000\nCASHFLOW_GOOGLE_CLIENT_SECRET=old\n# keep me\n", { mode: 0o600 });
  const env = {};
  const store = createSecretStore({ env, envFilePath });

  const tricky = "va$lue#with'quote";
  const result = await store.store("CASHFLOW_GOOGLE_CLIENT_SECRET", tricky);
  assert.equal(result.stored, true);
  assert.equal(result.target, "dotenv");
  assert.equal(env.CASHFLOW_GOOGLE_CLIENT_SECRET, tricky);
  const parsed = dotenv.parse(fs.readFileSync(envFilePath));
  assert.equal(parsed.CASHFLOW_GOOGLE_CLIENT_SECRET, tricky, "dotenv reads back exactly what was stored");
  assert.equal(parsed.PORT, "3000");
  assert.match(fs.readFileSync(envFilePath, "utf8"), /# keep me/);
  assert.equal(fs.statSync(envFilePath).mode & 0o777, 0o600, "file permissions are preserved");

  await store.store("CASHFLOW_GITHUB_CLIENT_SECRET", "plain-value");
  assert.equal(dotenv.parse(fs.readFileSync(envFilePath)).CASHFLOW_GITHUB_CLIENT_SECRET, "plain-value");

  const unquotable = await store.store("CASHFLOW_FACEBOOK_CLIENT_SECRET", `both'and"quotes`);
  assert.equal(unquotable.stored, false);
  assert.equal(unquotable.attempts[0].reason, "unquotable");
  assert.equal(env.CASHFLOW_FACEBOOK_CLIENT_SECRET, undefined);
});

test("without a usable .env or Kubernetes access, storing returns manual steps and why automatic storage failed", async () => {
  const dir = tempDir();
  const missing = await createSecretStore({ env: {}, envFilePath: path.join(dir, ".env") }).store("CASHFLOW_GOOGLE_CLIENT_SECRET", "v");
  assert.equal(missing.stored, false);
  assert.equal(missing.attempts[0].reason, "missing");
  assert.equal(missing.manual.kind, "env");
  assert.equal(missing.manual.line, "CASHFLOW_GOOGLE_CLIENT_SECRET=<paste the secret here>");

  const envFilePath = path.join(dir, ".env");
  fs.writeFileSync(envFilePath, "PORT=3000\n");
  fs.chmodSync(envFilePath, 0o444);
  const readOnly = await createSecretStore({ env: {}, envFilePath }).store("CASHFLOW_GOOGLE_CLIENT_SECRET", "v");
  if (process.getuid?.() !== 0) {
    assert.equal(readOnly.attempts[0].reason, "read_only");
    assert.equal(fs.readFileSync(envFilePath, "utf8"), "PORT=3000\n");
  }
});

test("in Kubernetes the secret is patched into the Secret, and missing permissions produce RBAC instructions", async () => {
  const serviceAccountDir = tempDir();
  fakeServiceAccount(serviceAccountDir);
  const requests = [];
  let status = 200;
  const makeStore = env => createSecretStore({
    env,
    serviceAccountDir,
    requestImpl: async request => {
      requests.push(request);
      return { status, text: "{}" };
    }
  });

  const env = { KUBERNETES_SERVICE_HOST: "10.0.0.1", KUBERNETES_SERVICE_PORT: "443" };
  const stored = await makeStore(env).store("CASHFLOW_GOOGLE_CLIENT_SECRET", "k8s-value");
  assert.equal(stored.stored, true);
  assert.equal(stored.target, "kubernetes");
  assert.equal(env.CASHFLOW_GOOGLE_CLIENT_SECRET, "k8s-value");
  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].apiPath, "/api/v1/namespaces/money/secrets/cashflow-secrets");
  assert.deepEqual(requests[0].body, { data: { CASHFLOW_GOOGLE_CLIENT_SECRET: Buffer.from("k8s-value").toString("base64") } });

  status = 403;
  const forbiddenEnv = { KUBERNETES_SERVICE_HOST: "10.0.0.1", CASHFLOW_K8S_SECRET_NAME: "my-secrets" };
  const forbidden = await makeStore(forbiddenEnv).store("CASHFLOW_GOOGLE_CLIENT_SECRET", "k8s-value");
  assert.equal(forbidden.stored, false);
  assert.equal(forbidden.attempts[0].reason, "forbidden");
  assert.match(forbidden.attempts[0].message, /cashflow-sa/);
  assert.equal(forbidden.manual.kind, "kubernetes");
  assert.equal(forbidden.manual.secretName, "my-secrets");
  assert.match(forbidden.manual.command, /kubectl -n money patch secret my-secrets/);
  assert.doesNotMatch(forbidden.manual.command, /k8s-value/, "instructions never echo the secret");
  assert.match(forbidden.manual.rbac, /resourceNames: \["my-secrets"\]/);
  assert.match(forbidden.manual.rbac, /name: cashflow-sa/);
  assert.equal(forbiddenEnv.CASHFLOW_GOOGLE_CLIENT_SECRET, undefined);

  status = 404;
  const notFound = await makeStore({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }).store("CASHFLOW_GOOGLE_CLIENT_SECRET", "v");
  assert.equal(notFound.attempts[0].reason, "not_found");
});
