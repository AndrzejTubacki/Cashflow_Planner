import { retainedLocalPaymentCount } from '../engine/local-linked-origin.js';
import { ENGINE_VERSION } from '../engine/index.js';
import { normalizeStandaloneTransferRequest } from './cashflow-standalone-transfer-journal.js';
import { normalizeSyncSelection } from './cashflow-app-sync-contract.js';
import { prepareStandaloneTransferRates } from './cashflow-standalone-transfer-rates.js';
import { canonicalAuditValue } from '../engine/ledger-audit-json.js';
import { todayInTimezone } from './cashflow-date-utils.js';

const MAX_BYTES = 10 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const lookup = input => Object.fromEntries(['version', 'transferId', 'instanceId', 'accountId', 'deviceId'].map(key => [key, input[key]]));

/** The wire carries a financial source object, not an escaped multi-megabyte
 * JSON string. Canonical observed bytes bind retries on both hosts. Generated
 * plans, imported receipts and unknown envelope fields are never accepted. */
function input(value, cancellation = false) {
  const keys = ['version', 'transferId', 'instanceId', 'accountId', 'deviceId', 'name', 'source', ...(cancellation ? [] : ['compatibility'])];
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key)) || !value.source || Object.getPrototypeOf(value.source) !== Object.prototype) {
    throw fail('INVALID_TRANSFER_REQUEST', 'Invalid transfer request');
  }
  // Existing format-1 clients remain valid upload writers. Their older engine
  // cannot read a version-2 origin, so that exception never applies to new proof.
  const legacy = value.source.transferVersion == null && value.compatibility?.engineVersion === '0.4.0-poc';
  const compatibility = cancellation ? null : normalizeSyncSelection(legacy
    ? { ...value.compatibility, engineVersion: ENGINE_VERSION } : value.compatibility);
  if (legacy) compatibility.engineVersion = '0.4.0-poc';
  let sourceJson;
  try { sourceJson = JSON.stringify(canonicalAuditValue(value.source)); }
  catch { throw fail('INVALID_TRANSFER_SOURCE', 'Review the financial source before uploading'); }
  const { source: _source, compatibility: _compatibility, ...scope } = value;
  const request = normalizeStandaloneTransferRequest({ ...scope, sourceJson });
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) throw fail('TRANSFER_SIZE_LIMIT', 'Transfer exceeds the app request limit');
  return { request, compatibility };
}

/** Thin, versioned review/submit/result/cancel interface. Authorization is checked
 * before provider IO and again before returning review data. Review creates no
 * reservation, budget or grant; submission freezes the exact reviewed source.
 * Recovery and cancellation remain independent of engine compatibility. */
export function createStandaloneTransferHttpHost({ publisher, fetchRate, now = Date.now }) {
  return {
    /** Probe without source bytes or allocation, under the same bound device
     * authorization as review. Old hosts return 404, which the phone treats as v1. */
    async formats(token, body) {
      const request = normalizeStandaloneTransferRequest(body, true);
      await publisher.reviewState(token, request);
      return { ...request, sourceVersions: [1, 2, 3] };
    },
    async review(token, body) {
      const { request, compatibility } = input(body);
      if (await publisher.reviewState(token, lookup(request))) throw fail('TRANSFER_ALREADY_STARTED', 'Recover the existing transfer before reviewing another source');
      const stamp = new Date(now());
      const timing = { today: todayInTimezone(JSON.parse(request.sourceJson).request?.settings?.timezone, stamp),
        generationTimestamp: stamp.toISOString(), idSeed: request.transferId };
      let prepared;
      try { prepared = await prepareStandaloneTransferRates({ sourceJson: request.sourceJson, fetchRate, ...timing }); }
      catch (error) {
        if (error.code === 'TRANSFER_RATE_REFRESH_FAILED') throw error;
        throw fail('INVALID_TRANSFER_SOURCE', 'Review the financial source and planning rates before uploading');
      }
      if (await publisher.reviewState(token, lookup(request))) throw fail('TRANSFER_ALREADY_STARTED', 'Recover the existing transfer before reviewing another source');
      const source = JSON.parse(prepared.sourceJson);
      const response = { version: 1, ...lookup(request), name: request.name, compatibility,
        source, rateChanges: prepared.refreshed,
        summary: { sourceBudgetId: source.budgetId, sourceRevision: source.revision,
          ledgerCurrency: source.request.settings.ledger_currency, confirmedBalance: source.request.openingBalance,
          effectivePaymentCount: source.localHistory.length, originalPaymentCount: retainedLocalPaymentCount(source.localAudit) } };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_BYTES) throw fail('TRANSFER_SIZE_LIMIT', 'Transfer review exceeds the app response limit');
      return response;
    },
    async submit(token, body) {
      const { request } = input(body);
      return publisher.submit(token, request);
    },
    async cancel(token, body) {
      // Cancellation is independent of financial engine compatibility and does
      // not reinterpret old source bytes or authorize their publication.
      const { request } = input(body, true);
      return publisher.cancel(token, request);
    },
    async result(token, body) {
      const request = normalizeStandaloneTransferRequest(body, true);
      return { ...request, ...await publisher.result(token, request) };
    }
  };
}
