'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { applyInitialCurrencyDefaults } = require('./fresh-defaults');

function utcNow() {
  return new Date().toISOString();
}

function migrationDirectory() {
  // Works both from the source tree and from electron-builder's app.asar.
  return path.join(__dirname, '..', '..', 'database', 'migrations');
}

function ensureMigrationTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at_utc TEXT NOT NULL
  )`);
}

function applyMigrations(db, directory = migrationDirectory()) {
  ensureMigrationTable(db);
  const files = fs.readdirSync(directory)
    .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
  const latestSupportedVersion = files.length ? Number(files[files.length - 1].slice(0, 3)) : 0;
  const currentVersion = db.pragma('user_version', { simple: true });
  if (currentVersion > latestSupportedVersion) {
    throw new Error(`This database uses schema version ${currentVersion}, newer than this application supports (${latestSupportedVersion}). Update MowxBack before opening it.`);
  }

  for (const file of files) {
    const version = Number(file.slice(0, 3));
    const sql = fs.readFileSync(path.join(directory, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const applied = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(version);

    if (applied) {
      if (applied.checksum !== checksum) {
        throw new Error(`Migration ${file} has changed after it was applied. Create a new migration instead.`);
      }
      continue;
    }

    const applyOne = db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO schema_migrations(version, name, checksum, applied_at_utc)
                  VALUES (?, ?, ?, ?)`)
        .run(version, file, checksum, utcNow());
      db.pragma(`user_version = ${version}`);
    });
    applyOne();
  }
}

function integrityReport(db) {
  const integrity = db.pragma('integrity_check');
  const foreignKeys = db.pragma('foreign_key_check');
  return {
    ok: integrity.length === 1 && integrity[0].integrity_check === 'ok' && foreignKeys.length === 0,
    integrity,
    foreignKeys,
  };
}

function openDatabase(filePath, options = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError('A database file path is required.');
  }
  const resolved = path.resolve(filePath);
  const exists = fs.existsSync(resolved);
  if (!exists && options.create === false) {
    throw new Error('The selected database file does not exist. It was not recreated automatically.');
  }
  if (exists && fs.statSync(resolved).size === 0) {
    throw new Error('The selected database file is empty. It was not initialized or overwritten; select the original database or restore a backup.');
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const db = new Database(resolved, { timeout: 5000, fileMustExist: exists });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('wal_autocheckpoint = 1000');
    applyMigrations(db, options.migrationsDirectory || migrationDirectory());
    applyInitialCurrencyDefaults(db, !exists);
    const report = integrityReport(db);
    if (!report.ok) {
      throw new Error(`Database integrity validation failed: ${JSON.stringify(report)}`);
    }
    return db;
  } catch (error) {
    try { db.close(); } catch (_) { /* preserve the original error */ }
    throw error;
  }
}

module.exports = { openDatabase, applyMigrations, integrityReport, utcNow };
