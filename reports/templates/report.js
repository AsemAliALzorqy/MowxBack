'use strict';
(() => {
  const root = document.getElementById('report');
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[ch]);
  const num = (value, places = 3) => new Intl.NumberFormat('en-US', { maximumFractionDigits: places }).format(Number(value) || 0);
  const dateText = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return match ? `${match[3]}/${match[2]}/${match[1]}` : esc(value);
  };
  const currency = (value, cfg) => {
    const amount = num(value, cfg.decimalPlaces);
    if (cfg.code === 'SAR') return `<span class="money"><span class="num">${amount}</span><img class="currency-icon" src="../../css/assets/saudi-riyal.svg" alt="ريال سعودي"></span>`;
    return `<span class="money"><span class="num">${amount}</span><bdi>${esc(cfg.label || cfg.code || '')}</bdi></span>`;
  };
  const summaryCard = (label, value, cfg, cls = '') => `<div class="summary-card ${cls}"><div class="summary-label">${esc(label)}</div><div class="summary-value">${currency(value, cfg)}</div></div>`;
  const summaryTextCard = (label, value, cls = '') => `<div class="summary-card ${cls}"><div class="summary-label">${esc(label)}</div><div class="summary-value">${esc(value)}</div></div>`;
  const section = (title, body) => `<section class="section"><h2 class="section-title">${esc(title)}</h2>${body || '<div class="empty">لا توجد بيانات خلال الفترة المحددة</div>'}</section>`;
  const table = (headers, rows, totalRow = '') => rows.length ? `<table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}${totalRow ? `<tr class="total-row">${totalRow}</tr>` : ''}</tbody></table>` : '<div class="empty">لا توجد بيانات خلال الفترة المحددة</div>';
  const renderRows = (rows, headers, cells) => table(headers, rows.map((row) => `<tr>${cells(row).map((cell) => `<td>${cell}</td>`).join('')}</tr>`));
  const header = (data) => `<header class="report-head"><div class="brand-line"><div class="brand">MowxBack</div><div class="doc-type">مستند صادر من النظام</div></div><h1 class="report-title">${esc(data.title)}</h1><div class="meta"><span>الفترة: <strong class="num">${dateText(data.fromDate)} — ${dateText(data.toDate)}</strong></span><span>تاريخ الإنشاء: <strong>${esc(data.generatedAtText)}</strong></span>${data.filterSummary ? `<span>نطاق العناصر: <strong>${esc(data.filterSummary)}</strong></span>` : ''}</div><div class="developer-links"><a href="https://github.com/AsemAliALzorqy">المطور: AsemAliALzorqy</a><a href="https://github.com/AsemAliALzorqy/MowxBack">مستودع MowxBack على GitHub</a></div></header>`;
  const footer = () => `<footer class="report-footer"><span><span class="brand-small">MowxBack</span> — تقرير صادر من التطبيق</span><span>البيانات مستخرجة من قاعدة SQLite المحلية</span></footer>`;
  const general = (data) => {
    const t = data.totals; const cfg = data.currency;
    const cards = `<div class="summary-grid">${summaryCard('إجمالي الأرباح', t.profit, cfg, 'gain')}${summaryCard('إجمالي المصروفات', t.expenses, cfg, 'loss')}${summaryCard('سحبيات العمال', t.withdrawals, cfg, 'warn')}${summaryCard('صافي الفترة', t.net, cfg, t.net >= 0 ? 'gain' : 'loss')}${summaryTextCard('عدد الحركات', String(data.movementCount ?? (data.movements || []).length))}${summaryTextCard('إجمالي كميات الأرباح', num(t.quantity, 3))}</div>`;
    const daily = renderRows(data.daily, ['التاريخ','الأرباح','المصروفات','السحبيات','صافي اليوم'], (r) => [dateText(r.date),currency(r.profit,cfg),currency(r.expenses,cfg),currency(r.withdrawals,cfg),currency(r.net,cfg)]);
    const items = renderRows(data.items, ['الصنف','الكمية','إجمالي الربح'], (r) => [esc(r.name),`<span class="num">${num(r.qty,3)}</span>`,currency(r.amount,cfg)]);
    const cats = renderRows(data.categories, ['الفئة','إجمالي المصروفات'], (r) => [esc(r.name),currency(r.amount,cfg)]);
    const workers = renderRows(data.workers, ['العامل','إجمالي السحبيات'], (r) => [esc(r.name),currency(r.amount,cfg)]);
    const movementTypes = { profit: 'ربح صنف', expense: 'مصروف', withdrawal: 'سحبية عامل' };
    const movements = renderRows(data.movements || [], ['التاريخ','نوع الحركة','الصنف أو الجهة','الكمية','المبلغ','الوصف والملاحظات'], (r) => [
      dateText(r.date), esc(movementTypes[r.type] || r.type), esc(r.party),
      r.quantity === null ? '—' : `<span class="num">${num(r.quantity,3)}</span>`, currency(r.amount,cfg),
      `<span class="note">${esc([r.description,r.notes].filter(Boolean).join(' — ') || '—')}</span>`,
    ]);
    return `${cards}${section('الحركة اليومية', daily)}${section('تفاصيل الحركات المسجلة',movements)}${section('الأرباح حسب الأصناف',items)}${section('المصروفات حسب الفئات',cats)}${section('السحبيات حسب العمال',workers)}`;
  };
  const profits = (data) => {
    const cfg = data.currency; const t = data.totals;
    const cards = `<div class="summary-grid">${summaryCard(data.scope === 'all' ? 'إجمالي أرباح جميع الأصناف' : 'إجمالي أرباح الأصناف المحددة',t.amount,cfg,'gain')}${summaryTextCard('إجمالي الكميات',num(t.quantity,3))}${summaryTextCard('عدد الحركات',String(t.operationCount))}</div>`;
    const items = renderRows(data.byItem,['الصنف','الكمية','الربح','عدد الحركات'],(r)=>[esc(r.name),`<span class="num">${num(r.quantity,3)}</span>`,currency(r.amount,cfg),`<span class="num">${r.operationCount}</span>`]);
    const days = renderRows(data.byDay,['التاريخ','الكمية','الربح','عدد الحركات'],(r)=>[dateText(r.date),`<span class="num">${num(r.quantity,3)}</span>`,currency(r.amount,cfg),`<span class="num">${r.operationCount}</span>`]);
    const rows = renderRows(data.rows,['التاريخ','الصنف','الكمية','الربح','الملاحظات'],(r)=>[dateText(r.date),esc(r.itemName),`<span class="num">${num(r.quantity,3)}</span>`,currency(r.amount,cfg),`<span class="note">${esc(r.notes || '—')}</span>`]);
    return `${cards}${section(data.scope === 'all' ? 'ملخص جميع الأصناف' : 'ملخص الأصناف المختارة',items)}${section('التجميع اليومي',days)}${section('تفاصيل حركات الأرباح',rows)}`;
  };
  const expenses = (data) => {
    const cfg=data.currency; const t=data.totals;
    const cards=`<div class="summary-grid">${summaryCard('إجمالي المصروفات',t.amount,cfg,'loss')}${summaryTextCard('عدد عمليات المصروفات',String(t.operationCount))}</div>`;
    const groups=renderRows(data.byCategory,['الفئة','عدد العمليات','الإجمالي'],(r)=>[esc(r.name),`<span class="num">${r.operationCount}</span>`,currency(r.amount,cfg)]);
    const rows=renderRows(data.rows,['التاريخ','الفئة','الوصف','المبلغ','الملاحظات'],(r)=>[dateText(r.date),esc(r.category),esc(r.description || '—'),currency(r.amount,cfg),`<span class="note">${esc(r.notes || '—')}</span>`]);
    return `${cards}${section('الإجمالي حسب الفئة',groups)}${section('تفاصيل المصروفات',rows)}`;
  };
  const withdrawals = (data) => {
    const cfg=data.currency; const t=data.totals;
    const cards=`<div class="summary-grid">${summaryCard('إجمالي السحبيات',t.amount,cfg,'warn')}${summaryTextCard('عدد السحبيات',String(t.operationCount))}</div>`;
    const groups=renderRows(data.byWorker,['العامل','عدد السحبيات','الإجمالي'],(r)=>[esc(r.name),`<span class="num">${r.operationCount}</span>`,currency(r.amount,cfg)]);
    const rows=renderRows(data.rows,['التاريخ','العامل','المبلغ','الملاحظات'],(r)=>[dateText(r.date),esc(r.worker),currency(r.amount,cfg),`<span class="note">${esc(r.notes || '—')}</span>`]);
    return `${cards}${section('الإجمالي حسب العامل',groups)}${section('تفاصيل السحبيات',rows)}`;
  };
  window.renderMowxReport = (data) => {
    if (!data || !data.type || !data.currency) throw new Error('بيانات التقرير غير مكتملة.');
    const body = data.type === 'general' ? general(data) : data.type === 'profits' ? profits(data) : data.type === 'expenses' ? expenses(data) : data.type === 'withdrawals' ? withdrawals(data) : '<div class="empty">نوع التقرير غير معروف</div>';
    root.innerHTML = `${header(data)}<div class="content">${body}</div>`;
    return document.fonts.ready.then(() => true);
  };
})();
