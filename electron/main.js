'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  safeStorage,
  clipboard,
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
const { DiagnosticLogger } = require('./diagnostic-logger');
const { TelegramBotService, buildWithdrawalMessage, escapeHtml } = require('./telegram-service');
const { toSvgDataUrl } = require('./qr-code');

let mainWindow = null;
let db = null;
let dbPath = null;
let runtimeConfig = null;
let isQuitting = false;
let diagnostics = null;
let shutdownFlushRequested = false;
let telegramService = null;
let telegramStartupError = '';
let telegramQueueProcessing = false;
let telegramQueueIdle = Promise.resolve();
let resolveTelegramQueueIdle = null;
let telegramRuntimeTransition = Promise.resolve();

function logDiagnostic(event, details = {}, level = 'info') {
  if (!diagnostics) return Promise.resolve();
  return diagnostics.log(event, details, level);
}

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
      footerTemplate: `<div style="width:100%;font-family:Arial,sans-serif;font-size:8px;color:#64748b;padding:0 12mm;display:flex;justify-content:space-between;direction:ltr;"><span>MowxBack</span><span style="direction:ltr;unicode-bidi:isolate"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
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
      telegramUpdateOffset: Number.isSafeInteger(parsed.telegramUpdateOffset) ? parsed.telegramUpdateOffset : 0,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { databasePath: null, backupDirectory: null, telegramUpdateOffset: 0 };
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

function telegramTokenPath() {
  return path.join(app.getPath('userData'), 'telegram-bot-token.enc');
}

function encryptTelegramSecret(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('التخزين الآمن غير متاح على هذا الجهاز؛ لم يتم حفظ رمز Telegram.');
  }
  return safeStorage.encryptString(token).toString('base64');
}

async function readTelegramToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('التخزين الآمن غير متاح لفك تشفير رمز Telegram.');
    const encoded = await fs.readFile(telegramTokenPath(), 'utf8');
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeTelegramToken(token) {
  const encrypted = encryptTelegramSecret(token);
  const target = telegramTokenPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, encrypted, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
}

async function deleteTelegramToken() {
  try { await fs.unlink(telegramTokenPath()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function processTelegramOutbox(service) {
  if (telegramQueueProcessing || !service || !service.running || !db) return;
  const settings = Repository.getAppSettings(db);
  if (settings.telegramEnabled !== true) return;
  telegramQueueProcessing = true;
  telegramQueueIdle = new Promise((resolve) => { resolveTelegramQueueIdle = resolve; });
  try {
    const pending = Repository.listPendingTelegramNotifications(db, new Date().toISOString(), 10);
    for (const notification of pending) {
      if (!service.running) break;
      if (!Repository.markTelegramNotificationSending(db, notification.id)) continue;
      try {
        const sent = await service.sendMessage(notification.chatId, buildWithdrawalMessage(notification.payload));
        Repository.markTelegramNotificationSent(db, notification.id, sent.message_id);
        void logDiagnostic('telegram-notification-sent', { notificationId: notification.id, withdrawalId: notification.withdrawalId });
      } catch (error) {
        const attempt = notification.attempts + 1;
        const ambiguousDelivery = error.deliveryAmbiguous === true || (!error.telegramCode && error.deliveryAmbiguous !== false);
        const delay = error.retryAfter ? Number(error.retryAfter) * 1000 : Math.min(60000 * (2 ** Math.max(0, attempt - 1)), 6 * 60 * 60 * 1000);
        const reason = ambiguousDelivery
          ? 'تعذر تأكيد نتيجة الإرسال بسبب انقطاع الاتصال. تحقق من محادثة العامل قبل إعادة المحاولة لتجنب تكرار الرسالة.'
          : String(error.message || error).slice(0, 450);
        Repository.markTelegramNotificationRetry(db, notification.id, reason, new Date(Date.now() + delay).toISOString(), ambiguousDelivery ? 1 : 7);
        void logDiagnostic('telegram-notification-failed', { notificationId: notification.id, withdrawalId: notification.withdrawalId, attempt, ambiguousDelivery, message: reason.slice(0, 250) }, 'warning');
      }
    }
  } finally {
    telegramQueueProcessing = false;
    const resolve = resolveTelegramQueueIdle;
    resolveTelegramQueueIdle = null;
    if (resolve) resolve();
  }
}

async function handleTelegramMessage(service, message) {
  if (!message?.chat || message.chat.type !== 'private') return;
  const text = String(message.text || '').trim();
  const match = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{1,64}))?/.exec(text);
  if (!match || !match[1]) {
    await service.sendMessage(message.chat.id,
      'أهلاً بك في إشعارات MowxBack. للحصول على الإشعارات، اطلب رابط ربط خاصاً من مسؤول النظام وافتحه ثم اضغط Start.');
    return;
  }
  const tokenHash = crypto.createHash('sha256').update(match[1]).digest('hex');
  let linked;
  try {
    linked = Repository.completeTelegramLink(db, {
      tokenHash,
      chatId: String(message.chat.id),
      username: message.from?.username || '',
      firstName: message.from?.first_name || '',
      lastName: message.from?.last_name || '',
    });
  } catch (error) {
    await service.sendMessage(message.chat.id,
      `تعذر ربط الحساب. ${escapeHtml(error.message || 'رابط الربط غير صالح.')}\n\nاطلب رابطاً جديداً من مسؤول النظام.`);
    void logDiagnostic('telegram-link-rejected', { reason: String(error.message || error).slice(0, 220) }, 'warning');
    return;
  }

  notifyTelegramWorkersChanged();
  void logDiagnostic('telegram-worker-linked', { workerId: linked.workerId });
  try {
    await service.sendMessage(message.chat.id,
      `أهلاً بك، <b>${escapeHtml(linked.workerName)}</b>.\n\nتم ربط حساب Telegram الخاص بك بنظام إشعارات MowxBack بنجاح.\n\nستصلك هنا إشعارات فورية عند تسجيل أي سحب مالي جديد باسمك، تتضمن المبلغ والتاريخ وبيان السحب، والملاحظة إذا كانت موجودة.\n\nهذه المحادثة مخصصة لاستقبال إشعارات السحبيات من جهة العمل المرتبطة بالنظام.`);
  } catch (error) {
    void logDiagnostic('telegram-welcome-delivery-failed', { workerId: linked.workerId, message: String(error.message || error).slice(0, 220) }, 'warning');
  }
}

function createTelegramService(token) {
  const service = new TelegramBotService({
    token,
    onMessage: (message) => handleTelegramMessage(service, message),
    onLog: (event, details, level) => { void logDiagnostic(event, details, level || 'info'); },
    getOffset: () => Number(runtimeConfig?.telegramUpdateOffset) || 0,
    saveOffset: (offset) => saveRuntimeConfig({ telegramUpdateOffset: offset }),
  });
  service.setQueueProcessor(() => processTelegramOutbox(service));
  return service;
}

function serializeTelegramRuntime(task) {
  const operation = telegramRuntimeTransition.then(task, task);
  telegramRuntimeTransition = operation.catch(() => {});
  return operation;
}

async function startTelegramRuntime(token) {
  return serializeTelegramRuntime(async () => {
    if (telegramService) await telegramService.stop();
    telegramService = null;
    await telegramQueueIdle;
    const next = createTelegramService(token);
    const info = await next.start();
    telegramService = next;
    telegramStartupError = '';
    void logDiagnostic('telegram-polling-started', { botUsername: info.username || '' });
    return info;
  });
}

async function stopTelegramRuntime() {
  return serializeTelegramRuntime(async () => {
    if (telegramService) await telegramService.stop();
    telegramService = null;
    await telegramQueueIdle;
  });
}

function notifyTelegramWorkersChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mowx:telegram-link-changed');
}

function getTelegramStatus() {
  const settings = Repository.getAppSettings(db);
  return {
    enabled: settings.telegramEnabled === true,
    configured: Boolean(telegramService || settings.telegramBotUsername),
    active: Boolean(telegramService?.running),
    botUsername: settings.telegramBotUsername || telegramService?.status().botUsername || '',
    businessName: settings.telegramBusinessName || '',
    verifiedAt: settings.telegramVerifiedAt || null,
    error: telegramStartupError || telegramService?.status().error || '',
    linkedWorkers: Repository.listTelegramWorkerStates(db).filter((worker) => worker.telegram.status === 'linked').length,
    workers: Repository.listTelegramWorkerStates(db),
    notifications: Repository.listTelegramNotificationHistory(db, 40),
  };
}

function getTelegramLink(workerId) {
  const settings = Repository.getAppSettings(db);
  if (settings.telegramEnabled !== true || !telegramService?.running) {
    throw new Error('فعّل Telegram واتصل بالبوت أولاً من الإعدادات.');
  }
  const worker = Repository.listTelegramWorkerStates(db).find((entry) => entry.id === workerId);
  if (!worker) throw new Error('العامل غير موجود.');
  if (worker.telegram.status === 'linked') throw new Error('العامل مرتبط بالفعل بحساب Telegram.');
  let active = Repository.getActiveTelegramLinkToken(db, workerId);
  let token;
  if (active) {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('التخزين الآمن غير متاح لاسترجاع رابط الربط.');
      token = safeStorage.decryptString(Buffer.from(active.token_encrypted, 'base64'));
    } catch (error) {
      // A pending link may have been restored from another Windows profile.
      // Replace only this short-lived, unused token rather than blocking sharing.
      void logDiagnostic('telegram-link-token-replaced', { workerId, reason: 'pending-token-not-decryptable' }, 'warning');
      active = null;
    }
  }
  if (!active) {
    token = crypto.randomBytes(24).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    Repository.createTelegramLinkToken(db, {
      workerId, tokenHash, expiresAt,
      tokenEncrypted: encryptTelegramSecret(token),
    });
    notifyTelegramWorkersChanged();
  }
  const botUsername = settings.telegramBotUsername || telegramService.status().botUsername;
  if (!/^[A-Za-z0-9_]{5,32}$/.test(String(botUsername || ''))) throw new Error('تعذر تحديد اسم مستخدم البوت. أعد التحقق من إعدادات Telegram.');
  return { worker, url: `https://t.me/${botUsername}?start=${token}`, expiresAt: active?.expires_at || new Date(Date.now() + 10 * 60 * 1000).toISOString() };
}

async function verifyTelegramToken(token) {
  const activeToken = String(token || '').trim() || await readTelegramToken();
  if (!activeToken) throw new Error('أدخل Bot Token أولاً.');
  const checker = new TelegramBotService({ token: activeToken });
  const me = await checker.getMe();
  const webhook = await checker.getWebhookInfo();
  return { ok: true, botName: me.first_name || '', username: me.username || '', hasWebhook: Boolean(webhook.url) };
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
  mainWindow.once('ready-to-show', () => { mainWindow.show(); void logDiagnostic('main-window-shown'); });
  mainWindow.webContents.on('render-process-gone', (_event, details) => { void logDiagnostic('renderer-process-gone', details, 'error'); });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => { void logDiagnostic('renderer-load-failed', { errorCode, errorDescription }, 'error'); });
  mainWindow.on('close', () => { void logDiagnostic('main-window-close-requested'); });
  mainWindow.on('closed', () => { void logDiagnostic('main-window-closed'); mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

function registerIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('رفض طلب IPC من إطار غير موثوق.');
    }
    void logDiagnostic('ipc-start', { channel });
    try {
      const result = await handler(payload);
      void logDiagnostic('ipc-success', { channel });
      return result;
    } catch (error) {
      void logDiagnostic('ipc-failure', { channel, message: String(error?.message || error).slice(0, 1200) }, 'error');
      throw error;
    }
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
      .map((entry) => ({ id: entry.id, name: entry.name, phone: entry.phone || '', active: Boolean(entry.is_active) }));
    const telegramWorkers = new Map(Repository.listTelegramWorkerStates(db).map((worker) => [worker.id, worker.telegram]));
    const status = {
      databasePath: dbPath,
      backupDirectory: runtimeConfig.backupDirectory,
      appVersion: app.getVersion(),
      databaseVersion: db.pragma('user_version', { simple: true }),
      integrityOk: integrityReport(db).ok,
    };
    return {
      v: 3,
      demo: Boolean(allSettings.legacyDemoFlag),
      ...settings,
      items: mapCatalog('item'),
      workers: mapCatalog('worker').map((worker) => ({ ...worker, telegram: telegramWorkers.get(worker.id) || { status: 'unlinked' } })),
      cats: mapCatalog('expense_category'),
      telegram: {
        enabled: allSettings.telegramEnabled === true,
        active: Boolean(telegramService?.running),
        botUsername: allSettings.telegramBotUsername || '',
      },
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
        workers: state.workers.map(({ id, name, phone, active }) => ({ id, name, phone: phone || '', active })),
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
        movementCount: result.transactions.length,
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
      const selected = payload.allItems === true ? [] : (Array.isArray(payload.itemNames) ? payload.itemNames.map((v) => stringValue(v, 'Item name', 300)) : []);
      if (payload.allItems !== true && selected.length === 0) throw new Error('Select at least one item or enable all items.');
      const result = Repository.getProfitItemReport(db, fromDate, toDate, selected);
      return {
        ...base,
        filterSummary: payload.allItems === true ? 'جميع الأصناف' : `الأصناف المختارة: ${result.selected.join('، ')}`,
        scope: payload.allItems === true ? 'all' : 'selected',
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
    await logDiagnostic('pdf-generation-start', { reportType: report.type, fromDate: report.fromDate, toDate: report.toDate, records: report.type === 'general' ? report.movements.length : report.rows.length });
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
    await logDiagnostic('pdf-export-success', { reportType: report.type, fileName: path.basename(result.filePath), bytes: pdf.length });
    Repository.recordSystemEvent(db, 'report_export', {
      reportType: report.type, title: report.title, fromDate: report.fromDate,
      toDate: report.toDate, fileName: path.basename(result.filePath), bytes: pdf.length,
    });
    return { canceled: false, path: result.filePath, bytes: pdf.length };
  });
  registerIpcHandler('mowx:record-diagnostic-log', async (payload) => {
    requiredObject(payload, 'Diagnostic event');
    if (!diagnostics) return { recorded: false };
    const event = stringValue(payload.event, 'Diagnostic event name', 100);
    const source = payload.details && typeof payload.details === 'object' && !Array.isArray(payload.details) ? payload.details : {};
    const safeDetails = {
      screen: typeof source.screen === 'string' ? source.screen.slice(0, 80) : undefined,
      action: typeof source.action === 'string' ? source.action.slice(0, 100) : undefined,
      modal: typeof source.modal === 'string' ? source.modal.slice(0, 100) : undefined,
      reason: typeof source.reason === 'string' ? source.reason.slice(0, 100) : undefined,
      to: typeof source.to === 'string' ? source.to.slice(0, 80) : undefined,
      entityType: typeof source.entityType === 'string' ? source.entityType.slice(0, 50) : undefined,
    };
    await logDiagnostic(event, safeDetails);
    return { recorded: true };
  });
  registerIpcHandler('mowx:get-diagnostic-status', async () => diagnostics ? diagnostics.status() : ({
    enabled: false, fileCount: 0, retentionDays: 14, directory: '', lastEntryAt: null,
  }));
  registerIpcHandler('mowx:open-diagnostic-folder', async () => {
    if (!diagnostics) throw new Error('Diagnostic logging is unavailable.');
    const status = await diagnostics.status();
    const error = await shell.openPath(status.directory);
    return error ? { error } : { opened: true };
  });
  registerIpcHandler('mowx:export-diagnostic-logs', async () => {
    if (!diagnostics) throw new Error('Diagnostic logging is unavailable.');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'تصدير سجلات تشخيص MowxBack', defaultPath: `MowxBack-Logs-${new Date().toISOString().slice(0, 10)}.log`,
      filters: [{ name: 'Log files', extensions: ['log', 'txt'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const content = await diagnostics.exportText();
    await fs.writeFile(result.filePath, content);
    await logDiagnostic('diagnostic-export-success', { bytes: content.length, fileName: path.basename(result.filePath) });
    return { canceled: false, bytes: content.length };
  });
  registerIpcHandler('mowx:set-diagnostic-retention', async (payload) => {
    requiredObject(payload, 'Diagnostic retention');
    if (!diagnostics) throw new Error('Diagnostic logging is unavailable.');
    return diagnostics.setRetentionDays(payload.days);
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
    const result = Repository.createWithdrawal(db, {
      id: payload.id ? stringValue(payload.id, 'Withdrawal ID', 160) : undefined,
      date: stringValue(payload.date, 'Withdrawal date', 10),
      workerId: stringValue(payload.refId, 'Worker ID', 160),
      amountMilli: amountMilli(payload.amount),
      notes: stringValue(payload.note || '', 'Withdrawal notes', 4000),
    });
    if (telegramService?.running) void processTelegramOutbox(telegramService);
    return result;
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
      phone: kind === 'worker' ? stringValue(payload.phone || '', 'Worker phone', 40) : '',
    });
  });
  registerIpcHandler('mowx:set-catalog-active', (payload) => {
    requiredObject(payload, 'Catalog state');
    const kind = CATALOG_KIND[payload.kind];
    if (!kind) throw new TypeError('Unknown catalog section.');
    return Repository.setCatalogActive(db, kind, stringValue(payload.id, 'Catalog ID', 160), payload.active);
  });
  registerIpcHandler('mowx:telegram-status', () => getTelegramStatus());
  registerIpcHandler('mowx:telegram-verify-token', async (payload) => {
    const token = payload && payload.token !== undefined ? stringValue(payload.token, 'Telegram Bot Token', 256) : '';
    const result = await verifyTelegramToken(token);
    Repository.setAppSetting(db, 'telegramVerifiedAt', new Date().toISOString());
    return result;
  });
  registerIpcHandler('mowx:telegram-save-token', async (payload) => {
    requiredObject(payload, 'Telegram Bot Token');
    const token = stringValue(payload.token, 'Telegram Bot Token', 256).trim();
    if (!token) throw new Error('أدخل Bot Token أولاً.');
    const verified = await verifyTelegramToken(token);
    if (verified.hasWebhook) throw new Error('هذا البوت لديه Webhook مفعّل. أزل Webhook يدوياً قبل تفعيل Long Polling؛ لم يغيّر MowxBack إعداد Webhook.');
    const previousUsername = Repository.getAppSettings(db).telegramBotUsername || '';
    const sameBot = previousUsername && previousUsername.toLowerCase() === verified.username.toLowerCase();
    await stopTelegramRuntime();
    if (!sameBot) {
      Repository.clearTelegramLinks(db);
      await saveRuntimeConfig({ telegramUpdateOffset: 0 });
    }
    await writeTelegramToken(token);
    Repository.setAppSetting(db, 'telegramBotUsername', verified.username);
    Repository.setAppSetting(db, 'telegramVerifiedAt', new Date().toISOString());
    Repository.setAppSetting(db, 'telegramEnabled', true);
    try {
      await startTelegramRuntime(token);
    } catch (error) {
      telegramStartupError = String(error.message || error).slice(0, 300);
      Repository.setAppSetting(db, 'telegramEnabled', false);
      throw error;
    }
    void logDiagnostic('telegram-token-configured', { botUsername: verified.username });
    return getTelegramStatus();
  });
  registerIpcHandler('mowx:telegram-disconnect', async () => {
    Repository.setAppSetting(db, 'telegramEnabled', false);
    Repository.cancelPendingTelegramNotifications(db);
    await stopTelegramRuntime();
    Repository.clearTelegramLinks(db);
    await deleteTelegramToken();
    await saveRuntimeConfig({ telegramUpdateOffset: 0 });
    Repository.setAppSetting(db, 'telegramBotUsername', '');
    telegramStartupError = '';
    notifyTelegramWorkersChanged();
    void logDiagnostic('telegram-disconnected-and-credentials-removed');
    return getTelegramStatus();
  });
  registerIpcHandler('mowx:telegram-set-enabled', async (payload) => {
    requiredObject(payload, 'Telegram enabled state');
    if (typeof payload.enabled !== 'boolean') throw new TypeError('Telegram enabled state must be boolean.');
    if (!payload.enabled) {
      Repository.setAppSetting(db, 'telegramEnabled', false);
      Repository.cancelPendingTelegramNotifications(db);
      await stopTelegramRuntime();
      void logDiagnostic('telegram-disabled');
      return getTelegramStatus();
    }
    const token = await readTelegramToken();
    if (!token) throw new Error('أدخل Bot Token واحفظه قبل تفعيل Telegram.');
    const verified = await verifyTelegramToken(token);
    if (verified.hasWebhook) throw new Error('يوجد Webhook مفعّل لهذا البوت؛ لا يمكن تشغيل Long Polling حالياً.');
    await startTelegramRuntime(token);
    Repository.setAppSetting(db, 'telegramBotUsername', verified.username);
    Repository.setAppSetting(db, 'telegramVerifiedAt', new Date().toISOString());
    Repository.setAppSetting(db, 'telegramEnabled', true);
    if (telegramService?.running) void processTelegramOutbox(telegramService);
    void logDiagnostic('telegram-enabled', { botUsername: verified.username });
    return getTelegramStatus();
  });
  registerIpcHandler('mowx:telegram-save-business-name', (payload) => {
    requiredObject(payload, 'Telegram business name');
    const name = stringValue(payload.name || '', 'Business name', 120).trim();
    Repository.setAppSetting(db, 'telegramBusinessName', name);
    void logDiagnostic('telegram-business-name-updated', { hasBusinessName: Boolean(name) });
    return getTelegramStatus();
  });
  registerIpcHandler('mowx:telegram-create-link', (payload) => {
    requiredObject(payload, 'Telegram worker link');
    const workerId = stringValue(payload.workerId, 'Worker ID', 160);
    const link = getTelegramLink(workerId);
    return { workerName: link.worker.name, expiresAt: link.expiresAt };
  });
  registerIpcHandler('mowx:telegram-copy-link', (payload) => {
    requiredObject(payload, 'Telegram worker link');
    const link = getTelegramLink(stringValue(payload.workerId, 'Worker ID', 160));
    clipboard.writeText(link.url);
    void logDiagnostic('telegram-link-copied', { workerId: payload.workerId });
    return { copied: true, expiresAt: link.expiresAt };
  });
  registerIpcHandler('mowx:telegram-show-qr', (payload) => {
    requiredObject(payload, 'Telegram worker QR');
    const link = getTelegramLink(stringValue(payload.workerId, 'Worker ID', 160));
    return { dataUrl: toSvgDataUrl(link.url), expiresAt: link.expiresAt, workerName: link.worker.name };
  });
  registerIpcHandler('mowx:telegram-open-whatsapp', async (payload) => {
    requiredObject(payload, 'WhatsApp share');
    const workerId = stringValue(payload.workerId, 'Worker ID', 160);
    const link = getTelegramLink(workerId);
    let phone = String(link.worker.phone || '').trim();
    if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
    const digits = phone.replace(/\D/g, '');
    if (!phone.startsWith('+') || digits.length < 8 || digits.length > 15) {
      throw new Error('أدخل رقم الهاتف بصيغة دولية مع رمز الدولة، مثل +9627XXXXXXXX.');
    }
    const message = `مرحباً، هذا رابط ربط حسابك بنظام إشعارات السحبيات في MowxBack عبر Telegram. افتح الرابط واضغط Start لإتمام الربط:\n${link.url}`;
    await shell.openExternal(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`);
    void logDiagnostic('telegram-link-whatsapp-opened', { workerId });
    return { opened: true, expiresAt: link.expiresAt };
  });
  registerIpcHandler('mowx:telegram-unlink-worker', (payload) => {
    requiredObject(payload, 'Telegram unlink');
    const workerId = stringValue(payload.workerId, 'Worker ID', 160);
    const result = Repository.unlinkTelegramWorker(db, workerId);
    notifyTelegramWorkersChanged();
    void logDiagnostic('telegram-worker-unlinked', { workerId });
    return result;
  });
  registerIpcHandler('mowx:telegram-test-message', async (payload) => {
    requiredObject(payload, 'Telegram test message');
    if (!telegramService?.running) throw new Error('Telegram غير متصل حالياً.');
    const workerId = stringValue(payload.workerId, 'Worker ID', 160);
    const worker = Repository.listTelegramWorkerStates(db).find((item) => item.id === workerId);
    if (!worker || worker.telegram.status !== 'linked') throw new Error('اختر عاملاً مرتبطاً بحساب Telegram.');
    const link = db.prepare('SELECT chat_id FROM telegram_worker_links WHERE worker_id=?').get(workerId);
    await telegramService.sendMessage(link.chat_id, `هذه رسالة اختبار من <b>MowxBack</b>.\nإشعارات السحبيات مفعّلة للعامل: <b>${escapeHtml(worker.name)}</b>.`);
    void logDiagnostic('telegram-test-message-sent', { workerId });
    return { sent: true };
  });
  registerIpcHandler('mowx:telegram-retry-notification', (payload) => {
    requiredObject(payload, 'Telegram notification retry');
    const id = stringValue(payload.id, 'Notification ID', 160);
    const changed = Repository.retryTelegramNotification(db, id);
    if (changed && telegramService?.running) void processTelegramOutbox(telegramService);
    return { queued: changed };
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
  void logDiagnostic('main-process-error', details, 'error');
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
    diagnostics = new DiagnosticLogger({ directory: path.join(app.getPath('userData'), 'Logs'), retentionDays: 14 });
    await diagnostics.init();
    await logDiagnostic('application-start', { appVersion: app.getVersion(), electronVersion: process.versions.electron, nodeVersion: process.versions.node, platform: process.platform, architecture: process.arch });
    const ready = await ensureDatabase();
    await logDiagnostic('database-initialized', { databasePath: dbPath, databaseVersion: db?.pragma('user_version', { simple: true }) });
    if (!ready) {
      app.quit();
      return;
    }
    registerIpc();
    const telegramSettings = Repository.getAppSettings(db);
    if (telegramSettings.telegramEnabled === true) {
      try {
        const storedToken = await readTelegramToken();
        if (storedToken) {
          Repository.recoverTelegramSending(db);
          await startTelegramRuntime(storedToken);
        } else {
          telegramStartupError = 'رمز Telegram غير موجود في مخزن الأسرار؛ أعد إدخاله من الإعدادات.';
          Repository.setAppSetting(db, 'telegramEnabled', false);
        }
      } catch (telegramError) {
        telegramStartupError = String(telegramError.message || telegramError).slice(0, 300);
        void logDiagnostic('telegram-startup-failed', { message: telegramStartupError }, 'warning');
      }
    }
    createWindow();
    await logDiagnostic('application-ready', { appVersion: app.getVersion() });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (error) {
    await logDiagnostic('application-start-failed', { message: String(error?.message || error), stack: String(error?.stack || '').slice(0, 5000) }, 'error');
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

app.on('before-quit', (event) => {
  isQuitting = true;
  if (diagnostics && !shutdownFlushRequested) {
    shutdownFlushRequested = true;
    event.preventDefault();
    void logDiagnostic('application-shutdown-requested');
    void stopTelegramRuntime().finally(() => diagnostics.flush()).finally(() => {
      if (db && db.open) {
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
        try { db.close(); } catch (_) {}
      }
      app.quit();
    });
    return;
  }
  if (db && db.open) {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    try { db.close(); } catch (_) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isQuitting) app.quit();
});
