import { calculateSnapshot } from "./snapshot.js";
import { prepareSnapshot } from "./prepare-snapshot.js";

/** Recalculate retained server data, never turn it into editable local state. */
export function refreshDownloadedSnapshot({ snapshot, today, generationTimestamp, idSeed }) {
  calculateSnapshot(snapshot);
  if (snapshot.writesSupported !== false || snapshot.revisionSemantics !== "preview-only-not-server-revision"
    || typeof snapshot.snapshotToken !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.snapshotToken)
    || snapshot.localHistory !== undefined || snapshot.localOpeningBalance !== undefined) {
    throw new Error("A read-only server preview is required");
  }
  if (today < snapshot.request.today) throw new Error("Cannot move a downloaded preview backwards in time");
  const prepared = prepareSnapshot({ budgetId: snapshot.budgetId, revision: snapshot.revision,
    settings: snapshot.request.settings, tables: snapshot.request.tables,
    confirmedRows: snapshot.request.predictionRows, fxSnapshot: snapshot.request.fxSnapshot,
    today, generationTimestamp, idSeed });
  // No applicable retained ledger row means there is no newer authoritative
  // running balance. Do not replace an explicit downloaded opening balance with
  // prepareSnapshot's empty-history default (zero).
  const currency = snapshot.request.settings.ledger_currency || "PLN";
  if (!snapshot.request.predictionRows.some(row => (row.ledger_currency || "PLN") === currency && String(row.date) <= today)) {
    prepared.request.openingBalance = snapshot.request.openingBalance;
  }
  // The server can reserve original installment ordinals after voids/history
  // gaps. Effective rows rebuild paid money, but cannot reconstruct that floor.
  // Preserve only identity metadata in this read-only preview, never paid totals.
  const progress = new Map(prepared.request.oneOffProgress);
  for (const [key, previous] of snapshot.request.oneOffProgress) {
    const current = progress.get(key) || { ...previous, confirmedAmount: 0, confirmedCount: 0 };
    current.confirmedCount = Math.max(current.confirmedCount, previous.confirmedCount);
    if (!Number.isSafeInteger(current.confirmedCount + 1)) throw new Error('Installment identity exceeds safe sequence precision');
    progress.set(key, current);
  }
  prepared.request.oneOffProgress = [...progress];
  // predictionRows is the complete history supplied by our preview endpoint, not
  // a page. Rebuild date-sensitive aggregates without claiming a fresh server read.
  const result = { ...snapshot, request: prepared.request,
    downloadedAt: snapshot.downloadedAt || snapshot.request.generationTimestamp,
    offlineRecalculated: true };
  calculateSnapshot(result);
  return result;
}

export function refreshDownloadedSnapshotJson(json) {
  try { return JSON.stringify({ ok: true, snapshot: refreshDownloadedSnapshot(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: "DOWNLOAD_REFRESH_REJECTED", message: error.message } }); }
}
