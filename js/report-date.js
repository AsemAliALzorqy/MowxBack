'use strict';
(function attachReportDateApi(root) {
  function isValidISODate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function range(selection) {
    if (selection.period === 'day') {
      if (!isValidISODate(selection.day)) throw new Error('اختر تاريخاً يومياً صحيحاً.');
      return { from: selection.day, to: selection.day };
    }
    if (selection.period === 'month') {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(selection.month || ''))) throw new Error('اختر شهراً وسنة صحيحين.');
      const [year, month] = selection.month.split('-').map(Number);
      const lastDayDate = new Date(0);
      lastDayDate.setUTCHours(0, 0, 0, 0);
      lastDayDate.setUTCFullYear(year, month, 0);
      const lastDay = lastDayDate.getUTCDate();
      return { from: `${selection.month}-01`, to: `${selection.month}-${String(lastDay).padStart(2, '0')}` };
    }
    if (selection.period !== 'range' || !isValidISODate(selection.from) || !isValidISODate(selection.to) || selection.from > selection.to) {
      throw new Error('تحقق من صحة تاريخ البداية والنهاية، ويجب ألا تسبق البداية النهاية.');
    }
    return { from: selection.from, to: selection.to };
  }

  const api = Object.freeze({ isValidISODate, range });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MowxReportDates = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
