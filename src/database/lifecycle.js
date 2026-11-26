'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { openDatabase, integrityReport, utcNow } = require('./db');

function dbFingerprint(db) {
  const tables = [
    'items', 'workers', 'expense_categories', 'profit_transactions',
    'profit_lines', 'expenses', 'withdrawals', 'name_suggestions', 'audit_log',
    'telegram_worker_links', 'telegram_link_tokens', 'telegram_notifications',
  ];
  const counts = {};
  const tableHashes = {};
  for (const table of tables) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    tableHashes[table] = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  const settingsRows = db.prepare('SELECT * FROM app_settings ORDER BY setting_key').all();
  const migrationRows = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  const importRows = db.prepare('SELECT * FROM legacy_imports ORDER BY content_sha256').all();
  tableHashes.app_settings = crypto.createHash('sha256').update(JSON.stringify(settingsRows)).digest('hex');
  tableHashes.schema_migrations = crypto.createHash('sha256').update(JSON.stringify(migrationRows)).digest('hex');
  tableHashes.legacy_imports = crypto.createHash('sha256').update(JSON.stringify(importRows)).digest('hex');
  const sums = db.prepare(`
    SELECT
      CAST(COALESCE((SELECT SUM(amount_milli) FROM profit_lines WHERE deleted_at IS NULL), 0) AS TEXT) AS profit_milli,
      CAST(COALESCE((SELECT SUM(amount_milli) FROM expenses WHERE deleted_at IS NULL), 0) AS TEXT) AS expense_milli,
      CAST(COALESCE((SELECT SUM(amount_milli) FROM withdrawals WHERE deleted_at IS NULL), 0) AS TEXT) AS withdrawal_milli
  `).get();
  return { counts, tableHashes, sums };
}

function listMigrationFiles(directory) {
  return require('node:fs').readdirSync(directory)
    .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
}

function verifyDatabaseFile(filePath) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    const integrity = integrityReport(db);
    if (!integrity.ok) throw new Error(`SQLite validation failed: ${JSON.stringify(integrity)}`);
    const version = db.pragma('user_version', { simple: true });
    const migrationDir = path.join(__dirname, '..', '..', 'database', 'migrations');
    const migrationFiles = listMigrationFiles(migrationDir);
    const latestSupported = migrationFiles.length ? Number(migrationFiles[migrationFiles.length - 1].slice(0, 3)) : 0;
    if (!version || version < 1 || version > latestSupported) {
      throw new Error(`The file uses an unsupported MowxBack database schema version (${version}).`);
    }
    const fingerprint = dbFingerprint(db);
    return { version, fingerprint };
  } finally {
    db.close();
  }
}

async function createDatabaseBackup(db, destinationPath) {
  const resolved = path.resolve(destinationPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await db.backup(resolved);
  const check = verifyDatabaseFile(resolved);
  return { path: resolved, ...check };
}

async function moveDatabase({ currentDb, currentPath, newRootFolder, persistConfig }) {
  const oldPath = path.resolve(currentPath);
  const targetFolder = path.join(path.resolve(newRootFolder), 'Data');
  const targetPath = path.join(targetFolder, 'mowxback.db');
  if (oldPath.toLowerCase() === targetPath.toLowerCase()) {
    return { db: currentDb, path: oldPath, unchanged: true };
  }
  await fs.mkdir(targetFolder, { recursive: true });
  try {
    await fs.access(targetPath);
    throw new Error('A database already exists in the selected folder. Choose another folder; it will not be overwritten.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const tempPath = path.join(targetFolder, `.mowxback-move-${process.pid}-${Date.now()}.db`);
  const sourceFingerprint = dbFingerprint(currentDb);
  let nextDb = null;
  try {
    await currentDb.backup(tempPath);
    const copied = verifyDatabaseFile(tempPath);
    if (JSON.stringify(copied.fingerprint) !== JSON.stringify(sourceFingerprint)) {
      throw new Error('The copied database does not match the source database. The active path was not changed.');
    }
    await fs.rename(tempPath, targetPath);
    nextDb = openDatabase(targetPath, { create: false });
    const afterOpen = dbFingerprint(nextDb);
    if (JSON.stringify(afterOpen) !== JSON.stringify(sourceFingerprint)) {
      throw new Error('The destination database failed the final comparison.');
    }
    nextDb.prepare(`INSERT INTO audit_log
      (id, entity_type, entity_id, action, before_json, after_json, occurred_at_utc)
      VALUES (?, 'system', 'database', 'database_move', ?, ?, ?)`)
      .run(`move-${crypto.randomUUID()}`, JSON.stringify({ databasePath: oldPath }),
        JSON.stringify({ databasePath: targetPath }), utcNow());
    await persistConfig({ databasePath: targetPath });
    try {
      currentDb.close();
    } catch (closeError) {
      // Keep the original connection/path active if its close unexpectedly fails.
      await persistConfig({ databasePath: oldPath });
      throw closeError;
    }
    return { db: nextDb, path: targetPath, unchanged: false };
  } catch (error) {
    if (nextDb) {
      try { nextDb.close(); } catch (_) {}
    }
    // The original database is not modified by the backup operation.
    try { await fs.unlink(tempPath); } catch (_) {}
    try { await fs.unlink(targetPath); } catch (_) {}
    throw error;
  }
}

async function restoreDatabase({ currentDb, activePath, backupPath, reopen }) {
  const targetPath = path.resolve(activePath);
  const sourcePath = path.resolve(backupPath);
  if (targetPath.toLowerCase() === sourcePath.toLowerCase()) {
    throw new Error('Choose a backup file, not the active database file.');
  }
  verifyDatabaseFile(sourcePath);

  const folder = path.dirname(targetPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tempPath = path.join(folder, `.mowxback-restore-${stamp}.db`);
  const safetyPath = path.join(folder, `mowxback-before-restore-${stamp}.db`);
  const fullSafetyPath = path.join(folder, `mowxback-before-restore-${stamp}.pre-restore.db`);
  await fs.copyFile(sourcePath, tempPath);
  verifyDatabaseFile(tempPath);

  // A fresh SQLite backup of the live DB is retained before switching files.
  const liveSafetyPath = `${fullSafetyPath}.tmp`;
  await currentDb.backup(liveSafetyPath);
  verifyDatabaseFile(liveSafetyPath);
  currentDb.pragma('wal_checkpoint(TRUNCATE)');
  currentDb.close();

  let movedCurrent = false;
  let restoredDb = null;
  try {
    await fs.rename(targetPath, safetyPath);
    movedCurrent = true;
    await fs.rename(tempPath, targetPath);
    restoredDb = reopen(targetPath);
    const result = integrityReport(restoredDb);
    if (!result.ok) throw new Error('The restored database failed integrity validation.');
    const now = utcNow();
    restoredDb.prepare(`INSERT INTO audit_log
      (id, entity_type, entity_id, action, before_json, after_json, occurred_at_utc)
      VALUES (?, 'system', 'database', 'backup_restore', ?, ?, ?)`)
      .run(`restore-${Date.now()}`, JSON.stringify({ activePath: targetPath }), JSON.stringify({ backupPath: sourcePath }), now);
    restoredDb.pragma('wal_checkpoint(TRUNCATE)');
    restoredDb.close();
    restoredDb = null;
    await fs.rename(liveSafetyPath, fullSafetyPath);
    return { db: reopen(targetPath), safetyPath: fullSafetyPath };
  } catch (error) {
    if (restoredDb && restoredDb.open) {
      try { restoredDb.close(); } catch (_) {}
    }
    try { await fs.unlink(targetPath); } catch (_) {}
    if (movedCurrent) {
      await fs.rename(safetyPath, targetPath);
    }
    try { await fs.unlink(tempPath); } catch (_) {}
    try { await fs.unlink(liveSafetyPath); } catch (_) {}
    const rollbackDb = reopen(targetPath);
    error.rollbackDatabase = rollbackDb;
    throw error;
  }
}

module.exports = {
  dbFingerprint,
  verifyDatabaseFile,
  createDatabaseBackup,
  moveDatabase,
  restoreDatabase,
};
