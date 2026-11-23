'use strict';

const SAUDI_RIYAL_SIGN = '\u20C1';

function applyInitialCurrencyDefaults(db, isNewDatabase) {
  if (!isNewDatabase) return false;
  const now = new Date().toISOString();
  const update = db.prepare('UPDATE app_settings SET value_json = ?, updated_at = ? WHERE setting_key = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    const code = update.run(JSON.stringify('SAR'), now, 'currencyCode');
    const label = update.run(JSON.stringify(SAUDI_RIYAL_SIGN), now, 'currencyLabel');
    const places = update.run(JSON.stringify(2), now, 'currencyDecimalPlaces');
    if (code.changes !== 1 || label.changes !== 1 || places.changes !== 1) {
      throw new Error('Unable to initialize the default SAR currency settings.');
    }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { applyInitialCurrencyDefaults, SAUDI_RIYAL_SIGN };
