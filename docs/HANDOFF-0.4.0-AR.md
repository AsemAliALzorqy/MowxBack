# تسليم MowxBack 0.4.0

## نطاق التسليم

إضافة إشعارات سحبيات العمال عبر Telegram كميزة اختيارية، دون تغيير الحسابات المالية أو تدفق حفظ السحوبات.

## التغييرات

- إضافة migration 003 لرقم الهاتف وروابط Telegram وoutbox.
- توصيل Bot API في Electron Main Process مع `getMe`, `getWebhookInfo`, `getUpdates`, `sendMessage`.
- تخزين Bot Token المشفر باستخدام `safeStorage` داخل `app.getPath('userData')` في `telegram-bot-token.enc`.
- روابط ربط قصيرة العمر تستخدم مرة واحدة، وتعالج Start تلقائياً.
- مشاركة عبر WhatsApp URL + نص جاهز، QR SVG مولد محلياً، ونسخ الرابط.
- صفحة إعدادات البوت، اسم منشأة اختياري، سجل إشعارات، وإعادة محاولة يدوية.
- تنسيق إشعار السحب مع الملاحظة الاختيارية، وعرض التاريخ بصيغة يوم/شهر/سنة ووقت آخر تحقق من الاتصال في الإعدادات.
- إبقاء Long Polling في وضع إعادة الاتصال عند بدء التطبيق دون إنترنت، مع تمييز حالات فشل الشبكة المؤكدة قبل التسليم عن حالات نتيجة الإرسال المبهمة.
- إضافة اختبار `database/tests/test_telegram.js` وتوسيع اختبارات SQLite وRepository/IPC.
- تحديث الإصدار إلى `0.4.0` في package وlockfile.

## الملفات التي أضيفت

- `database/migrations/003_telegram_notifications.sql`
- `database/tests/test_telegram.js`
- `electron/telegram-service.js`
- `electron/qr-code.js`
- `electron/vendor/QRCode/` (مع إشعار ترخيص MIT)
- `docs/release-0.4.0-ar.md`
- `docs/HANDOFF-0.4.0-AR.md`

## الملفات التي عُدلت

- `.gitignore`
- `README.md`
- `package.json`
- `package-lock.json`
- `database/schema.sql`
- `database/tests/test_database.py`
- `database/tests/test_repository_node.js`
- `docs/test-plan.md`
- `electron/main.js`
- `electron/preload.js`
- `js/storage.js`
- `js/app.js`
- `css/main.css`
- `src/database/repository.js`
- `src/database/legacy-import.js`
- `src/database/lifecycle.js`
- `docs/test-plan.md`
- `docs/RELEASE-CHECKLIST-AR.md`

## نتائج الاختبارات الآلية

- الحسابات: 12 تحققاً ناجحاً.
- SQLite: 17 اختباراً ناجحاً، بما فيها ترحيل Telegram والحفاظ على العامل والسحب الموجودين.
- Repository: اختبارات التقارير وسجل التدقيق والاستيراد والتصدير والاستمرارية وربط Telegram وoutbox.
- IPC: 50 واجهة Bridge تم التحقق منها عبر الاختبار.
- PDF: الأنواع الأربعة اجتازت اختبار القالب.
- Diagnostic Logging: الاختبارات الموجودة ناجحة.
- Report Dates: الاختبارات الموجودة ناجحة.
- Telegram: تنسيق الرسائل، الملاحظة الاختيارية، اسم المنشأة، HTML escaping، Bot API mock، تنقيح أخطاء الشبكة لمنع كشف Token، وتوليد QR محلياً. تم كذلك فك QR الناتج آلياً بأداة OpenCV للتحقق من أن محتواه هو رابط Deep Link الصحيح.

## ما لم يتم اختباره هنا

- لم يتم استخدام Bot Token حقيقي أو مراسلة عامل حقيقي.
- لم يتم تشغيل Electron GUI فعلياً على Windows في بيئة التسليم.
- لم يتم بناء Installer/NSIS في هذه البيئة؛ يلزم تنفيذ GitHub Actions بعد رفع المشروع من المستخدم.
- لم يتم اختبار QR بكاميرا هاتف حقيقي، ولا تجربة Long Polling على Windows أو إرسال رسالة إلى عامل حقيقي.

## قيود تشغيل معروفة

- Long Polling يتطلب نسخة نشطة واحدة فقط لكل Bot Token؛ لا تشغل البوت نفسه على أكثر من جهاز في الوقت نفسه.
- وجود Webhook سابق يمنع Long Polling؛ التطبيق لا يحذفه تلقائياً.
- تعذر تأكيد نتيجة `sendMessage` عند انقطاع الاتصال يصنف الإشعار للفحص اليدوي قبل إعادة الإرسال لتقليل احتمال التكرار.
- Bot Token محفوظ محلياً باستخدام مخزن أسرار Windows؛ عند نقل قاعدة البيانات إلى جهاز آخر يجب إدخال Token مجدداً.

## التحقق قبل الإصدار النهائي

راجع `docs/RELEASE-CHECKLIST-AR.md` وشغّل اختبار Windows مع بوت تجريبي قبل استخدام بوت الإنتاج.
