'use strict';

const crypto = require('node:crypto');
const { utcNow } = require('./db');
const { normalizeName, normalizeKey } = require('./legacy-import');

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function assertValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error('Date must use YYYY-MM-DD format.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new Error('The selected date is not a valid calendar date.');
  }
  return value;
}

function audit(db, { entityType, entityId, parentEntityId = null, action, before = null, after = null, at = utcNow() }) {
  db.prepare(`INSERT INTO audit_log
    (id, entity_type, entity_id, parent_entity_id, action, before_json, after_json, occurred_at_utc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(makeId('audit'), entityType, String(entityId), parentEntityId, action,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after), at);
}

function recordSystemEvent(db, action, details, at = utcNow()) {
  if (!['report_export', 'application_error'].includes(action)) throw new Error('Unsupported system audit action.');
  const id = makeId('system-event');
  audit(db, { entityType: 'system', entityId: id, action, after: details || {}, at });
  return id;
}

function addSuggestion(db, rawName, at = utcNow()) {
  const display = normalizeName(rawName);
  const key = normalizeKey(display);
  if (!display || !key) return;
  db.prepare(`INSERT INTO name_suggestions
    (normalized_name, display_name, first_used_at, last_used_at, use_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(normalized_name) DO UPDATE SET
      display_name = excluded.display_name,
      last_used_at = excluded.last_used_at,
      use_count = name_suggestions.use_count + 1`)
    .run(key, display, at, at);
}

function createProfitMovement(db, payload) {
  if (!payload || !Array.isArray(payload.lines) || payload.lines.length < 1) {
    throw new Error('A profit movement must contain at least one line.');
  }
  const at = utcNow();
  const lines = payload.lines.map((line) => {
    const name = normalizeName(line.name);
    if (!name) throw new Error('Every profit line requires a free-text item name.');
    if (!Number.isSafeInteger(line.quantityMicros) || line.quantityMicros <= 0) throw new Error('Invalid profit quantity.');
    if (!Number.isSafeInteger(line.amountMilli) || line.amountMilli <= 0) throw new Error('Invalid profit amount.');
    return { ...line, name, notes: String(line.notes ?? '') };
  });
  const sum = {
    amountMilli: lines.reduce((n, line) => n + line.amountMilli, 0),
    quantityMicros: lines.reduce((n, line) => n + line.quantityMicros, 0),
  };
  if (!Number.isSafeInteger(sum.amountMilli) || !Number.isSafeInteger(sum.quantityMicros)) {
    throw new RangeError('Profit movement total exceeds the supported numeric range.');
  }

  assertValidDate(payload.date);
  const txId = payload.id || makeId('profit');
  const create = db.transaction(() => {
    db.prepare(`INSERT INTO profit_transactions(id, tx_date, created_at, updated_at)
                VALUES (?, ?, ?, ?)`)
      .run(txId, payload.date, at, at);
    const insertLine = db.prepare(`INSERT INTO profit_lines
      (id, transaction_id, item_id, legacy_ref_id, item_name, quantity_micros, amount_milli, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const line of lines) {
      insertLine.run(line.id || makeId('line'), txId, line.itemId || null, line.legacyRefId || null,
        line.name, line.quantityMicros, line.amountMilli, line.notes, at, at);
      addSuggestion(db, line.name, at);
    }
    audit(db, {
      entityType: 'profit_transaction', entityId: txId, action: 'create',
      after: { id: txId, date: payload.date, lineCount: lines.length, ...sum, lines }, at,
    });
    return { id: txId, ...sum, lineCount: lines.length };
  });
  return create();
}

function getActiveProfitLine(db, transactionId, lineId) {
  return db.prepare(`SELECT * FROM profit_lines
    WHERE id = ? AND transaction_id = ? AND deleted_at IS NULL`).get(lineId, transactionId);
}

function updateProfitLine(db, transactionId, lineId, patch) {
  const at = utcNow();
  const update = db.transaction(() => {
    const beforeRow = getActiveProfitLine(db, transactionId, lineId);
    if (!beforeRow) throw new Error('Profit line was not found or is already deleted.');
    const next = {
      item_name: patch.name === undefined ? beforeRow.item_name : normalizeName(patch.name),
      quantity_micros: patch.quantityMicros === undefined ? beforeRow.quantity_micros : patch.quantityMicros,
      amount_milli: patch.amountMilli === undefined ? beforeRow.amount_milli : patch.amountMilli,
      notes: patch.notes === undefined ? beforeRow.notes : String(patch.notes),
    };
    if (!next.item_name || !Number.isSafeInteger(next.quantity_micros) || next.quantity_micros <= 0 ||
        !Number.isSafeInteger(next.amount_milli) || next.amount_milli <= 0) {
      throw new Error('Invalid profit line values.');
    }
    const changedName = next.item_name !== beforeRow.item_name;
    db.prepare(`UPDATE profit_lines SET item_name=?, quantity_micros=?, amount_milli=?, notes=?,
      item_id=CASE WHEN ? THEN NULL ELSE item_id END,
      legacy_ref_id=CASE WHEN ? THEN NULL ELSE legacy_ref_id END,
      updated_at=? WHERE id=? AND transaction_id=?`)
      .run(next.item_name, next.quantity_micros, next.amount_milli, next.notes,
        changedName ? 1 : 0, changedName ? 1 : 0, at, lineId, transactionId);
    db.prepare('UPDATE profit_transactions SET updated_at=? WHERE id=?').run(at, transactionId);
    addSuggestion(db, next.item_name, at);
    const before = {
      name: beforeRow.item_name, quantityMicros: beforeRow.quantity_micros,
      amountMilli: beforeRow.amount_milli, notes: beforeRow.notes,
    };
    audit(db, { entityType: 'profit_line', entityId: lineId, parentEntityId: transactionId,
      action: 'update', before, after: next, at });
    return next;
  });
  return update();
}

function deleteProfitLine(db, transactionId, lineId) {
  const at = utcNow();
  const remove = db.transaction(() => {
    const line = getActiveProfitLine(db, transactionId, lineId);
    if (!line) throw new Error('Profit line was not found or is already deleted.');
    db.prepare('UPDATE profit_lines SET deleted_at=?, updated_at=? WHERE id=?').run(at, at, lineId);
    db.prepare('UPDATE profit_transactions SET updated_at=? WHERE id=?').run(at, transactionId);
    audit(db, {
      entityType: 'profit_line', entityId: lineId, parentEntityId: transactionId,
      action: 'soft_delete',
      before: { name: line.item_name, quantityMicros: line.quantity_micros, amountMilli: line.amount_milli, notes: line.notes },
      after: { deleted: true }, at,
    });
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM profit_lines
      WHERE transaction_id=? AND deleted_at IS NULL`).get(transactionId).n;
    return { deleted: true, remainingLines: remaining, movementVisible: remaining > 0 };
  });
  return remove();
}

function softDeleteProfitMovement(db, transactionId) {
  const at = utcNow();
  const remove = db.transaction(() => {
    const row = db.prepare('SELECT * FROM profit_transactions WHERE id=? AND deleted_at IS NULL').get(transactionId);
    if (!row) throw new Error('Profit movement was not found.');
    db.prepare('UPDATE profit_transactions SET deleted_at=?, updated_at=? WHERE id=?').run(at, at, transactionId);
    audit(db, { entityType: 'profit_transaction', entityId: transactionId,
      action: 'soft_delete', before: { id: row.id, date: row.tx_date }, after: { deleted: true }, at });
  });
  remove();
}

function updateProfitMovementDate(db, transactionId, nextDate) {
  const date = assertValidDate(nextDate);
  const at = utcNow();
  const save = db.transaction(() => {
    const before = db.prepare('SELECT * FROM profit_transactions WHERE id=? AND deleted_at IS NULL').get(transactionId);
    if (!before) throw new Error('Profit movement was not found or is deleted.');
    const after = { ...before, tx_date: date, updated_at: at };
    db.prepare('UPDATE profit_transactions SET tx_date=?, updated_at=? WHERE id=?')
      .run(date, at, transactionId);
    audit(db, { entityType: 'profit_transaction', entityId: transactionId,
      action: 'update', before, after, at });
    return after;
  });
  return save();
}

function createExpense(db, payload) {
  const at = utcNow();
  const category = db.prepare('SELECT id,name FROM expense_categories WHERE id=? AND is_active=1 AND deleted_at IS NULL').get(payload.categoryId);
  if (!category) throw new Error('Choose an active expense category.');
  if (!Number.isSafeInteger(payload.amountMilli) || payload.amountMilli <= 0) throw new Error('Invalid expense amount.');
  const id = payload.id || makeId('expense');
  const create = db.transaction(() => {
    const row = {
      id, date: assertValidDate(payload.date), categoryId: category.id, categoryName: category.name,
      amountMilli: payload.amountMilli, description: String(payload.description ?? '').trim(),
      notes: String(payload.notes ?? ''),
    };
    if (!row.description) throw new Error('Expense description is required by the current form.');
    db.prepare(`INSERT INTO expenses(id,tx_date,category_id,category_name_snapshot,amount_milli,description,notes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, row.date, row.categoryId, row.categoryName, row.amountMilli, row.description, row.notes, at, at);
    audit(db, { entityType: 'expense', entityId: id, action: 'create', after: row, at });
    return row;
  });
  return create();
}

function createWithdrawal(db, payload) {
  const at = utcNow();
  const worker = db.prepare('SELECT id,name FROM workers WHERE id=? AND is_active=1 AND deleted_at IS NULL').get(payload.workerId);
  if (!worker) throw new Error('Choose an active worker.');
  if (!Number.isSafeInteger(payload.amountMilli) || payload.amountMilli <= 0) throw new Error('Invalid withdrawal amount.');
  const id = payload.id || makeId('withdrawal');
  const row = {
    id, date: assertValidDate(payload.date), workerId: worker.id, workerName: worker.name,
    amountMilli: payload.amountMilli, notes: String(payload.notes ?? ''),
  };
  const create = db.transaction(() => {
    db.prepare(`INSERT INTO withdrawals(id,tx_date,worker_id,worker_name_snapshot,amount_milli,notes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, row.date, row.workerId, row.workerName, row.amountMilli, row.notes, at, at);
    audit(db, { entityType: 'withdrawal', entityId: id, action: 'create', after: row, at });
    return row;
  });
  return create();
}

function updateExpense(db, id, patch) {
  const at = utcNow();
  const save = db.transaction(() => {
    const before = db.prepare('SELECT * FROM expenses WHERE id=? AND deleted_at IS NULL').get(id);
    if (!before) throw new Error('Expense was not found or is deleted.');
    const keepCategory = patch.categoryId === undefined || patch.categoryId === before.category_id;
    const category = keepCategory
      ? db.prepare('SELECT id,name FROM expense_categories WHERE id=?').get(before.category_id)
      : db.prepare('SELECT id,name FROM expense_categories WHERE id=? AND is_active=1 AND deleted_at IS NULL').get(patch.categoryId);
    if (!category) throw new Error('Choose an existing category.');
    const amountMilli = patch.amountMilli === undefined ? before.amount_milli : patch.amountMilli;
    if (!Number.isSafeInteger(amountMilli) || amountMilli <= 0) throw new Error('Invalid expense amount.');
    const description = patch.description === undefined ? before.description : String(patch.description).trim();
    if (!description) throw new Error('Expense description is required by the current form.');
    const next = {
      tx_date: assertValidDate(patch.date === undefined ? before.tx_date : patch.date),
      category_id: category.id,
      category_name_snapshot: keepCategory ? before.category_name_snapshot : category.name,
      amount_milli: amountMilli,
      description,
      notes: patch.notes === undefined ? before.notes : String(patch.notes),
    };
    db.prepare(`UPDATE expenses SET tx_date=?, category_id=?, category_name_snapshot=?, amount_milli=?,
      description=?, notes=?, updated_at=? WHERE id=?`)
      .run(next.tx_date, next.category_id, next.category_name_snapshot, next.amount_milli,
        next.description, next.notes, at, id);
    audit(db, { entityType: 'expense', entityId: id, action: 'update', before, after: next, at });
    return next;
  });
  return save();
}

function updateWithdrawal(db, id, patch) {
  const at = utcNow();
  const save = db.transaction(() => {
    const before = db.prepare('SELECT * FROM withdrawals WHERE id=? AND deleted_at IS NULL').get(id);
    if (!before) throw new Error('Withdrawal was not found or is deleted.');
    const keepWorker = patch.workerId === undefined || patch.workerId === before.worker_id;
    const worker = keepWorker
      ? db.prepare('SELECT id,name FROM workers WHERE id=?').get(before.worker_id)
      : db.prepare('SELECT id,name FROM workers WHERE id=? AND is_active=1 AND deleted_at IS NULL').get(patch.workerId);
    if (!worker) throw new Error('Choose an existing worker.');
    const amountMilli = patch.amountMilli === undefined ? before.amount_milli : patch.amountMilli;
    if (!Number.isSafeInteger(amountMilli) || amountMilli <= 0) throw new Error('Invalid withdrawal amount.');
    const next = {
      tx_date: assertValidDate(patch.date === undefined ? before.tx_date : patch.date),
      worker_id: worker.id,
      worker_name_snapshot: keepWorker ? before.worker_name_snapshot : worker.name,
      amount_milli: amountMilli,
      notes: patch.notes === undefined ? before.notes : String(patch.notes),
    };
    db.prepare(`UPDATE withdrawals SET tx_date=?, worker_id=?, worker_name_snapshot=?, amount_milli=?,
      notes=?, updated_at=? WHERE id=?`)
      .run(next.tx_date, next.worker_id, next.worker_name_snapshot, next.amount_milli, next.notes, at, id);
    audit(db, { entityType: 'withdrawal', entityId: id, action: 'update', before, after: next, at });
    return next;
  });
  return save();
}

function softDeleteExpense(db, id) {
  return softDeleteSimple(db, 'expense', 'expenses', id);
}

function softDeleteWithdrawal(db, id) {
  return softDeleteSimple(db, 'withdrawal', 'withdrawals', id);
}

function softDeleteSimple(db, entityType, table, id) {
  const at = utcNow();
  const remove = db.transaction(() => {
    const before = db.prepare(`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`).get(id);
    if (!before) throw new Error(`${entityType} was not found or is deleted.`);
    db.prepare(`UPDATE ${table} SET deleted_at=?, updated_at=? WHERE id=?`).run(at, at, id);
    audit(db, { entityType, entityId: id, action: 'soft_delete', before, after: { deleted: true }, at });
  });
  remove();
}

const CATALOG_TABLES = Object.freeze({
  item: 'items',
  worker: 'workers',
  expense_category: 'expense_categories',
});

function saveCatalogEntry(db, kind, payload) {
  const table = CATALOG_TABLES[kind];
  if (!table) throw new Error('Unknown catalog type.');
  const at = utcNow();
  const name = normalizeName(payload.name);
  if (!name) throw new Error('A catalog name is required.');
  const id = payload.id || makeId(kind);
  const save = db.transaction(() => {
    const before = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) || null;
    if (before) {
      db.prepare(`UPDATE ${table} SET name=?, updated_at=? WHERE id=?`).run(name, at, id);
    } else {
      db.prepare(`INSERT INTO ${table}(id,name,is_active,created_at,updated_at) VALUES(?,?,1,?,?)`).run(id, name, at, at);
    }
    const after = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    audit(db, { entityType: kind, entityId: id, action: before ? 'update' : 'create', before, after, at });
    return after;
  });
  return save();
}

function setCatalogActive(db, kind, id, active) {
  const table = CATALOG_TABLES[kind];
  if (!table || typeof active !== 'boolean') throw new Error('Invalid catalog state.');
  const at = utcNow();
  const toggle = db.transaction(() => {
    const before = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!before) throw new Error('Catalog record was not found.');
    db.prepare(`UPDATE ${table} SET is_active=?, updated_at=? WHERE id=?`).run(active ? 1 : 0, at, id);
    const after = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    audit(db, { entityType: kind, entityId: id, action: active ? 'activate' : 'deactivate', before, after, at });
    return after;
  });
  return toggle();
}

function searchNameSuggestions(db, input, limit = 8) {
  const key = normalizeKey(input);
  if ([...key].length < 2) return [];
  const names = db.prepare('SELECT normalized_name, display_name FROM name_suggestions').all();
  const starts = [];
  const contains = [];
  for (const name of names) {
    if (name.normalized_name === key) continue;
    if (name.normalized_name.startsWith(key)) starts.push(name.display_name);
    else if (name.normalized_name.includes(key)) contains.push(name.display_name);
  }
  return starts.concat(contains).slice(0, Math.min(Math.max(limit, 1), 20));
}

function listCatalogEntries(db, kind, includeInactive = true) {
  const table = CATALOG_TABLES[kind];
  if (!table) throw new Error('Unknown catalog type.');
  return db.prepare(`SELECT id, name, is_active, created_at, updated_at
    FROM ${table} WHERE deleted_at IS NULL AND (? = 1 OR is_active = 1)
    ORDER BY name COLLATE NOCASE, id`).all(includeInactive ? 1 : 0);
}

const APP_SETTING_KEYS = new Set(['currencyCode', 'currencyLabel', 'currencyDecimalPlaces', 'legacyDemoFlag']);

function getAppSettings(db) {
  const result = {};
  for (const row of db.prepare('SELECT setting_key, value_json FROM app_settings').all()) {
    result[row.setting_key] = JSON.parse(row.value_json);
  }
  return result;
}

function setAppSetting(db, key, value) {
  if (!APP_SETTING_KEYS.has(key)) throw new Error('This setting must not be stored in the database.');
  if (value === undefined) throw new Error('Undefined settings cannot be saved.');
  if (key === 'currencyCode' && !['SAR', 'JOD', 'AED', 'KWD', 'USD', 'EGP', 'custom'].includes(value)) {
    throw new Error('Unsupported currency code.');
  }
  if (key === 'currencyLabel' && (typeof value !== 'string' || !value.trim() || value.length > 12)) {
    throw new Error('Currency label must contain 1–12 characters.');
  }
  if (key === 'currencyDecimalPlaces' && (!Number.isInteger(value) || value < 0 || value > 3)) {
    throw new Error('Currency precision must be an integer from 0 to 3.');
  }
  const at = utcNow();
  const save = db.transaction(() => {
    const beforeRow = db.prepare('SELECT value_json FROM app_settings WHERE setting_key=?').get(key);
    const before = beforeRow ? JSON.parse(beforeRow.value_json) : null;
    const afterJson = JSON.stringify(value);
    db.prepare(`INSERT INTO app_settings(setting_key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, afterJson, at);
    audit(db, { entityType: 'system', entityId: `setting:${key}`,
      action: beforeRow ? 'update' : 'create', before: { value: before }, after: { value }, at });
    return value;
  });
  return save();
}

function setCurrencySettings(db, { code, label, decimalPlaces }) {
  const supported = ['SAR', 'JOD', 'AED', 'KWD', 'USD', 'EGP', 'custom'];
  if (!supported.includes(code)) throw new Error('Unsupported currency code.');
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 12) throw new Error('Currency label must contain 1–12 characters.');
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 3) throw new Error('Currency precision must be an integer from 0 to 3.');
  const entries = [
    ['currencyCode', code],
    ['currencyLabel', label.trim()],
    ['currencyDecimalPlaces', decimalPlaces],
  ];
  const at = utcNow();
  const save = db.transaction(() => {
    for (const [key, value] of entries) {
      const beforeRow = db.prepare('SELECT value_json FROM app_settings WHERE setting_key=?').get(key);
      const before = beforeRow ? JSON.parse(beforeRow.value_json) : null;
      db.prepare(`INSERT INTO app_settings(setting_key,value_json,updated_at) VALUES(?,?,?)
        ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
        .run(key, JSON.stringify(value), at);
      audit(db, { entityType: 'system', entityId: `setting:${key}`,
        action: beforeRow ? 'update' : 'create', before: { value: before }, after: { value }, at });
    }
    return { currencyCode: code, currencyLabel: label.trim(), currencyDecimalPlaces: decimalPlaces };
  });
  return save();
}

function listTransactions(db, fromDate, toDate, type = null) {
  assertValidDate(fromDate);
  assertValidDate(toDate);
  if (fromDate > toDate) throw new Error('Start date cannot be after end date.');
  const rows = db.prepare(`SELECT type,id,tx_date,name,line_count,
      CAST(quantity_micros AS TEXT) AS quantity_micros,
      CAST(amount_milli AS TEXT) AS amount_milli,
      description,notes,category_id,worker_id
    FROM v_all_transactions
    WHERE tx_date BETWEEN ? AND ? AND (? IS NULL OR type = ?)
    ORDER BY tx_date DESC, id DESC`)
    .all(fromDate, toDate, type, type);
  return rows;
}

function getDailyTotals(db, fromDate, toDate) {
  assertValidDate(fromDate);
  assertValidDate(toDate);
  if (fromDate > toDate) throw new Error('Start date cannot be after end date.');
  return db.prepare(`SELECT tx_date,
      CAST(profit_milli AS TEXT) AS profit_milli,
      CAST(profit_quantity_micros AS TEXT) AS profit_quantity_micros,
      CAST(expense_milli AS TEXT) AS expense_milli,
      CAST(withdrawal_milli AS TEXT) AS withdrawal_milli,
      CAST(total_expense_milli AS TEXT) AS total_expense_milli,
      CAST(net_milli AS TEXT) AS net_milli
    FROM v_daily_totals WHERE tx_date BETWEEN ? AND ? ORDER BY tx_date`).all(fromDate, toDate);
}

function getProfitByItem(db, fromDate, toDate) {
  assertValidDate(fromDate);
  assertValidDate(toDate);
  if (fromDate > toDate) throw new Error('Start date cannot be after end date.');
  return db.prepare(`SELECT item_name,
      CAST(quantity_micros AS TEXT) AS quantity_micros,
      CAST(amount_milli AS TEXT) AS amount_milli,
      CAST(line_count AS TEXT) AS line_count
    FROM v_profit_by_item WHERE tx_date BETWEEN ? AND ?
    ORDER BY v_profit_by_item.amount_milli DESC, item_name`).all(fromDate, toDate);
}

function getExpensesByCategory(db, fromDate, toDate) {
  assertValidDate(fromDate);
  assertValidDate(toDate);
  if (fromDate > toDate) throw new Error('Start date cannot be after end date.');
  return db.prepare(`SELECT category_id, category_name_snapshot,
      CAST(amount_milli AS TEXT) AS amount_milli,
      CAST(operation_count AS TEXT) AS operation_count
    FROM v_expense_by_category WHERE tx_date BETWEEN ? AND ?
    ORDER BY v_expense_by_category.amount_milli DESC, category_name_snapshot`).all(fromDate, toDate);
}

function getWithdrawalsByWorker(db, fromDate, toDate) {
  assertValidDate(fromDate);
  assertValidDate(toDate);
  if (fromDate > toDate) throw new Error('Start date cannot be after end date.');
  return db.prepare(`SELECT worker_id, worker_name_snapshot,
      CAST(amount_milli AS TEXT) AS amount_milli,
      CAST(operation_count AS TEXT) AS operation_count
    FROM v_withdrawal_by_worker WHERE tx_date BETWEEN ? AND ?
    ORDER BY v_withdrawal_by_worker.amount_milli DESC, worker_name_snapshot`).all(fromDate, toDate);
}

function getProfitLinesForTransaction(db, transactionId) {
  return db.prepare(`SELECT id, transaction_id, item_name,
      CAST(quantity_micros AS TEXT) AS quantity_micros,
      CAST(amount_milli AS TEXT) AS amount_milli, notes
    FROM profit_lines WHERE transaction_id=? AND deleted_at IS NULL ORDER BY rowid`)
    .all(transactionId);
}

function listNameSuggestionHistory(db) {
  return db.prepare(`SELECT display_name, use_count, first_used_at, last_used_at
    FROM name_suggestions ORDER BY last_used_at DESC, display_name COLLATE NOCASE`).all();
}

function mapAuditRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    parentEntityId: row.parent_entity_id,
    txId: row.parent_entity_id || (row.entity_type === 'profit_transaction' ? row.entity_id : null),
    lineId: row.entity_type === 'profit_line' ? row.entity_id : null,
    op: row.action,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null,
    at: Date.parse(row.occurred_at_utc) || Date.now(),
    occurredAt: row.occurred_at_utc,
  }));
}

function listAuditLog(db, limit = 100) {
  const safeLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 100, 1), 500);
  const rows = db.prepare(`SELECT id, entity_type, entity_id, parent_entity_id, action,
      before_json, after_json, occurred_at_utc
    FROM audit_log ORDER BY occurred_at_utc DESC, rowid DESC LIMIT ?`).all(safeLimit);
  return mapAuditRows(rows);
}

function listAllAuditLog(db) {
  const rows = db.prepare(`SELECT id, entity_type, entity_id, parent_entity_id, action,
      before_json, after_json, occurred_at_utc
    FROM audit_log ORDER BY occurred_at_utc DESC, rowid DESC`).all();
  return mapAuditRows(rows);
}

function scaledIntegerToNumber(value, scale, label) {
  const integer = Number(value || 0);
  if (!Number.isSafeInteger(integer)) throw new RangeError(`${label} exceeds JavaScript's safe integer range.`);
  return integer / scale;
}

function listAllTransactions(db, fromDate = null, toDate = null) {
  if ((fromDate && !toDate) || (!fromDate && toDate)) throw new Error('Both range dates must be supplied.');
  if (fromDate) {
    assertValidDate(fromDate);
    assertValidDate(toDate);
    if (fromDate > toDate) throw new Error('Start date cannot be after end date.');
  }
  const rows = fromDate
    ? db.prepare(`SELECT type,id,tx_date,name,line_count,quantity_micros,amount_milli,description,notes,category_id,worker_id
        FROM v_all_transactions WHERE tx_date BETWEEN ? AND ? ORDER BY tx_date DESC,id DESC`).all(fromDate, toDate)
    : db.prepare(`SELECT type,id,tx_date,name,line_count,quantity_micros,amount_milli,description,notes,category_id,worker_id
        FROM v_all_transactions ORDER BY tx_date DESC,id DESC`).all();

  const expenseRows = db.prepare(`SELECT id,category_id,description,notes FROM expenses WHERE deleted_at IS NULL`).all();
  const expensesById = new Map(expenseRows.map((row) => [row.id, row]));
  const withdrawalRows = db.prepare(`SELECT id,worker_id,notes FROM withdrawals WHERE deleted_at IS NULL`).all();
  const withdrawalsById = new Map(withdrawalRows.map((row) => [row.id, row]));

  return rows.map((row) => {
    const common = {
      id: row.id,
      type: row.type,
      date: row.tx_date,
      name: row.name,
      amount: scaledIntegerToNumber(row.amount_milli, 1000, 'Transaction amount'),
      qty: scaledIntegerToNumber(row.quantity_micros || 0, 1000000, 'Transaction quantity'),
      desc: row.description || '',
      note: row.notes || '',
      refId: row.category_id || row.worker_id || '',
    };
    if (row.type === 'profit') {
      const lines = getProfitLinesForTransaction(db, row.id).map((line) => ({
        id: line.id,
        name: line.item_name,
        qty: scaledIntegerToNumber(line.quantity_micros, 1000000, 'Profit line quantity'),
        amount: scaledIntegerToNumber(line.amount_milli, 1000, 'Profit line amount'),
        note: line.notes || '',
      }));
      return { ...common, lines, qty: lines.reduce((sum, line) => sum + line.qty, 0),
        amount: lines.reduce((sum, line) => sum + line.amount, 0), void: lines.length === 0 };
    }
    if (row.type === 'expense') {
      const detail = expensesById.get(row.id) || {};
      return { ...common, refId: detail.category_id || row.category_id || '',
        desc: detail.description ?? row.description ?? '', note: detail.notes ?? row.notes ?? '' };
    }
    const detail = withdrawalsById.get(row.id) || {};
    return { ...common, refId: detail.worker_id || row.worker_id || '', note: detail.notes ?? row.notes ?? '' };
  });
}

function getReportData(db, fromDate, toDate) {
  assertValidDate(fromDate);
  assertValidDate(toDate);
  if (fromDate > toDate) throw new Error('Start date cannot be after end date.');

  const totals = db.prepare(`SELECT
      CAST(COALESCE(SUM(CASE WHEN type='profit' THEN amount_milli ELSE 0 END),0) AS TEXT) AS profit_milli,
      CAST(COALESCE(SUM(CASE WHEN type='profit' THEN quantity_micros ELSE 0 END),0) AS TEXT) AS quantity_micros,
      CAST(COALESCE(SUM(CASE WHEN type='expense' THEN amount_milli ELSE 0 END),0) AS TEXT) AS expense_milli,
      CAST(COALESCE(SUM(CASE WHEN type='withdrawal' THEN amount_milli ELSE 0 END),0) AS TEXT) AS withdrawal_milli,
      CAST(COALESCE(SUM(CASE WHEN type IN ('expense','withdrawal') THEN amount_milli ELSE 0 END),0) AS TEXT) AS total_expense_milli,
      CAST(COALESCE(SUM(CASE WHEN type='profit' THEN amount_milli ELSE -amount_milli END),0) AS TEXT) AS net_milli
    FROM v_all_transactions WHERE tx_date BETWEEN ? AND ?`).get(fromDate, toDate);

  const items = db.prepare(`SELECT item_name,
      CAST(SUM(quantity_micros) AS TEXT) AS quantity_micros,
      CAST(SUM(amount_milli) AS TEXT) AS amount_milli
    FROM profit_lines pl JOIN profit_transactions pt ON pt.id=pl.transaction_id
    WHERE pt.deleted_at IS NULL AND pl.deleted_at IS NULL AND pt.tx_date BETWEEN ? AND ?
    GROUP BY item_name ORDER BY SUM(amount_milli) DESC,item_name`).all(fromDate, toDate);
  const categories = db.prepare(`SELECT category_name_snapshot AS name,
      CAST(SUM(amount_milli) AS TEXT) AS amount_milli
    FROM expenses WHERE deleted_at IS NULL AND tx_date BETWEEN ? AND ?
    GROUP BY category_id,category_name_snapshot ORDER BY SUM(amount_milli) DESC,category_name_snapshot`).all(fromDate, toDate);
  const workers = db.prepare(`SELECT worker_name_snapshot AS name,
      CAST(SUM(amount_milli) AS TEXT) AS amount_milli
    FROM withdrawals WHERE deleted_at IS NULL AND tx_date BETWEEN ? AND ?
    GROUP BY worker_id,worker_name_snapshot ORDER BY SUM(amount_milli) DESC,worker_name_snapshot`).all(fromDate, toDate);

  return {
    fromDate,
    toDate,
    totals,
    items,
    categories,
    workers,
    transactions: listAllTransactions(db, fromDate, toDate),
  };
}

function listTransactionsForLegacyExport(db) {
  const exported = [];
  const profitRows = db.prepare(`SELECT id,tx_date,created_at,deleted_at
    FROM profit_transactions ORDER BY tx_date,id`).all();
  const allLines = db.prepare(`SELECT id,transaction_id,legacy_ref_id,item_name,quantity_micros,amount_milli,notes,created_at,deleted_at
    FROM profit_lines ORDER BY rowid`).all();
  const linesByMovement = new Map();
  for (const line of allLines) {
    if (!linesByMovement.has(line.transaction_id)) linesByMovement.set(line.transaction_id, []);
    linesByMovement.get(line.transaction_id).push({
      id: line.id,
      refId: line.legacy_ref_id || '',
      name: line.item_name,
      qty: scaledIntegerToNumber(line.quantity_micros, 1000000, 'Legacy export quantity'),
      amount: scaledIntegerToNumber(line.amount_milli, 1000, 'Legacy export amount'),
      note: line.notes || '',
      deleted: Boolean(line.deleted_at),
      deletedAt: line.deleted_at || null,
    });
  }
  for (const movement of profitRows) {
    const lines = linesByMovement.get(movement.id) || [];
    const activeLines = lines.filter((line) => !line.deleted);
    const totalAmount = activeLines.reduce((sum, line) => sum + line.amount, 0);
    const totalQuantity = activeLines.reduce((sum, line) => sum + line.qty, 0);
    exported.push({
      id: movement.id, type: 'profit', date: movement.tx_date,
      name: activeLines.length === 1 ? activeLines[0].name : 'حركة أرباح أصناف',
      refId: activeLines.length === 1 ? activeLines[0].refId : '',
      qty: totalQuantity, amount: totalAmount, desc: '', note: '',
      void: Boolean(movement.deleted_at) || activeLines.length === 0,
      deletedAt: movement.deleted_at || null,
      createdAt: movement.created_at,
      lines,
    });
  }

  const expenses = db.prepare(`SELECT id,tx_date,category_id,category_name_snapshot,amount_milli,description,notes,created_at,deleted_at
    FROM expenses ORDER BY tx_date,id`).all();
  for (const row of expenses) exported.push({
    id: row.id, type: 'expense', date: row.tx_date, refId: row.category_id,
    name: row.category_name_snapshot, qty: 0,
    amount: scaledIntegerToNumber(row.amount_milli, 1000, 'Legacy export amount'),
    desc: row.description, note: row.notes || '', void: Boolean(row.deleted_at),
    deletedAt: row.deleted_at || null, createdAt: row.created_at,
  });

  const withdrawals = db.prepare(`SELECT id,tx_date,worker_id,worker_name_snapshot,amount_milli,notes,created_at,deleted_at
    FROM withdrawals ORDER BY tx_date,id`).all();
  for (const row of withdrawals) exported.push({
    id: row.id, type: 'withdrawal', date: row.tx_date, refId: row.worker_id,
    name: row.worker_name_snapshot, qty: 0,
    amount: scaledIntegerToNumber(row.amount_milli, 1000, 'Legacy export amount'),
    desc: '', note: row.notes || '', void: Boolean(row.deleted_at),
    deletedAt: row.deleted_at || null, createdAt: row.created_at,
  });
  return exported.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

function validateReportRange(fromDate, toDate) {
  assertValidDate(fromDate);
  assertValidDate(toDate);
  if (fromDate > toDate) throw new Error('Start date cannot be after end date.');
}

function reportInteger(value) {
  return String(value ?? '0');
}

function sumIntegerStrings(values) {
  return values.reduce((total, value) => total + BigInt(value || 0), 0n).toString();
}

function listReportOptions(db) {
  const catalogItems = db.prepare(`SELECT name, is_active FROM items
    WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`).all();
  const historicalItems = db.prepare(`SELECT pl.item_name AS name, 0 AS is_active FROM profit_lines pl
    JOIN profit_transactions pt ON pt.id=pl.transaction_id
    WHERE pl.deleted_at IS NULL AND pt.deleted_at IS NULL
    GROUP BY pl.item_name ORDER BY pl.item_name COLLATE NOCASE`).all();
  const itemMap = new Map();
  for (const row of [...catalogItems, ...historicalItems]) {
    const key = String(row.name || '').trim();
    if (!key) continue;
    const existing = itemMap.get(key);
    itemMap.set(key, { value: key, name: key, active: Boolean(row.is_active) || Boolean(existing?.active) });
  }
  const categories = db.prepare(`SELECT id AS value, name, is_active AS active
    FROM expense_categories WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id`).all()
    .map((row) => ({ ...row, active: Boolean(row.active) }));
  const workers = db.prepare(`SELECT id AS value, name, is_active AS active
    FROM workers WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id`).all()
    .map((row) => ({ ...row, active: Boolean(row.active) }));
  return {
    items: [...itemMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar')),
    categories,
    workers,
  };
}

function getProfitItemReport(db, fromDate, toDate, itemNames = []) {
  validateReportRange(fromDate, toDate);
  if (!Array.isArray(itemNames) || itemNames.length > 500) {
    throw new Error('Invalid profit item selection.');
  }
  const names = [...new Set(itemNames.map((name) => normalizeName(name)).filter(Boolean))];
  const filterSql = names.length ? `AND pl.item_name IN (${names.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT pl.id AS line_id, pl.transaction_id, pt.tx_date,
      pl.item_name, CAST(pl.quantity_micros AS TEXT) AS quantity_micros,
      CAST(pl.amount_milli AS TEXT) AS amount_milli, pl.notes
    FROM profit_lines pl JOIN profit_transactions pt ON pt.id=pl.transaction_id
    WHERE pt.deleted_at IS NULL AND pl.deleted_at IS NULL
      AND pt.tx_date BETWEEN ? AND ? ${filterSql}
    ORDER BY pt.tx_date, pl.item_name COLLATE NOCASE, pl.rowid`).all(fromDate, toDate, ...names);
  const byItemMap = new Map();
  const byDayMap = new Map();
  for (const row of rows) {
    const item = byItemMap.get(row.item_name) || { name: row.item_name, quantity_micros: '0', amount_milli: '0', operation_count: 0 };
    item.quantity_micros = (BigInt(item.quantity_micros) + BigInt(row.quantity_micros)).toString();
    item.amount_milli = (BigInt(item.amount_milli) + BigInt(row.amount_milli)).toString();
    item.operation_count += 1;
    byItemMap.set(row.item_name, item);
    const day = byDayMap.get(row.tx_date) || { date: row.tx_date, quantity_micros: '0', amount_milli: '0', operation_count: 0 };
    day.quantity_micros = (BigInt(day.quantity_micros) + BigInt(row.quantity_micros)).toString();
    day.amount_milli = (BigInt(day.amount_milli) + BigInt(row.amount_milli)).toString();
    day.operation_count += 1;
    byDayMap.set(row.tx_date, day);
  }
  return {
    type: 'profits', fromDate, toDate, selected: [...byItemMap.keys()].sort((a, b) => a.localeCompare(b, 'ar')),
    totals: {
      quantity_micros: sumIntegerStrings(rows.map((row) => row.quantity_micros)),
      amount_milli: sumIntegerStrings(rows.map((row) => row.amount_milli)),
      operation_count: rows.length,
    },
    rows: rows.map((row) => ({ ...row })),
    byItem: [...byItemMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar')),
    byDay: [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function getExpenseCategoryReport(db, fromDate, toDate, categoryIds = []) {
  validateReportRange(fromDate, toDate);
  if (!Array.isArray(categoryIds) || categoryIds.length > 100) throw new Error('Invalid expense category selection.');
  const ids = [...new Set(categoryIds.map(String).filter(Boolean))];
  const filter = ids.length ? `AND category_id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT id, tx_date, category_id, category_name_snapshot,
      CAST(amount_milli AS TEXT) AS amount_milli, description, notes
    FROM expenses WHERE deleted_at IS NULL AND tx_date BETWEEN ? AND ? ${filter}
    ORDER BY tx_date, category_name_snapshot COLLATE NOCASE, id`).all(fromDate, toDate, ...ids);
  const group = new Map();
  for (const row of rows) {
    const key = `${row.category_id}::${row.category_name_snapshot}`;
    const current = group.get(key) || { id: row.category_id, name: row.category_name_snapshot, amount_milli: '0', operation_count: 0 };
    current.amount_milli = (BigInt(current.amount_milli) + BigInt(row.amount_milli)).toString();
    current.operation_count += 1;
    group.set(key, current);
  }
  return {
    type: 'expenses', fromDate, toDate, selected: ids,
    totals: { amount_milli: sumIntegerStrings(rows.map((row) => row.amount_milli)), operation_count: rows.length },
    rows, byCategory: [...group.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar')),
  };
}

function getWorkerWithdrawalReport(db, fromDate, toDate, workerIds = []) {
  validateReportRange(fromDate, toDate);
  if (!Array.isArray(workerIds) || workerIds.length > 100) throw new Error('Invalid worker selection.');
  const ids = [...new Set(workerIds.map(String).filter(Boolean))];
  const filter = ids.length ? `AND worker_id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT id, tx_date, worker_id, worker_name_snapshot,
      CAST(amount_milli AS TEXT) AS amount_milli, notes
    FROM withdrawals WHERE deleted_at IS NULL AND tx_date BETWEEN ? AND ? ${filter}
    ORDER BY tx_date, worker_name_snapshot COLLATE NOCASE, id`).all(fromDate, toDate, ...ids);
  const group = new Map();
  for (const row of rows) {
    const key = `${row.worker_id}::${row.worker_name_snapshot}`;
    const current = group.get(key) || { id: row.worker_id, name: row.worker_name_snapshot, amount_milli: '0', operation_count: 0 };
    current.amount_milli = (BigInt(current.amount_milli) + BigInt(row.amount_milli)).toString();
    current.operation_count += 1;
    group.set(key, current);
  }
  return {
    type: 'withdrawals', fromDate, toDate, selected: ids,
    totals: { amount_milli: sumIntegerStrings(rows.map((row) => row.amount_milli)), operation_count: rows.length },
    rows, byWorker: [...group.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar')),
  };
}

function getGeneralReport(db, fromDate, toDate) {
  validateReportRange(fromDate, toDate);
  const base = getReportData(db, fromDate, toDate);
  const dailyRows = getDailyTotals(db, fromDate, toDate);
  const dailyMap = new Map(dailyRows.map((row) => [row.tx_date, row]));
  const daily = [];
  const cursor = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T00:00:00.000Z`);
  for (let guard = 0; cursor <= end && guard < 3661; guard += 1) {
    const date = cursor.toISOString().slice(0, 10);
    const row = dailyMap.get(date) || {};
    daily.push({
      date,
      profit_milli: reportInteger(row.profit_milli),
      expense_milli: reportInteger(row.expense_milli),
      withdrawal_milli: reportInteger(row.withdrawal_milli),
      total_expense_milli: reportInteger(row.total_expense_milli),
      net_milli: reportInteger(row.net_milli),
      quantity_micros: reportInteger(row.profit_quantity_micros),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (daily.length >= 3661 && daily[daily.length - 1].date < toDate) {
    throw new RangeError('The selected report range is too long. Select a period of 10 years or less.');
  }
  return { type: 'general', fromDate, toDate, totals: base.totals, daily,
    items: base.items, categories: base.categories, workers: base.workers, transactions: base.transactions };
}

function listAuditLogPage(db, { limit = 50, offset = 0, search = '' } = {}) {
  const safeLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), 200);
  const safeOffset = Math.min(Math.max(Number.isInteger(offset) ? offset : 0, 0), 10000000);
  const query = String(search || '').trim().slice(0, 200);
  const like = `%${query.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
  const where = query ? `WHERE entity_type LIKE ? ESCAPE '\\' OR entity_id LIKE ? ESCAPE '\\'
    OR action LIKE ? ESCAPE '\\' OR COALESCE(before_json,'') LIKE ? ESCAPE '\\'
    OR COALESCE(after_json,'') LIKE ? ESCAPE '\\'` : '';
  const args = query ? [like, like, like, like, like] : [];
  const rows = db.prepare(`SELECT id, entity_type, entity_id, parent_entity_id, action,
      before_json, after_json, occurred_at_utc FROM audit_log ${where}
      ORDER BY occurred_at_utc DESC, rowid DESC LIMIT ? OFFSET ?`).all(...args, safeLimit, safeOffset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...args).n;
  return { items: mapAuditRows(rows), total, limit: safeLimit, offset: safeOffset, hasMore: safeOffset + rows.length < total };
}

module.exports = {
  createProfitMovement,
  updateProfitLine,
  deleteProfitLine,
  updateProfitMovementDate,
  softDeleteProfitMovement,
  createExpense,
  updateExpense,
  softDeleteExpense,
  createWithdrawal,
  updateWithdrawal,
  softDeleteWithdrawal,
  saveCatalogEntry,
  setCatalogActive,
  listCatalogEntries,
  getAppSettings,
  setAppSetting,
  setCurrencySettings,
  searchNameSuggestions,
  listTransactions,
  getDailyTotals,
  getProfitByItem,
  getExpensesByCategory,
  getWithdrawalsByWorker,
  getProfitLinesForTransaction,
  listNameSuggestionHistory,
  listAuditLog,
  listAllAuditLog,
  listAllTransactions,
  getReportData,
  listReportOptions,
  getProfitItemReport,
  getExpenseCategoryReport,
  getWorkerWithdrawalReport,
  getGeneralReport,
  listAuditLogPage,
  recordSystemEvent,
  listTransactionsForLegacyExport,
};
