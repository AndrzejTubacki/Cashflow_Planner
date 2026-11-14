import { createHash } from 'node:crypto';
import { BOOTSTRAP_PARTS, readFinancialBootstrapPart } from './cashflow-app-bootstrap-records.js';
import { prepareLinkedLedgerAuditHashes } from '../engine/linked-ledger-audit.js';
import { prepareLinkedSnapshot } from '../engine/linked-snapshot.js';
import { calculateSnapshot } from '../engine/snapshot.js';

const MAX_ENGINE = 20 * 1024 * 1024, MAX_PAGE = 10 * 1024 * 1024;
const fail = () => Object.assign(new Error('Transfer exceeds app download or calculation limits'), { code: 'TRANSFER_SIZE_LIMIT' });
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Verify actual normalized database rows against the native download and
 * engine-return bounds before publishing a usable budget. This is not a grant
 * or a calculated-plan upload. It uses the exact reader used by real sync.
 * Failed checks must roll back the caller's financial/global publication. */
export async function assertStandaloneTransferReadable({ writer, budgetId, readFxSnapshot, ...timing }) {
  const parts = {};
  let count = 0;
  for (const part of BOOTSTRAP_PARTS) {
    const rows = await readFinancialBootstrapPart({ writer, budgetId, ...timing }, part,
      { fxSnapshot: readFxSnapshot, allowStandaloneOrigins: true });
    count += rows.length;
    if (count > 200000) throw fail();
    // Current page tokens are <=256 characters. Reserve 16 KiB for the full
    // scope/version/page envelope, including longer future nonfinancial IDs.
    for (let offset = 0; offset < rows.length; offset += 100) if (bytes(rows.slice(offset, offset + 100)) + 16384 > MAX_PAGE) throw fail();
    // Convert driver Dates into the same plain JSON that Android downloads.
    parts[part] = JSON.parse(JSON.stringify(rows));
  }
  const command = { budgetId, epoch: '11111111-1111-4111-8111-111111111111', revision: 0, parts, ...timing };
  const prepared = prepareLinkedLedgerAuditHashes(command, { allowStandaloneOrigins: true });
  if (bytes({ ok: true, ...prepared }) > MAX_ENGINE) throw fail();
  const auditHashes = prepared.texts.map(text => [text, createHash('sha256').update(text).digest('hex')]);
  const snapshot = prepareLinkedSnapshot({ ...command, auditHashes }, { allowStandaloneOrigins: true });
  if (bytes({ ok: true, snapshot }) > MAX_ENGINE || bytes({ ok: true, ...calculateSnapshot(snapshot) }) > MAX_ENGINE) throw fail();
  return { records: count };
}
