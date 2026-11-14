import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { openAppSnapshotStore } from "./lib/app-snapshot-store.mjs";
import { prepareSnapshot } from "../src/engine/prepare-snapshot.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".sandbox-runtime", "app-host");
let store;
try {
  if (process.argv.length > 2) throw new Error("This synthetic demo takes no arguments and never opens supplied budget copies");
  const source = await readFile(path.join(root, "dist-engine", "cashflow-engine.js"), "utf8");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  store = openAppSnapshotStore(path.join(directory, "demo.sqlite"));
  const budgetId = "app-host-demo";
  let current;
  try { current = store.read(budgetId); }
  catch (error) {
    if (error.message !== "Unknown reference-host budget") throw error;
    const tables = Object.fromEntries(["planned_transactions", "recurring_expenses", "recurring_incomes",
      "flex_transactions", "goals", "one_off_transactions", "pending_transactions", "future_transactions",
      "projection_snapshots"].map(name => [name, []]));
    tables.one_off_transactions.push({ id: "demo-bill", name: "Synthetic example bill", type: "expense",
      currency: "PLN", amount: 100, date: "2026-06-10" });
    const snapshot = prepareSnapshot({ budgetId, revision: 0, settings: { ledger_currency: "PLN", future_periods: 2 },
      tables, confirmedRows: [{ id: "opening", type: "income", currency: "PLN", ledger_currency: "PLN",
        amount: 500, ledger_amount: 500, running_balance_pln: 500, date: "2026-05-01" }],
      fxSnapshot: null, today: "2026-06-01", generationTimestamp: "2026-06-01T00:00:00.000Z", idSeed: "demo-initial" });
    current = store.create(budgetId, snapshot.request);
  }
  // Simulate a native host consuming the packaged artifact rather than ESM modules.
  const context = vm.createContext({ snapshotJson: JSON.stringify(current) });
  vm.runInContext(source, context, { timeout: 5000 });
  const response = JSON.parse(vm.runInContext("CashflowEngine.calculateSnapshotJson(snapshotJson)", context, { timeout: 10000 }));
  if (!response.ok) throw new Error(response.error.message);
  const { ok, ...result } = response;
  const applied = store.apply(result);
  console.log(JSON.stringify({ ok: true, mode: "synthetic-app-host-demo",
    sourceRevision: result.baseRevision, persistedRevision: applied.revision,
    futureRowCount: result.plan.futureRows.length, engineVersion: result.engineVersion,
    database: path.join(directory, "demo.sqlite") }, null, 2));
} catch (error) {
  console.error(`App-host demo failed: ${error.message}`);
  process.exitCode = 1;
} finally { store?.close(); }