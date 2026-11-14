// Explicit embedded-runtime surface. Legacy loose projection requests remain available
// for server compatibility; app hosts should use the strict snapshot entry point.
export { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION, calculateProjection, calculateProjectionJson } from "./index.js";
export { SNAPSHOT_VERSION, calculateSnapshot, calculateSnapshotJson } from "./snapshot.js";
export { prepareSnapshot } from "./prepare-snapshot.js";
export { confirmLocalOccurrence, confirmLocalOccurrenceJson, refreshLocalSnapshot, refreshLocalSnapshotJson } from "./local-confirmation.js";
export { undoLocalConfirmation, undoLocalConfirmationJson } from "./local-confirmation.js";
export { correctLocalConfirmation, correctLocalConfirmationJson } from "./local-confirmation.js";
export { refreshDownloadedSnapshot, refreshDownloadedSnapshotJson } from "./download-refresh.js";
export { localAnchorFallbackDays, localAnchorFallbackDaysJson, localPeriodSummaries, localPeriodSummariesJson } from "./local-planning.js";
export { LINKED_PARTS, prepareLinkedSnapshot, prepareLinkedSnapshotJson } from "./linked-snapshot.js";
export { DEVICE_NOTIFICATION_TYPES, deviceNotifications, deviceNotificationsJson } from "./device-notifications.js";
export { prepareLedgerAuditHashesJson, replayLedgerAuditFromHostJson } from './ledger-audit-host.js';
export { prepareLinkedLedgerAuditHashesJson, verifyLinkedLedgerAuditJson } from './linked-ledger-audit.js';
export { reviewLinkedCorrectionJson } from './linked-correction-review.js';

export { changeLocalLedgerCurrency, changeLocalLedgerCurrencyJson } from "./local-ledger-currency.js";

export { localCsvJson } from "./local-csv.js";
export { reviewLocalCorrection, reviewLocalCorrectionJson, applyReviewedLocalCorrection, applyReviewedLocalCorrectionJson } from './local-correction-review.js';

export { materializeLinkedStandalone, materializeLinkedStandaloneJson } from './linked-materialization.js';
