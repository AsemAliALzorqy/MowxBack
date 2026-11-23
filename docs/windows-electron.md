# أساس Windows وElectron — MowxBack

## 1. الاختيار التقني

- Electron: `45.4.1` (إصدار Stable المنشور في 18 نوفمبر 2026 وقت تجهيز الحزمة).
- SQLite: `better-sqlite3 13.2.0` في Main Process فقط.
- إعادة بناء native module: `@electron/rebuild 4.2.1`.
- إنشاء المثبت: `electron-builder 26.18.1` وهدف NSIS x64.
- Node في GitHub Actions: 24.

`better-sqlite3` مكتبة native ذات واجهة متزامنة وتدعم SQLite Transactions والنسخ الاحتياطي، ولا تتطلب تشغيل خادم منفصل. لأن اعتمادها native، يجب إعادة بنائها لـElectron ABI المطابق قبل التغليف؛ لذلك يوجد `npm run rebuild:native` في scripts وخط بناء Windows.

## 2. هيكل المسؤوليات

- `electron/main.js`: فتح القاعدة واختيار مسارات Windows الأصلية، النسخ الاحتياطي والاستعادة والنقل واستيراد JSON، ومعالجة IPC.
- `electron/preload.js`: واجهة محدودة عبر `contextBridge` بأساليب مسماة فقط.
- `src/database/db.js`: فتح SQLite، تفعيل Foreign Keys/WAL/FULL synchronous، تطبيق Migration، فحص السلامة.
- `src/database/repository.js`: عمليات مالية ذرية وسجل تدقيق ضمن Transaction.
- `src/database/lifecycle.js`: backup/restore/move والتحقق من سلامة الملفات وبصمة البيانات.
- `src/database/legacy-import.js`: التحقق من JSON القديم واستيراده إلى قاعدة فارغة داخل معاملة واحدة.
- `database/migrations/`: SQL migrations.

لا ترى الواجهة ملف `.db` مباشرة، ولا تستورد `fs` أو `better-sqlite3` من Renderer. IPC يمر من Preload إلى Main فقط.

## 3. إعدادات الأمان

تم ضبط BrowserWindow على:

```js
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false
}
```

- لا نعرض `ipcRenderer` كاملاً ولا `require` ولا `fs`.
- كل method في Preload يرسل قناة محددة فقط، ويُرفض IPC ما لم يأتِ من النافذة الرئيسية والإطار الرئيسي الموثوق.
- تُرفض النوافذ الجديدة والتنقل إلى عناوين خارجية.
- تمت إضافة CSP محلية إلى `index.html` دون مورد CDN.
- يعتمد التطبيق على الملفات المحلية داخل الحزمة؛ لا يحمّل JavaScript أو CSS خارجياً.

هذه طبقة أساس، ويجب مراجعة كل Handler جديد والتحقق من `sender` ومن شكل payload قبل استخدامه. كذلك يجب ألا يسمح Renderer بإرسال SQL أو أسماء جداول عشوائية.

## 4. موقع قاعدة البيانات

أول تشغيل:

1. تظهر نافذة اختيار مجلد أصلية من Electron.
2. يختار المستخدم مجلداً رئيسياً.
3. ينشأ `Data/` تحته إذا لم يكن موجوداً.
4. ينشأ `mowxback.db` أو تفتح القاعدة القائمة بعد التحقق.
5. يحفظ مسار DB في ملف `mowxback-runtime.json` ضمن `app.getPath('userData')`، وليس داخل قاعدة البيانات أو مجلد التثبيت.

مثال ناتج:

```text
D:\MowxBack\Data\mowxback.db
```

إذا كان المسار المسجل غير متاح أو ملف القاعدة مفقوداً، لا يسمح Main Process بإنشاء DB جديدة بصمت. يطلب تحديد القاعدة الموجودة أو اختيار نسخة احتياطية، أو إغلاق البرنامج.

## 5. تغيير مجلد قاعدة البيانات

`moveDatabase()` ينفذ هذه الخطوات:

1. لا يستبدل أي `mowxback.db` موجود في الوجهة.
2. يأخذ fingerprint لمحتويات الجداول والإعدادات والترحيلات وسجل الاستيراد والإجماليات.
3. يستخدم `db.backup(tempPath)` بدلاً من نسخ ملف WAL مفتوح.
4. يفتح نسخة الوجهة للقراءة فقط وينفذ `integrity_check` و`foreign_key_check`.
5. يقارن Hash لكل جدول مع المصدر، إضافة إلى أعداد الصفوف والإجماليات.
6. يفتح النسخة الجديدة، يعيد المقارنة، ثم يحدث ملف إعداد التطبيق.
7. يغلق اتصال المصدر بعد نجاح اعتماد الوجهة. عند فشل أي تحقق، يبقى المسار القديم نشطاً.

يجب تنفيذ اختبار النقل الفعلي في Windows على مسارين، ومن الأفضل أيضاً اختبار محرك أقراص خارجي قبل استخدام بيانات العمل.

## 6. النسخ والاستعادة

- مجلد النسخ الاحتياطي مستقل عن `Data/` ويمكن تغييره من إعدادات التطبيق لاحقاً.
- ملف النسخ الكامل هو SQLite `.db` مولد من Backup API.
- الاستعادة تتحقق من ملف النسخة أولاً، تنشئ نسخة أمان للقاعدة النشطة، ثم تبدل الملف بشكل مضبوط وتعيد فتحه وفحص سلامته.
- يتم الاحتفاظ بنسخة قبل الاستعادة في مجلد البيانات.
- JSON القديم يُستورد من وظيفة منفصلة، ولا يعتبر النسخة الاحتياطية الأساسية.

### سياسة يومية مقترحة

لا يوجد تشغيل تلقائي يومي مفعّل حالياً. أقل إضافة على الواجهة الحالية هي مفتاح اختياري داخل بطاقة النسخ الاحتياطي بعنوان «نسخ احتياطي يومي تلقائي»؛ عند تفعيله، ينشئ التطبيق نسخة في أول تشغيل ناجح بعد تغير التاريخ المحلي، بشرط أن يكون مجلد النسخ الاحتياطي محدداً ومتوفراً. تحفظ آخر نسخة لكل يوم، مع الاحتفاظ بـ30 نسخة يومية مثلاً وحذف الأقدم فقط بعد نجاح النسخة الجديدة وفحصها. يدوّن وقت آخر نسخة في ملف إعداد التشغيل. لا يعمل هذا عند غياب المجلد، ويعرض تنبيهاً واضحاً بدلاً من الادعاء بالنجاح. لا حاجة لخادم أو اتصال إنترنت.

## 7. البناء من الهاتف عبر GitHub Actions

المطور يستطيع تعديل الكود من الهاتف ثم دفع التغييرات إلى `main`. الملف:

`.github/workflows/build-windows.yml`

يشغّل Windows 2022، يثبت Node 24، يثبت npm dependencies، يعيد بناء `better-sqlite3` لـElectron، يشغّل الاختبارات، ثم ينشئ NSIS x64 ويرفع ملف `.exe` كـArtifact.

من GitHub يمكن تشغيل Workflow يدوياً عبر Actions → Build MowxBack for Windows → Run workflow، ثم تنزيل Artifact بعد اكتماله.

لا يمكن إنشاء نسخة Windows تنفيذية داخل بيئة Android/Termux مباشرة من ملفات هذا المشروع دون cross-build/toolchain، ولذلك المسار المعتمد هو Windows runner.

## 8. حالة المرحلة الثانية: ربط الواجهة

ملفات التشغيل في الجذر أصبحت مرتبطة بطبقة SQLite:

- `js/app.js` يستدعي `Store` ولا يقرأ/يكتب `localStorage`.
- `js/storage.js` و`js/backup.js` طبقتا واجهة Renderer رقيقتان إلى Preload.
- تقارير الفترات تستدعي `Repository.getReportData()` من Main، ولا تبني الإجماليات من حالة Renderer.
- CRUD الأرباح والمصروفات والسحبيات والقوائم والعملة يتم من Main عبر Repository.
- النسخ والاستعادة والنقل واستيراد JSON والتصدير متاحة في بطاقة الإعدادات.
- اقتراحات الأصناف تُقرأ من `name_suggestions` المستقل عن سجل الأصناف.
- لا توجد بيانات تجريبية تزرع عند بدء التشغيل.

### قنوات IPC المسماة

| المجال | القنوات |
|---|---|
| الحالة والقراءة | `mowx:get-snapshot`, `mowx:get-report`, `mowx:database-status`, `mowx:integrity-check`, `mowx:search-name-suggestions` |
| الأرباح | `mowx:create-profit-movement`, `mowx:update-profit-line`, `mowx:delete-profit-line`, `mowx:update-profit-date`, `mowx:delete-profit-movement` |
| المصروفات والسحبيات | `mowx:create-expense`, `mowx:update-expense`, `mowx:delete-expense`, `mowx:create-withdrawal`, `mowx:update-withdrawal`, `mowx:delete-withdrawal` |
| القوائم والعملة | `mowx:save-catalog-entry`, `mowx:set-catalog-active`, `mowx:set-currency` |
| إدارة الملفات | `mowx:choose-database-folder`, `mowx:choose-backup-folder`, `mowx:clear-backup-folder`, `mowx:create-database-backup`, `mowx:save-database-backup-as`, `mowx:restore-database-backup`, `mowx:import-legacy-json`, `mowx:export-legacy-json` |

تتحقق Main من أن طلب IPC صادر من النافذة والإطار الرئيسي الموثوق. لا تكشف Preload واجهة عامة لاستدعاء IPC أو SQL.

## 9. ما لم يُنجز أو لم يُختبر بعد

- لم تُثبت dependencies في بيئة تنفيذ هذه المهمة؛ محاولة `npm install` لم تكتمل، ولا يوجد `package-lock.json` ناتج من تثبيت ناجح.
- لم يتم تشغيل تطبيق Electron فعلياً بهذه الحزمة، ولم يُختبر `better-sqlite3` native module مع Electron ABI.
- لم يُشغّل GitHub Actions ولم يُبْنَ ملف NSIS `.exe`؛ لذلك لم يتم التحقق من تشغيل التطبيق على Windows دون إنترنت.
- اختبارات Repository تستخدم `node:sqlite` المدمجة في Node 22، واختبارات SQL تستخدم Python SQLite؛ وهي لا تثبت عمل binary الأصلي في Electron.
- لم يختبر التفاعل البصري لكل نافذة على Chromium/Windows end-to-end.
- لم يختبر استيراد بيانات المستخدم الفعلية؛ لا يوجد JSON خاص بالمستخدم في ZIP.
- النسخ اليومي التلقائي غير مفعل.
- تصدير Excel ما زال CSV وليس XLSX حقيقياً. PDF ما زال عبر الطباعة ولم يُختبر على Windows.

تفاصيل الاختبارات وحدودها محفوظة في `docs/phase-2-integration-report-ar.md` و`docs/test-plan.md`.

## 9. مراجع تقنية خارجية تم التحقق منها وقت إعداد الأساس

- Electron Stable 45.4.1: https://releases.electronjs.org/release/v45.4.1
- جدول دورة إصدارات Electron: https://releases.electronjs.org/schedule
- توصيات أمان Electron: https://www.electronjs.org/docs/latest/tutorial/security/
- `better-sqlite3` 13.2.0: https://www.npmjs.com/package/better-sqlite3
- `@electron/rebuild` 4.2.1: https://www.npmjs.com/package/@electron/rebuild
- `electron-builder` 26.18.x: https://www.npmjs.com/package/electron-builder
