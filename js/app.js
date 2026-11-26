'use strict';

let S = null;
const PAGES = [
  ['home', 'الرئيسية', 'home'], ['ledger', 'دفتر اليوم', 'book'],
  ['profits', 'أرباح الأصناف', 'up'], ['expenses', 'المصروفات', 'receipt'],
  ['withdrawals', 'سحبيات العمال', 'wallet'], ['reports', 'التقارير', 'chart'],
  ['items', 'الأصناف', 'package'], ['workers', 'العمال', 'users'], ['settings', 'الإعدادات', 'settings'],
];
const MAIN = ['home', 'ledger', 'expenses', 'reports'];
const TYPE = {
  profit: ['ربح صنف', 'up', 'gain'],
  expense: ['مصروف', 'receipt', 'loss'],
  withdrawal: ['سحبية عامل', 'wallet', 'warn'],
};
const CURS = { SAR: 'الريال السعودي', JOD: 'د.أ', AED: 'د.إ', KWD: 'د.ك', USD: '$', EGP: 'ج.م' };
const $ = (id) => document.getElementById(id);
let page = 'home';
let day = todayStr();
let rng = { from: `${todayStr().slice(0, 8)}01`, to: todayStr() };
let rep = { kind: 'month', day: todayStr(), from: rng.from, to: rng.to, cur: null };
let q = '';
let renderSequence = 0;
const reportUi = {
  type: 'general', period: 'month', day: todayStr(), month: todayStr().slice(0, 7),
  from: `${todayStr().slice(0, 8)}01`, to: todayStr(),
  itemNames: [], categoryIds: [], workerIds: [], allItems: true, allCategories: true, allWorkers: true, preview: null,
};
let reportOptionsData = null;
let reportItemSearch = '';
let diagnosticStatus = null;
let telegramStatus = null;
let modalPointerStartedOutside = false;
let modalPointerEndedOutside = false;
let auditQuery = '';
let auditLoading = false;
let auditSearchTimer = null;
let auditSearchSequence = 0;

const fmtNum = (n, max = 3) => new Intl.NumberFormat('en-US', { maximumFractionDigits: max }).format(Number(n) || 0);
const normName = (name) => String(name || '').replace(/\s+/g, ' ').trim();
const money = (n) => `<span class="num">${fmtNum(n, Number(S?.currencyDecimalPlaces ?? 3))}</span> ${S?.currencyCode === 'SAR' ? '<span class="currency-symbol" role="img" aria-label="ريال سعودي" title="ريال سعودي"></span>' : `<bdi>${esc(S?.currency || '')}</bdi>`}`;
const netTxt = (n) => n >= 0 ? 'ربح' : 'خسارة';
const inRange = (t, a, b) => t.date >= a && t.date <= b;

function live() { return (S?.tx || []).filter((t) => !t.void); }
function aLines(t) { return t.lines ? t.lines : [t]; }
function sums(list) {
  const result = { profit: 0, qty: 0, exp: 0, wd: 0 };
  list.forEach((t) => {
    if (t.type === 'profit') {
      result.profit += Number(t.amount) || 0;
      result.qty += Number(t.qty) || 0;
    } else if (t.type === 'withdrawal') result.wd += Number(t.amount) || 0;
    else result.exp += Number(t.amount) || 0;
  });
  result.totalExp = result.exp + result.wd;
  result.net = result.profit - result.totalExp;
  return result;
}
function stat(label, icon, cls, value) {
  return `<div class="card"><div class="k">${ic(icon)} ${label}</div><div class="v ${cls}">${money(value)}</div></div>`;
}
function summary(s) {
  return `<div class="grid c3">${stat('أرباح الأصناف', 'up', 'gain', s.profit)}${stat('المصروفات (شاملة السحبيات)', 'receipt', 'loss', s.totalExp)}${stat('منها سحبيات العمال', 'wallet', 'warn', s.wd)}</div>`;
}
function netCard(s) {
  return `<div class="card net"><div class="k" style="color:#cbd5e1">${ic('chart')} صافي النتيجة</div><div class="big">${s.net >= 0 ? '+' : '−'}${money(Math.abs(s.net))}</div><div>${netTxt(s.net)}</div><small>صافي النتيجة = أرباح الأصناف − المصروفات (السحبيات محسوبة مرة واحدة ضمنها)</small></div>`;
}
function quick(date) {
  return `<div class="btns"><button class="btn p" data-act="add" data-type="profit" data-date="${date}">${ic('plus')} إضافة ربح صنف</button><button class="btn p" data-act="add" data-type="expense" data-date="${date}">${ic('plus')} إضافة مصروف</button><button class="btn p" data-act="add" data-type="withdrawal" data-date="${date}">${ic('plus')} تسجيل سحبية عامل</button></div>`;
}
function dateBar(extra = '') {
  return `<div class="bar"><label class="fld">من<input type="date" data-rng="from" value="${rng.from}"></label><label class="fld">إلى<input type="date" data-rng="to" value="${rng.to}"></label>${extra}</div>`;
}
function row(t) {
  if (t.type === 'profit') return prow(t);
  const [label, icon, cls] = TYPE[t.type];
  return `<div class="row"><span class="${cls}">${ic(icon, 'l')}</span><div class="m"><div class="d">${esc(t.name || label)}</div><div class="s">${label} · ${esc(t.desc || t.note || '')} · <span class="num">${t.date}</span></div></div><b class="${cls}">${t.type === 'profit' ? '+' : '−'}${money(t.amount)}</b><button class="btn i" data-act="edit" data-id="${esc(t.id)}" aria-label="تعديل">${ic('pencil')}</button><button class="btn i" data-act="delete" data-id="${esc(t.id)}" aria-label="حذف">${ic('x')}</button></div>`;
}
function list(entries) {
  return entries.length ? entries.map(row).join('') : '<div class="empty">لا توجد عمليات. ابدأ بإضافة عملية جديدة.</div>';
}

const V = {
  home() {
    const today = todayStr();
    const entries = live().filter((t) => t.date === today);
    const s = sums(entries);
    return `<div class="grid">${netCard(s)}</div><h2 style="margin-top:12px"> </h2>${summary(s)}<h2>عمليات سريعة</h2>${quick(today)}<h2>آخر العمليات</h2><div class="card">${list(entries.slice(0, 8))}</div>`;
  },
  ledger() {
    const entries = live().filter((t) => t.date === day);
    const s = sums(entries);
    return `<div class="bar"><label class="fld">التاريخ<input type="date" id="dayIn" value="${day}"></label></div>${netCard(s)}<div style="height:12px"></div>${summary(s)}<h2>إضافة</h2>${quick(day)}${['profit', 'expense', 'withdrawal'].map((kind) => `<h2>${TYPE[kind][0]}</h2><div class="card">${list(entries.filter((t) => t.type === kind))}</div>`).join('')}`;
  },
  list(type) {
    const entries = live().filter((t) => t.type === type && inRange(t, rng.from, rng.to));
    const s = sums(entries);
    const total = type === 'profit' ? s.profit : type === 'expense' ? s.exp : s.wd;
    let by = '';
    const grouped = {};
    entries.forEach((entry) => {
      (entry.type === 'profit' ? aLines(entry) : [entry]).forEach((line) => {
        const name = line.name || entry.name;
        grouped[name] = grouped[name] || { amount: 0, qty: 0 };
        grouped[name].amount += Number(line.amount) || 0;
        grouped[name].qty += Number(line.qty) || 0;
      });
    });
    if (Object.keys(grouped).length) {
      by = `<h2>${type === 'withdrawal' ? 'حسب العامل' : type === 'profit' ? 'حسب الصنف' : 'حسب التصنيف'}</h2><div class="card">${Object.entries(grouped).map(([name, value]) => `<div class="row"><div class="m d">${esc(name)}${type === 'profit' ? ` — <span class="num">${fmtNum(value.qty)}</span>` : ''}</div><b>${money(value.amount)}</b></div>`).join('')}</div>`;
    }
    return `${dateBar(`<button class="btn p" data-act="add" data-type="${type}" data-date="${todayStr()}">${ic('plus')} إضافة</button>`)}<div class="card" style="margin-bottom:12px"><div class="k">المجموع${type === 'profit' ? ` — الكمية <span class="num">${fmtNum(s.qty)}</span>` : ''}</div><div class="v ${TYPE[type][2]}">${money(total)}</div>${type === 'withdrawal' ? '<div class="sub">تُحتسب ضمن المصروفات مرة واحدة</div>' : ''}</div><div class="card">${list(entries.slice().sort((a, b) => b.date.localeCompare(a.date)))}</div>${by}`;
  },
  reports() {
    const options = reportOptionsData || { items: [], categories: [], workers: [] };
    const types = [
      ['withdrawals', 'سحبيات العمال', 'wallet', 'تفاصيل السحبيات وإجمالي كل عامل'],
      ['expenses', 'المصروفات', 'receipt', 'تحليل المصروفات حسب الفئات المختارة'],
      ['profits', 'أرباح الأصناف', 'up', 'حركات وأرباح صنف واحد أو عدة أصناف'],
      ['general', 'التقرير العام', 'chart', 'ملخص يومي للأرباح والمصروفات والسحبيات'],
    ];
    const selected = reportUi.type === 'profits' ? reportUi.itemNames
      : reportUi.type === 'expenses' ? reportUi.categoryIds : reportUi.workerIds;
    const optionList = reportUi.type === 'profits' ? options.items
      : reportUi.type === 'expenses' ? options.categories : options.workers;
    const filterKey = reportUi.type === 'profits' ? 'itemNames'
      : reportUi.type === 'expenses' ? 'categoryIds' : 'workerIds';
    const filterLabel = reportUi.type === 'profits' ? 'الأصناف المطلوبة'
      : reportUi.type === 'expenses' ? 'فئات المصروفات' : 'العمال';
    const allFlag = reportUi.type === 'expenses' ? 'allCategories' : 'allWorkers';
    const showAll = reportUi.type === 'expenses' || reportUi.type === 'withdrawals';
    const filter = reportUi.type === 'general' ? '' : reportUi.type === 'profits'
      ? `<div class="card report-filter"><div class="fld">نطاق الأصناف</div><div class="report-mode"><label><input type="radio" name="reportItemMode" value="all"${reportUi.allItems ? ' checked' : ''}> جميع الأصناف</label><label><input type="radio" name="reportItemMode" value="selected"${!reportUi.allItems ? ' checked' : ''}> أصناف محددة</label></div>${reportUi.allItems ? '<div class="sub">سيشمل التقرير جميع الأصناف التي لها حركات ضمن الفترة، بما فيها الأسماء التاريخية والأصناف الموقوفة.</div>' : `<div class="report-item-picker"><label class="fld">بحث باسم الصنف<input id="reportItemSearch" type="search" value="${esc(reportItemSearch)}" placeholder="اكتب اسم الصنف للبحث"></label><div class="report-item-actions"><button class="btn" data-act="report-select-visible">تحديد نتائج البحث</button><button class="btn" data-act="report-clear-items">مسح التحديد</button></div><div class="report-selected"><span class="sub">الأصناف المحددة (${reportUi.itemNames.length})</span>${reportUi.itemNames.length ? reportUi.itemNames.map((name) => `<button class="report-chip" type="button" data-report-remove="${esc(name)}" aria-label="إزالة ${esc(name)}">${esc(name)} ×</button>`).join('') : '<span class="sub">لم يتم اختيار أصناف بعد.</span>'}</div><div class="report-choice-list">${optionList.filter((item) => item.name.toLocaleLowerCase().includes(reportItemSearch.trim().toLocaleLowerCase())).map((item) => `<label class="report-choice"><input type="checkbox" data-report-choice="itemNames" value="${esc(item.value)}"${selected.includes(item.value) ? ' checked' : ''}><span>${esc(item.name)}${item.active === false ? ' — موقوف' : ''}</span></label>`).join('') || '<div class="empty">لا توجد أصناف مطابقة للبحث.</div>'}</div></div>`}</div>`
      : `<div class="card report-filter"><div class="fld">${filterLabel}</div>${showAll ? `<label class="report-all"><input type="checkbox" data-report-all="${allFlag}"${reportUi[allFlag] ? ' checked' : ''}> ${reportUi.type === 'expenses' ? 'تضمين جميع الفئات' : 'تضمين جميع العمال'}</label>` : ''}<div class="report-choice-list ${reportUi[allFlag] && showAll ? 'disabled' : ''}">${optionList.map((item) => `<label class="report-choice"><input type="checkbox" data-report-choice="${filterKey}" value="${esc(item.value)}"${selected.includes(item.value) ? ' checked' : ''}${reportUi[allFlag] && showAll ? ' disabled' : ''}><span>${esc(item.name)}${item.active === false ? ' — موقوف' : ''}</span></label>`).join('') || '<div class="empty">لا توجد عناصر مسجلة لهذا النوع حالياً.</div>'}</div><div class="sub">يمكنك اختيار جميع العناصر أو تحديد عنصراً واحداً أو عدة عناصر.</div></div>`;
    let periodFields = '';
    if (reportUi.period === 'day') periodFields = `<label class="fld">يومي — التاريخ<input type="date" id="reportDay" value="${esc(reportUi.day)}"></label>`;
    else if (reportUi.period === 'month') periodFields = `<label class="fld">شهري — الشهر والسنة<input type="month" id="reportMonth" value="${esc(reportUi.month)}"></label>`;
    else periodFields = `<label class="fld">من تاريخ<input type="date" id="reportFrom" value="${esc(reportUi.from)}"></label><label class="fld">إلى تاريخ<input type="date" id="reportTo" value="${esc(reportUi.to)}"></label>`;
    return `<div class="report-types">${types.map(([key, title, icon, desc]) => `<button class="report-type ${reportUi.type === key ? 'selected' : ''}" data-act="report-type" data-type="${key}"><span>${ic(icon, 'l')}</span><b>${title}</b><small>${desc}</small></button>`).join('')}</div>
      <div class="card report-controls"><div class="bar"><label class="fld">الفترة<select id="reportPeriod"><option value="day"${reportUi.period === 'day' ? ' selected' : ''}>يومي</option><option value="month"${reportUi.period === 'month' ? ' selected' : ''}>شهري</option><option value="range"${reportUi.period === 'range' ? ' selected' : ''}>من تاريخ إلى تاريخ</option></select></label>${periodFields}</div>${filter}<div class="btns"><button class="btn p" data-act="report-preview">${ic('chart')} معاينة التقرير</button><button class="btn" data-act="report-pdf" ${reportUi.preview ? '' : 'disabled'}>${ic('download')} إنشاء PDF وحفظه</button></div><div class="sub report-hint">سيتم استخراج البيانات مباشرة من قاعدة SQLite وفق الاختيارات الحالية.</div></div>
      ${reportUi.preview ? reportPreviewMarkup(reportUi.preview) : '<div class="empty report-empty">حدد التقرير والفترة والعناصر المطلوبة، ثم اضغط «معاينة التقرير» لمراجعة البيانات قبل إنشاء PDF.</div>'}`;
  },
  mgmt(kind) {
    const entries = (S[kind] || []).filter((item) => item.name.includes(q));
    const label = { items: 'صنف', workers: 'عامل', cats: 'تصنيف' }[kind];
    const rows = kind === 'workers' ? entries.map((item) => {
      const link = item.telegram || { status: 'unlinked' };
      const labels = { unlinked: 'غير مرتبط', pending: 'بانتظار الربط', expired: 'انتهت الصلاحية', linked: 'مرتبط' };
      const cls = link.status === 'linked' ? 'gain' : link.status === 'pending' ? 'warn' : link.status === 'expired' ? 'loss' : '';
      const share = link.status === 'linked'
        ? `<button class="btn worker-manage" data-act="telegram-manage" data-id="${esc(item.id)}">إدارة الربط</button>`
        : (telegramStatus?.active || S.telegram?.active) ? (item.active ? `<div class="worker-share-actions"><button class="btn" data-act="telegram-whatsapp" data-id="${esc(item.id)}" ${item.phone ? '' : 'disabled'} title="إرسال رابط الربط عبر WhatsApp">WhatsApp</button><button class="btn" data-act="telegram-qr" data-id="${esc(item.id)}">QR</button><button class="btn" data-act="telegram-copy" data-id="${esc(item.id)}">نسخ الرابط</button></div>` : '<span class="sub">فعّل العامل لإتاحة الربط</span>')
          : '<span class="sub">فعّل Telegram من الإعدادات لإتاحة الربط</span>';
      return `<div class="worker-entry"><div class="worker-entry-head"><div class="m"><b>${esc(item.name)}</b><small>${item.phone ? esc(item.phone) : 'لا يوجد رقم هاتف'}</small></div><span class="badge ${item.active ? 'gain' : 'warn'}">${item.active ? 'نشط' : 'موقوف'}</span><button class="btn i" data-act="medit" data-k="workers" data-id="${esc(item.id)}" aria-label="تعديل">${ic('pencil')}</button><button class="btn" data-act="mtog" data-k="workers" data-id="${esc(item.id)}">${item.active ? 'إيقاف' : 'تفعيل'}</button></div><div class="worker-telegram-line"><span class="worker-link-status ${cls}">${esc(labels[link.status] || 'غير مرتبط')}</span>${share}</div></div>`;
    }).join('') : entries.map((item) => `<div class="row"><div class="m d">${esc(item.name)}</div><span class="badge ${item.active ? 'gain' : 'warn'}">${item.active ? 'نشط' : 'موقوف'}</span><button class="btn i" data-act="medit" data-k="${kind}" data-id="${esc(item.id)}" aria-label="تعديل">${ic('pencil')}</button><button class="btn" data-act="mtog" data-k="${kind}" data-id="${esc(item.id)}">${item.active ? 'إيقاف' : 'تفعيل'}</button></div>`).join('');
    return `<div class="bar"><label class="fld">بحث<input type="search" id="q" value="${esc(q)}" placeholder="ابحث بالاسم"></label><button class="btn p" data-act="madd" data-k="${kind}">${ic('plus')} إضافة ${label}</button></div><div class="card">${rows || '<div class="empty">لا توجد نتائج</div>'}</div><div class="sub" style="margin-top:8px">الإيقاف لا يحذف السجلات السابقة.${kind === 'workers' ? ' · ربط Telegram اختياري، ويتطلب تفعيل البوت من الإعدادات.' : ''}</div>`;
  },
  settings() {
    const runtime = S.runtime || {};
    const log = S.log || [];
    const normalizedQuery = auditQuery.trim().toLocaleLowerCase();
    const filteredLog = normalizedQuery ? log.filter((entry) => auditSearchText(entry).includes(normalizedQuery)) : log;
    const entries = filteredLog.map(auditEntryMarkup).join('');
    const diagnostics = diagnosticStatus || { enabled: true, fileCount: 0, retentionDays: 14, directory: 'جارٍ قراءة الحالة…' };
    const telegram = telegramStatus || { enabled: false, configured: false, active: false, botUsername: '', businessName: '', workers: [], notifications: [] };
    const linkedWorkers = (telegram.workers || []).filter((worker) => worker.telegram.status === 'linked');
    const notificationRows = (telegram.notifications || []).map((entry) => `<div class="telegram-history-row"><div><b>${esc(entry.withdrawal_id)}</b><small>${esc(entry.status === 'sent' ? 'تم الإرسال' : entry.status === 'pending' ? 'بانتظار الإرسال' : entry.status === 'failed' ? 'فشل الإرسال' : entry.status === 'cancelled' ? 'ملغى' : 'قيد الإرسال')} · ${esc(new Date(entry.created_at).toLocaleString('ar-JO'))}</small>${entry.last_error ? `<small class="loss">${esc(entry.last_error)}</small>` : ''}</div>${entry.status === 'failed' ? `<button class="btn" data-act="telegram-retry" data-id="${esc(entry.id)}">إعادة المحاولة</button>` : ''}</div>`).join('');
    const telegramCard = `<h2>ربط Telegram والإشعارات</h2><div class="card telegram-settings"><div class="row"><div class="m"><b>حالة البوت</b><div class="sub">${telegram.enabled ? (telegram.active ? 'التشغيل المحلي للبوت نشط؛ يعيد الاتصال تلقائياً عند الانقطاع' : 'مفعّل لكن الاستقبال متوقف') : 'غير مفعل — يمكنك استخدام البرنامج بشكل طبيعي دون Telegram'}</div></div><span class="badge ${telegram.active ? 'gain' : 'warn'}">${telegram.active ? 'يعمل' : telegram.configured ? 'غير نشط' : 'غير معد'}</span></div>${telegram.botUsername ? `<div class="sub">البوت: @${esc(telegram.botUsername)} · العمال المرتبطون: ${fmtNum(telegram.linkedWorkers || 0, 0)}</div>` : ''}<div class="sub">آخر تحقق من الاتصال: ${telegram.verifiedAt ? esc(new Date(telegram.verifiedAt).toLocaleString('ar-JO')) : 'لم يتم التحقق بعد'}</div>${telegram.error ? `<div class="telegram-error">${esc(telegram.error)}</div>` : ''}<label class="fld">Bot Token<input id="telegramToken" type="password" autocomplete="new-password" placeholder="أدخل Token من BotFather — لا يتم عرضه بعد الحفظ"></label><div class="btns"><button class="btn" data-act="telegram-verify">التحقق من الرمز</button><button class="btn p" data-act="telegram-save-token">حفظ وربط البوت</button></div><div class="sub">أنشئ بوتاً خاصاً بك من @BotFather باستخدام /newbot، ثم أدخل الرمز هنا. يُحفظ الرمز مشفراً محلياً ولا يُرسل إلى GitHub.</div><div class="btns"><button class="btn" data-act="telegram-enable" ${telegram.active ? 'disabled' : ''}>تفعيل الإشعارات</button><button class="btn" data-act="telegram-disable" ${!telegram.enabled ? 'disabled' : ''}>تعطيل الإشعارات</button><button class="btn" data-act="telegram-disconnect" ${!telegram.configured ? 'disabled' : ''}>فصل البوت وحذف بيانات الربط</button></div><div class="telegram-separator"></div><b>هوية الإشعارات</b><label class="fld">اسم المنشأة (اختياري)<input id="telegramBusinessName" maxlength="120" value="${esc(telegram.businessName || '')}" placeholder="مثال: مصنع النور"></label><button class="btn" data-act="telegram-save-business">حفظ اسم المنشأة</button><div class="telegram-separator"></div><b>اختبار إرسال رسالة</b><label class="fld">العامل المرتبط<select id="telegramTestWorker"><option value="">اختر عاملاً</option>${linkedWorkers.map((worker) => `<option value="${esc(worker.id)}">${esc(worker.name)}</option>`).join('')}</select></label><button class="btn" data-act="telegram-test-message" ${!telegram.active || !linkedWorkers.length ? 'disabled' : ''}>إرسال رسالة اختبارية</button><div class="telegram-separator"></div><b>سجل الإشعارات الأخيرة</b>${notificationRows || '<div class="empty">لا توجد إشعارات مسجلة بعد.</div>'}</div>`;
    const hasMore = log.length < Number(S.auditLogCount || log.length);
    return `<div class="card"><label class="fld">العملة<select id="curCode">${Object.entries(CURS).map(([code, symbol]) => `<option value="${code}"${S.currencyCode === code ? ' selected' : ''}>${code} — ${symbol}</option>`).join('')}<option value="custom"${S.currencyCode === 'custom' ? ' selected' : ''}>أخرى (نص مخصص)</option></select></label><label class="fld">النص المخصص (عند اختيار أخرى)<input id="cur" value="${esc(S.currency)}" maxlength="12"></label><button class="btn p" data-act="cur">حفظ العملة</button></div>${telegramCard}${backupCard(runtime)}<h2>الإدارة</h2><div class="btns"><button class="btn" data-go="items">${ic('package')} الأصناف</button><button class="btn" data-go="workers">${ic('users')} العمال</button><button class="btn" data-act="cats">${ic('receipt')} تصنيفات المصروفات</button></div>
      <div class="audit-heading"><div><h2>سجل التغييرات</h2><div class="sub">سجل تدقيق محلي متسلسل للعمليات التي تمت على بيانات النظام وإعداداته.</div></div><span class="badge">${fmtNum(S.auditLogCount || log.length, 0)} سجل</span></div>
      <div class="card audit-card"><div class="audit-notice">${ic('check','s')} سجل للقراءة فقط. لا يمكن تعديل السجلات أو حذفها من داخل التطبيق، وتُحفظ تفاصيل العملية السابقة واللاحقة عند توفرها.</div><label class="fld">البحث في السجل<input id="auditSearch" type="search" value="${esc(auditQuery)}" placeholder="ابحث باسم أو نوع عملية أو رقم سجل"></label>${entries || '<div class="empty">لا توجد سجلات مطابقة.</div>'}${hasMore ? `<button class="btn audit-more" data-act="audit-more" ${auditLoading ? 'disabled' : ''}>${auditLoading ? 'جارٍ تحميل السجلات…' : 'عرض سجلات أقدم'}</button>` : ''}</div>
      <h2>سجلات التشخيص</h2><div class="card diagnostic-card"><div class="row"><div class="m"><b>حالة التسجيل</b><div class="sub">${diagnostics.enabled ? 'مفعّل — يسجل أحداث التشغيل والأخطاء والعمليات دون قيم الحقول الحساسة' : 'متوقف'}</div></div><span class="badge ${diagnostics.enabled ? 'gain' : 'warn'}">${diagnostics.enabled ? 'نشط' : 'متوقف'}</span></div><div class="sub">آخر تسجيل: ${esc(diagnostics.lastEntryAt ? new Date(diagnostics.lastEntryAt).toLocaleString('ar-JO') : 'لا يوجد بعد')}<br>عدد ملفات السجل: ${fmtNum(diagnostics.fileCount, 0)}<br>مسار السجلات: ${esc(diagnostics.directory || 'غير متاح')}</div><label class="fld">مدة الاحتفاظ بالسجلات<select id="diagRetention">${[7,14,30,60].map((days) => `<option value="${days}"${Number(diagnostics.retentionDays) === days ? ' selected' : ''}>${days} يوماً</option>`).join('')}</select></label><div class="btns"><button class="btn" data-act="diag-open">فتح مجلد السجلات</button><button class="btn p" data-act="diag-export">تصدير السجلات للمشاركة</button></div></div><h2>معلومات النظام</h2><div class="card sub">MowxBack — تخزين محلي عبر SQLite. إصدار التطبيق: ${esc(runtime.appVersion || 'غير متاح')}<br>إصدار قاعدة البيانات: ${esc(runtime.databaseVersion ?? '')}<br>مسار القاعدة: ${esc(runtime.databasePath || 'غير متاح')}<br>الفحص: ${runtime.integrityOk ? 'سليم' : 'لم يُفحص بعد أو توجد مشكلة'}<br>لا توجد مزامنة أو اتصال سحابي.</div>`;
  },
};

function reportRange() {
  return MowxReportDates.range(reportUi);
}

function reportPayload() {
  const range = reportRange();
  if (!range.from || !range.to || range.from > range.to) throw new Error('تحقق من بداية الفترة ونهايتها.');
  const payload = { type: reportUi.type, fromDate: range.from, toDate: range.to };
  if (reportUi.type === 'profits') { payload.allItems = reportUi.allItems; payload.itemNames = reportUi.allItems ? [] : reportUi.itemNames; }
  if (reportUi.type === 'expenses') { payload.allCategories = reportUi.allCategories; payload.categoryIds = reportUi.allCategories ? [] : reportUi.categoryIds; }
  if (reportUi.type === 'withdrawals') { payload.allWorkers = reportUi.allWorkers; payload.workerIds = reportUi.allWorkers ? [] : reportUi.workerIds; }
  return payload;
}

function reportPreviewMarkup(data) {
  const cfg = S;
  const table = (headers, rows) => rows.length ? `<div class="scroll"><table><thead><tr>${headers.map((value) => `<th>${esc(value)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="empty">لا توجد حركات ضمن الاختيارات الحالية.</div>';
  const statCard = (label, value, cls = '') => `<div class="card report-stat"><div class="sub">${esc(label)}</div><b class="${cls}">${typeof value === 'number' ? money(value) : esc(value)}</b></div>`;
  let body = '';
  if (data.type === 'general') {
    const t = data.totals;
    const movementTypes = { profit: 'ربح صنف', expense: 'مصروف', withdrawal: 'سحبية عامل' };
    body = `<div class="grid c3 report-stats">${statCard('الأرباح',t.profit,'gain')}${statCard('المصروفات',t.expenses,'loss')}${statCard('السحبيات',t.withdrawals,'warn')}${statCard('صافي الفترة',t.net,t.net >= 0 ? 'gain' : 'loss')}${statCard('عدد الحركات',data.movementCount ?? data.movements?.length ?? 0)}${statCard('الكمية الإجمالية',fmtNum(t.quantity))}</div><h3>الحركة اليومية</h3>${table(['التاريخ','الأرباح','المصروفات','السحبيات','صافي اليوم'],data.daily.map((r)=>`<tr><td class="num">${esc(r.date)}</td><td>${money(r.profit)}</td><td>${money(r.expenses)}</td><td>${money(r.withdrawals)}</td><td>${money(r.net)}</td></tr>`))}<h3>تفاصيل الحركات المسجلة</h3>${table(['التاريخ','نوع الحركة','الصنف أو الجهة','الكمية','المبلغ','الوصف والملاحظات'],(data.movements || []).map((r)=>`<tr><td class="num">${esc(r.date)}</td><td>${movementTypes[r.type] || esc(r.type)}</td><td>${esc(r.party)}</td><td class="num">${r.quantity === null ? '—' : fmtNum(r.quantity)}</td><td>${money(r.amount)}</td><td>${esc([r.description,r.notes].filter(Boolean).join(' — ') || '—')}</td></tr>`))}<h3>الأرباح حسب الصنف</h3>${table(['الصنف','الكمية','الربح'],data.items.map((r)=>`<tr><td>${esc(r.name)}</td><td class="num">${fmtNum(r.qty)}</td><td>${money(r.amount)}</td></tr>`))}<h3>المصروفات حسب الفئة</h3>${table(['الفئة','الإجمالي'],data.categories.map((r)=>`<tr><td>${esc(r.name)}</td><td>${money(r.amount)}</td></tr>`))}<h3>السحبيات حسب العامل</h3>${table(['العامل','الإجمالي'],data.workers.map((r)=>`<tr><td>${esc(r.name)}</td><td>${money(r.amount)}</td></tr>`))}`;
  } else if (data.type === 'profits') {
    const t=data.totals;
    body = `<div class="grid c3 report-stats">${statCard('إجمالي الأرباح',t.amount,'gain')}${statCard('إجمالي الكميات',fmtNum(t.quantity))}${statCard('عدد الحركات',t.operationCount)}</div><h3>حسب الصنف</h3>${table(['الصنف','الكمية','الربح'],data.byItem.map((r)=>`<tr><td>${esc(r.name)}</td><td class="num">${fmtNum(r.quantity)}</td><td>${money(r.amount)}</td></tr>`))}<h3>حسب اليوم</h3>${table(['التاريخ','الكمية','الربح','عدد الحركات'],data.byDay.map((r)=>`<tr><td class="num">${esc(r.date)}</td><td class="num">${fmtNum(r.quantity)}</td><td>${money(r.amount)}</td><td class="num">${r.operationCount}</td></tr>`))}<h3>تفاصيل الحركات</h3>${table(['التاريخ','الصنف','الكمية','الربح','ملاحظات'],data.rows.map((r)=>`<tr><td class="num">${esc(r.date)}</td><td>${esc(r.itemName)}</td><td class="num">${fmtNum(r.quantity)}</td><td>${money(r.amount)}</td><td>${esc(r.notes || '—')}</td></tr>`))}`;
  } else if (data.type === 'expenses') {
    body = `<div class="grid c2 report-stats">${statCard('إجمالي المصروفات',data.totals.amount,'loss')}${statCard('عدد العمليات',data.totals.operationCount)}</div><h3>حسب الفئة</h3>${table(['الفئة','العدد','الإجمالي'],data.byCategory.map((r)=>`<tr><td>${esc(r.name)}</td><td class="num">${r.operationCount}</td><td>${money(r.amount)}</td></tr>`))}<h3>تفاصيل المصروفات</h3>${table(['التاريخ','الفئة','الوصف','المبلغ','الملاحظات'],data.rows.map((r)=>`<tr><td class="num">${esc(r.date)}</td><td>${esc(r.category)}</td><td>${esc(r.description)}</td><td>${money(r.amount)}</td><td>${esc(r.notes || '—')}</td></tr>`))}`;
  } else {
    body = `<div class="grid c2 report-stats">${statCard('إجمالي السحبيات',data.totals.amount,'warn')}${statCard('عدد السحبيات',data.totals.operationCount)}</div><h3>حسب العامل</h3>${table(['العامل','العدد','الإجمالي'],data.byWorker.map((r)=>`<tr><td>${esc(r.name)}</td><td class="num">${r.operationCount}</td><td>${money(r.amount)}</td></tr>`))}<h3>تفاصيل السحبيات</h3>${table(['التاريخ','العامل','المبلغ','الملاحظات'],data.rows.map((r)=>`<tr><td class="num">${esc(r.date)}</td><td>${esc(r.worker)}</td><td>${money(r.amount)}</td><td>${esc(r.notes || '—')}</td></tr>`))}`;
  }
  return `<section class="card report-preview"><div class="row"><div class="m"><b>معاينة: ${esc(data.title)}</b><div class="sub">${esc(data.fromDate)} إلى ${esc(data.toDate)} · معاينة قبل تصدير PDF</div></div><span class="badge gain">جاهز للمراجعة</span></div>${body}</section>`;
}

const AUDIT_ACTIONS = {
  create: 'إضافة سجل', update: 'تعديل سجل', soft_delete: 'حذف منطقي', restore: 'استعادة سجل',
  activate: 'تفعيل عنصر', deactivate: 'إيقاف عنصر', import: 'استيراد بيانات',
  backup_restore: 'استعادة نسخة احتياطية', database_move: 'نقل قاعدة البيانات', reset: 'إعادة ضبط',
  report_export: 'إنشاء ملف تقرير PDF', application_error: 'تسجيل خطأ في التطبيق',
};
const AUDIT_ENTITIES = {
  profit_transaction: 'حركة أرباح', profit_line: 'سطر ربح لصنف', expense: 'مصروف', withdrawal: 'سحبية عامل',
  item: 'صنف', worker: 'عامل', expense_category: 'فئة مصروفات', system: 'عملية نظام',
};
const AUDIT_FIELDS = {
  name: 'الاسم', item_name: 'اسم الصنف', itemName: 'اسم الصنف', worker_name_snapshot: 'اسم العامل',
  category_name_snapshot: 'فئة المصروفات', date: 'التاريخ', tx_date: 'التاريخ',
  amountMilli: 'المبلغ', amount_milli: 'المبلغ', quantityMicros: 'الكمية', quantity_micros: 'الكمية',
  description: 'الوصف', notes: 'الملاحظات', note: 'الملاحظات', active: 'الحالة', is_active: 'الحالة',
  currencyCode: 'رمز العملة', currencyLabel: 'اسم العملة', currencyDecimalPlaces: 'الخانات العشرية',
  lineCount: 'عدد الأصناف', deleted: 'حالة السجل', message: 'رسالة الخطأ', stack: 'التفاصيل التقنية للخطأ',
  source: 'مصدر الخطأ', screen: 'الشاشة', reportType: 'نوع التقرير', title: 'عنوان التقرير',
  fromDate: 'من تاريخ', toDate: 'إلى تاريخ', fileName: 'اسم الملف', bytes: 'حجم الملف بالبايت',
  value: 'القيمة',
};
function auditValue(key, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (['amountMilli','amount_milli'].includes(key) && Number.isFinite(Number(value))) return money(Number(value) / 1000);
  if (['quantityMicros','quantity_micros'].includes(key) && Number.isFinite(Number(value))) return fmtNum(Number(value) / 1000000);
  if (['active','is_active'].includes(key)) return value === true || value === 1 ? 'نشط' : 'موقوف';
  if (key === 'lines' && Array.isArray(value)) return value.map((line) => `${line.name || line.item_name || 'صنف'} — كمية ${fmtNum((line.quantityMicros ?? line.quantity_micros ?? line.qty ?? 0) / (line.quantityMicros || line.quantity_micros ? 1000000 : 1))} — ${line.amountMilli !== undefined ? money(line.amountMilli / 1000) : line.amount_milli !== undefined ? money(line.amount_milli / 1000) : line.amount !== undefined ? money(line.amount) : ''}`).join('، ');
  if (key === 'stack') return `<code class="audit-stack">${esc(value)}</code>`;
  if (typeof value === 'object') return esc(JSON.stringify(value));
  return esc(String(value));
}
function auditSnapshotMarkup(snapshot, title) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const pairs = Object.entries(snapshot).filter(([key]) => !['id','created_at','updated_at','deleted_at','transaction_id','legacy_ref_id','item_id','category_id','worker_id'].includes(key));
  if (!pairs.length) return '';
  return `<div class="audit-snapshot"><b>${title}</b><div>${pairs.map(([key,value]) => `<span><small>${esc(AUDIT_FIELDS[key] || key)}</small>${auditValue(key,value)}</span>`).join('')}</div></div>`;
}
function auditSubject(entry) {
  const details = entry.after || entry.before || {};
  if (entry.entityType === 'system' && String(entry.entityId).startsWith('setting:')) {
    const key = String(entry.entityId).slice('setting:'.length);
    const labels = { currencyCode: 'رمز العملة', currencyLabel: 'اسم العملة', currencyDecimalPlaces: 'الخانات العشرية' };
    return `إعداد ${labels[key] || key}`;
  }
  return details.name || details.item_name || details.itemName || details.category_name_snapshot || details.worker_name_snapshot || details.description || details.message || details.title || (Array.isArray(details.lines) ? details.lines.map((line) => line.name || line.item_name).filter(Boolean).join('، ') : '') || entry.entityId;
}
function auditActionText(entry) {
  const byEntity = {
    create: {
      profit_transaction: 'تسجيل حركة أرباح', profit_line: 'إضافة صنف إلى حركة أرباح',
      expense: 'تسجيل مصروف', withdrawal: 'تسجيل سحبية عامل', item: 'إضافة صنف إلى القائمة',
      worker: 'إضافة عامل', expense_category: 'إضافة فئة مصروفات', system: 'إضافة إعداد للنظام',
    },
    update: {
      profit_transaction: 'تعديل تاريخ حركة أرباح', profit_line: 'تعديل تفاصيل ربح صنف',
      expense: 'تعديل مصروف', withdrawal: 'تعديل سحبية عامل', item: 'تعديل بيانات صنف',
      worker: 'تعديل بيانات عامل', expense_category: 'تعديل فئة مصروفات', system: 'تعديل إعدادات النظام',
    },
    soft_delete: {
      profit_transaction: 'حذف حركة أرباح', profit_line: 'حذف سطر ربح',
      expense: 'حذف مصروف', withdrawal: 'حذف سحبية عامل',
    },
    activate: { item: 'تفعيل صنف', worker: 'تفعيل عامل', expense_category: 'تفعيل فئة مصروفات' },
    deactivate: { item: 'إيقاف صنف', worker: 'إيقاف عامل', expense_category: 'إيقاف فئة مصروفات' },
  };
  return byEntity[entry.op]?.[entry.entityType] || AUDIT_ACTIONS[entry.op] || 'عملية مسجلة';
}
function auditEntryMarkup(entry) {
  const action = auditActionText(entry);
  const entity = AUDIT_ENTITIES[entry.entityType] || entry.entityType;
  const details = `${entity} — ${auditSubject(entry)}`;
  const timestamp = new Date(entry.occurredAt || entry.at).toLocaleString('ar-JO-u-nu-latn');
  const before = auditSnapshotMarkup(entry.before, 'قبل العملية');
  const after = auditSnapshotMarkup(entry.after, 'بعد العملية');
  return `<details class="audit-entry"><summary><span class="audit-symbol">${ic(entry.op === 'application_error' ? 'x' : entry.op === 'soft_delete' ? 'receipt' : 'check','s')}</span><span class="audit-summary"><b>${esc(action)} — ${esc(details)}</b><small>${esc(timestamp)} · ${esc(entity)} · رقم السجل: ${esc(entry.entityId)}</small></span><span class="sub audit-chevron">التفاصيل</span></summary><div class="audit-body">${before}${after || '<div class="sub">لم تُسجل قيم لاحقة لهذه العملية.</div>'}<div class="sub">المصدر: تطبيق MowxBack المحلي · سجل للقراءة فقط</div></div></details>`;
}
function auditSearchText(entry) {
  return [AUDIT_ACTIONS[entry.op] || entry.op, AUDIT_ENTITIES[entry.entityType] || entry.entityType, entry.entityId,
    JSON.stringify(entry.before || {}), JSON.stringify(entry.after || {})].join(' ').toLocaleLowerCase();
}

async function render() {
  if (!S) return;
  const sequence = ++renderSequence;
  if (page === 'settings') {
    try { diagnosticStatus = await Store.diagnosticStatus(); }
    catch (error) { diagnosticStatus = { enabled: false, fileCount: 0, directory: 'تعذر قراءة الحالة', retentionDays: 14 }; console.error('Diagnostic status unavailable:', error); }
    try { telegramStatus = await Store.telegramStatus(); }
    catch (error) { telegramStatus = { enabled: false, configured: false, active: false, workers: [], notifications: [], error: error.message }; }
    if (sequence !== renderSequence) return;
  }
  if (page === 'reports') {
    try {
      if (!reportOptionsData) reportOptionsData = await Store.reportOptions();
    } catch (error) {
      if (sequence === renderSequence) $('view').innerHTML = `<div class="empty loss">تعذر تحميل خيارات التقارير من SQLite: ${esc(error.message)}</div>`;
      return;
    }
    if (sequence !== renderSequence) return;
  }
  const current = PAGES.find((entry) => entry[0] === page) || PAGES[0];
  $('pageTitle').textContent = current[1];
  $('pageDate').textContent = fmtDate(todayStr());
  const views = {
    home: V.home, ledger: V.ledger, profits: () => V.list('profit'),
    expenses: () => V.list('expense'), withdrawals: () => V.list('withdrawal'),
    reports: V.reports, items: () => V.mgmt('items'), workers: () => V.mgmt('workers'),
    cats: () => V.mgmt('cats'), settings: V.settings,
  };
  try { $('view').innerHTML = (views[page] || V.home)(); }
  catch (error) { console.error(error); $('view').innerHTML = '<div class="empty loss">تعذر عرض الصفحة</div>'; }
  $('side').innerHTML = '<div class="logo">MowxBack</div>' + PAGES.map((entry) => `<button data-go="${entry[0]}" class="${entry[0] === page ? 'on' : ''}">${ic(entry[2])}${entry[1]}</button>`).join('');
  const active = MAIN.includes(page) ? page : 'more';
  $('bottom').innerHTML = MAIN.map((key) => { const entry = PAGES.find((item) => item[0] === key); return `<button data-go="${key}" class="${active === key ? 'on' : ''}">${ic(entry[2])}${entry[1]}</button>`; }).join('') + `<button data-act="more" class="${active === 'more' ? 'on' : ''}">${ic('menu')}المزيد</button>`;
  $('status').innerHTML = `<span class="pill ok">${ic('check', 's')} SQLite محلي</span><span>الحفظ على هذا الجهاز</span>`;
}

async function refreshState() {
  S = await Store.load();
  reportOptionsData = null;
  await render();
}
function diag(event, details = {}) { Store.diagnosticLog({ event, details: { screen: page, ...details } }).catch((error) => console.error('Diagnostic logging failed:', error)); }
function go(nextPage) { diag('navigation', { to: nextPage }); page = nextPage; q = ''; closeM('navigation'); render(); window.scrollTo(0, 0); }
function closeM(reason = 'programmatic') { const modal = $('modal'); if (!modal.hidden) diag('modal-close', { reason, modal: modal.querySelector('[role=dialog]')?.getAttribute('aria-label') || 'dialog' }); modal.hidden = true; modal.innerHTML = ''; }
function showError(error) {
  console.error(error);
  const message = error?.message ? String(error.message).slice(0, 1500) : 'حدث خطأ غير محدد.';
  const stack = String(error?.stack || '').slice(0, 8000);
  toast(`تعذر تنفيذ العملية: ${message}`, 'err');
  Store.logApplicationError({ screen: page, message, stack, source: 'renderer-caught-error' })
    .catch((logError) => console.error('تعذر تسجيل الخطأ:', logError));
}

window.addEventListener('error', (event) => {
  const error = event.error;
  Store.logApplicationError({
    screen: page, message: String(event.message || error?.message || 'خطأ غير معالج في الواجهة').slice(0, 1500),
    stack: String(error?.stack || '').slice(0, 8000), source: 'renderer-uncaught-error',
  }).catch((logError) => console.error('تعذر تسجيل خطأ الواجهة:', logError));
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  Store.logApplicationError({
    screen: page, message: String(reason?.message || reason || 'رفض Promise غير معالج').slice(0, 1500),
    stack: String(reason?.stack || '').slice(0, 8000), source: 'renderer-unhandled-rejection',
  }).catch((logError) => console.error('تعذر تسجيل رفض Promise:', logError));
});
function backupCard(runtime) {
  const folder = runtime.backupDirectory;
  return `<h2>قاعدة البيانات والنسخ الاحتياطي</h2><div class="card"><div class="sub" style="margin-bottom:12px">ملف SQLite محفوظ خارج مجلد تثبيت البرنامج. مجلد النسخ الاحتياطي مستقل عن مجلد قاعدة البيانات.</div><div class="row"><div class="m"><div class="s">موقع قاعدة البيانات</div><div class="d">${esc(runtime.databasePath || 'غير محدد')}</div></div><button class="btn" data-act="dbfolder">تغيير المجلد</button></div><div class="row"><div class="m"><div class="s">مجلد النسخ الاحتياطي</div><div class="d">${folder ? esc(folder) : 'لم يُحدد مجلد'}</div></div></div><div class="btns"><button class="btn p" data-act="bpick">${folder ? 'تغيير مجلد النسخ' : 'اختيار مجلد النسخ'}</button>${folder ? '<button class="btn" data-act="bdel">إزالة اختيار المجلد</button><button class="btn" data-act="bsave">حفظ نسخة في المجلد</button>' : ''}<button class="btn" data-act="bdl">حفظ نسخة باسم...</button><button class="btn" data-act="brestore">استعادة نسخة SQLite</button><button class="btn" data-act="bimport">استيراد JSON قديم</button><button class="btn" data-act="bjson">تصدير JSON</button><button class="btn" data-act="bintegrity">فحص سلامة القاعدة</button></div><div class="sub" style="margin-top:8px">النسخ الاحتياطي التلقائي اليومي غير مفعل في هذا الإصدار.</div></div>`;
}

function form(title, fields, values, onSave) {
  diag('modal-open', { modal: title });
  $('modal').hidden = false;
  $('modal').innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(title)}"><h3>${esc(title)}</h3><div id="ff">${fields.map((field) => `<label class="fld">${field.l}${field.t === 'select' ? `<select name="${field.k}">${field.o.map((option) => `<option value="${esc(option[0])}"${option[0] === values[field.k] ? ' selected' : ''}>${esc(option[1])}</option>`).join('')}</select>` : field.t === 'area' ? `<textarea name="${field.k}">${esc(values[field.k] || '')}</textarea>` : `<input name="${field.k}" type="${field.t || 'text'}" ${field.t === 'number' ? 'step="any" min="0" inputmode="decimal"' : ''} value="${esc(values[field.k] ?? '')}">`}<span class="err" data-e="${field.k}"></span></label>`).join('')}</div><div class="btns" style="grid-template-columns:1fr 1fr"><button class="btn p" id="fs">حفظ</button><button class="btn" id="fc">إلغاء</button></div></div>`;
  $('fc').onclick = () => closeM('cancel-button');
  $('fs').onclick = async () => {
    const data = {};
    let valid = true;
    fields.forEach((field) => {
      const element = document.querySelector(`[name="${field.k}"]`);
      data[field.k] = element.value.trim();
      const errorElement = document.querySelector(`[data-e="${field.k}"]`);
      errorElement.textContent = '';
      if (field.r && !data[field.k]) { errorElement.textContent = 'هذا الحقل مطلوب'; valid = false; }
      else if (field.t === 'number' && data[field.k] && !(Number(data[field.k]) > 0)) { errorElement.textContent = 'أدخل رقماً أكبر من صفر'; valid = false; }
    });
    if (!valid) return;
    try { await onSave(data); } catch (error) { showError(error); }
  };
}

function txForm(transaction) {
  const isNew = !transaction.id;
  const type = transaction.type;
  if (type === 'profit') return profitMulti(transaction.date || todayStr());
  const refs = type === 'withdrawal' ? S.workers : S.cats;
  const options = refs.filter((item) => item.active || item.id === transaction.refId).map((item) => [item.id, item.name]);
  if (!options.length) { toast('أضف عنصراً نشطاً من الإدارة أولاً', 'err'); return; }
  const fields = [
    { k: 'date', l: 'التاريخ', t: 'date', r: true },
    { k: 'refId', l: type === 'withdrawal' ? 'العامل' : 'التصنيف', t: 'select', o: options, r: true },
    { k: 'amount', l: type === 'expense' ? 'المبلغ' : 'المبلغ', t: 'number', r: true },
  ];
  if (type === 'expense') fields.push({ k: 'desc', l: 'الوصف', r: true });
  fields.push({ k: 'note', l: 'ملاحظات (اختياري)', t: 'area' });
  form(`${isNew ? 'إضافة ' : 'تعديل '}${TYPE[type][0]}`, fields, transaction, async (values) => {
    const payload = { date: values.date, refId: values.refId, amount: values.amount, desc: values.desc || '', note: values.note || '' };
    if (isNew) {
      if (type === 'expense') await Store.createExpense(payload);
      else await Store.createWithdrawal(payload);
    } else if (type === 'expense') await Store.updateExpense({ id: transaction.id, patch: payload });
    else await Store.updateWithdrawal({ id: transaction.id, patch: payload });
    closeM(); await refreshState(); toast(isNew ? 'تمت الإضافة' : 'تم حفظ التعديل');
  });
}

function catalogForm(kind, item) {
  const isNew = !item;
  const fields = [{ k: 'name', l: 'الاسم', r: true }];
  if (kind === 'workers') fields.push({ k: 'phone', l: 'رقم الهاتف (اختياري — يفضّل مع رمز الدولة)', t: 'tel' });
  form(isNew ? 'إضافة' : 'تعديل', fields, item || {}, async (values) => {
    if ((S[kind] || []).some((entry) => entry.name.trim() === values.name && (!item || entry.id !== item.id))) {
      toast('الاسم موجود مسبقاً', 'err'); return;
    }
    await Store.saveCatalog({ kind, id: item?.id, name: values.name, phone: values.phone || '' });
    closeM(); await refreshState(); toast('تم الحفظ');
  });
}

function lineEdit(transaction, line) {
  form('تعديل صنف', [
    { k: 'name', l: 'اسم الصنف', r: true },
    { k: 'qty', l: 'الكمية', t: 'number', r: true },
    { k: 'amount', l: 'إجمالي الربح', t: 'number', r: true },
    { k: 'note', l: 'ملاحظات (اختياري)', t: 'area' },
  ], line, async (values) => {
    if (!normName(values.name)) { toast('أدخل اسم الصنف', 'err'); return; }
    await Store.updateProfitLine({ transactionId: transaction.id, lineId: line.id, patch: {
      name: normName(values.name), qty: values.qty, amount: values.amount, note: values.note,
    } });
    closeM(); await refreshState(); toast('تم حفظ التعديل');
    const latest = S.tx.find((entry) => entry.id === transaction.id);
    if (latest) profitDetail(latest.id);
  });
  attachSuggest(document.querySelector('#ff [name="name"]'));
}

function profitDetail(id) {
  diag('modal-open', { modal: 'profit-details' });
  const transaction = S.tx.find((entry) => entry.id === id);
  if (!transaction || transaction.void || !transaction.lines) { closeM(); return; }
  $('modal').hidden = false;
  $('modal').innerHTML = `<div class="sheet" style="max-width:640px"><h3>تفاصيل حركة أرباح</h3><div class="sub"><label class="fld">التاريخ<input type="date" id="pdDate" value="${transaction.date}"></label><button class="btn" id="pdDateSave">حفظ التاريخ</button></div><div class="scroll"><table style="min-width:420px"><thead><tr><th>الصنف</th><th>الكمية</th><th>إجمالي الربح</th><th>الإجراءات</th></tr></thead><tbody>${aLines(transaction).map((line) => `<tr><td>${esc(line.name)}${line.note ? `<div class="s">${esc(line.note)}</div>` : ''}</td><td><span class="num">${fmtNum(line.qty)}</span></td><td><b class="gain">${money(line.amount)}</b></td><td style="white-space:nowrap"><button class="btn i" data-le="${esc(line.id)}" aria-label="تعديل ${esc(line.name)}">${ic('pencil')}</button> <button class="btn i" data-ld="${esc(line.id)}" aria-label="حذف ${esc(line.name)}">${ic('x')}</button></td></tr>`).join('')}</tbody></table></div><div class="row"><b class="m">إجمالي أرباح الحركة</b><b class="gain" style="font-size:20px">${money(transaction.amount)}</b></div><div class="btns"><button class="btn" data-act="pddelete" data-id="${esc(transaction.id)}">حذف الحركة</button><button class="btn" id="pdClose">إغلاق</button></div></div>`;
  $('pdClose').onclick = () => closeM('close-button');
  $('pdDateSave').onclick = async () => {
    try {
      await Store.updateProfitDate({ id: transaction.id, date: $('pdDate').value });
      closeM(); await refreshState(); toast('تم تحديث تاريخ الحركة');
      const latest = S.tx.find((entry) => entry.id === transaction.id); if (latest) profitDetail(latest.id);
    } catch (error) { showError(error); }
  };
  $('modal').querySelectorAll('[data-le]').forEach((button) => {
    button.onclick = () => lineEdit(transaction, transaction.lines.find((line) => line.id === button.dataset.le));
  });
  $('modal').querySelectorAll('[data-ld]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('حذف هذا الصنف من الحركة؟ يبقى أثره في سجل التغييرات.')) return;
      try {
        await Store.deleteProfitLine({ transactionId: transaction.id, lineId: button.dataset.ld });
        closeM(); await refreshState(); toast('تم حذف الصنف');
        const latest = S.tx.find((entry) => entry.id === transaction.id); if (latest) profitDetail(latest.id);
      } catch (error) { showError(error); }
    };
  });
}

function prow(transaction) {
  const lines = aLines(transaction);
  return `<div class="row"><span class="gain">${ic('up', 'l')}</span><div class="m"><div class="d">${lines.length === 1 ? esc(lines[0].name) : 'حركة أرباح أصناف'}</div><div class="s">عدد الأصناف <span class="num">${lines.length}</span> · الكمية <span class="num">${fmtNum(transaction.qty)}</span> · <span class="num">${transaction.date}</span></div></div><b class="gain">+${money(transaction.amount)}</b><button class="btn" data-act="detail" data-id="${esc(transaction.id)}">عرض التفاصيل</button></div>`;
}

function profitMulti(date) {
  diag('modal-open', { modal: 'profit-entry' });
  let rows = [];
  let edit = -1;
  let current = { name: '', qty: '', amount: '', note: '' };
  let saving = false;
  const total = () => rows.reduce((sum, item) => sum + item.amount, 0);
  const value = (name) => document.querySelector(`#pm [name="${name}"]`);
  const error = (key, message) => { const element = document.querySelector(`#pm [data-e="${key}"]`); if (element) element.textContent = message || ''; };
  const readRow = () => {
    date = value('date').value;
    ['date', 'name', 'qty', 'amount'].forEach((key) => error(key, ''));
    let valid = true;
    if (!date) { error('date', 'هذا الحقل مطلوب'); valid = false; }
    const quantity = Number(value('qty').value);
    const amount = Number(value('amount').value);
    if (!(quantity > 0)) { error('qty', 'أدخل كمية أكبر من صفر'); valid = false; }
    if (!(amount > 0)) { error('amount', 'أدخل رقماً أكبر من صفر'); valid = false; }
    const name = normName(value('name').value);
    if (!name) { error('name', 'أدخل اسم الصنف'); valid = false; }
    return valid ? { id: rows[edit]?.id || undefined, name, qty: quantity, amount, note: value('note').value.trim() } : null;
  };
  const commit = () => {
    const line = readRow();
    if (!line) return false;
    if (edit >= 0) rows[edit] = line; else rows.push(line);
    edit = -1; current = { name: '', qty: '', amount: '', note: '' };
    return true;
  };
  const draw = () => {
    $('modal').hidden = false;
    $('modal').innerHTML = `<div class="sheet" id="pm" role="dialog" aria-label="إضافة أرباح أصناف" style="max-width:640px"><h3>إضافة أرباح أصناف</h3><label class="fld">التاريخ<input name="date" type="date" value="${date}"><span class="err" data-e="date"></span></label><label class="fld">اسم الصنف<input name="name" type="text" value="${esc(current.name)}" placeholder="اكتب اسم الصنف" autocomplete="off"><span class="err" data-e="name"></span></label><div class="grid c2"><label class="fld">الكمية<input name="qty" type="number" step="any" min="0" inputmode="decimal" value="${esc(current.qty)}"><span class="err" data-e="qty"></span></label><label class="fld">إجمالي الربح<input name="amount" type="number" step="any" min="0" inputmode="decimal" value="${esc(current.amount)}"><span class="err" data-e="amount"></span></label></div><label class="fld">ملاحظات (اختياري)<textarea name="note">${esc(current.note)}</textarea></label><div class="btns" style="grid-template-columns:1fr${edit >= 0 ? ' 1fr' : ''};margin-bottom:16px"><button class="btn" id="pmAdd">${ic(edit >= 0 ? 'check' : 'plus')} ${edit >= 0 ? 'تحديث الصنف' : 'إضافة إلى القائمة'}</button>${edit >= 0 ? '<button class="btn" id="pmCancel">إلغاء التعديل</button>' : ''}</div><div class="scroll"><table style="min-width:420px"><thead><tr><th>الصنف</th><th>الكمية</th><th>إجمالي الربح</th><th>الإجراءات</th></tr></thead><tbody>${rows.length ? rows.map((line, index) => `<tr><td>${esc(line.name)}${line.note ? `<div class="s">${esc(line.note)}</div>` : ''}</td><td><span class="num">${fmtNum(line.qty)}</span></td><td><b class="gain">${money(line.amount)}</b></td><td style="white-space:nowrap"><button class="btn i" data-pe="${index}" aria-label="تعديل ${esc(line.name)}">${ic('pencil')}</button> <button class="btn i" data-pr="${index}" aria-label="إزالة ${esc(line.name)}">${ic('x')}</button></td></tr>`).join('') : '<tr><td colspan="4" class="empty">لم تُضف أصناف بعد</td></tr>'}</tbody></table></div><div class="row"><b class="m">إجمالي أرباح جميع الأصناف (<span class="num">${rows.length}</span>)</b><b class="gain" style="font-size:20px">${money(total())}</b></div><div class="btns" style="grid-template-columns:1fr 1fr;margin-top:12px"><button class="btn p" id="pmSave">حفظ جميع الأصناف</button><button class="btn" id="pmClose">إلغاء</button></div></div>`;
    attachSuggest(value('name'));
    value('date').onchange = () => { date = value('date').value; };
    $('pmClose').onclick = () => closeM('cancel-button');
    if ($('pmCancel')) $('pmCancel').onclick = () => { edit = -1; current = { name: '', qty: '', amount: '', note: '' }; draw(); };
    $('pmAdd').onclick = () => { if (commit()) draw(); };
    $('modal').querySelectorAll('[data-pe]').forEach((button) => {
      button.onclick = () => { date = value('date').value; edit = Number(button.dataset.pe); const line = rows[edit]; current = { name: line.name, qty: line.qty, amount: line.amount, note: line.note }; draw(); };
    });
    $('modal').querySelectorAll('[data-pr]').forEach((button) => {
      button.onclick = () => { date = value('date').value; const index = Number(button.dataset.pr); rows.splice(index, 1); if (edit === index) { edit = -1; current = { name: '', qty: '', amount: '', note: '' }; } else if (edit > index) edit -= 1; draw(); };
    });
    $('pmSave').onclick = async () => {
      if (saving) return;
      date = value('date').value; error('date', '');
      if (!date) { error('date', 'هذا الحقل مطلوب'); return; }
      if (value('qty').value || value('amount').value || edit >= 0) { if (!commit()) return; }
      if (!rows.length) { toast('أضف صنفاً واحداً على الأقل', 'err'); return; }
      saving = true; $('pmSave').disabled = true;
      try {
        await Store.saveProfit({ date, lines: rows.map((line) => ({ ...line, id: line.id || uid() })) });
        const count = rows.length; closeM(); await refreshState(); toast(`تم حفظ حركة تحتوي ${count} من الأصناف`);
      } catch (errorValue) { saving = false; $('pmSave').disabled = false; showError(errorValue); }
    };
  };
  draw();
}

function attachSuggest(input) {
  if (!input) return;
  const box = document.createElement('div');
  box.className = 'sugbox'; box.hidden = true; box.setAttribute('role', 'listbox');
  input.insertAdjacentElement('afterend', box);
  input.setAttribute('autocomplete', 'off');
  let items = []; let highlight = -1; let requestNumber = 0;
  const close = () => { box.hidden = true; box.innerHTML = ''; items = []; highlight = -1; };
  const pick = (name) => { input.value = name; close(); input.focus(); };
  const paint = () => [...box.children].forEach((child, index) => child.classList.toggle('on', index === highlight));
  const open = async () => {
    const query = input.value;
    if (normName(query).length < 2) { close(); return; }
    const request = ++requestNumber;
    try {
      const suggestions = await Store.searchNames(query);
      if (request !== requestNumber || input.value !== query) return;
      items = suggestions;
      if (!items.length) { close(); return; }
      box.innerHTML = items.map((name, index) => `<div class="sug" role="option" data-i="${index}">${esc(name)}</div>`).join('');
      box.hidden = false; highlight = -1;
    } catch (error) { console.error('Name suggestions unavailable:', error); close(); }
  };
  input.addEventListener('input', open);
  input.addEventListener('keydown', (event) => {
    if (box.hidden) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); highlight = (highlight + 1) % items.length; paint(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); highlight = (highlight - 1 + items.length) % items.length; paint(); }
    else if (event.key === 'Enter' && highlight >= 0) { event.preventDefault(); pick(items[highlight]); }
    else if (event.key === 'Escape') { event.stopPropagation(); close(); }
  });
  box.addEventListener('mousedown', (event) => { const element = event.target.closest('.sug'); if (element) { event.preventDefault(); pick(items[Number(element.dataset.i)]); } });
  document.addEventListener('mousedown', function outside(event) { if (!document.body.contains(input)) { document.removeEventListener('mousedown', outside); return; } if (event.target !== input && !box.contains(event.target)) close(); });
}

async function deleteTransaction(transaction) {
  if (!transaction) return;
  const typeName = TYPE[transaction.type][0];
  if (!confirm(`تأكيد حذف ${typeName}؟ سيُحتفظ بسجل التغيير.`)) return;
  if (transaction.type === 'expense') await Store.deleteExpense({ id: transaction.id });
  else if (transaction.type === 'withdrawal') await Store.deleteWithdrawal({ id: transaction.id });
  else await Store.deleteProfit({ id: transaction.id });
  closeM(); await refreshState(); toast('تم الحذف المنطقي للعملية');
}

function csv() {
  const report = rep.cur;
  if (!report) return;
  const rows = [['النوع', 'التاريخ', 'اسم الصنف/الجهة', 'الكمية', 'المبلغ', 'الوصف/الملاحظات']];
  const typeNames = { profit: 'ربح صنف', expense: 'مصروف', withdrawal: 'سحبية' };
  report.transactions.forEach((transaction) => {
    if (transaction.type === 'profit') transaction.lines.forEach((line) => rows.push([typeNames.profit, transaction.date, line.name, line.qty, line.amount, line.note]));
    else rows.push([typeNames[transaction.type], transaction.date, transaction.name, '', transaction.amount, transaction.desc || transaction.note]);
  });
  const totals = report.totals;
  rows.push([], ['إجمالي الأرباح', '', '', totals.qty, totals.profit], ['إجمالي المصروفات (تشمل السحبيات)', '', '', '', totals.totalExp], ['منها سحبيات', '', '', '', totals.wd], ['صافي النتيجة', '', '', '', totals.net]);
  try {
    const content = '\ufeff' + rows.map((rowValues) => rowValues.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `mowxback-${report.from}_${report.to}.csv`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); toast('تم التصدير');
  } catch (error) { showError(error); }
}

async function runBackupAction(action) {
  let result;
  if (action === 'dbfolder') result = await Backup.chooseDatabaseFolder();
  else if (action === 'bpick') result = await Backup.chooseFolder();
  else if (action === 'bdel') result = await Backup.clearFolder();
  else if (action === 'bsave') result = await Backup.create();
  else if (action === 'bdl') result = await Backup.saveAs();
  else if (action === 'brestore') result = await Backup.restore();
  else if (action === 'bimport') result = await Backup.importJson();
  else if (action === 'bjson') result = await Backup.exportJson();
  else if (action === 'bintegrity') result = await Backup.integrity();
  if (result?.canceled) return;
  if (action === 'bimport') {
    toast(`اكتمل الاستيراد: ${JSON.stringify(result.counts || {})}`);
  } else if (action === 'bintegrity') {
    toast(result.ok ? 'قاعدة البيانات سليمة' : 'فشل فحص سلامة قاعدة البيانات', result.ok ? 'ok' : 'err');
  } else if (action === 'brestore') toast('تمت استعادة النسخة الاحتياطية');
  else if (action === 'bsave' || action === 'bdl') toast('تم إنشاء النسخة الاحتياطية');
  else if (action === 'bimport') toast('تم استيراد البيانات');
  else if (action === 'bjson') toast('تم تصدير JSON');
  else if (action === 'bpick') toast('تم تحديد مجلد النسخ');
  else if (action === 'bdel') toast('تمت إزالة مجلد النسخ');
  await refreshState();
}

document.addEventListener('click', async (event) => {
  const removeItem = event.target.closest('[data-report-remove]');
  if (removeItem) { reportUi.itemNames = reportUi.itemNames.filter((name) => name !== removeItem.dataset.reportRemove); reportUi.preview = null; await render(); return; }
  const element = event.target.closest('[data-act],[data-go]');
  if (!element) return;
  if (element.dataset.go) { go(element.dataset.go); return; }
  const { act, type, date, id, k } = element.dataset;
  if (act && !['report-item-search'].includes(act)) diag('ui-action', { action: act, entityType: type || k || undefined });
  try {
    if (act === 'add') txForm({ type, date, refId: '', amount: '', qty: '', desc: '', note: '' });
    else if (act === 'edit') { const transaction = S.tx.find((entry) => entry.id === id); if (transaction) txForm(transaction); }
    else if (act === 'delete') await deleteTransaction(S.tx.find((entry) => entry.id === id));
    else if (act === 'madd') catalogForm(k);
    else if (act === 'medit') catalogForm(k, S[k].find((entry) => entry.id === id));
    else if (act === 'mtog') {
      const item = S[k].find((entry) => entry.id === id);
      await Store.setCatalogActive({ kind: k, id, active: !item.active });
      await refreshState(); toast(item.active ? 'تم الإيقاف' : 'تم التفعيل');
    } else if (act === 'cats') go('cats');
    else if (act === 'detail') profitDetail(id);
    else if (act === 'pddelete') await deleteTransaction(S.tx.find((entry) => entry.id === id));
    else if (['dbfolder', 'bpick', 'bdel', 'bsave', 'bdl', 'brestore', 'bimport', 'bjson', 'bintegrity'].includes(act)) await runBackupAction(act);
    else if (act === 'cur') {
      const code = $('curCode').value; const label = $('cur').value.trim();
      if (code === 'custom' && !label) { toast('أدخل اسم العملة', 'err'); return; }
      await Store.setCurrency({ code, label }); await refreshState(); toast('تم تغيير العملة');
    } else if (act === 'more') {
      diag('modal-open', { modal: 'more-menu' });
      $('modal').hidden = false;
      $('modal').innerHTML = `<div class="sheet"><h3>المزيد</h3><div class="grid">${PAGES.filter((entry) => !MAIN.includes(entry[0])).map((entry) => `<button class="btn" data-go="${entry[0]}">${ic(entry[2])}${entry[1]}</button>`).join('')}<button class="btn" id="fc2">إغلاق</button></div></div>`;
      $('fc2').onclick = () => closeM('close-button');
    } else if (act === 'telegram-verify') {
      const result = await Store.verifyTelegramToken({ token: $('telegramToken')?.value || '' });
      toast(result.hasWebhook ? `الرمز صحيح (@${result.username}) لكن يوجد Webhook يحتاج إلى إزالته` : `الرمز صحيح — @${result.username}` , result.hasWebhook ? 'err' : 'ok');
    } else if (act === 'telegram-save-token') {
      const token = $('telegramToken')?.value || '';
      if (!token.trim()) throw new Error('أدخل Bot Token أولاً.');
      telegramStatus = await Store.saveTelegramToken({ token });
      if ($('telegramToken')) $('telegramToken').value = '';
      S = await Store.load(); await render(); toast('تم حفظ البوت وتفعيل إشعارات Telegram');
    } else if (act === 'telegram-enable') {
      telegramStatus = await Store.setTelegramEnabled({ enabled: true }); S = await Store.load(); await render(); toast('تم تفعيل إشعارات Telegram');
    } else if (act === 'telegram-disable') {
      if (!confirm('سيتم إيقاف الإشعارات وإلغاء الرسائل المعلقة. هل تريد المتابعة؟')) return;
      telegramStatus = await Store.setTelegramEnabled({ enabled: false }); S = await Store.load(); await render(); toast('تم تعطيل إشعارات Telegram');
    } else if (act === 'telegram-disconnect') {
      if (!confirm('سيتم حذف Bot Token المحفوظ وفصل جميع العمال وإلغاء الإشعارات المعلقة. هل تريد المتابعة؟')) return;
      telegramStatus = await Store.disconnectTelegram(); S = await Store.load(); await render(); toast('تم فصل البوت وحذف بيانات اعتماده وربط العمال');
    } else if (act === 'telegram-save-business') {
      telegramStatus = await Store.saveTelegramBusinessName({ name: $('telegramBusinessName')?.value || '' }); await render(); toast('تم حفظ اسم المنشأة');
    } else if (act === 'telegram-test-message') {
      const workerId = $('telegramTestWorker')?.value || ''; if (!workerId) throw new Error('اختر عاملاً مرتبطاً أولاً.');
      await Store.sendTelegramTestMessage({ workerId }); toast('تم إرسال الرسالة الاختبارية');
    } else if (act === 'telegram-copy') {
      await Store.copyTelegramLink({ workerId: id }); toast('تم نسخ رابط الربط. صلاحيته 10 دقائق.'); await refreshState();
    } else if (act === 'telegram-whatsapp') {
      await Store.openTelegramWhatsApp({ workerId: id }); toast('تم فتح محادثة WhatsApp مع رسالة جاهزة؛ اضغط إرسال من WhatsApp.');
    } else if (act === 'telegram-qr') {
      const result = await Store.showTelegramQr({ workerId: id });
      $('modal').hidden = false; $('modal').innerHTML = `<div class="sheet telegram-qr-sheet" role="dialog" aria-label="رمز ربط Telegram"><h3>ربط العامل عبر QR</h3><p class="sub">${esc(result.workerName)}</p><img class="telegram-qr-image" alt="رمز QR لرابط Telegram" src="${result.dataUrl}"><p class="sub">وجّه كاميرا الهاتف إلى الرمز لفتح البوت، ثم اضغط Start.</p><p class="sub">تنتهي صلاحية الرابط: ${new Date(result.expiresAt).toLocaleTimeString('ar-JO')}</p><button class="btn" id="telegramQrClose">إغلاق</button></div>`;
      $('telegramQrClose').onclick = () => closeM('close-button');
    } else if (act === 'telegram-manage') {
      const worker = S.workers.find((entry) => entry.id === id); const link = worker?.telegram || {};
      $('modal').hidden = false; $('modal').innerHTML = `<div class="sheet" role="dialog" aria-label="إدارة ربط Telegram"><h3>إدارة ربط Telegram</h3><p><b>${esc(worker?.name || '')}</b></p><p class="sub">الحالة: مرتبط${link.username ? ` · @${esc(link.username)}` : ''}</p><p class="sub">تاريخ الربط: ${link.linkedAt ? esc(new Date(link.linkedAt).toLocaleString('ar-JO')) : 'غير متاح'}</p><div class="btns"><button class="btn p" id="telegramRelink">إعادة ربط الحساب</button><button class="btn" id="telegramUnlink">فصل الربط</button><button class="btn" id="telegramManageClose">إغلاق</button></div></div>`;
      $('telegramManageClose').onclick = () => closeM('close-button');
      $('telegramUnlink').onclick = async () => { if (!confirm('هل تريد فصل حساب Telegram عن هذا العامل؟')) return; await Store.unlinkTelegramWorker({ workerId: id }); closeM(); await refreshState(); toast('تم فصل حساب Telegram'); };
      $('telegramRelink').onclick = async () => { if (!confirm('سيتم فصل الحساب الحالي وإنشاء رابط ربط جديد. هل تريد المتابعة؟')) return; await Store.unlinkTelegramWorker({ workerId: id }); await refreshState(); const qrResult = await Store.showTelegramQr({ workerId: id }); $('modal').hidden = false; $('modal').innerHTML = `<div class="sheet telegram-qr-sheet" role="dialog" aria-label="إعادة ربط Telegram"><h3>إعادة ربط Telegram</h3><p class="sub">${esc(qrResult.workerName)}</p><img class="telegram-qr-image" alt="رمز QR لرابط Telegram" src="${qrResult.dataUrl}"><p class="sub">امسح الرمز من هاتف العامل ثم اضغط Start.</p><button class="btn" id="telegramQrClose">إغلاق</button></div>`; $('telegramQrClose').onclick = () => closeM('close-button'); };
    } else if (act === 'telegram-retry') {
      const result = await Store.retryTelegramNotification({ id }); if (!result.queued) throw new Error('لم يعد الإشعار قابلاً لإعادة المحاولة.');
      telegramStatus = await Store.telegramStatus(); await render(); toast('تمت إعادة الإشعار إلى قائمة الإرسال');
    } else if (act === 'report-type') { reportUi.type = type; reportUi.preview = null; await render(); }
    else if (act === 'report-preview') {
      const payload = reportPayload();
      if (reportUi.type === 'profits' && !reportUi.allItems && !reportUi.itemNames.length) throw new Error('اختر صنفاً واحداً على الأقل أو اختر جميع الأصناف.');
      if (reportUi.type === 'expenses' && !reportUi.allCategories && !reportUi.categoryIds.length) throw new Error('اختر فئة واحدة على الأقل أو فعّل جميع الفئات.');
      if (reportUi.type === 'withdrawals' && !reportUi.allWorkers && !reportUi.workerIds.length) throw new Error('اختر عاملاً واحداً على الأقل أو فعّل جميع العمال.');
      reportUi.preview = await Store.customReport(payload); await render(); toast('تم تجهيز معاينة التقرير');
    } else if (act === 'report-pdf') {
      if (!reportUi.preview) throw new Error('اعرض المعاينة أولاً قبل إنشاء ملف PDF.');
      const result = await Store.exportReportPdf(reportPayload());
      if (!result.canceled) { await refreshState(); toast('تم حفظ ملف PDF بنجاح'); }
    } else if (act === 'diag-open') {
      const result = await Store.openDiagnosticFolder(); if (result?.error) throw new Error(result.error); toast('تم فتح مجلد السجلات');
    } else if (act === 'diag-export') {
      const result = await Store.exportDiagnosticLogs(); if (!result?.canceled) toast('تم تصدير ملف السجلات');
    } else if (act === 'report-select-visible') {
      const query = reportItemSearch.trim().toLocaleLowerCase();
      const visible = (reportOptionsData?.items || []).filter((item) => item.name.toLocaleLowerCase().includes(query)).map((item) => item.value);
      reportUi.itemNames = [...new Set([...reportUi.itemNames, ...visible])]; reportUi.preview = null; await render();
    } else if (act === 'report-clear-items') {
      reportUi.itemNames = []; reportUi.preview = null; await render();
    } else if (act === 'audit-more') {
      if (auditLoading) return;
      auditLoading = true; await render();
      try {
        const result = await Store.auditLog({ limit: 100, offset: S.log.length, search: auditQuery });
        S.log.push(...result.items); S.auditLogCount = result.total;
      } finally { auditLoading = false; }
      await render();
    } else if (act === 'pdf') window.print();
    else if (act === 'xls') csv();
  } catch (error) { showError(error); }
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.id === 'dayIn' && target.value) { day = target.value; await render(); }
  else if (target.dataset.rng) { rng[target.dataset.rng] = target.value; await render(); }
  else if (target.id === 'repKind') { rep.kind = target.value; await render(); }
  else if (target.dataset.rep) { rep[target.dataset.rep] = target.value; await render(); }
  else if (target.id === 'reportPeriod') { reportUi.period = target.value; reportUi.preview = null; await render(); }
  else if (target.id === 'reportDay') { reportUi.day = target.value; reportUi.preview = null; await render(); }
  else if (target.id === 'reportMonth') { reportUi.month = target.value; reportUi.preview = null; await render(); }
  else if (target.id === 'reportFrom') { reportUi.from = target.value; reportUi.preview = null; await render(); }
  else if (target.id === 'reportTo') { reportUi.to = target.value; reportUi.preview = null; await render(); }
  else if (target.dataset.reportChoice) {
    const key = target.dataset.reportChoice;
    reportUi[key] = target.checked ? [...new Set([...reportUi[key], target.value])] : reportUi[key].filter((value) => value !== target.value);
    reportUi.preview = null; await render();
  }
  else if (target.dataset.reportAll) { reportUi[target.dataset.reportAll] = target.checked; reportUi.preview = null; await render(); }
  else if (target.name === 'reportItemMode') { reportUi.allItems = target.value === 'all'; reportUi.preview = null; await render(); }
  else if (target.id === 'diagRetention') { try { const result = await Store.setDiagnosticRetention({ days: Number(target.value) }); diagnosticStatus = result; await render(); toast('تم تحديث مدة الاحتفاظ بالسجلات'); } catch (error) { showError(error); } }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'reportItemSearch') {
    reportItemSearch = event.target.value;
    const position = event.target.selectionStart;
    render().then(() => { const input = $('reportItemSearch'); if (input) { input.focus(); input.setSelectionRange(position, position); } });
  } else if (event.target.id === 'auditSearch') {
    auditQuery = event.target.value;
    const position = event.target.selectionStart;
    const sequence = ++auditSearchSequence;
    clearTimeout(auditSearchTimer);
    auditSearchTimer = setTimeout(async () => {
      try {
        const result = await Store.auditLog({ limit: 100, offset: 0, search: auditQuery });
        if (sequence !== auditSearchSequence) return;
        S.log = result.items; S.auditLogCount = result.total;
      } catch (error) { if (sequence === auditSearchSequence) showError(error); }
      if (sequence !== auditSearchSequence) return;
      await render();
      const input = $('auditSearch');
      if (input) { input.focus(); input.setSelectionRange(position, position); }
    }, 180);
  } else if (event.target.id === 'q') {
    q = event.target.value;
    const position = event.target.selectionStart;
    render().then(() => { const input = $('q'); if (input) { input.focus(); input.setSelectionRange(position, position); } });
  }
});
const modalSurface = $('modal');
modalSurface.addEventListener('pointerdown', (event) => { modalPointerStartedOutside = event.target === modalSurface; modalPointerEndedOutside = false; });
modalSurface.addEventListener('pointerup', (event) => { modalPointerEndedOutside = event.target === modalSurface; });
modalSurface.addEventListener('pointercancel', () => { modalPointerStartedOutside = false; modalPointerEndedOutside = false; });
modalSurface.addEventListener('click', (event) => {
  const shouldClose = event.target === modalSurface && event.detail !== 0 && modalPointerStartedOutside && modalPointerEndedOutside;
  modalPointerStartedOutside = false; modalPointerEndedOutside = false;
  if (shouldClose) closeM('backdrop-click');
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('modal').hidden) closeM('escape-key'); });

if (typeof Store.onTelegramLinkChanged === 'function') {
  Store.onTelegramLinkChanged(async () => {
    try { S = await Store.load(); if (page === 'settings') telegramStatus = await Store.telegramStatus(); await render(); }
    catch (error) { console.error('Telegram worker status refresh failed:', error); }
  });
}

(async function startApplication() {
  try {
    S = await Store.load();
    if (!S || !Array.isArray(S.tx)) throw new Error('لم تُرجع قاعدة البيانات بيانات صالحة.');
    await render();
  } catch (error) {
    console.error(error);
    $('view').innerHTML = `<div class="card loss"><h2>تعذر تحميل قاعدة البيانات</h2><p>${esc(error.message)}</p><p>لم يتم إنشاء قاعدة بيانات بديلة أو استخدام التخزين المحلي كبديل.</p></div>`;
    $('status').textContent = 'قاعدة البيانات غير متاحة';
  }
})();
