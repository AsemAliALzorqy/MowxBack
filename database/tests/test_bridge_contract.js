'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const preload = read('electron/preload.js');
const main = read('electron/main.js');
const app = read('js/app.js');
const storage = read('js/storage.js');
const backup = read('js/backup.js');
const schema = read('database/schema.sql');

const ipcCalls = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]);
assert.ok(ipcCalls.length >= 25, 'Preload should expose a narrow set of named API methods.');
for (const channel of ipcCalls) assert.ok(main.includes(`'${channel}'`), `Missing Main handler for ${channel}`);
assert.match(main, /contextIsolation:\s*true/);
assert.match(main, /nodeIntegration:\s*false/);
assert.match(main, /sandbox:\s*true/);
assert.doesNotMatch(preload, /exposeInMainWorld\([^,]+,\s*ipcRenderer/);
assert.doesNotMatch(preload, /invoke\([^,]+,\s*sql/i);
assert.doesNotMatch(app + storage, /localStorage|indexedDB|showDirectoryPicker|Store\.seed|Store\.migrate/);
assert.match(app, /Store\.customReport\(/, 'Report previews must be fetched from the custom SQLite report IPC.');
assert.match(app, /Store\.exportReportPdf\(/, 'PDF export must use the named Electron IPC bridge.');
assert.match(main, /Repository\.getCustomReportData|Repository\.getGeneralReport\(db/);
assert.match(main, /Repository\.recordSystemEvent\(db, 'report_export'/, 'PDF exports must be recorded in the audit log.');
assert.match(schema, /trg_audit_log_no_update/, 'Audit log must be protected against edits.');
assert.match(schema, /trg_audit_log_no_delete/, 'Audit log must be protected against deletion.');

const storeUsed = new Set([...app.matchAll(/\bStore\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
const storeDefined = new Set([...storage.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map((match) => match[1]));
for (const method of storeUsed) assert.ok(storeDefined.has(method), `Store adapter is missing ${method}`);

const backupUsed = new Set([...app.matchAll(/\bBackup\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
const backupDefined = new Set([...backup.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map((match) => match[1]));
for (const method of backupUsed) assert.ok(backupDefined.has(method), `Backup adapter is missing ${method}`);

const preloadMethods = new Set([...preload.matchAll(/^\s{2}([A-Za-z_$][\w$]*):\s*\(/gm)].map((match) => match[1]));
const bridgeMethodsUsed = new Set([...`${storage}\n${backup}`.matchAll(/window\.mowx\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
for (const method of bridgeMethodsUsed) assert.ok(preloadMethods.has(method), `Preload bridge is missing ${method}`);

console.log(`IPC bridge contract: ${ipcCalls.length} channels and ${bridgeMethodsUsed.size} adapter bridge methods verified; no renderer-side LocalStorage path.`);
