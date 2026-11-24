'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
} = require('electron');
const { openDatabase, integrityReport } = require('../src/database/db');
const {
  verifyDatabaseFile,
  createDatabaseBackup,
  moveDatabase,
  restoreDatabase,
} = require('../src/database/lifecycle');
const { importLegacyBackup } = require('../src/database/legacy-import');
const Repository = require('../src/database/repository');
const Money = require('../src/database/money');

let mainWindow = null;
let db = null;
let dbPath = null;
let runtimeConfig = null;
let isQuitting = false;

async function renderReportPdf(reportData) {
  const pdfWindow = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await pdfWindow.loadFile(path.join(__dirname, '..', 'reports', 'templates', 'report.html'));
    await pdfWindow.webContents.executeJavaScript(`window.renderMowxReport(${JSON.stringify(reportData)}).then(() => true)`);
    return await pdfWindow.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      margins: { top: 0.35, right: 0.35, bottom: 0.55, left: 0.35 },
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="width:100%;font-family:Arial,sans-serif;font-size:8px;color:#64748b;padding:0 12mm;display:flex;justify-content:space-between;"><span>MowxBack</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    if (!pdfWindow.isDestroyed()) pdfWindow.destroy();
  }
}

const APP_CONFIG_NAME = 'mowxback-runtime.json';

function configPath() {
  return path.join(app.getPath('userData'), APP_CONFIG_NAME);
}

async function readRuntimeConfig() {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid app config shape');
    return {
      databasePath: typeof parsed.databasePath === 'string' ? parsed.databasePath : null,
      backupDirectory: typeof parsed.backupDirectory === 'string' ? parsed.backupDirectory : null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { databasePath: null, backupDirectory: null };
    throw new Error(`تعذر قراءة إعدادات تشغيل MowxBack: ${error.message}`);
  }
}

async function saveRuntimeConfig(patch) {
  const next = { ...runtimeConfig, ...patch };
  const file = configPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(temp, file);
  runtimeConfig = next;
}

async function chooseDirectory(title) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

async function chooseDatabaseFile(title = 'تحديد قاعدة بيانات MowxBack الأصلية') {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openFile'],
    filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }],
  });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

async function chooseBackupFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'اختيار نسخة MowxBack الاحتياطية',
    properties: ['openFile'],
    filters: [{ name: 'SQLite backup', extensions: ['db', 'sqlite', 'sqlite3'] }],
  });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

async function initializeFirstDatabase() {
  const selectedRoot = await chooseDirectory('اختر المجلد الرئيسي لبيانات MowxBack');
  if (!selectedRoot) return false;
  const dataDirectory = path.join(selectedRoot, 'Data');
  await fs.mkdir(dataDirectory, { recursive: true });
  const selectedPath = path.join(dataDirectory, 'mowxback.db');
  // If a file already exists at the expected location, open and validate it;
  // never replace it with a new empty database.
  try {
    db = openDatabase(selectedPath, { create: true });
  } catch (error) {
    return recoverMissingDatabase(error.message || String(error));
  }
  dbPath = selectedPath;
  await saveRuntimeConfig({ databasePath: dbPath });
  return true;
}

async function recoverMissingDatabase(reason = '') {
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'قاعدة بيانات MowxBack غير متاحة',
    message: 'تعذر الوصول إلى ملف قاعدة البيانات المسجل. لن يتم إنشاء قاعدة فارغة تلقائياً حتى لا تبدو البيانات القديمة وكأنها فُقدت.',
    detail: `${reason ? `سبب التعذر: ${reason}\n\n` : ''}اختر تحديد ملف القاعدة الأصلية، أو استعادة نسخة احتياطية، أو إغلاق البرنامج.`,
    buttons: ['تحديد ملف القاعدة الأصلية', 'استعادة نسخة احتياطية', 'إغلاق البرنامج'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  if (choice.response === 0) {
    const selectedFile = await chooseDatabaseFile();
    if (!selectedFile) return false;
    db = openDatabase(selectedFile, { create: false });
    dbPath = selectedFile;
    await saveRuntimeConfig({ databasePath: dbPath });
    return true;
  }

  if (choice.response === 1) {
    const backupFile = await chooseBackupFile();
    if (!backupFile) return false;
    verifyDatabaseFile(backupFile);
    const selectedRoot = await chooseDirectory('اختر مكان إنشاء مجلد Data لاستعادة القاعدة');
    if (!selectedRoot) return false;
    const dataDirectory = path.join(selectedRoot, 'Data');
    await fs.mkdir(dataDirectory, { recursive: true });
    const target = path.join(dataDirectory, 'mowxback.db');
    try {
      await fs.access(target);
      throw new Error('يوجد ملف قاعدة بيانات في المسار المختار. اختر مجلداً آخر؛ لم يتم استبداله.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temp = `${target}.${process.pid}.restore.tmp`;
    await fs.copyFile(backupFile, temp);
    verifyDatabaseFile(temp);
    await fs.rename(temp, target);
    db = openDatabase(target, { create: false });
    dbPath = target;
    await saveRuntimeConfig({ databasePath: dbPath });
    return true;
  }
  return false;
}

async function ensureDatabase() {
  runtimeConfig = await readRuntimeConfig();
  if (!runtimeConfig.databasePath) return initializeFirstDatabase();
  try {
    await fs.access(runtimeConfig.databasePath);
    db = openDatabase(runtimeConfig.databasePath, { create: false });
    dbPath = path.resolve(runtimeConfig.databasePath);
    return true;
  } catch (error) {
    // Missing, detached, unreadable, empty, or corrupt files all enter an
    // explicit recovery choice; none is replaced with a fresh database.
    return recoverMissingDatabase(error.message || String(error));
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 850,
    minHeight: 620,
    title: 'MowxBack',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

function registerIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('رفض طلب IPC من إطار غير موثوق.');
    }
    return handler(payload);
  });
}

function registerIpc() {
  const CATALOG_KIND = Object.freeze({ items: 'item', workers: 'worker', cats: 'expense_category' });
  const DEFAULT_CURRENCY = Object.freeze({ code: 'SAR', label: '\u20C1', decimalPlaces: 2 });

  function currencySettings() {
    const settings = Repository.getAppSettings(db);
    const code = settings.currencyCode || DEFAULT_CURRENCY.code;
    const label = code === 'SAR' ? DEFAULT_CURRENCY.label : (settings.currencyLabel || DEFAULT_CURRENCY.label);
    const decimalPlaces = settings.currencyDecimalPlaces ?? Money.decimalPlacesForCurrency(code, 2);
    return { currencyCode: code, currency: label, currencyDecimalPlaces: decimalPlaces };
  }

  function currentSnapshot() {
    const settings = currencySettings();
    const allSettings = Repository.getAppSettings(db);
    const mapCatalog = (kind) => Repository.listCatalogEntries(db, kind, true)
      .map((entry) => ({ id: entry.id, name: entry.name, active: Boolean(entry.is_active) }));
    const status = {
      databasePath: dbPath,
      backupDirectory: runtimeConfig.backupDirectory,
      databaseVersion: db.pragma('user_version', { simple: true }),
      integrityOk: integrityReport(db).ok,
    };
    return {
      v: 3,
      demo: Boolean(allSettings.legacyDemoFlag),
      ...settings,
      items: mapCatalog('item'),
      workers: mapCatalog('worker'),
      cats: mapCatalog('expense_category'),
      tx: Repository.listAllTransactions(db),
      names: Repository.listNameSuggestionHistory(db).map((row) => row.display_name),
      log: Repository.listAuditLog(db, 200),
      auditLogCount: Repository.listAuditLogPage(db, { limit: 1, offset: 0 }).total,
      runtime: status,
    };
  }

  function requiredObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
    return value;
  }

  function stringValue(value, label, max = 4000) {
    if (typeof value !== 'string' || value.length > max) throw new TypeError(`${label} is invalid.`);
    return value;
  }

  function amountMilli(value) {
    const places = currencySettings().currencyDecimalPlaces;
    return Money.parseMoneyToMilli(String(value ?? ''), places);
  }

  function quantityMicros(value) {
    return Money.parseQuantityToMicros(String(value ?? ''));
  }

  function legacyExportPayload() {
    const state = currentSnapshot();
    const now = new Date().toISOString();
    return {
      app: 'MowxBack',
      schema: 2,
      exportedAt: now,
      data: {
        v: 3,
        demo: Boolean(state.demo),
        currencyCode: state.currencyCode,
        currency: state.currency,
        items: state.items,
        workers: state.workers,
        cats: state.cats,
        names: state.names,
        tx: Repository.listTransactionsForLegacyExport(db),
        log: Repository.listAllAuditLog(db).map((entry) => ({
          id: entry.id,
          entityType: entry.entityType,
          entityId: entry.entityId,
          parentEntityId: entry.parentEntityId,
          txId: entry.txId,
          lineId: entry.lineId,
          op: entry.op,
          before: entry.before,
          after: entry.after,
          at: entry.at,
        })),
      },
    };
  }

  registerIpcHandler('mowx:get-snapshot', () => currentSnapshot());
  registerIpcHandler('mowx:get-report', (payload) => {
    requiredObject(payload, 'Report request');
    const result = Repository.getReportData(db, payload.fromDate, payload.toDate);
    const scaled = (value, scale, label) => {
      const integer = BigInt(value || '0');
      if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new RangeError(`${label} exceeds the safe display range. Export a report or review the underlying records.`);
      }
      return Number(integer) / scale;
    };
    const milli = (value) => scaled(value, 1000, 'Report amounts');
    const micros = (value) => scaled(value, 1000000, 'Report quantities');
    const totals = {
      profit: milli(result.totals.profit_milli),
      qty: micros(result.totals.quantity_micros),
      exp: milli(result.totals.expense_milli),
      wd: milli(result.totals.withdrawal_milli),
      totalExp: milli(result.totals.total_expense_milli),
      net: milli(result.totals.net_milli),
    };
    return {
      from: result.fromDate,
      to: result.toDate,
      totals,
      items: result.items.map((row) => ({ name: row.item_name, qty: micros(row.quantity_micros), amount: milli(row.amount_milli) })),
      categories: result.categories.map((row) => ({ name: row.name, amount: milli(row.amount_milli) })),
      workers: result.workers.map((row) => ({ name: row.name, amount: milli(row.amount_milli) })),
      transactions: result.transactions,
    };
  });
  registerIpcHandler('mowx:get-report-options', () => Repository.listReportOptions(db));

  function prepareReportData(payload) {
    requiredObject(payload, 'Report request');
    const type = stringValue(payload.type, 'Report type', 20);
    if (!['general', 'profits', 'expenses', 'withdrawals'].includes(type)) throw new TypeError('نوع التقرير غير مدعوم.');
    const fromDate = stringValue(payload.fromDate, 'Report start date', 10);
    const toDate = stringValue(payload.toDate, 'Report end date', 10);
    const scaled = (value, scale, label) => {
      const integer = BigInt(value || '0');
      if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new RangeError(`${label} exceeds the safe display range. Narrow the report period.`);
      }
      return Number(integer) / scale;
    };
    const milli = (value) => scaled(value, 1000, 'Report amounts');
    const micros = (value) => scaled(value, 1000000, 'Report quantities');
    const settings = currencySettings();
    const base = {
      type, fromDate, toDate,
      title: ({ general: 'التقرير العام', profits: 'تقرير أرباح الأصناف', expenses: 'تقرير المصروفات', withdrawals: 'تقرير سحبيات العمال' })[type],
      generatedAt: new Date().toISOString(),
      generatedAtText: new Intl.DateTimeFormat('ar-JO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()),
      currency: { code: settings.currencyCode, label: settings.currency, decimalPlaces: settings.currencyDecimalPlaces },
      filterSummary: type === 'general' ? 'جميع الحركات المالية المسجلة' : '',
    };
    if (type === 'general') {
      const result = Repository.getGeneralReport(db, fromDate, toDate);
      return {
        ...base,
        totals: {
          profit: milli(result.totals.profit_milli), expenses: milli(result.totals.expense_milli),
          withdrawals: milli(result.totals.withdrawal_milli), totalExpenses: milli(result.totals.total_expense_milli),
          net: milli(result.totals.net_milli), quantity: micros(result.totals.quantity_micros),
        },
        daily: result.daily.map((row) => ({
          date: row.date, profit: milli(row.profit_milli), expenses: milli(row.expense_milli),
          withdrawals: milli(row.withdrawal_milli), net: milli(row.net_milli), quantity: micros(row.quantity_micros),
        })),
        items: result.items.map((row) => ({ name: row.item_name, qty: micros(row.quantity_micros), amount: milli(row.amount_milli) })),
        categories: result.categories.map((row) => ({ name: row.name, amount: milli(row.amount_milli) })),
        workers: result.workers.map((row) => ({ name: row.name, amount: milli(row.amount_milli) })),
        movements: result.transactions.flatMap((transaction) => {
          if (transaction.type === 'profit') {
            return (transaction.lines || []).map((line) => ({
              type: 'profit', date: transaction.date, party: line.name,
              quantity: line.qty, amount: line.amount, description: '', notes: line.note || '',
            }));
          }
          return [{
            type: transaction.type, date: transaction.date,
            party: transaction.name, quantity: null, amount: transaction.amount,
            description: transaction.desc || '', notes: transaction.note || '',
          }];
        }),
      };
    }
    if (type === 'profits') {
      const selected = Array.isArray(payload.itemNames) ? payload.itemNames.map((v) => stringValue(v, 'Item name', 300)) : [];
      const result = Repository.getProfitItemReport(db, fromDate, toDate, selected);
      return {
        ...base,
        filterSummary: `الأصناف المختارة: ${result.selected.join('، ')}`,
        selected: result.selected,
        totals: { amount: milli(result.totals.amount_milli), quantity: micros(result.totals.quantity_micros), operationCount: result.totals.operation_count },
        byItem: result.byItem.map((row) => ({ name: row.name, amount: milli(row.amount_milli), quantity: micros(row.quantity_micros), operationCount: row.operation_count })),
        byDay: result.byDay.map((row) => ({ date: row.date, amount: milli(row.amount_milli), quantity: micros(row.quantity_micros), operationCount: row.operation_count })),
        rows: result.rows.map((row) => ({ date: row.tx_date, itemName: row.item_name, quantity: micros(row.quantity_micros), amount: milli(row.amount_milli), notes: row.notes || '', transactionId: row.transaction_id, lineId: row.line_id })),
      };
    }
    if (type === 'expenses') {
      const selected = Array.isArray(payload.categoryIds) ? payload.categoryIds.map((v) => stringValue(v, 'Category ID', 160)) : [];
      if (payload.allCategories === false && selected.length === 0) throw new Error('Select at least one expense category or enable all categories.');
      const result = Repository.getExpenseCategoryReport(db, fromDate, toDate, selected);
      const categoryOptions = Repository.listReportOptions(db).categories;
      const categoryNames = payload.allCategories === false
        ? categoryOptions.filter((entry) => selected.includes(entry.value)).map((entry) => entry.name)
        : ['جميع الفئات'];
      return {
        ...base, filterSummary: `الفئات: ${categoryNames.join('، ') || 'فئات محددة'}`, selected: result.selected,
        totals: { amount: milli(result.totals.amount_milli), operationCount: result.totals.operation_count },
        byCategory: result.byCategory.map((row) => ({ id: row.id, name: row.name, amount: milli(row.amount_milli), operationCount: row.operation_count })),
        rows: result.rows.map((row) => ({ date: row.tx_date, category: row.category_name_snapshot, amount: milli(row.amount_milli), description: row.description || '', notes: row.notes || '', id: row.id })),
      };
    }
    const selected = Array.isArray(payload.workerIds) ? payload.workerIds.map((v) => stringValue(v, 'Worker ID', 160)) : [];
    if (payload.allWorkers === false && selected.length === 0) throw new Error('Select at least one worker or enable all workers.');
    const result = Repository.getWorkerWithdrawalReport(db, fromDate, toDate, selected);
    const workerOptions = Repository.listReportOptions(db).workers;
    const workerNames = payload.allWorkers === false
      ? workerOptions.filter((entry) => selected.includes(entry.value)).map((entry) => entry.name)
      : ['جميع العمال'];
    return {
      ...base, filterSummary: `العمال: ${workerNames.join('، ') || 'عمال محددون'}`, selected: result.selected,
      totals: { amount: milli(result.totals.amount_milli), operationCount: result.totals.operation_count },
      byWorker: result.byWorker.map((row) => ({ id: row.id, name: row.name, amount: milli(row.amount_milli), operationCount: row.operation_count })),
      rows: result.rows.map((row) => ({ date: row.tx_date, worker: row.worker_name_snapshot, amount: milli(row.amount_milli), notes: row.notes || '', id: row.id })),
    };
  }

  registerIpcHandler('mowx:get-custom-report-data', (payload) => prepareReportData(payload));
  registerIpcHandler('mowx:export-custom-report-pdf', async (payload) => {
    const report = prepareReportData(payload);
    const fromStamp = report.fromDate;
    const toStamp = report.toDate;
    const suffix = fromStamp === toStamp ? fromStamp : `${fromStamp}_${toStamp}`;
    const filename = `MowxBack_${report.title.replace(/\s+/g, '_')}_${suffix}.pdf`;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'حفظ تقرير MowxBack بصيغة PDF',
      defaultPath: filename,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const pdf = await renderReportPdf(report);
    await fs.writeFile(result.filePath, pdf);
    Repository.recordSystemEvent(db, 'report_export', {
      reportType: report.type, title: report.title, fromDate: report.fromDate,
      toDate: report.toDate, fileName: path.basename(result.filePath), bytes: pdf.length,
    });
    return { canceled: false, path: result.filePath, bytes: pdf.length };
  });
  registerIpcHandler('mowx:get-audit-log', (payload) => {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const limit = source.limit === undefined ? 100 : source.limit;
    const offset = source.offset === undefined ? 0 : source.offset;
    if (!Number.isInteger(limit) || !Number.isInteger(offset)) throw new TypeError('Audit log paging values must be integers.');
    const search = source.search === undefined ? '' : stringValue(source.search, 'Audit log search', 200);
    return Repository.listAuditLogPage(db, { limit, offset, search });
  });

  registerIpcHandler('mowx:record-application-error', (payload) => {
    requiredObject(payload, 'Application error');
    const screen = stringValue(payload.screen || 'غير معروف', 'Error screen', 80);
    const message = stringValue(payload.message || 'خطأ غير محدد', 'Error message', 1500);
    const stack = payload.stack === undefined ? '' : stringValue(payload.stack, 'Error stack', 8000);
    const source = payload.source === undefined ? 'renderer' : stringValue(payload.source, 'Error source', 40);
    return Repository.recordSystemEvent(db, 'application_error', { screen, message, stack, source });
  });

  registerIpcHandler('mowx:search-name-suggestions', (payload) => {
    requiredObject(payload, 'Name search');
    return Repository.searchNameSuggestions(db, stringValue(payload.query, 'Search query', 200), 8);
  });

  registerIpcHandler('mowx:create-profit-movement', (payload) => {
    requiredObject(payload, 'Profit movement');
    if (!Array.isArray(payload.lines) || payload.lines.length < 1 || payload.lines.length > 500) {
      throw new TypeError('A profit movement must contain between 1 and 500 lines.');
    }
    const lines = payload.lines.map((line) => {
      requiredObject(line, 'Profit line');
      return {
        id: line.id ? stringValue(line.id, 'Line ID', 160) : undefined,
        name: stringValue(line.name, 'Item name', 300),
        quantityMicros: quantityMicros(line.qty),
        amountMilli: amountMilli(line.amount),
        notes: stringValue(line.note || '', 'Line notes', 4000),
      };
    });
    return Repository.createProfitMovement(db, {
      id: payload.id ? stringValue(payload.id, 'Movement ID', 160) : undefined,
      date: stringValue(payload.date, 'Movement date', 10),
      lines,
    });
  });
  registerIpcHandler('mowx:update-profit-line', (payload) => {
    requiredObject(payload, 'Profit line update');
    requiredObject(payload.patch, 'Profit line patch');
    const patch = {};
    if (payload.patch.name !== undefined) patch.name = stringValue(payload.patch.name, 'Item name', 300);
    if (payload.patch.qty !== undefined) patch.quantityMicros = quantityMicros(payload.patch.qty);
    if (payload.patch.amount !== undefined) patch.amountMilli = amountMilli(payload.patch.amount);
    if (payload.patch.note !== undefined) patch.notes = stringValue(payload.patch.note, 'Line notes', 4000);
    return Repository.updateProfitLine(db, stringValue(payload.transactionId, 'Movement ID', 160),
      stringValue(payload.lineId, 'Line ID', 160), patch);
  });
  registerIpcHandler('mowx:delete-profit-line', (payload) => {
    requiredObject(payload, 'Profit line deletion');
    return Repository.deleteProfitLine(db, stringValue(payload.transactionId, 'Movement ID', 160),
      stringValue(payload.lineId, 'Line ID', 160));
  });
  registerIpcHandler('mowx:update-profit-date', (payload) => {
    requiredObject(payload, 'Profit date update');
    return Repository.updateProfitMovementDate(db, stringValue(payload.id, 'Movement ID', 160),
      stringValue(payload.date, 'Movement date', 10));
  });
  registerIpcHandler('mowx:delete-profit-movement', (payload) => {
    requiredObject(payload, 'Profit movement deletion');
    return Repository.softDeleteProfitMovement(db, stringValue(payload.id, 'Movement ID', 160));
  });

  registerIpcHandler('mowx:create-expense', (payload) => {
    requiredObject(payload, 'Expense');
    return Repository.createExpense(db, {
      id: payload.id ? stringValue(payload.id, 'Expense ID', 160) : undefined,
      date: stringValue(payload.date, 'Expense date', 10),
      categoryId: stringValue(payload.refId, 'Expense category ID', 160),
      amountMilli: amountMilli(payload.amount),
      description: stringValue(payload.desc || '', 'Expense description', 1000),
      notes: stringValue(payload.note || '', 'Expense notes', 4000),
    });
  });
  registerIpcHandler('mowx:update-expense', (payload) => {
    requiredObject(payload, 'Expense update');
    const source = requiredObject(payload.patch || {}, 'Expense patch');
    const patch = {};
    if (source.date !== undefined) patch.date = stringValue(source.date, 'Expense date', 10);
    if (source.refId !== undefined) patch.categoryId = stringValue(source.refId, 'Expense category ID', 160);
    if (source.amount !== undefined) patch.amountMilli = amountMilli(source.amount);
    if (source.desc !== undefined) patch.description = stringValue(source.desc, 'Expense description', 1000);
    if (source.note !== undefined) patch.notes = stringValue(source.note, 'Expense notes', 4000);
    return Repository.updateExpense(db, stringValue(payload.id, 'Expense ID', 160), patch);
  });
  registerIpcHandler('mowx:delete-expense', (payload) => {
    requiredObject(payload, 'Expense deletion');
    return Repository.softDeleteExpense(db, stringValue(payload.id, 'Expense ID', 160));
  });

  registerIpcHandler('mowx:create-withdrawal', (payload) => {
    requiredObject(payload, 'Withdrawal');
    return Repository.createWithdrawal(db, {
      id: payload.id ? stringValue(payload.id, 'Withdrawal ID', 160) : undefined,
      date: stringValue(payload.date, 'Withdrawal date', 10),
      workerId: stringValue(payload.refId, 'Worker ID', 160),
      amountMilli: amountMilli(payload.amount),
      notes: stringValue(payload.note || '', 'Withdrawal notes', 4000),
    });
  });
  registerIpcHandler('mowx:update-withdrawal', (payload) => {
    requiredObject(payload, 'Withdrawal update');
    const source = requiredObject(payload.patch || {}, 'Withdrawal patch');
    const patch = {};
    if (source.date !== undefined) patch.date = stringValue(source.date, 'Withdrawal date', 10);
    if (source.refId !== undefined) patch.workerId = stringValue(source.refId, 'Worker ID', 160);
    if (source.amount !== undefined) patch.amountMilli = amountMilli(source.amount);
    if (source.note !== undefined) patch.notes = stringValue(source.note, 'Withdrawal notes', 4000);
    return Repository.updateWithdrawal(db, stringValue(payload.id, 'Withdrawal ID', 160), patch);
  });
  registerIpcHandler('mowx:delete-withdrawal', (payload) => {
    requiredObject(payload, 'Withdrawal deletion');
    return Repository.softDeleteWithdrawal(db, stringValue(payload.id, 'Withdrawal ID', 160));
  });

  registerIpcHandler('mowx:save-catalog-entry', (payload) => {
    requiredObject(payload, 'Catalog entry');
    const kind = CATALOG_KIND[payload.kind];
    if (!kind) throw new TypeError('Unknown catalog section.');
    return Repository.saveCatalogEntry(db, kind, {
      id: payload.id ? stringValue(payload.id, 'Catalog ID', 160) : undefined,
      name: stringValue(payload.name, 'Catalog name', 300),
    });
  });
  registerIpcHandler('mowx:set-catalog-active', (payload) => {
    requiredObject(payload, 'Catalog state');
    const kind = CATALOG_KIND[payload.kind];
    if (!kind) throw new TypeError('Unknown catalog section.');
    return Repository.setCatalogActive(db, kind, stringValue(payload.id, 'Catalog ID', 160), payload.active);
  });
  registerIpcHandler('mowx:set-currency', (payload) => {
    requiredObject(payload, 'Currency settings');
    const code = stringValue(payload.code, 'Currency code', 12);
    const allowed = ['SAR', 'JOD', 'AED', 'KWD', 'USD', 'EGP', 'custom'];
    if (!allowed.includes(code)) throw new TypeError('Unsupported currency code.');
    const labels = { SAR: '\u20C1', JOD: 'د.أ', AED: 'د.إ', KWD: 'د.ك', USD: '$', EGP: 'ج.م' };
    const label = code === 'custom' ? stringValue(payload.label, 'Currency label', 12).trim() : labels[code];
    if (!label) throw new TypeError('Currency label is required.');
    const places = Money.decimalPlacesForCurrency(code, 2);
    const saved = Repository.setCurrencySettings(db, { code, label, decimalPlaces: places });
    return { currencyCode: saved.currencyCode, currency: saved.currencyLabel, currencyDecimalPlaces: saved.currencyDecimalPlaces };
  });

  registerIpcHandler('mowx:export-legacy-json', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'تصدير نسخة JSON متوافقة مع MowxBack',
      defaultPath: `mowxback-json-${stamp}.json`,
      filters: [{ name: 'MowxBack JSON backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, JSON.stringify(legacyExportPayload(), null, 2), 'utf8');
    return { canceled: false, path: result.filePath };
  });
  registerIpcHandler('mowx:database-status', () => ({
    databasePath: dbPath,
    backupDirectory: runtimeConfig.backupDirectory,
    version: db.pragma('user_version', { simple: true }),
    integrity: integrityReport(db),
    journalMode: db.pragma('journal_mode', { simple: true }),
  }));

  registerIpcHandler('mowx:integrity-check', () => integrityReport(db));

  registerIpcHandler('mowx:choose-database-folder', async () => {
    const selectedRoot = await chooseDirectory('اختر المجلد الجديد لقاعدة بيانات MowxBack');
    if (!selectedRoot) return { canceled: true };
    const result = await moveDatabase({
      currentDb: db,
      currentPath: dbPath,
      newRootFolder: selectedRoot,
      persistConfig: (patch) => saveRuntimeConfig(patch),
    });
    db = result.db;
    dbPath = result.path;
    return { canceled: false, databasePath: dbPath, unchanged: Boolean(result.unchanged) };
  });

  registerIpcHandler('mowx:choose-backup-folder', async () => {
    const selected = await chooseDirectory('اختر مجلد النسخ الاحتياطي');
    if (!selected) return { canceled: true };
    await fs.mkdir(selected, { recursive: true });
    await saveRuntimeConfig({ backupDirectory: selected });
    return { canceled: false, backupDirectory: selected };
  });

  registerIpcHandler('mowx:clear-backup-folder', async () => {
    await saveRuntimeConfig({ backupDirectory: null });
    return { cleared: true };
  });

  registerIpcHandler('mowx:create-database-backup', async () => {
    if (!runtimeConfig.backupDirectory) throw new Error('لم يتم تحديد مجلد النسخ الاحتياطي بعد.');
    await fs.mkdir(runtimeConfig.backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(runtimeConfig.backupDirectory, `mowxback-backup-${stamp}.db`);
    return createDatabaseBackup(db, target);
  });

  registerIpcHandler('mowx:save-database-backup-as', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'حفظ نسخة قاعدة بيانات MowxBack',
      defaultPath: `mowxback-backup-${stamp}.db`,
      filters: [{ name: 'SQLite backup', extensions: ['db'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { canceled: false, ...await createDatabaseBackup(db, result.filePath) };
  });

  registerIpcHandler('mowx:restore-database-backup', async () => {
    const backupFile = await chooseBackupFile();
    if (!backupFile) return { canceled: true };
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'تأكيد استعادة النسخة الاحتياطية',
      message: 'سيتم استبدال قاعدة البيانات الحالية بمحتويات النسخة المختارة.',
      detail: 'سيُحتفظ بنسخة أمان من القاعدة الحالية قبل الاستعادة، ولن يتم اعتماد النسخة قبل فحص سلامتها.',
      buttons: ['استعادة النسخة', 'إلغاء'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) return { canceled: true };
    try {
      const result = await restoreDatabase({
        currentDb: db,
        activePath: dbPath,
        backupPath: backupFile,
        reopen: (file) => openDatabase(file, { create: false }),
      });
      db = result.db;
      return { canceled: false, safetyPath: result.safetyPath };
    } catch (error) {
      if (error.rollbackDatabase) db = error.rollbackDatabase;
      throw error;
    }
  });

  registerIpcHandler('mowx:import-legacy-json', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'استيراد نسخة JSON من MowxBack',
      properties: ['openFile'],
      filters: [{ name: 'MowxBack JSON backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const file = result.filePaths[0];
    const raw = await fs.readFile(file, 'utf8');
    const summary = importLegacyBackup(db, raw, path.basename(file));
    return { canceled: false, ...summary };
  });
}

function recordMainProcessError(source, reason) {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  const details = {
    screen: 'العملية الرئيسية', message: String(error.message || error).slice(0, 1500),
    stack: String(error.stack || '').slice(0, 8000), source,
  };
  try {
    if (db) Repository.recordSystemEvent(db, 'application_error', details);
  } catch (logError) {
    console.error('تعذر حفظ سجل خطأ العملية الرئيسية:', logError);
  }
  console.error(`[MowxBack ${source}]`, error);
}

process.on('unhandledRejection', (reason) => recordMainProcessError('main-unhandled-rejection', reason));
process.once('uncaughtException', (error) => {
  recordMainProcessError('main-uncaught-exception', error);
  try { dialog.showErrorBox('توقف غير متوقع في MowxBack', String(error?.message || error)); } catch (_) { /* app may not be ready */ }
  app.quit();
});

app.whenReady().then(async () => {
  try {
    const ready = await ensureDatabase();
    if (!ready) {
      app.quit();
      return;
    }
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'تعذر تشغيل MowxBack',
      message: 'لم يتمكن البرنامج من فتح قاعدة البيانات بأمان.',
      detail: error.message,
      buttons: ['إغلاق'],
    });
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (db && db.open) {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    try { db.close(); } catch (_) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isQuitting) app.quit();
});
