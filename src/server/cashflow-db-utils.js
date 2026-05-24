export function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map(col => col.name);
}

export function tableExists(db, tableName) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName);

  return Boolean(row);
}

export function replaceTableRowsFromBackup(liveDb, backupDb, tableName) {
  if (!tableExists(backupDb, tableName) || !tableExists(liveDb, tableName)) return;

  const liveColumns = tableColumns(liveDb, tableName);
  const backupColumns = new Set(tableColumns(backupDb, tableName));
  const columns = liveColumns.filter(col => backupColumns.has(col));

  if (!columns.length) return;

  const colList = columns.map(col => `"${col}"`).join(", ");
  const placeholders = columns.map(() => "?").join(", ");

  const rows = backupDb.prepare(`SELECT ${colList} FROM ${tableName}`).all();
  const insert = liveDb.prepare(`
    INSERT INTO ${tableName} (${colList})
    VALUES (${placeholders})
  `);

  liveDb.prepare(`DELETE FROM ${tableName}`).run();

  for (const row of rows) {
    insert.run(...columns.map(col => row[col]));
  }
}
