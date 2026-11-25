'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DiagnosticLogger, sanitize } = require('../../electron/diagnostic-logger');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mowx-diagnostics-'));
  try {
    const logDir = path.join(root, 'Logs');
    const logger = new DiagnosticLogger({ directory: logDir, retentionDays: 14 });
    await logger.init();
    await logger.log('test-operation', { screen: 'reports', password: 'do-not-store', count: 3 });
    await logger.flush();
    const status = await logger.status();
    assert.equal(status.enabled, true);
    assert.equal(status.fileCount, 1);
    assert.ok(status.lastEntryAt);
    const output = await logger.exportText();
    const text = output.toString('utf8');
    assert.match(text, /test-operation/);
    assert.match(text, /\[redacted\]/);
    assert.doesNotMatch(text, /do-not-store/);
    const updated = await logger.setRetentionDays(30);
    assert.equal(updated.retentionDays, 30);
    await assert.rejects(() => logger.setRetentionDays(2), /7, 14, 30, or 60/);
    assert.deepEqual(sanitize({ apiKey: 'secret', nested: { value: 'ok' } }), { apiKey: '[redacted]', nested: { value: 'ok' } });
    console.log('Diagnostic logger: append, export, status, retention, and sensitive-key redaction passed.');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
