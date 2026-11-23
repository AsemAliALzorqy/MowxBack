'use strict';

const crypto = require('node:crypto');
const { utcNow } = require('./db');
const { parseMoneyToMilli, parseQuantityToMicros, decimalPlacesForCurrency } = require('./money');

const CURRENCIES = new Set(['SAR', 'JOD', 'AED', 'KWD', 'USD', 'EGP', 'custom']);

function normalizeName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeName(value).toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

function timeFromLegacy(value, fallback = utcNow()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString();
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid legacy backup: ${field} is missing.`);
  return value;
}

function parseAndValidateLegacyBackup(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) throw new Error('The selected JSON file is empty.');
  let wrapper;
  try { wrapper = JSON.parse(rawText); } catch (_) { throw new Error('The selected file is not valid JSON.'); }
  if (!wrapper || wrapper.app !== 'MowxBack') throw new Error('This JSON file is not a MowxBack backup.');
  if (wrapper.schema !== 2) throw new Error(`Unsupported backup wrapper schema: ${String(wrapper.schema)}. Supported schema: 2.`);
  const data = wrapper.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The backup does not contain the expected data object.');
  const internalVersion = Number(data.v || 1);
  if (!Number.isInteger(internalVersion) || internalVersion < 1 || internalVersion > 3) {
    throw new Error(`Unsupported internal data version: ${String(data.v)}. Supported versions: 1–3.`);
  }
  for (const key of ['items', 'workers', 'cats', 'tx', 'log', 'names']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`Invalid backup: data.${key} must be an array.`);
  }
  return { wrapper, data, internalVersion };
}

function isBusinessDatabaseEmpty(db) {
  const tables = ['items', 'workers', 'profit_transactions', 'profit_lines', 'expenses', 'withdrawals', 'name_suggestions', 'audit_log', 'legacy_imports'];
  const noBusinessRows = tables.every((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n === 0);
  const hasCustomCategories = db.prepare(`SELECT 1 FROM expense_categories
    WHERE id NOT IN ('builtin-food','builtin-fuel','builtin-maintenance') LIMIT 1`).get();
  return noBusinessRows && !hasCustomCategories;
}

function importLegacyBackup(db, rawText, sourceName = '') {
  const { wrapper, data, internalVersion } = parseAndValidateLegacyBackup(rawText);
  const digest = crypto.createHash('sha256').update(rawText).digest('hex');
  if (db.prepare('SELECT 1 FROM legacy_imports WHERE content_sha256 = ?').get(digest)) {
    throw new Error('This exact backup file has already been imported.');
  }
  if (!isBusinessDatabaseEmpty(db)) {
    throw new Error('Import is allowed only into an empty business database. Export/backup the current data before proceeding.');
  }

  const now = utcNow();
  const currencyCode = CURRENCIES.has(data.currencyCode) ? data.currencyCode : 'custom';
  const currencyLabel = String(data.currency ?? (currencyCode === 'custom' ? 'ريال' : currencyCode)).trim() || 'ريال';
  const currencyPlaces = decimalPlacesForCurrency(currencyCode, 2);
  const insertCatalog = {
    items: db.prepare(`INSERT INTO items(id, name, is_active, created_at, updated_at)
                       VALUES (@id, @name, @active, @created, @updated)`),
    workers: db.prepare(`INSERT INTO workers(id, name, is_active, created_at, updated_at)
                         VALUES (@id, @name, @active, @created, @updated)`),
    cats: db.prepare(`INSERT INTO expense_categories(id, name, is_active, created_at, updated_at)
                      VALUES (@id, @name, @active, @created, @updated)`),
  };

  const runImport = db.transaction(() => {
    if (!isBusinessDatabaseEmpty(db)) throw new Error('The database changed while import was being prepared.');

    // Replace only the three unused built-in category rows with the imported
    // category records, preserving their original IDs and avoiding duplicates.
    db.prepare("DELETE FROM expense_categories WHERE id IN ('builtin-food','builtin-fuel','builtin-maintenance')").run();

    for (const kind of ['items', 'workers', 'cats']) {
      const source = Array.isArray(data[kind]) ? data[kind] : [];
      const seen = new Set();
      for (const entry of source) {
        const id = requireString(entry?.id, `${kind}.id`);
        const name = normalizeName(entry?.name);
        if (!name) throw new Error(`Invalid legacy record in ${kind}: name is empty.`);
        if (seen.has(id)) throw new Error(`Duplicate legacy ID in ${kind}: ${id}`);
        seen.add(id);
        const active = entry.active === false || entry.active === 0 ? 0 : 1;
        insertCatalog[kind].run({ id, name, active, created: now, updated: now });
      }
    }

    const defaultCategories = [
      ['builtin-food', 'الطعام'],
      ['builtin-fuel', 'المحروقات'],
      ['builtin-maintenance', 'الصيانة والأعطال'],
    ];
    const categoryByNormalizedName = new Set(
      db.prepare('SELECT name FROM expense_categories').all().map((row) => normalizeKey(row.name)),
    );
    const insertDefaultCategory = db.prepare(`INSERT INTO expense_categories
      (id, name, is_active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`);
    for (const [defaultId, defaultName] of defaultCategories) {
      const key = normalizeKey(defaultName);
      if (!categoryByNormalizedName.has(key)) {
        // Keep the built-in ID when there is no corresponding imported row.
        if (!db.prepare('SELECT 1 FROM expense_categories WHERE id=?').get(defaultId)) {
          insertDefaultCategory.run(defaultId, defaultName, now, now);
        }
      }
    }

    const getItem = db.prepare('SELECT id FROM items WHERE id = ?');
    const getWorker = db.prepare('SELECT id, name FROM workers WHERE id = ?');
    const getCategory = db.prepare('SELECT id, name FROM expense_categories WHERE id = ?');
    const insertProfit = db.prepare(`INSERT INTO profit_transactions(id, tx_date, created_at, updated_at, deleted_at)
                                     VALUES (?, ?, ?, ?, ?)`);
    const insertLine = db.prepare(`INSERT INTO profit_lines
      (id, transaction_id, item_id, legacy_ref_id, item_name, quantity_micros, amount_milli, notes, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertExpense = db.prepare(`INSERT INTO expenses
      (id, tx_date, category_id, category_name_snapshot, amount_milli, description, notes, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertWithdrawal = db.prepare(`INSERT INTO withdrawals
      (id, tx_date, worker_id, worker_name_snapshot, amount_milli, notes, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const usedSuggestion = new Map();
    const addSuggestion = db.prepare(`INSERT INTO name_suggestions
      (normalized_name, display_name, first_used_at, last_used_at, use_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(normalized_name) DO UPDATE SET
        last_used_at = excluded.last_used_at,
        use_count = name_suggestions.use_count + 1`);

    for (const name of Array.isArray(data.names) ? data.names : []) {
      const display = normalizeName(name);
      const key = normalizeKey(display);
      if (display && key && !usedSuggestion.has(key)) {
        usedSuggestion.set(key, display);
        addSuggestion.run(key, display, now, now);
      }
    }

    const transactions = Array.isArray(data.tx) ? data.tx : [];
    const transactionTypeById = new Map(transactions.map((tx) => [String(tx.id), tx.type]));
    const txIds = new Set();
    for (const tx of transactions) {
      const id = requireString(tx?.id, 'tx.id');
      if (txIds.has(id)) throw new Error(`Duplicate transaction ID: ${id}`);
      txIds.add(id);
      const type = tx.type;
      const date = requireString(tx.date, `tx(${id}).date`);
      const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      const validDate = dateMatch && (() => {
        const probe = new Date(Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3])));
        return probe.getUTCFullYear() === Number(dateMatch[1]) &&
          probe.getUTCMonth() + 1 === Number(dateMatch[2]) &&
          probe.getUTCDate() === Number(dateMatch[3]);
      })();
      if (!validDate) throw new Error(`Invalid transaction date for ${id}: ${date}`);
      const created = timeFromLegacy(tx.createdAt, now);
      const deletedAt = tx.void ? timeFromLegacy(tx.deletedAt, now) : null;

      if (type === 'profit') {
        insertProfit.run(id, date, created, now, deletedAt);
        let lines;
        if (Array.isArray(tx.lines)) {
          lines = tx.lines;
        } else {
          // v1/v2 single-item profit: preserve its movement ID and make one child line.
          lines = [{
            id: `${id}-line-1`, refId: tx.refId, name: tx.name,
            qty: tx.qty, amount: tx.amount, note: tx.note || '',
          }];
        }
        const lineIds = new Set();
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const lineId = String(line.id || `${id}-line-${index + 1}`);
          if (lineIds.has(lineId)) throw new Error(`Duplicate line ID in transaction ${id}: ${lineId}`);
          lineIds.add(lineId);
          const name = normalizeName(line.name || tx.name);
          if (!name) throw new Error(`Profit line ${lineId} has no item name.`);
          const quantity = parseQuantityToMicros(line.qty ?? 0);
          const amount = parseMoneyToMilli(line.amount ?? 0, 3);
          const refId = line.refId || tx.refId || null;
          const itemId = refId && getItem.get(refId) ? refId : null;
          const isDeleted = line.deleted === true || line.deleted === 1;
          const lineDeletedAt = isDeleted ? timeFromLegacy(line.deletedAt, now) : null;
          insertLine.run(
            lineId, id, itemId, refId, name, quantity, amount,
            String(line.note ?? ''), created, now, lineDeletedAt,
          );
          const key = normalizeKey(name);
          if (key) {
            if (!usedSuggestion.has(key)) {
              usedSuggestion.set(key, name);
              addSuggestion.run(key, name, now, now);
            } else if (!Array.isArray(data.names) || !data.names.some((n) => normalizeKey(n) === key)) {
              addSuggestion.run(key, usedSuggestion.get(key), now, now);
            }
          }
        }
      } else if (type === 'expense') {
        const refId = requireString(tx.refId, `expense(${id}).refId`);
        let category = getCategory.get(refId);
        const snapshot = normalizeName(tx.name || category?.name);
        if (!category) {
          if (!snapshot) throw new Error(`Expense ${id} has no category snapshot.`);
          db.prepare(`INSERT INTO expense_categories(id, name, is_active, created_at, updated_at)
                      VALUES (?, ?, 0, ?, ?)`)
            .run(refId, snapshot, now, now);
          category = { id: refId, name: snapshot };
        }
        insertExpense.run(id, date, category.id, snapshot || category.name,
          parseMoneyToMilli(tx.amount ?? 0, 3), String(tx.desc ?? ''),
          String(tx.note ?? ''), created, now, deletedAt);
      } else if (type === 'withdrawal') {
        const refId = requireString(tx.refId, `withdrawal(${id}).refId`);
        let worker = getWorker.get(refId);
        const snapshot = normalizeName(tx.name || worker?.name);
        if (!worker) {
          if (!snapshot) throw new Error(`Withdrawal ${id} has no worker snapshot.`);
          db.prepare(`INSERT INTO workers(id, name, is_active, created_at, updated_at)
                      VALUES (?, ?, 0, ?, ?)`)
            .run(refId, snapshot, now, now);
          worker = { id: refId, name: snapshot };
        }
        insertWithdrawal.run(id, date, worker.id, snapshot || worker.name,
          parseMoneyToMilli(tx.amount ?? 0, 3), String(tx.note ?? ''),
          created, now, deletedAt);
      } else {
        throw new Error(`Unknown legacy transaction type for ${id}: ${String(type)}`);
      }
    }

    const insertAudit = db.prepare(`INSERT INTO audit_log
      (id, entity_type, entity_id, parent_entity_id, action, before_json, after_json, occurred_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const entry of Array.isArray(data.log) ? data.log : []) {
      const id = String(entry.id || `legacy-log-${Math.random().toString(36).slice(2)}`);
      const hasLine = Boolean(entry.lineId);
      const legacyType = transactionTypeById.get(String(entry.txId || ''));
      const inferredEntityType = hasLine ? 'profit_line'
        : legacyType === 'profit' ? 'profit_transaction'
          : legacyType === 'expense' ? 'expense'
            : legacyType === 'withdrawal' ? 'withdrawal' : 'system';
      const allowedEntityTypes = new Set(['profit_transaction', 'profit_line', 'expense', 'withdrawal', 'item', 'worker', 'expense_category', 'system']);
      const entityType = allowedEntityTypes.has(entry.entityType) ? entry.entityType : inferredEntityType;
      const entityId = String(entry.entityId || entry.lineId || entry.txId || id);
      const parentEntityId = entry.parentEntityId || entry.txId || null;
      const allowedActions = new Set(['create', 'update', 'soft_delete', 'restore', 'activate', 'deactivate', 'backup_restore', 'database_move', 'import']);
      const op = allowedActions.has(entry.op) ? entry.op
        : entry.op === 'delete' ? 'soft_delete' : 'update';
      insertAudit.run(
        id, entityType, entityId, parentEntityId ? String(parentEntityId) : null, op,
        entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
        entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
        timeFromLegacy(entry.at, now),
      );
    }

    const putSetting = db.prepare(`INSERT INTO app_settings(setting_key, value_json, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`);
    putSetting.run('currencyCode', JSON.stringify(currencyCode), now);
    putSetting.run('currencyLabel', JSON.stringify(currencyLabel), now);
    putSetting.run('currencyDecimalPlaces', JSON.stringify(currencyPlaces), now);
    putSetting.run('legacyDemoFlag', JSON.stringify(Boolean(data.demo)), now);

    db.prepare(`INSERT INTO legacy_imports
      (content_sha256, external_schema, internal_version, exported_at, imported_at_utc, source_name)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(digest, wrapper.schema, internalVersion, wrapper.exportedAt || null, now, String(sourceName));

    insertAudit.run(
      `import-${digest.slice(0, 20)}`, 'system', 'legacy-backup', null, 'import', null,
      JSON.stringify({ externalSchema: wrapper.schema, internalVersion, sourceName }), now,
    );
  });

  runImport();
  return {
    imported: true,
    contentSha256: digest,
    internalVersion,
    counts: {
      items: db.prepare('SELECT COUNT(*) AS n FROM items').get().n,
      workers: db.prepare('SELECT COUNT(*) AS n FROM workers').get().n,
      categories: db.prepare('SELECT COUNT(*) AS n FROM expense_categories').get().n,
      profitTransactions: db.prepare('SELECT COUNT(*) AS n FROM profit_transactions').get().n,
      profitLines: db.prepare('SELECT COUNT(*) AS n FROM profit_lines').get().n,
      expenses: db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n,
      withdrawals: db.prepare('SELECT COUNT(*) AS n FROM withdrawals').get().n,
      auditEntries: db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,
    },
  };
}

module.exports = { parseAndValidateLegacyBackup, importLegacyBackup, normalizeName, normalizeKey };
