'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
  const templatePath = path.join(__dirname, '..', '..', 'reports', 'templates', 'report.js');
  const source = fs.readFileSync(templatePath, 'utf8');
  const root = { innerHTML: '' };
  const context = {
    document: { getElementById: (id) => id === 'report' ? root : null, fonts: { ready: Promise.resolve() } },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'report.js' });

  const base = {
    fromDate: '2026-11-01', toDate: '2026-11-02', generatedAtText: '24 نوفمبر 2026، 12:00',
    currency: { code: 'SAR', label: '⃁', decimalPlaces: 2 },
  };
  await context.window.renderMowxReport({
    ...base, type: 'general', title: 'التقرير العام', filterSummary: 'جميع الحركات المالية المسجلة',
    totals: { profit: 100, expenses: 10, withdrawals: 20, net: 70, quantity: 2 },
    daily: [
      { date: '2026-11-01', profit: 100, expenses: 10, withdrawals: 20, net: 70 },
      { date: '2026-11-02', profit: 0, expenses: 0, withdrawals: 0, net: 0 },
    ],
    movements: [
      { date: '2026-11-01', type: 'profit', party: 'صنف أ', quantity: 2, amount: 100, description: '', notes: 'تفصيل حركة' },
      { date: '2026-11-01', type: 'expense', party: 'الطعام', quantity: null, amount: 10, description: 'وجبة', notes: '' },
      { date: '2026-11-01', type: 'withdrawal', party: 'عامل أ', quantity: null, amount: 20, description: '', notes: 'دفعة' },
    ],
    items: [{ name: 'صنف أ', qty: 2, amount: 100 }],
    categories: [{ name: 'الطعام', amount: 10 }], workers: [{ name: 'عامل أ', amount: 20 }],
  });
  assert.match(root.innerHTML, /تفاصيل الحركات المسجلة/);
  assert.match(root.innerHTML, /وجبة/);
  assert.match(root.innerHTML, /عامل أ/);
  assert.ok(root.innerHTML.includes('02/11/2026'));
  assert.match(root.innerHTML, /https:\/\/github\.com\/AsemAliALzorqy/);
  assert.match(root.innerHTML, /https:\/\/github\.com\/AsemAliALzorqy\/MowxBack/);
  assert.match(root.innerHTML, /saudi-riyal\.svg/);

  await context.window.renderMowxReport({
    ...base, type: 'profits', title: 'تقرير أرباح الأصناف', filterSummary: 'الأصناف المختارة: صنف ب',
    totals: { amount: 25, quantity: 1.5, operationCount: 1 },
    byItem: [{ name: 'صنف ب', amount: 25, quantity: 1.5, operationCount: 1 }],
    byDay: [{ date: '2026-11-01', amount: 25, quantity: 1.5, operationCount: 1 }],
    rows: [{ date: '2026-11-01', itemName: 'صنف ب', quantity: 1.5, amount: 25, notes: '<ملاحظة>' }],
  });
  assert.match(root.innerHTML, /صنف ب/);
  assert.match(root.innerHTML, /&lt;ملاحظة&gt;/);
  assert.doesNotMatch(root.innerHTML, /<ملاحظة>/);

  await context.window.renderMowxReport({
    ...base, type: 'expenses', title: 'تقرير المصروفات', filterSummary: 'الفئات: الصيانة',
    totals: { amount: 0, operationCount: 0 }, byCategory: [], rows: [],
  });
  assert.match(root.innerHTML, /تقرير المصروفات/);
  assert.match(root.innerHTML, /لا توجد بيانات خلال الفترة المحددة/);

  await context.window.renderMowxReport({
    ...base, type: 'withdrawals', title: 'تقرير سحبيات العمال', filterSummary: 'العمال: عامل أ',
    totals: { amount: 20, operationCount: 1 },
    byWorker: [{ name: 'عامل أ', amount: 20, operationCount: 1 }],
    rows: [{ date: '2026-11-01', worker: 'عامل أ', amount: 20, notes: '' }],
  });
  assert.match(root.innerHTML, /تقرير سحبيات العمال/);
  assert.match(root.innerHTML, /عامل أ/);
  console.log('PDF template rendering: 4 report types, developer links, SAR icon, Arabic text escaping, and empty-state rendering passed.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
