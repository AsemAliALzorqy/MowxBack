'use strict';

const API_BASE = 'https://api.telegram.org/bot';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function formatMoney(amountMilli, decimalPlaces, currencyLabel) {
  const numeric = Number(amountMilli) / 1000;
  const safePlaces = Math.max(0, Math.min(3, Number(decimalPlaces) || 0));
  const amount = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: safePlaces,
    maximumFractionDigits: safePlaces,
  }).format(numeric);
  return `${amount}${currencyLabel ? ` ${escapeHtml(currencyLabel)}` : ''}`;
}

function buildWithdrawalMessage(payload) {
  const workerName = escapeHtml(payload.workerName || 'العامل');
  const businessName = String(payload.businessName || '').trim();
  const amount = formatMoney(payload.amountMilli, payload.decimalPlaces, payload.currencyLabel);
  const dateValue = String(payload.date || '');
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const date = escapeHtml(dateMatch ? `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}` : (dateValue || '—'));
  const time = payload.createdAt
    ? escapeHtml(new Date(payload.createdAt).toLocaleTimeString('ar-JO', { hour: '2-digit', minute: '2-digit' }))
    : '—';
  const rawNotes = String(payload.notes || '').trim();
  // Telegram sendMessage accepts up to 4096 characters; reserve room for the invoice fields.
  const noteChars = [...rawNotes];
  const notes = noteChars.length > 3400 ? `${noteChars.slice(0, 3400).join('')}…` : rawNotes;
  const withdrawalId = escapeHtml(`WD-${String(payload.withdrawalId || '').slice(-8).toUpperCase()}`);
  const lines = [
    '<b>MowxBack</b>',
    ...(businessName ? [escapeHtml(businessName)] : []),
    '<i>إشعار مالي</i>',
    '━━━━━━━━━━━━━━',
    '<b>تم تسجيل سحب جديد باسمك</b>',
    '',
    '<b>المبلغ المسحوب</b>',
    `<b>${amount}</b>`,
    '',
    '<b>تفاصيل العملية</b>',
    `اسم العامل: ${workerName}`,
    `التاريخ: ${date}`,
    `الوقت: ${time}`,
    `البيان: سحب نقدي`,
    `رقم العملية: <code>${withdrawalId}</code>`,
  ];
  if (notes) lines.push('', '<b>ملاحظة السحب</b>', escapeHtml(notes));
  lines.push('', '━━━━━━━━━━━━━━', '<i>تم إرسال هذا الإشعار تلقائياً بواسطة نظام MowxBack.</i>');
  return lines.join('\n');
}

class TelegramBotService {
  constructor({ token, onMessage, onLog, getOffset, saveOffset, fetchImpl = globalThis.fetch }) {
    if (typeof token !== 'string' || !token.trim()) throw new TypeError('Telegram Bot Token is required.');
    this.token = token.trim();
    if (typeof fetchImpl !== 'function') throw new TypeError('Fetch API is unavailable.');
    this.fetchImpl = fetchImpl;
    this.onMessage = onMessage || (async () => {});
    this.onLog = onLog || (() => {});
    this.getOffset = getOffset || (() => 0);
    this.saveOffset = saveOffset || (async () => {});
    this.running = false;
    this.pollController = null;
    this.pollPromise = null;
    this.queueTimer = null;
    this.retryWait = null;
    this.queueProcessor = null;
    this.info = null;
    this.error = null;
  }

  async call(method, payload = {}, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${API_BASE}${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal || AbortSignal.timeout(options.timeoutMs || 15000),
      });
    } catch (cause) {
      // Fetch errors may include request URL details on some runtimes. Never
      // propagate an exception that could reveal the Bot Token in diagnostics.
      const safeError = new Error(cause?.name === 'AbortError'
        ? 'Telegram request aborted.'
        : cause?.name === 'TimeoutError'
          ? 'Telegram request timed out.'
          : 'تعذر الاتصال بخدمة Telegram.');
      safeError.name = cause?.name === 'AbortError' || cause?.name === 'TimeoutError'
        ? cause.name : 'TelegramNetworkError';
      const networkCode = cause?.cause?.code || cause?.code || '';
      // DNS/refused/unreachable errors are definitive pre-delivery failures;
      // timeout/reset failures can be ambiguous after Telegram accepted a request.
      safeError.deliveryAmbiguous = !['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(networkCode);
      throw safeError;
    }
    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error(`Telegram returned HTTP ${response.status} without a valid JSON response.`); }
    if (!response.ok || !data.ok) {
      const description = String(data.description || `Telegram HTTP ${response.status}`).replaceAll(this.token, '[TOKEN REDACTED]');
      const error = new Error(description.slice(0, 500));
      error.telegramCode = data.error_code || response.status;
      error.retryAfter = data.parameters?.retry_after || null;
      throw error;
    }
    return data.result;
  }

  async getMe() { return this.call('getMe'); }
  async getWebhookInfo() { return this.call('getWebhookInfo'); }
  async sendMessage(chatId, text) {
    return this.call('sendMessage', {
      chat_id: String(chatId), text, parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  async start() {
    if (this.running) return this.info;
    let info = null;
    try {
      info = await this.getMe();
      const webhook = await this.getWebhookInfo();
      if (webhook.url) {
        throw new Error('هذا البوت لديه Webhook مفعّل. أزل إعداد Webhook من Telegram قبل استخدام وضع الاتصال المحلي Long Polling. لم يغيّر MowxBack إعداد Webhook.');
      }
      this.error = null;
    } catch (error) {
      // A network outage at application startup must not disable the service.
      // Keep Long Polling alive so it can reconnect when the network returns.
      if (error.telegramCode || /Webhook/i.test(String(error.message || ''))) throw error;
      this.error = String(error.message || 'تعذر الاتصال بخدمة Telegram.').slice(0, 300);
      this.onLog('telegram-start-deferred', { reason: this.error }, 'warning');
    }
    this.info = info;
    this.running = true;
    this.pollPromise = this.pollLoop();
    if (this.queueProcessor) {
      void this.queueProcessor();
      this.queueTimer = setInterval(() => { void this.queueProcessor(); }, 15000);
    }
    return info;
  }

  async pollLoop() {
    let offset = Number(await this.getOffset()) || 0;
    let delay = 1000;
    while (this.running) {
      const controller = new AbortController();
      this.pollController = controller;
      try {
        const updates = await this.call('getUpdates', {
          offset, timeout: 25, allowed_updates: ['message'],
        }, { signal: controller.signal, timeoutMs: 35000 });
        delay = 1000;
        this.error = null;
        for (const update of updates) {
          if (!this.running) break;
          try {
            if (update.message) await this.onMessage(update.message);
          } catch (error) {
            this.onLog('telegram-update-failed', { updateId: update.update_id, message: String(error?.message || error).slice(0, 300) }, 'error');
          }
          offset = Number(update.update_id) + 1;
          await this.saveOffset(offset);
        }
      } catch (error) {
        if (!this.running || error.name === 'AbortError') break;
        this.error = String(error?.message || error).slice(0, 300);
        this.onLog('telegram-poll-failed', { message: this.error }, 'warning');
        const wait = Math.max(delay, Number(error.retryAfter || 0) * 1000);
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            this.retryWait = null;
            resolve();
          }, Math.min(wait, 60000));
          this.retryWait = { timer, resolve };
        });
        delay = Math.min(delay * 2, 30000);
      } finally {
        if (this.pollController === controller) this.pollController = null;
      }
    }
  }

  setQueueProcessor(processor) { this.queueProcessor = processor; }

  async stop() {
    this.running = false;
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = null;
    if (this.pollController) this.pollController.abort();
    if (this.retryWait) {
      clearTimeout(this.retryWait.timer);
      const retryWait = this.retryWait;
      this.retryWait = null;
      retryWait.resolve();
    }
    if (this.pollPromise) {
      try { await this.pollPromise; } catch (_) { /* shutdown is best effort */ }
    }
    this.pollPromise = null;
  }

  status() {
    return {
      active: this.running,
      botUsername: this.info?.username || '',
      botName: this.info?.first_name || '',
      error: this.error || '',
    };
  }
}

module.exports = { TelegramBotService, buildWithdrawalMessage, escapeHtml, formatMoney };
