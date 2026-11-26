'use strict';

const assert = require('node:assert/strict');
const { TelegramBotService, buildWithdrawalMessage } = require('../../electron/telegram-service');
const { matrixFor, toSvgDataUrl } = require('../../electron/qr-code');

async function main() {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body || '{}') });
    const method = String(url).split('/').pop();
    const result = method === 'getMe'
      ? { id: 123, is_bot: true, first_name: 'MowxBack', username: 'MowxBackTestBot' }
      : method === 'getWebhookInfo'
        ? { url: '', has_custom_certificate: false, pending_update_count: 0 }
        : { message_id: 987, chat: { id: 123456789 }, date: 1, text: 'ok' };
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };

  const service = new TelegramBotService({ token: '123456:TEST_SECRET', fetchImpl: fakeFetch });
  const me = await service.getMe();
  assert.equal(me.username, 'MowxBackTestBot');
  const webhook = await service.getWebhookInfo();
  assert.equal(webhook.url, '');
  const sent = await service.sendMessage('123456789', '<b>اختبار</b>');
  assert.equal(sent.message_id, 987);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.parse_mode, 'HTML');
  assert.equal(calls[2].body.chat_id, '123456789');
  assert.equal(calls[2].body.text, '<b>اختبار</b>');

  const invoice = buildWithdrawalMessage({
    workerName: 'محمد <أحمد>', businessName: 'مصنع النور & الشركاء',
    amountMilli: 25750, decimalPlaces: 2, currencyLabel: 'د.أ',
    date: '2026-11-26', createdAt: '2026-11-26T10:45:00.000Z',
    notes: 'دفعة <مقدمة> & مراجعة', withdrawalId: 'withdrawal-12345678',
  });
  assert.match(invoice, /<b>MowxBack<\/b>/);
  assert.match(invoice, /مصنع النور &amp; الشركاء/);
  assert.match(invoice, /25\.75 د\.أ/);
  assert.match(invoice, /التاريخ: 26\/11\/2026/);
  assert.match(invoice, /محمد &lt;أحمد&gt;/);
  assert.match(invoice, /ملاحظة السحب/);
  assert.match(invoice, /دفعة &lt;مقدمة&gt; &amp; مراجعة/);
  assert.match(invoice, /WD-12345678/);

  const noNotes = buildWithdrawalMessage({ workerName: 'عامل', amountMilli: 1000, decimalPlaces: 2, currencyLabel: 'د.أ', date: '2026-11-26' });
  assert.doesNotMatch(noNotes, /ملاحظة السحب/);
  assert.doesNotMatch(noNotes, /مصنع/);
  assert.match(noNotes, /<b>MowxBack<\/b>/);

  const matrix = matrixFor('https://t.me/MowxBackTestBot?start=AbCdEf0123456789_xyz');
  assert.ok(matrix.length >= 21);
  assert.equal(matrix.length, matrix[0].length);
  assert.ok(matrix.every((row) => row.every((cell) => typeof cell === 'boolean')));
  const qr = toSvgDataUrl('https://t.me/MowxBackTestBot?start=AbCdEf0123456789_xyz');
  assert.match(qr, /^data:image\/svg\+xml;base64,/);
  const decodedSvg = Buffer.from(qr.split(',')[1], 'base64').toString('utf8');
  assert.match(decodedSvg, /<svg/);
  assert.match(decodedSvg, /<path/);

  const failingService = new TelegramBotService({
    token: '123456:TEST_SECRET',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) }),
  });
  await assert.rejects(() => failingService.getMe(), /Unauthorized/);
  const networkFailureService = new TelegramBotService({
    token: '987654:VERY_SECRET_TOKEN',
    fetchImpl: async () => { throw new TypeError('fetch failed for https://api.telegram.org/bot987654:VERY_SECRET_TOKEN/getMe'); },
  });
  await assert.rejects(() => networkFailureService.getMe(), (error) => {
    assert.equal(error.message.includes('VERY_SECRET_TOKEN'), false);
    assert.equal(error.message.includes('api.telegram.org'), false);
    return error.name === 'TelegramNetworkError';
  });

  const dnsFailure = new TypeError('fetch failed');
  dnsFailure.cause = Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' });
  const offlineService = new TelegramBotService({
    token: '111111:OFFLINE_TEST',
    fetchImpl: async (url) => {
      const method = String(url).split('/').pop();
      if (method === 'getMe') throw dnsFailure;
      if (method === 'getUpdates') return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
      if (method === 'sendMessage') throw dnsFailure;
      throw new Error('unexpected test request');
    },
  });
  await offlineService.start();
  assert.equal(offlineService.running, true, 'a temporary startup outage should leave Long Polling available for recovery');
  await offlineService.stop();
  await assert.rejects(() => offlineService.call('sendMessage', { chat_id: '1', text: 'test' }), (error) => error.deliveryAmbiguous === false);
  console.log('Telegram tests: message formatting, date formatting, optional notes/business name, HTML escaping, Bot API requests, token redaction, startup reconnect handling, DNS retry classification, and QR generation passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
