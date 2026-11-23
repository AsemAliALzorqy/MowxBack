'use strict';

// Renderer-side adapter only. All persistent reads/writes are explicit IPC
// calls to Electron Main; this file intentionally has no LocalStorage path.
const Store = Object.freeze({
  load: () => window.mowx.getSnapshot(),
  report: (fromDate, toDate) => window.mowx.getReport({ fromDate, toDate }),
  saveProfit: (payload) => window.mowx.createProfitMovement(payload),
  updateProfitLine: (payload) => window.mowx.updateProfitLine(payload),
  deleteProfitLine: (payload) => window.mowx.deleteProfitLine(payload),
  updateProfitDate: (payload) => window.mowx.updateProfitDate(payload),
  deleteProfit: (payload) => window.mowx.deleteProfitMovement(payload),
  createExpense: (payload) => window.mowx.createExpense(payload),
  updateExpense: (payload) => window.mowx.updateExpense(payload),
  deleteExpense: (payload) => window.mowx.deleteExpense(payload),
  createWithdrawal: (payload) => window.mowx.createWithdrawal(payload),
  updateWithdrawal: (payload) => window.mowx.updateWithdrawal(payload),
  deleteWithdrawal: (payload) => window.mowx.deleteWithdrawal(payload),
  saveCatalog: (payload) => window.mowx.saveCatalogEntry(payload),
  setCatalogActive: (payload) => window.mowx.setCatalogActive(payload),
  setCurrency: (payload) => window.mowx.setCurrency(payload),
  searchNames: (query) => window.mowx.searchNameSuggestions(query),
});
