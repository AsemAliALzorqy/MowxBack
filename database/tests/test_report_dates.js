'use strict';
const assert = require('node:assert/strict');
const { isValidISODate, range } = require('../../js/report-date');

assert.equal(isValidISODate('2024-02-29'), true);
assert.equal(isValidISODate('2025-02-29'), false);
assert.equal(isValidISODate('2026-13-01'), false);
assert.equal(isValidISODate('2026-04-31'), false);
assert.equal(isValidISODate(''), false);
assert.deepEqual(range({ period: 'day', day: '2026-11-25' }), { from: '2026-11-25', to: '2026-11-25' });
assert.deepEqual(range({ period: 'month', month: '2024-02' }), { from: '2024-02-01', to: '2024-02-29' });
assert.deepEqual(range({ period: 'month', month: '2025-02' }), { from: '2025-02-01', to: '2025-02-28' });
assert.deepEqual(range({ period: 'range', from: '2026-11-01', to: '2026-11-25' }), { from: '2026-11-01', to: '2026-11-25' });
assert.throws(() => range({ period: 'day', day: '' }), /تاريخاً يومياً صحيحاً/);
assert.throws(() => range({ period: 'range', from: '2026-11-26', to: '2026-11-25' }), /تاريخ البداية والنهاية/);
assert.throws(() => range({ period: 'range', from: '2026-11-31', to: '2026-12-01' }), /تاريخ البداية والنهاية/);
console.log('Report date ranges: daily, month boundaries/leap years, custom ranges, invalid dates, and reversed periods passed.');
