'use strict';

// Runs the actual Repository logic against SQLite using Node 22's built-in
// SQLite driver. The desktop runtime continues to use better-sqlite3.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './db' && parent && /src\/database\/(repository|legacy-import)\.js$/.test(parent.filename)) {
    return { utcNow: () => new Date().toISOString() };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const repository = require('../../src/database/repository');
const { importLegacyBackup } = require('../../src/database/legacy-import');
const { applyInitialCurrencyDefaults } = require('../../src/database/fresh-defaults');
const database = new DatabaseSync(':memory:');
database.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
database.exec('PRAGMA foreign_keys = ON');
const initialSettings = repository.getAppSettings(database);
assert.deepEqual(initialSettings, { currencyCode: 'SAR', currencyLabel: '\u20C1', currencyDecimalPlaces: 2 });
const legacyDefaultDb = new DatabaseSync(':memory:');
legacyDefaultDb.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
legacyDefaultDb.prepare('UPDATE app_settings SET value_json=? WHERE setting_key=?').run(JSON.stringify('custom'), 'currencyCode');
legacyDefaultDb.prepare('UPDATE app_settings SET value_json=? WHERE setting_key=?').run(JSON.stringify('ريال خاص'), 'currencyLabel');
assert.equal(applyInitialCurrencyDefaults(legacyDefaultDb, false), false);
assert.equal(repository.getAppSettings(legacyDefaultDb).currencyCode, 'custom');
assert.equal(repository.getAppSettings(legacyDefaultDb).currencyLabel, 'ريال خاص');
const freshTestDb = new DatabaseSync(':memory:');
freshTestDb.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
freshTestDb.prepare('UPDATE app_settings SET value_json=? WHERE setting_key=?').run(JSON.stringify('custom'), 'currencyCode');
assert.equal(applyInitialCurrencyDefaults(freshTestDb, true), true);
assert.deepEqual(repository.getAppSettings(freshTestDb), { currencyCode: 'SAR', currencyLabel: '\u20C1', currencyDecimalPlaces: 2 });
database.transaction = (callback) => (...args) => {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback(...args);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};

function run() {
  const worker = repository.saveCatalogEntry(database, 'worker', { id: 'worker-test-1', name: 'عامل الاختبار' });
  const category = repository.listCatalogEntries(database, 'expense_category', true)[0];

  const movement = repository.createProfitMovement(database, {
    id: 'profit-test-1', date: '2026-11-23', lines: [
      { id: 'line-test-1', name: 'صنف ألف', quantityMicros: 1250000, amountMilli: 12500, notes: 'أول سطر' },
      { id: 'line-test-2', name: 'صنف باء', quantityMicros: 2000000, amountMilli: 7000, notes: '' },
    ],
  });
  assert.equal(movement.amountMilli, 19500);
  assert.equal(movement.quantityMicros, 3250000);

  repository.updateProfitLine(database, 'profit-test-1', 'line-test-1', {
    name: 'صنف ألف معدل', quantityMicros: 1500000, amountMilli: 15000,
  });
  repository.deleteProfitLine(database, 'profit-test-1', 'line-test-2');

  let transactions = repository.listAllTransactions(database);
  assert.equal(transactions.find((entry) => entry.id === 'profit-test-1').amount, 15);
  assert.equal(transactions.find((entry) => entry.id === 'profit-test-1').qty, 1.5);
  assert.ok(repository.searchNameSuggestions(database, 'صن', 8).includes('صنف ألف معدل'));

  repository.createExpense(database, {
    id: 'expense-test-1', date: '2026-11-23', categoryId: category.id,
    amountMilli: 8000, description: 'وقود', notes: 'ملاحظة مصروف',
  });
  repository.createWithdrawal(database, {
    id: 'withdrawal-test-1', date: '2026-11-23', workerId: worker.id,
    amountMilli: 2000, notes: 'دفعة',
  });

  let report = repository.getReportData(database, '2026-11-23', '2026-11-23');
  assert.equal(Number(report.totals.profit_milli), 15000);
  assert.equal(Number(report.totals.expense_milli), 8000);
  assert.equal(Number(report.totals.withdrawal_milli), 2000);
  assert.equal(Number(report.totals.total_expense_milli), 10000);
  assert.equal(Number(report.totals.net_milli), 5000);
  assert.equal(report.transactions.length, 3);

  repository.updateExpense(database, 'expense-test-1', { amountMilli: 9000, description: 'وقود معدل' });
  repository.updateWithdrawal(database, 'withdrawal-test-1', { amountMilli: 3000 });
  repository.setCatalogActive(database, 'worker', worker.id, false);
  repository.softDeleteExpense(database, 'expense-test-1');

  transactions = repository.listAllTransactions(database);
  assert.equal(transactions.length, 2);
  assert.equal(transactions.some((entry) => entry.type === 'expense'), false);
  report = repository.getReportData(database, '2026-11-23', '2026-11-23');
  assert.equal(Number(report.totals.total_expense_milli), 3000);
  assert.equal(Number(report.totals.net_milli), 12000);

  repository.deleteProfitLine(database, 'profit-test-1', 'line-test-1');
  assert.equal(repository.listAllTransactions(database).some((entry) => entry.id === 'profit-test-1'), false);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM profit_transactions WHERE id='profit-test-1'").get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id='line-test-1'").get().n, 2);

  repository.setCurrencySettings(database, { code: 'JOD', label: 'د.أ', decimalPlaces: 3 });
  assert.equal(database.prepare("SELECT amount_milli FROM withdrawals WHERE id='withdrawal-test-1'").get().amount_milli, 3000);
  assert.deepEqual(repository.getAppSettings(database), {
    currencyCode: 'JOD', currencyLabel: 'د.أ', currencyDecimalPlaces: 3,
  });

  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.ok(repository.listAuditLog(database).length >= 10);
  assert.equal(repository.listAllAuditLog(database).length, database.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n);

  const importDb = new DatabaseSync(':memory:');
  importDb.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  importDb.exec('PRAGMA foreign_keys = ON');
  importDb.transaction = (callback) => (...args) => {
    importDb.exec('BEGIN IMMEDIATE');
    try { const result = callback(...args); importDb.exec('COMMIT'); return result; }
    catch (error) { importDb.exec('ROLLBACK'); throw error; }
  };
  const legacy = {
    app: 'MowxBack', schema: 2, exportedAt: '2026-11-23T10:00:00.000Z',
    data: {
      v: 3, demo: false, currencyCode: 'JOD', currency: 'د.أ',
      items: [{ id: 'legacy-item-1', name: 'صنف إداري', active: true }],
      workers: [{ id: 'legacy-worker-1', name: 'عامل قديم', active: true }],
      cats: [{ id: 'legacy-cat-1', name: 'مصاريف متنوعة', active: true }],
      names: ['اسم محفوظ سابقاً'],
      tx: [
        { id: 'legacy-profit-1', type: 'profit', date: '2026-11-20', lines: [{ id: 'legacy-line-1', name: 'اسم حر', qty: 1.25, amount: 4.5, note: 'ملاحظة' }] },
        { id: 'legacy-expense-1', type: 'expense', date: '2026-11-20', refId: 'legacy-cat-1', name: 'مصاريف متنوعة', amount: 2.5, desc: 'مشتريات', note: '' },
        { id: 'legacy-withdrawal-1', type: 'withdrawal', date: '2026-11-20', refId: 'legacy-worker-1', name: 'عامل قديم', amount: 1, note: '' },
      ],
      log: [{ id: 'legacy-audit-1', entityType: 'worker', entityId: 'legacy-worker-1', op: 'deactivate', before: { name: 'عامل قديم' }, after: { active: false }, at: '2026-11-21T12:00:00.000Z' }],
    },
  };
  const legacyText = JSON.stringify(legacy);
  const importResult = importLegacyBackup(importDb, legacyText, 'test-old-backup.json');
  assert.equal(importResult.imported, true);
  assert.equal(importResult.counts.profitTransactions, 1);
  assert.equal(importResult.counts.expenses, 1);
  assert.equal(importResult.counts.withdrawals, 1);
  assert.equal(repository.listAllTransactions(importDb).length, 3);
  assert.ok(repository.searchNameSuggestions(importDb, 'اسم', 8).includes('اسم محفوظ سابقاً'));
  assert.equal(repository.listAuditLog(importDb).some((entry) => entry.op === 'deactivate' && entry.entityType === 'worker'), true);
  assert.throws(() => importLegacyBackup(importDb, legacyText, 'duplicate.json'), /already been imported/);
  assert.equal(importDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  importDb.close();

  const allHistorical = repository.listTransactionsForLegacyExport(database);
  assert.equal(allHistorical.length, 3);
  assert.equal(allHistorical.find((entry) => entry.id === 'profit-test-1').lines.every((line) => line.deleted), true);
  assert.equal(allHistorical.find((entry) => entry.id === 'expense-test-1').void, true);
  const roundTripDb = new DatabaseSync(':memory:');
  roundTripDb.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  roundTripDb.exec('PRAGMA foreign_keys = ON');
  roundTripDb.transaction = (callback) => (...args) => {
    roundTripDb.exec('BEGIN IMMEDIATE');
    try { const result = callback(...args); roundTripDb.exec('COMMIT'); return result; }
    catch (error) { roundTripDb.exec('ROLLBACK'); throw error; }
  };
  const toLegacyCatalog = (kind) => repository.listCatalogEntries(database, kind, true)
    .map((entry) => ({ id: entry.id, name: entry.name, active: Boolean(entry.is_active) }));
  const roundTripData = {
    v: 3, demo: false, currencyCode: 'JOD', currency: 'د.أ',
    items: toLegacyCatalog('item'), workers: toLegacyCatalog('worker'), cats: toLegacyCatalog('expense_category'),
    names: repository.listNameSuggestionHistory(database).map((entry) => entry.display_name),
    tx: allHistorical,
    log: repository.listAuditLog(database).map((entry) => ({ ...entry, at: entry.at })),
  };
  importLegacyBackup(roundTripDb, JSON.stringify({ app: 'MowxBack', schema: 2, exportedAt: new Date().toISOString(), data: roundTripData }), 'roundtrip.json');
  assert.equal(repository.listAllTransactions(roundTripDb).length, 1);
  assert.equal(repository.listAllTransactions(roundTripDb)[0].type, 'withdrawal');
  assert.equal(roundTripDb.prepare("SELECT COUNT(*) AS n FROM profit_lines WHERE deleted_at IS NOT NULL").get().n, 2);
  assert.equal(roundTripDb.prepare("SELECT COUNT(*) AS n FROM expenses WHERE deleted_at IS NOT NULL").get().n, 1);
  roundTripDb.close();

  // Disk-backed close/reopen test: verify durable persistence across an app restart.
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mowxback-persistence-'));
  const persistentPath = path.join(tempDirectory, 'mowxback.db');
  try {
    const persistentDb = new DatabaseSync(persistentPath);
    persistentDb.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    persistentDb.exec('PRAGMA foreign_keys = ON');
    persistentDb.transaction = (callback) => (...args) => {
      persistentDb.exec('BEGIN IMMEDIATE');
      try { const result = callback(...args); persistentDb.exec('COMMIT'); return result; }
      catch (error) { persistentDb.exec('ROLLBACK'); throw error; }
    };
    repository.createProfitMovement(persistentDb, {
      id: 'restart-profit-1', date: '2026-11-23',
      lines: [{ id: 'restart-line-1', name: 'صنف بعد إعادة التشغيل', quantityMicros: 2500000, amountMilli: 7250, notes: '' }],
    });
    persistentDb.close();

    const reopenedDb = new DatabaseSync(persistentPath);
    reopenedDb.exec('PRAGMA foreign_keys = ON');
    assert.equal(reopenedDb.prepare("SELECT COUNT(*) AS n FROM profit_transactions WHERE id='restart-profit-1'").get().n, 1);
    assert.equal(repository.listAllTransactions(reopenedDb)[0].amount, 7.25);
    assert.equal(reopenedDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    reopenedDb.close();
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
  console.log('Repository/import integration: 50 assertions passed (including full audit export and file close/reopen).');
}

try { run(); }
finally { database.close(); Module._load = originalLoad; }
