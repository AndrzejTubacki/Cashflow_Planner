export function createCashflowLedgerService({
  listLedgerYears,
  openLedgerDb,
  openPlanningDb
}) {
  function loadAllConfirmedTransactions(userId) {
    const rows = [];

    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        const yearRows = ledgerDb.prepare(`
          SELECT *, ? AS ledger_year
          FROM confirmed_transactions
        `).all(year);

        rows.push(...yearRows);
      } finally {
        ledgerDb.close();
      }
    }

    return rows.sort((a, b) => {
      const dateCompare = String(a.date).localeCompare(String(b.date));
      if (dateCompare !== 0) return dateCompare;

      const createdCompare = String(a.created_at).localeCompare(String(b.created_at));
      if (createdCompare !== 0) return createdCompare;

      return String(a.id).localeCompare(String(b.id));
    });
  }

  function sumConfirmedFunding(userId, sourceColumn, sourceId, targetCurrency = "PLN", settings = null) {
    let totalLedger = 0;

    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        const rows = ledgerDb.prepare(`
          SELECT amount, fx_rate, buffered_fx_rate, ledger_amount
          FROM confirmed_transactions
          WHERE ${sourceColumn} = ?
            AND type = 'expense'
        `).all(sourceId);

        for (const row of rows) {
          if (row.ledger_amount !== null && row.ledger_amount !== undefined) {
            totalLedger += Number(row.ledger_amount || 0);
          } else {
            totalLedger += Number(row.amount || 0) * Number(row.buffered_fx_rate || row.fx_rate || 1);
          }
        }
      } finally {
        ledgerDb.close();
      }
    }

    return totalLedger;
  }

  function sumPendingFunding(userId, sourceColumn, sourceId, targetCurrency = "PLN", settings = null) {
    const db = openPlanningDb(userId);
    let totalLedger = 0;

    try {
      const rows = db.prepare(`
        SELECT amount, funded_amount, fx_rate, buffered_fx_rate, ledger_amount
        FROM pending_transactions
        WHERE ${sourceColumn} = ?
          AND type != 'income'
      `).all(sourceId);

      for (const row of rows) {
        if (row.ledger_amount !== null && row.ledger_amount !== undefined) {
          totalLedger += Number(row.ledger_amount || 0);
        } else {
          const amount = Number(row.funded_amount ?? row.amount ?? 0);
          totalLedger += amount * Number(row.buffered_fx_rate || row.fx_rate || 1);
        }
      }

      return totalLedger;
    } finally {
      db.close();
    }
  }

  function hasAnyConfirmedTransactions(userId) {
    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        const row = ledgerDb.prepare(`
          SELECT 1 AS exists_flag
          FROM confirmed_transactions
          LIMIT 1
        `).get();

        if (row) return true;
      } finally {
        ledgerDb.close();
      }
    }

    return false;
  }

  function newestConfirmedTransactionDate(userId) {
    let newest = null;

    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        const row = ledgerDb.prepare(`
          SELECT MAX(date) AS newest
          FROM confirmed_transactions
        `).get();

        if (row?.newest && (!newest || row.newest > newest)) {
          newest = row.newest;
        }
      } finally {
        ledgerDb.close();
      }
    }

    return newest;
  }

  function recalculateLedgerRunningBalance(userId) {
    const rows = loadAllConfirmedTransactions(userId);
    let balance = 0;

    const dbByYear = new Map();

    try {
      for (const row of rows) {
        const effectiveRate = Number(row.buffered_fx_rate || row.fx_rate || 1);
        const ledgerAmount = Number(row.amount || 0) * effectiveRate;

        if (row.type === "income") {
          balance += ledgerAmount;
        } else {
          balance -= ledgerAmount;
        }

        if (!dbByYear.has(row.ledger_year)) {
          dbByYear.set(row.ledger_year, openLedgerDb(userId, row.ledger_year));
        }

        dbByYear.get(row.ledger_year).prepare(`
          UPDATE confirmed_transactions
          SET running_balance_pln = ?, ledger_amount = ?
          WHERE id = ?
        `).run(balance, ledgerAmount, row.id);
      }
    } finally {
      for (const db of dbByYear.values()) {
        db.close();
      }
    }
  }

  function wouldLedgerGoNegativeAfterInsert(userId, candidate) {
    const rows = loadAllConfirmedTransactions(userId);

    rows.push({
      id: candidate.id,
      amount: candidate.amount,
      type: candidate.type,
      date: candidate.date,
      created_at: candidate.created_at,
      fx_rate: candidate.fx_rate,
      buffered_fx_rate: candidate.buffered_fx_rate
    });

    rows.sort((a, b) => {
      const dateCompare = String(a.date).localeCompare(String(b.date));
      if (dateCompare !== 0) return dateCompare;

      const createdCompare = String(a.created_at).localeCompare(String(b.created_at));
      if (createdCompare !== 0) return createdCompare;

      return String(a.id).localeCompare(String(b.id));
    });

    let balance = 0;

    for (const row of rows) {
      const effectiveRate = Number(row.buffered_fx_rate || row.fx_rate || 1);
      const ledgerAmount = Number(row.amount || 0) * effectiveRate;

      if (row.type === "income") {
        balance += ledgerAmount;
      } else {
        balance -= ledgerAmount;
      }

      if (balance < -0.0001) return true;
    }

    return false;
  }

  function latestConfirmedBalance(userId) {
    const rows = loadAllConfirmedTransactions(userId);

    if (!rows.length) return 0;

    const last = rows[rows.length - 1];

    if (last.running_balance_pln !== null && last.running_balance_pln !== undefined) {
      return Number(last.running_balance_pln || 0);
    }

    let balance = 0;

    for (const row of rows) {
      const effectiveRate = Number(row.buffered_fx_rate || row.fx_rate || 1);
      const ledgerAmount = Number(row.amount || 0) * effectiveRate;

      if (row.type === "income") {
        balance += ledgerAmount;
      } else {
        balance -= ledgerAmount;
      }
    }

    return balance;
  }
  return {
    hasAnyConfirmedTransactions,
    latestConfirmedBalance,
    loadAllConfirmedTransactions,
    newestConfirmedTransactionDate,
    recalculateLedgerRunningBalance,
    sumConfirmedFunding,
    sumPendingFunding,
    wouldLedgerGoNegativeAfterInsert
  };
}

