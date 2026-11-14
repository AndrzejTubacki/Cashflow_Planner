import { canonicalAuditValue } from './ledger-audit-json.js';
/** Currency ordering uses accepted identities and sequence boundaries only.
 * Dates, balances and FX amounts never decide where a switch belongs. */
export function currencyOrderFromReceipts(event, currencyEvents, audit, proof) {
  if (!proof || proof.version !== 1 || !Array.isArray(proof.records) || !proof.records.length
    || !Number.isSafeInteger(proof.headRevision) || proof.headRevision !== proof.records.length) return null;
  const receipts = proof.records;
  // A complete unpruned journal is required. Browser invalidations cannot
  // identify their financial changes, so their chronology remains unresolved.
  if (receipts.some(({ operation: op, result }, index) => !op || !result || op.payload === null
    || !op.payload || typeof op.payload !== 'object' || op.kind === 'budget.invalidate' || result.revision !== index + 1 || op.baseRevision !== index
    || op.budgetId !== audit.budgetId || op.epoch !== proof.epoch
    || result.epoch !== proof.epoch || result.budgetId !== audit.budgetId
    || op.operationId !== result.operationId)) return null;
  const switches = receipts.filter(({ operation: op, result }) => op.kind === 'settings.update' && result.pendingConversion);
  // Event identity was absent in old receipts. A unique currency transition is
  // authoritative; repeated visits to the same currency are ambiguous here.
  if (switches.length !== currencyEvents.length) return null;
  const matching = switches.filter(({ operation: op }) => op.payload.ledger_currency === event.new_currency);
  if (matching.length !== 1 || currencyEvents.filter(row => row.new_currency === event.new_currency).length !== 1) return null;
  const change = matching[0];
  const payments = receipts.filter(({ operation: op, result }) => op.kind === 'occurrence.confirm' && result.confirmedTransaction);
  const immutableFact = row => {
    const value = { ...row }; delete value.running_balance_pln;
    return JSON.stringify(canonicalAuditValue(value));
  };
  const paymentReceipts = new Map();
  for (const receipt of payments) {
    const id = receipt.result.confirmedTransaction.id;
    if (paymentReceipts.has(id)) return null;
    paymentReceipts.set(id, receipt);
  }
  if (audit.origin || audit.originals.some(original => {
    const receipt = paymentReceipts.get(original.row.id);
    return original.captureKind !== 'payment' || !receipt
      || receipt.operation.payload.occurrenceKey !== original.row.occurrence_key
      || immutableFact(receipt.result.confirmedTransaction) !== immutableFact(original.row);
  })) return null;
  const priorSwitches = switches.filter(value => value.result.revision < change.result.revision);
  const previousSwitch = priorSwitches.at(-1);
  if (previousSwitch && event.old_currency !== previousSwitch.operation.payload.ledger_currency) return null;
  const pending = change.result.pendingConversion;
  if (pending.occurrence_key !== `ledger_currency_conversion:${pending.id}` || pending.ledger_currency !== event.new_currency) return null;
  const prior = audit.originals.filter(original => paymentReceipts.get(original.row.id).result.revision < change.result.revision);
  const later = audit.originals.filter(original => !prior.includes(original));
  const afterSequence = Math.max(0, ...prior.map(original => original.sequence));
  if (later.some(original => original.sequence <= afterSequence)) return null;
  return { version: 1, eventId: event.id, conversionId: pending.id, afterSequence,
    paymentIds: prior.map(original => original.row.id).sort(),
    previousEventIds: switches.filter(value => value.result.revision < change.result.revision).map(value => {
      const matches = currencyEvents.filter(row => row.new_currency === value.operation.payload.ledger_currency);
      return matches.length === 1 ? matches[0].id : null;
    }), resolution: { version: 1, basis: 'accepted-journal-receipts', proof } };
}

/** A switch captures a durable audit boundary, including voided originals.
 * A complete prior origin supplies its own timeline; native additions then use
 * server acceptance sequence. Missing evidence keeps the old safe refusal. */
export function orderedLinkedTimeline(event, originTimeline, originals, resolve = false) {
  const prefix = originTimeline || [];
  const prefixPayments = new Set(prefix.filter(value => value.kind === 'payment').map(value => value.id));
  const prefixCurrencies = new Set(prefix.filter(value => value.kind === 'ledger-currency').map(value => value.id));
  const native = event.audit.originals.filter(value => !prefixPayments.has(value.row.id)).sort((a, b) => a.sequence - b.sequence);
  if ([...originals.keys()].some(id => !prefixPayments.has(id) && !native.some(value => value.row.id === id))) return null;
  const changes = [];
  for (const change of event.currencyEvents.filter(value => !prefixCurrencies.has(value.id))) {
    const details = typeof change.details === 'string' ? JSON.parse(change.details) : change.details;
    let order = details?.acceptanceOrder;
    if (!order && resolve) order = currencyOrderFromReceipts(change, event.currencyEvents, event.audit, change.orderResolution);
    if (!order || order.version !== 1 || order.eventId !== change.id || typeof order.conversionId !== 'string' || !order.conversionId
      || !Number.isSafeInteger(order.afterSequence) || order.afterSequence < 0 || order.afterSequence > event.audit.lastSequence
      || !Array.isArray(order.paymentIds) || !Array.isArray(order.previousEventIds) || order.previousEventIds.includes(null)) return null;
    const preceding = new Set(order.paymentIds);
    if (preceding.size !== order.paymentIds.length || [...preceding].some(id => !originals.has(id))
      || [...prefixPayments].some(id => !preceding.has(id))) return null;
    // A baseline captured AFTER the switch has deliberately unknown internal
    // order. The switch's exact identity set still proves which of those facts
    // preceded it. New payment captures must agree with its audit boundary.
    if (native.some(value => (value.sequence <= order.afterSequence && !preceding.has(value.row.id))
      || (value.captureKind !== 'legacy' && value.sequence > order.afterSequence && preceding.has(value.row.id)))) return null;
    const clean = { ...change }; delete clean.orderResolution;
    changes.push({ kind: 'ledger-currency', id: change.id, event: clean, order,
      pending: { id: order.conversionId, occurrence_key: `ledger_currency_conversion:${order.conversionId}` } });
  }
  changes.sort((a, b) => a.order.afterSequence - b.order.afterSequence || a.order.previousEventIds.length - b.order.previousEventIds.length);
  const seen = [...prefixCurrencies];
  let priorPayments = new Set(prefixPayments);
  for (const change of changes) {
    if (JSON.stringify([...change.order.previousEventIds].sort()) !== JSON.stringify([...seen].sort())) return null;
    if ([...priorPayments].some(id => !change.order.paymentIds.includes(id))) return null;
    priorPayments = new Set(change.order.paymentIds);
    seen.push(change.id);
  }
  // Accepted conversion payments must follow their generating switch. Do not
  // assign a reused conversion identity to a different transition.
  const conversionIds = new Set();
  for (const change of changes) {
    if (conversionIds.has(change.pending.occurrence_key)) return null;
    conversionIds.add(change.pending.occurrence_key);
    const payment = native.find(value => value.row.occurrence_key === change.pending.occurrence_key);
    if (payment && (change.order.paymentIds.includes(payment.row.id) || payment.row.ledger_currency !== change.event.new_currency)) return null;
  }
  const timeline = [...prefix];
  for (const change of changes) {
    const preceding = native.filter(value => change.order.paymentIds.includes(value.row.id));
    for (const value of preceding) {
      timeline.push(originals.get(value.row.id)); native.splice(native.indexOf(value), 1);
    }
    timeline.push(change);
  }
  timeline.push(...native.map(value => originals.get(value.row.id)));
  return timeline;
}
