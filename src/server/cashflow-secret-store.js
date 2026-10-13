import fs from "node:fs";
import https from "node:https";
import path from "node:path";

import { badRequest } from "./cashflow-user-utils.js";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const DEFAULT_K8S_SECRET_NAME = "cashflow-secrets";
const SECRET_NAME_PATTERN = /^CASHFLOW_[A-Z0-9_]{1,100}_SECRET$/;
const MAX_SECRET_LENGTH = 4096;

// Only names in Cashflow's own *_SECRET namespace may be written, so an admin session can
// never rewrite settings such as CASHFLOW_DATABASE_URL or inject other environment variables.
export function normalizeStorableSecret(name, value) {
  const normalizedName = String(name || "").trim();
  if (!SECRET_NAME_PATTERN.test(normalizedName)) {
    throw badRequest("Secrets can only be stored under names like CASHFLOW_GOOGLE_CLIENT_SECRET", [{
      field: "name",
      reason: "invalid_secret_name"
    }]);
  }
  const secret = typeof value === "string" ? value : "";
  if (!secret || secret.length > MAX_SECRET_LENGTH || /[\r\n\u0000]/u.test(secret)) {
    throw badRequest("The secret must be 1-4096 characters on a single line", [{
      field: "value",
      reason: "invalid_secret_value"
    }]);
  }
  return { name: normalizedName, value: secret };
}

function readFileIfPresent(fsImpl, filePath) {
  try {
    return fsImpl.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function serviceAccountName(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1] || "", "base64url").toString("utf8"));
    return payload?.["kubernetes.io"]?.serviceaccount?.name
      || payload?.["kubernetes.io/serviceaccount/service-account.name"]
      || "";
  } catch {
    return "";
  }
}

export function detectSecretTargets({ env = process.env, envFilePath = null, fsImpl = fs, serviceAccountDir = SERVICE_ACCOUNT_DIR } = {}) {
  const targets = [];
  const token = env.KUBERNETES_SERVICE_HOST ? readFileIfPresent(fsImpl, path.join(serviceAccountDir, "token")) : "";
  if (env.KUBERNETES_SERVICE_HOST && token) {
    targets.push({
      kind: "kubernetes",
      namespace: readFileIfPresent(fsImpl, path.join(serviceAccountDir, "namespace")) || "default",
      secretName: String(env.CASHFLOW_K8S_SECRET_NAME || DEFAULT_K8S_SECRET_NAME).trim(),
      serviceAccount: serviceAccountName(token) || "default",
      apiHost: env.KUBERNETES_SERVICE_HOST,
      apiPort: env.KUBERNETES_SERVICE_PORT || "443"
    });
  }
  if (envFilePath) {
    let present = false;
    let writable = false;
    try {
      present = fsImpl.statSync(envFilePath).isFile();
      fsImpl.accessSync(envFilePath, fs.constants.W_OK);
      writable = present;
    } catch {
      // Missing or read-only; reported below.
    }
    targets.push({ kind: "dotenv", path: envFilePath, present, writable });
  }
  return targets;
}

function kubernetesRequest({ target, method, apiPath, body, serviceAccountDir, fsImpl }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = https.request({
      host: target.apiHost,
      port: Number(target.apiPort) || 443,
      method,
      path: apiPath,
      ca: readFileIfPresent(fsImpl, path.join(serviceAccountDir, "ca.crt")) || undefined,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${readFileIfPresent(fsImpl, path.join(serviceAccountDir, "token"))}`,
        ...(payload ? { "Content-Type": "application/merge-patch+json", "Content-Length": Buffer.byteLength(payload) } : {})
      },
      timeout: 10000
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode || 0, text }));
    });
    request.on("timeout", () => request.destroy(new Error("Kubernetes API request timed out")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function storeInKubernetes({ target, name, value, requestImpl }) {
  const apiPath = `/api/v1/namespaces/${encodeURIComponent(target.namespace)}/secrets/${encodeURIComponent(target.secretName)}`;
  let response;
  try {
    response = await requestImpl({
      target,
      method: "PATCH",
      apiPath,
      body: { data: { [name]: Buffer.from(value, "utf8").toString("base64") } }
    });
  } catch (error) {
    return { target: "kubernetes", stored: false, reason: "unreachable", message: `Couldn't reach the Kubernetes API: ${error.message}` };
  }
  if (response.status >= 200 && response.status < 300) {
    return { target: "kubernetes", stored: true, message: `Stored in Secret ${target.secretName} (namespace ${target.namespace}).` };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      target: "kubernetes",
      stored: false,
      reason: "forbidden",
      message: `Cashflow's service account (${target.serviceAccount}) isn't allowed to update Secret ${target.secretName} in namespace ${target.namespace}.`
    };
  }
  if (response.status === 404) {
    return {
      target: "kubernetes",
      stored: false,
      reason: "not_found",
      message: `Secret ${target.secretName} doesn't exist in namespace ${target.namespace} (set CASHFLOW_K8S_SECRET_NAME if Cashflow uses another one).`
    };
  }
  return { target: "kubernetes", stored: false, reason: "error", message: `The Kubernetes API answered ${response.status}.` };
}

// dotenv reads 'single-quoted' values literally; values that contain a quote are left to the manual path.
function dotenvLine(name, value) {
  if (!value.includes("'")) return `${name}='${value}'`;
  if (!value.includes("\"") && !value.includes("\\")) return `${name}="${value}"`;
  return null;
}

function storeInDotenv({ target, name, value, fsImpl }) {
  if (!target.present) {
    return { target: "dotenv", stored: false, reason: "missing", message: `There is no .env file at ${target.path}.` };
  }
  if (!target.writable) {
    return { target: "dotenv", stored: false, reason: "read_only", message: `Cashflow can't write to ${target.path}.` };
  }
  const line = dotenvLine(name, value);
  if (!line) {
    return { target: "dotenv", stored: false, reason: "unquotable", message: "This secret contains both kinds of quotes, so it has to be added by hand." };
  }
  try {
    const current = fsImpl.readFileSync(target.path, "utf8");
    const lines = current.split(/\r?\n/);
    const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    const index = lines.findIndex(existing => keyPattern.test(existing));
    if (index >= 0) {
      lines[index] = line;
    } else {
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(line, "");
    }
    const mode = fsImpl.statSync(target.path).mode & 0o777;
    const tempPath = `${target.path}.cashflow-${process.pid}.tmp`;
    fsImpl.writeFileSync(tempPath, lines.join("\n"), { mode });
    fsImpl.renameSync(tempPath, target.path);
    return { target: "dotenv", stored: true, message: `Stored in ${target.path}.` };
  } catch (error) {
    return { target: "dotenv", stored: false, reason: "error", message: `Couldn't update ${target.path}: ${error.message}` };
  }
}

// A pod created by a Deployment is named <deployment>-<replicaset hash>-<suffix>.
function deploymentFromPodName(podName) {
  const match = String(podName || "").match(/^(.+)-[a-z0-9]{5,10}-[a-z0-9]{5}$/);
  return match ? match[1] : "";
}

// Works out how this Cashflow process is run, so the steps can name the real thing to restart.
export function detectRuntime({ env = process.env, fsImpl = fs, cgroupPath = "/proc/self/cgroup", dockerEnvPath = "/.dockerenv" } = {}) {
  const cgroup = readFileIfPresent(fsImpl, cgroupPath);
  if (env.KUBERNETES_SERVICE_HOST) {
    return { kind: "kubernetes", deployment: deploymentFromPodName(env.HOSTNAME) };
  }
  let inDocker = false;
  try {
    inDocker = fsImpl.existsSync(dockerEnvPath);
  } catch {
    inDocker = false;
  }
  if (inDocker || /docker|containerd|libpod/.test(cgroup)) {
    return { kind: "docker", container: String(env.HOSTNAME || "").trim() };
  }
  const unit = cgroup.match(/\/([A-Za-z0-9@._-]+\.service)(?:\/|$)/m)?.[1] || "";
  if (unit && !/^(user@|session-)/.test(unit)) {
    return { kind: "systemd", unit };
  }
  return { kind: "process" };
}

export function restartInstructions(runtime, namespace = "") {
  const after = "When Cashflow is back, reopen Admin > Sign-in providers: the provider shows \"Secret found\" once Cashflow can read the secret.";
  if (runtime.kind === "kubernetes") {
    const deployment = runtime.deployment || "<cashflow-deployment>";
    const ns = namespace ? `-n ${namespace} ` : "";
    return {
      summary: runtime.deployment
        ? `Restart the ${deployment} deployment so its pods load the new value (the name comes from this pod; adjust it if yours differs).`
        : "Restart the Cashflow deployment so its pods load the new value.",
      commands: [
        { label: "Restart", command: `kubectl ${ns}rollout restart deployment/${deployment}` },
        { label: "Wait until it's done", command: `kubectl ${ns}rollout status deployment/${deployment}` }
      ],
      after
    };
  }
  if (runtime.kind === "docker") {
    const container = runtime.container || "<cashflow-container>";
    return {
      summary: "Restart the Cashflow container. If you use Docker Compose, restart its service instead.",
      commands: [
        { label: "Docker", command: `docker restart ${container}` },
        { label: "Docker Compose (from the folder with your compose file)", command: "docker compose restart cashflow" }
      ],
      after
    };
  }
  if (runtime.kind === "systemd") {
    return {
      summary: `Cashflow runs as the systemd service ${runtime.unit}. Restart it:`,
      commands: [{ label: "Restart", command: `sudo systemctl restart ${runtime.unit}` }],
      after
    };
  }
  return {
    summary: "Stop Cashflow (Ctrl+C in the terminal it runs in, or however you normally stop it) and start it again from the Cashflow folder:",
    commands: [{ label: "Start", command: "npm start" }],
    after
  };
}

function manualInstructions(targets, name, runtime) {
  const kubernetes = targets.find(target => target.kind === "kubernetes");
  if (kubernetes) {
    return {
      kind: "kubernetes",
      namespace: kubernetes.namespace,
      secretName: kubernetes.secretName,
      serviceAccount: kubernetes.serviceAccount,
      command: `kubectl -n ${kubernetes.namespace} patch secret ${kubernetes.secretName} --type merge -p '{"stringData":{"${name}":"<paste the secret here>"}}'`,
      restart: restartInstructions(runtime, kubernetes.namespace),
      rbac: [
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: Role",
        "metadata:",
        "  name: cashflow-secret-writer",
        `  namespace: ${kubernetes.namespace}`,
        "rules:",
        "  - apiGroups: [\"\"]",
        "    resources: [\"secrets\"]",
        `    resourceNames: [\"${kubernetes.secretName}\"]`,
        "    verbs: [\"get\", \"patch\"]",
        "---",
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: RoleBinding",
        "metadata:",
        "  name: cashflow-secret-writer",
        `  namespace: ${kubernetes.namespace}`,
        "subjects:",
        "  - kind: ServiceAccount",
        `    name: ${kubernetes.serviceAccount}`,
        `    namespace: ${kubernetes.namespace}`,
        "roleRef:",
        "  apiGroup: rbac.authorization.k8s.io",
        "  kind: Role",
        "  name: cashflow-secret-writer"
      ].join("\n")
    };
  }
  const dotenv = targets.find(target => target.kind === "dotenv");
  return {
    kind: "env",
    envFile: dotenv?.path || "",
    line: `${name}=<paste the secret here>`,
    note: "Add it to Cashflow's environment: the .env file in the Cashflow folder, or your container's environment settings.",
    restart: restartInstructions(runtime)
  };
}

export function createSecretStore({
  env = process.env,
  envFilePath = null,
  fsImpl = fs,
  serviceAccountDir = SERVICE_ACCOUNT_DIR,
  requestImpl = null,
  cgroupPath = "/proc/self/cgroup",
  dockerEnvPath = "/.dockerenv"
} = {}) {
  const kubeRequest = requestImpl || (options => kubernetesRequest({ ...options, serviceAccountDir, fsImpl }));

  function describe() {
    return detectSecretTargets({ env, envFilePath, fsImpl, serviceAccountDir }).map(target => (
      target.kind === "kubernetes"
        ? { kind: "kubernetes", namespace: target.namespace, secretName: target.secretName, serviceAccount: target.serviceAccount }
        : { kind: "dotenv", path: target.path, present: target.present, writable: target.writable }
    ));
  }

  async function store(name, value) {
    const secret = normalizeStorableSecret(name, value);
    const targets = detectSecretTargets({ env, envFilePath, fsImpl, serviceAccountDir });
    const attempts = [];
    for (const target of targets) {
      const attempt = target.kind === "kubernetes"
        ? await storeInKubernetes({ target, name: secret.name, value: secret.value, requestImpl: kubeRequest })
        : storeInDotenv({ target, name: secret.name, value: secret.value, fsImpl });
      attempts.push(attempt);
      if (attempt.stored) {
        // Usable right away in this process; other replicas need a restart to see it.
        env[secret.name] = secret.value;
        return { stored: true, name: secret.name, target: attempt.target, attempts };
      }
    }
    const runtime = detectRuntime({ env, fsImpl, cgroupPath, dockerEnvPath });
    return { stored: false, name: secret.name, attempts, manual: manualInstructions(targets, secret.name, runtime) };
  }

  return { describe, store };
}
