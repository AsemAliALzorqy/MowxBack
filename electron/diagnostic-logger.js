'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const LOG_FILE = /^MowxBack-\d{4}-\d{2}-\d{2}\.log$/;
const ALLOWED_RETENTION_DAYS = new Set([7, 14, 30, 60]);
const SENSITIVE_KEY = /(password|passwd|token|secret|api.?key|cookie|authorization|credential|private.?key)/i;

function localDateStamp(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function sanitize(value, depth = 0) {
  if (depth > 4) return '[depth-limited]';
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value === 'string' ? value.slice(0, 2000) : value;
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 200);
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 40)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(child, depth + 1);
  }
  return result;
}

class DiagnosticLogger {
  constructor({ directory, retentionDays = 14, clock = () => new Date() } = {}) {
    if (!directory) throw new TypeError('A diagnostic log directory is required.');
    this.directory = path.resolve(directory);
    this.configPath = path.join(path.dirname(this.directory), 'mowxback-diagnostics.json');
    this.retentionDays = ALLOWED_RETENTION_DAYS.has(retentionDays) ? retentionDays : 14;
    this.clock = clock;
    this.queue = Promise.resolve();
    this.lastEntryAt = null;
    this.lastError = null;
    this.initialized = false;
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const config = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
      if (ALLOWED_RETENTION_DAYS.has(Number(config.retentionDays))) this.retentionDays = Number(config.retentionDays);
    } catch (error) {
      if (error.code !== 'ENOENT') this.lastError = error.message;
    }
    this.initialized = true;
    await this.prune();
    await this.log('diagnostics-initialized', { retentionDays: this.retentionDays });
    return this;
  }

  log(event, details = {}, level = 'info') {
    const timestamp = this.clock().toISOString();
    const entry = JSON.stringify({ timestamp, level, event: String(event || 'unknown').slice(0, 100), details: sanitize(details) }) + '\n';
    this.queue = this.queue.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.appendFile(path.join(this.directory, `MowxBack-${localDateStamp(this.clock())}.log`), entry, { encoding: 'utf8', flag: 'a' });
      this.lastEntryAt = timestamp;
      this.lastError = null;
    }).catch((error) => {
      this.lastError = error.message;
      console.error('[MowxBack diagnostics]', error);
    });
    return this.queue;
  }

  async flush() { await this.queue; }

  async prune() {
    await fs.mkdir(this.directory, { recursive: true });
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const cutoff = this.clock().getTime() - this.retentionDays * 86400000;
    await Promise.all(entries.filter((entry) => entry.isFile() && LOG_FILE.test(entry.name)).map(async (entry) => {
      const fullPath = path.join(this.directory, entry.name);
      const match = /MowxBack-(\d{4}-\d{2}-\d{2})\.log/.exec(entry.name);
      const age = match ? new Date(`${match[1]}T23:59:59.999`).getTime() : (await fs.stat(fullPath)).mtimeMs;
      if (Number.isFinite(age) && age < cutoff) await fs.unlink(fullPath);
    }));
  }

  async status() {
    await this.flush();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && LOG_FILE.test(entry.name));
    let lastEntryAt = this.lastEntryAt;
    if (files.length) {
      const stats = await Promise.all(files.map((entry) => fs.stat(path.join(this.directory, entry.name))));
      const newest = Math.max(...stats.map((stat) => stat.mtimeMs));
      if (!lastEntryAt || newest > new Date(lastEntryAt).getTime()) lastEntryAt = new Date(newest).toISOString();
    }
    return {
      enabled: true, directory: this.directory, fileCount: files.length,
      lastEntryAt, retentionDays: this.retentionDays, lastError: this.lastError,
    };
  }

  async setRetentionDays(days) {
    const value = Number(days);
    if (!ALLOWED_RETENTION_DAYS.has(value)) throw new RangeError('Retention period must be 7, 14, 30, or 60 days.');
    this.retentionDays = value;
    await fs.writeFile(this.configPath, JSON.stringify({ retentionDays: value }, null, 2), 'utf8');
    await this.prune();
    await this.log('diagnostics-retention-updated', { retentionDays: value });
    return this.status();
  }

  async exportText() {
    await this.flush();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && LOG_FILE.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    const chunks = [];
    for (const file of files) {
      chunks.push(`===== ${file.name} =====\n`, await fs.readFile(path.join(this.directory, file.name), 'utf8'), '\n');
    }
    return Buffer.from(chunks.join(''), 'utf8');
  }
}

module.exports = { DiagnosticLogger, localDateStamp, sanitize, LOG_FILE };
