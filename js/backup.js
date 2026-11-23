'use strict';

// Database backup and migration UI actions are thin wrappers over named IPC.
const Backup = Object.freeze({
  status: () => window.mowx.getDatabaseStatus(),
  chooseDatabaseFolder: () => window.mowx.chooseDatabaseFolder(),
  chooseFolder: () => window.mowx.chooseBackupFolder(),
  clearFolder: () => window.mowx.clearBackupFolder(),
  create: () => window.mowx.createDatabaseBackup(),
  saveAs: () => window.mowx.saveDatabaseBackupAs(),
  restore: () => window.mowx.restoreDatabaseBackup(),
  importJson: () => window.mowx.importLegacyJson(),
  exportJson: () => window.mowx.exportLegacyJson(),
  integrity: () => window.mowx.runIntegrityCheck(),
});
