// SQLite must replace related planning tables on one connection/transaction.
// Postgres writers already belong to the surrounding whole-budget transaction.
export async function replacePlanningBatches(writer, budgetId, batches, onBatch) {
  const summaries = batches.map(batch => ({
    budgetId,
    ledgerYear: null,
    rows: batch.rows.length,
    tableName: batch.tableName,
    type: "planning"
  }));
  let results;
  if (typeof writer.replacePlanningTables === "function") {
    // Finish async hooks before entering SQLite's synchronous transaction. A
    // rejected hook must not leave the first few planning tables replaced.
    for (const summary of summaries) await onBatch(summary);
    results = await writer.replacePlanningTables(budgetId, batches);
  } else {
    results = [];
    for (const [index, batch] of batches.entries()) {
      await onBatch(summaries[index]);
      results.push(await writer.replacePlanningRows(budgetId, batch.tableName, batch.rows));
    }
  }
  return summaries.map((summary, index) => ({ ...summary, result: { ...(results[index] || {}) } }));
}
