'use strict';

const MONEY_SCALE = 1000;
const QUANTITY_SCALE = 1000000;

function decimalToScaledInteger(value, scale, maxFractionDigits, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:\d+)(?:\.\d+)?$/.test(raw)) {
    throw new TypeError(`${label} must be a positive decimal number.`);
  }
  const [whole, fraction = ''] = raw.split('.');
  if (fraction.length > maxFractionDigits) {
    throw new RangeError(`${label} supports at most ${maxFractionDigits} decimal places.`);
  }
  const scaleDigits = String(scale).length - 1;
  if (fraction.length > scaleDigits) {
    throw new RangeError(`${label} exceeds the internal precision.`);
  }
  const valueBig = (BigInt(whole) * BigInt(scale)) + BigInt((fraction + '0'.repeat(scaleDigits)).slice(0, scaleDigits) || '0');
  if (valueBig <= 0n) throw new RangeError(`${label} must be positive.`);
  if (valueBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} is outside the supported range.`);
  }
  return Number(valueBig);
}

function parseMoneyToMilli(value, currencyDecimalPlaces = 2) {
  if (!Number.isInteger(currencyDecimalPlaces) || currencyDecimalPlaces < 0 || currencyDecimalPlaces > 3) {
    throw new RangeError('Currency decimal places must be between 0 and 3.');
  }
  return decimalToScaledInteger(value, MONEY_SCALE, currencyDecimalPlaces, 'Amount');
}

function parseQuantityToMicros(value) {
  return decimalToScaledInteger(value, QUANTITY_SCALE, 6, 'Quantity');
}

function moneyFromMilli(value) {
  if (!Number.isSafeInteger(value)) throw new TypeError('Stored amount must be a safe integer.');
  return value / MONEY_SCALE;
}

function quantityFromMicros(value) {
  if (!Number.isSafeInteger(value)) throw new TypeError('Stored quantity must be a safe integer.');
  return value / QUANTITY_SCALE;
}

function decimalPlacesForCurrency(code, customPlaces = 2) {
  const places = { SAR: 2, AED: 2, USD: 2, EGP: 2, JOD: 3, KWD: 3 };
  return places[code] ?? customPlaces;
}

module.exports = {
  MONEY_SCALE,
  QUANTITY_SCALE,
  parseMoneyToMilli,
  parseQuantityToMicros,
  moneyFromMilli,
  quantityFromMicros,
  decimalPlacesForCurrency,
};
