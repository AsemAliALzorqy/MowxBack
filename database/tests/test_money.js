'use strict';
const assert = require('node:assert/strict');
const {
  parseMoneyToMilli,
  parseQuantityToMicros,
  moneyFromMilli,
  quantityFromMicros,
  decimalPlacesForCurrency,
} = require('../../src/database/money');

assert.equal(parseMoneyToMilli('12.34', 2), 12340);
assert.equal(parseMoneyToMilli('12.345', 3), 12345);
assert.equal(moneyFromMilli(12345), 12.345);
assert.equal(parseQuantityToMicros('1.250000'), 1250000);
assert.equal(quantityFromMicros(1250000), 1.25);
assert.equal(decimalPlacesForCurrency('JOD'), 3);
assert.equal(decimalPlacesForCurrency('KWD'), 3);
assert.equal(decimalPlacesForCurrency('USD'), 2);
assert.throws(() => parseMoneyToMilli('1.001', 2), /decimal places/);
assert.throws(() => parseMoneyToMilli('0', 2), /positive/);
assert.throws(() => parseQuantityToMicros('1.0000001'), /decimal places/);
assert.throws(() => parseMoneyToMilli('-2', 2), /positive/);
console.log('money tests: 12 assertions passed');
