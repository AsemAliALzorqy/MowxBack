'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Every exposed method maps to one named IPC command. No generic invoke or
// ipcRenderer object is exposed to the renderer.
contextBridge.exposeInMainWorld('mowx', Object.freeze({
  getDatabaseStatus: () => ipcRenderer.invoke('mowx:database-status'),
  getSnapshot: () => ipcRenderer.invoke('mowx:get-snapshot'),
  getReport: (range) => ipcRenderer.invoke('mowx:get-report', range),
  getReportOptions: () => ipcRenderer.invoke('mowx:get-report-options'),
  getCustomReportData: (payload) => ipcRenderer.invoke('mowx:get-custom-report-data', payload),
  exportCustomReportPdf: (payload) => ipcRenderer.invoke('mowx:export-custom-report-pdf', payload),
  getAuditLog: (payload) => ipcRenderer.invoke('mowx:get-audit-log', payload),
  recordApplicationError: (payload) => ipcRenderer.invoke('mowx:record-application-error', payload),
  searchNameSuggestions: (query) => ipcRenderer.invoke('mowx:search-name-suggestions', { query }),

  createProfitMovement: (payload) => ipcRenderer.invoke('mowx:create-profit-movement', payload),
  updateProfitLine: (payload) => ipcRenderer.invoke('mowx:update-profit-line', payload),
  deleteProfitLine: (payload) => ipcRenderer.invoke('mowx:delete-profit-line', payload),
  updateProfitDate: (payload) => ipcRenderer.invoke('mowx:update-profit-date', payload),
  deleteProfitMovement: (payload) => ipcRenderer.invoke('mowx:delete-profit-movement', payload),

  createExpense: (payload) => ipcRenderer.invoke('mowx:create-expense', payload),
  updateExpense: (payload) => ipcRenderer.invoke('mowx:update-expense', payload),
  deleteExpense: (payload) => ipcRenderer.invoke('mowx:delete-expense', payload),
  createWithdrawal: (payload) => ipcRenderer.invoke('mowx:create-withdrawal', payload),
  updateWithdrawal: (payload) => ipcRenderer.invoke('mowx:update-withdrawal', payload),
  deleteWithdrawal: (payload) => ipcRenderer.invoke('mowx:delete-withdrawal', payload),

  saveCatalogEntry: (payload) => ipcRenderer.invoke('mowx:save-catalog-entry', payload),
  setCatalogActive: (payload) => ipcRenderer.invoke('mowx:set-catalog-active', payload),
  setCurrency: (payload) => ipcRenderer.invoke('mowx:set-currency', payload),

  chooseDatabaseFolder: () => ipcRenderer.invoke('mowx:choose-database-folder'),
  chooseBackupFolder: () => ipcRenderer.invoke('mowx:choose-backup-folder'),
  clearBackupFolder: () => ipcRenderer.invoke('mowx:clear-backup-folder'),
  createDatabaseBackup: () => ipcRenderer.invoke('mowx:create-database-backup'),
  saveDatabaseBackupAs: () => ipcRenderer.invoke('mowx:save-database-backup-as'),
  restoreDatabaseBackup: () => ipcRenderer.invoke('mowx:restore-database-backup'),
  importLegacyJson: () => ipcRenderer.invoke('mowx:import-legacy-json'),
  exportLegacyJson: () => ipcRenderer.invoke('mowx:export-legacy-json'),
  runIntegrityCheck: () => ipcRenderer.invoke('mowx:integrity-check'),
}));
