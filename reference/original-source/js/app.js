let S=Store.migrate(Store.load()||Store.seed());Store.save(S);
const PAGES=[['home','الرئيسية','home'],['ledger','دفتر اليوم','book'],['profits','أرباح الأصناف','up'],['expenses','المصروفات','receipt'],['withdrawals','سحبيات العمال','wallet'],['reports','التقارير','chart'],['items','الأصناف','package'],['workers','العمال','users'],['settings','الإعدادات','settings']];
const MAIN=['home','ledger','expenses','reports'];
const TYPE={profit:['ربح صنف','up','gain'],expense:['مصروف','receipt','loss'],withdrawal:['سحبية عامل','wallet','warn']};
let page=localStorage.getItem('mowx_page')||'home',day=todayStr(),rng={from:todayStr().slice(0,8)+'01',to:todayStr()},rep={kind:'month',day:todayStr(),from:rng.from,to:rng.to},q='';
const $=id=>document.getElementById(id);
const money=n=>`<span class="num">${fmtNum(n)}</span> <bdi>${esc(S.currency)}</bdi>`;
const save=()=>Store.save(S);
const inRange=(t,a,b)=>t.date>=a&&t.date<=b;
function sums(list){const r={profit:0,qty:0,exp:0,wd:0};list.forEach(t=>{if(t.type==='profit'){r.profit+=+t.amount;r.qty+=+t.qty||0}else if(t.type==='withdrawal')r.wd+=+t.amount;else r.exp+=+t.amount});r.totalExp=r.exp+r.wd;r.net=r.profit-r.totalExp;return r}
const netTxt=n=>`${n>=0?'ربح':'خسارة'}`;
function row(t){if(t.type==='profit'&&t.lines)return prow(t);const[l,i,c]=TYPE[t.type];return`<div class="row"><span class="${c}">${ic(i,'l')}</span><div class="m"><div class="d">${esc(t.name||l)}${t.type==='profit'?` — الكمية <span class="num">${t.qty}</span>`:''}</div><div class="s">${l} · ${esc(t.desc||t.note||'')} · <span class="num">${t.date}</span></div></div><b class="${c}">${t.type==='profit'?'+':'−'}${money(t.amount)}</b><button class="btn i" data-act="edit" data-id="${t.id}" aria-label="تعديل">${ic('pencil')}</button></div>`}
const list=a=>a.length?a.map(row).join(''):'<div class="empty">لا توجد عمليات. ابدأ بإضافة عملية جديدة.</div>';
function stat(label,icon,cls,val){return`<div class="card"><div class="k">${ic(icon)} ${label}</div><div class="v ${cls}">${money(val)}</div></div>`}
function summary(s,sc){return`<div class="grid c3">${stat('أرباح الأصناف','up','gain',s.profit)}${stat('المصروفات (شاملة السحبيات)','receipt','loss',s.totalExp)}${stat('منها سحبيات العمال','wallet','warn',s.wd)}</div>`}
function netCard(s){return`<div class="card net"><div class="k" style="color:#cbd5e1">${ic('chart')} صافي النتيجة</div><div class="big">${s.net>=0?'+':'−'}${money(Math.abs(s.net))}</div><div>${netTxt(s.net)}</div><small>صافي النتيجة = أرباح الأصناف − المصروفات (السحبيات محسوبة مرة واحدة ضمنها)</small></div>`}
function quick(date){return`<div class="btns"><button class="btn p" data-act="add" data-type="profit" data-date="${date}">${ic('plus')} إضافة ربح صنف</button><button class="btn p" data-act="add" data-type="expense" data-date="${date}">${ic('plus')} إضافة مصروف</button><button class="btn p" data-act="add" data-type="withdrawal" data-date="${date}">${ic('plus')} تسجيل سحبية عامل</button></div>`}
function dateBar(extra=''){return`<div class="bar"><label class="fld">من<input type="date" data-rng="from" value="${rng.from}"></label><label class="fld">إلى<input type="date" data-rng="to" value="${rng.to}"></label>${extra}</div>`}
const V={
home(){const t=todayStr(),l=live().filter(x=>x.date===t),s=sums(l);return(S.demo?'<div class="card" style="margin-bottom:12px;color:var(--warn)">بيانات تجريبية — يمكنك مسحها من الإعدادات.</div>':'')+`<div class="grid">${netCard(s)}</div><h2 style="margin-top:12px"> </h2>${summary(s)}<h2>عمليات سريعة</h2>${quick(t)}<h2>آخر العمليات</h2><div class="card">${list(l.slice().reverse().slice(0,8))}</div>`},
ledger(){const l=live().filter(x=>x.date===day),s=sums(l);return`<div class="bar"><label class="fld">التاريخ<input type="date" id="dayIn" value="${day}"></label></div>${netCard(s)}<div style="height:12px"></div>${summary(s)}<h2>إضافة</h2>${quick(day)}${['profit','expense','withdrawal'].map(k=>`<h2>${TYPE[k][0]}</h2><div class="card">${list(l.filter(x=>x.type===k))}</div>`).join('')}`},
list(type){const l=live().filter(x=>x.type===type&&inRange(x,rng.from,rng.to)),s=sums(l),tot=type==='profit'?s.profit:type==='expense'?s.exp:s.wd;
let by='';if(type==='withdrawal'||type==='profit'||type==='expense'){const m={};l.forEach(x=>(x.type==='profit'?aLines(x):[x]).forEach(y=>{m[y.name]=m[y.name]||{a:0,q:0};m[y.name].a+=+y.amount;m[y.name].q+=+y.qty||0}));by=Object.keys(m).length?`<h2>${type==='withdrawal'?'حسب العامل':type==='profit'?'حسب الصنف':'حسب التصنيف'}</h2><div class="card">${Object.entries(m).map(([n,v])=>`<div class="row"><div class="m d">${esc(n)}${type==='profit'?` — <span class="num">${v.q}</span>`:''}</div><b>${money(v.a)}</b></div>`).join('')}</div>`:''}
return dateBar(`<button class="btn p" data-act="add" data-type="${type}" data-date="${todayStr()}">${ic('plus')} إضافة</button>`)+`<div class="card" style="margin-bottom:12px"><div class="k">المجموع${type==='profit'?` — الكمية <span class="num">${s.qty}</span>`:''}</div><div class="v ${TYPE[type][2]}">${money(tot)}</div>${type==='withdrawal'?'<div class="sub">تُحتسب ضمن المصروفات مرة واحدة</div>':''}</div><div class="card">${list(l.slice().sort((a,b)=>b.date.localeCompare(a.date)))}</div>`+by},
reports(){let a,b;if(rep.kind==='day')a=b=rep.day;else if(rep.kind==='month'){a=rep.day.slice(0,8)+'01';const d=new Date(+rep.day.slice(0,4),+rep.day.slice(5,7),0);b=rep.day.slice(0,8)+String(d.getDate()).padStart(2,'0')}else{a=rep.from;b=rep.to}
const l=live().filter(x=>inRange(x,a,b)),s=sums(l),m={},c={},w={};l.forEach(x=>{if(x.type==='profit'){aLines(x).forEach(y=>{m[y.name]=m[y.name]||{q:0,a:0};m[y.name].q+=+y.qty||0;m[y.name].a+=+y.amount})}else if(x.type==='expense')c[x.name]=(c[x.name]||0)+ +x.amount;else w[x.name]=(w[x.name]||0)+ +x.amount});
rep.cur={a,b,l,s};const tb=(o,f)=>Object.keys(o).length?`<table>${Object.entries(o).map(f).join('')}</table>`:'<div class="empty">لا توجد بيانات</div>';
return`<div class="bar"><label class="fld">نوع التقرير<select id="repKind"><option value="day"${rep.kind==='day'?' selected':''}>يومي</option><option value="month"${rep.kind==='month'?' selected':''}>شهري</option><option value="range"${rep.kind==='range'?' selected':''}>من تاريخ إلى تاريخ</option></select></label>${rep.kind==='range'?`<label class="fld">من<input type="date" data-rep="from" value="${rep.from}"></label><label class="fld">إلى<input type="date" data-rep="to" value="${rep.to}"></label>`:`<label class="fld">التاريخ<input type="date" data-rep="day" value="${rep.day}"></label>`}</div><div class="bar"><button class="btn" data-act="pdf">${ic('download')} تصدير PDF (طباعة)</button><button class="btn" data-act="xls">${ic('download')} تصدير Excel</button></div>
<div class="sub">الفترة: <span class="num">${a}</span> إلى <span class="num">${b}</span></div><div style="height:8px"></div>${netCard(s)}<h2>أرباح الأصناف</h2><div class="card scroll">${tb(m,([n,v])=>`<tr><td>${esc(n)}</td><td><span class="num">${v.q}</span></td><td>${money(v.a)}</td></tr>`)}<div class="row"><b class="m">إجمالي الأرباح (الكمية <span class="num">${s.qty}</span>)</b><b class="gain">${money(s.profit)}</b></div></div>
<h2>المصروفات حسب التصنيف</h2><div class="card scroll">${tb(c,([n,v])=>`<tr><td>${esc(n)}</td><td>${money(v)}</td></tr>`)}</div><h2>سحبيات العمال (تفصيل ضمن المصروفات)</h2><div class="card scroll">${tb(w,([n,v])=>`<tr><td>${esc(n)}</td><td>${money(v)}</td></tr>`)}</div>
<h2>تفاصيل العمليات</h2><div class="card">${list(l)}</div><div class="card" style="margin-top:12px"><div class="row"><span class="m">مصروفات التصنيفات</span>${money(s.exp)}</div><div class="row"><span class="m">سحبيات العمال</span>${money(s.wd)}</div><div class="row"><b class="m">إجمالي المصروفات</b><b class="loss">${money(s.totalExp)}</b></div></div>`},
mgmt(kind){const L=S[kind],t={items:'صنف',workers:'عامل',cats:'تصنيف'}[kind];const f=L.filter(x=>x.name.includes(q));return`<div class="bar"><label class="fld">بحث<input type="search" id="q" value="${esc(q)}" placeholder="ابحث بالاسم"></label><button class="btn p" data-act="madd" data-k="${kind}">${ic('plus')} إضافة ${t}</button></div><div class="card">${f.length?f.map(x=>`<div class="row"><div class="m d">${esc(x.name)}</div><span class="badge ${x.active?'gain':'warn'}">${x.active?'نشط':'موقوف'}</span><button class="btn i" data-act="medit" data-k="${kind}" data-id="${x.id}" aria-label="تعديل">${ic('pencil')}</button><button class="btn" data-act="mtog" data-k="${kind}" data-id="${x.id}">${x.active?'إيقاف':'تفعيل'}</button></div>`).join(''):'<div class="empty">لا توجد نتائج</div>'}</div><div class="sub" style="margin-top:8px">الإيقاف لا يحذف السجلات السابقة.</div>`},
settings(){return`<div class="card"><label class="fld">العملة<select id="curCode">${Object.entries(CURS).map(([k,v])=>`<option value="${k}"${S.currencyCode===k?' selected':''}>${k} — ${v}</option>`).join('')}<option value="custom"${S.currencyCode==='custom'?' selected':''}>أخرى (نص مخصص)</option></select></label><label class="fld">النص المخصص (عند اختيار أخرى)<input id="cur" value="${esc(S.currency)}" maxlength="12"></label><button class="btn p" data-act="cur">حفظ العملة</button></div>${backupCard()}<h2>الإدارة</h2><div class="btns"><button class="btn" data-go="items">${ic('package')} الأصناف</button><button class="btn" data-go="workers">${ic('users')} العمال</button><button class="btn" data-act="cats">${ic('receipt')} تصنيفات المصروفات</button></div><h2>البيانات التجريبية</h2><div class="btns"><button class="btn" data-act="wipe">مسح البيانات التجريبية</button><button class="btn" data-act="reset">إعادة ضبط</button></div><h2>سجل التغييرات (تجريبي)</h2><div class="card">${S.log.length?S.log.slice().reverse().slice(0,30).map(g=>`<div class="row"><div class="m"><div class="d">${{create:'إضافة',edit:'تعديل',delete:'حذف'}[g.op]||g.op} — ${esc(g.after.name||'')}</div><div class="s">${new Date(g.at).toLocaleString('ar-EG-u-nu-latn')} · قبل: ${g.before?`<span class="num">${g.before.amount}</span>`:'—'} · بعد: <span class="num">${g.after.amount??''}</span></div></div></div>`).join(''):'<div class="empty">لا توجد تغييرات</div>'}</div><h2>معلومات النظام</h2><div class="card sub">MowxBack — واجهة تجريبية محلية. الحفظ في المتصفح فقط. لا توجد مزامنة سحابية ولا نسخ احتياطي سحابي ولا PIN. حذف العمليات المالية غير مفعّل.</div>`}};
function render(){const p=PAGES.find(x=>x[0]===page)||PAGES[0];$('pageTitle').textContent=p[1];$('pageDate').textContent=fmtDate(todayStr());
const v={home:V.home,ledger:V.ledger,profits:()=>V.list('profit'),expenses:()=>V.list('expense'),withdrawals:()=>V.list('withdrawal'),reports:V.reports,items:()=>V.mgmt('items'),workers:()=>V.mgmt('workers'),cats:()=>V.mgmt('cats'),settings:V.settings}[page]||V.home;
try{$('view').innerHTML=v()}catch(e){console.error(e);$('view').innerHTML='<div class="empty loss">تعذر عرض الصفحة</div>'}
$('side').innerHTML='<div class="logo">MowxBack</div>'+PAGES.map(x=>`<button data-go="${x[0]}" class="${x[0]===page?'on':''}">${ic(x[2])}${x[1]}</button>`).join('');
const act=MAIN.includes(page)?page:'more';$('bottom').innerHTML=MAIN.map(k=>{const x=PAGES.find(y=>y[0]===k);return`<button data-go="${k}" class="${act===k?'on':''}">${ic(x[2])}${x[1]}</button>`}).join('')+`<button data-act="more" class="${act==='more'?'on':''}">${ic('menu')}المزيد</button>`;
const on=navigator.onLine;$('status').innerHTML=`<span class="pill ${on?'ok':'off'}">${ic('wifi','s')}${on?'متصل':'غير متصل'}</span><span>المزامنة: غير مفعّلة (تجريبي)</span>`}
function go(p){page=p;q='';try{localStorage.setItem('mowx_page',p)}catch(e){}closeM();render();window.scrollTo(0,0)}
function closeM(){$('modal').hidden=true;$('modal').innerHTML=''}
function form(title,fields,vals,onSave){$('modal').hidden=false;$('modal').innerHTML=`<div class="sheet" role="dialog" aria-label="${esc(title)}"><h3>${esc(title)}</h3><div id="ff">${fields.map(f=>`<label class="fld">${f.l}${f.t==='select'?`<select name="${f.k}">${f.o.map(o=>`<option value="${o[0]}"${o[0]===vals[f.k]?' selected':''}>${esc(o[1])}</option>`).join('')}</select>`:f.t==='area'?`<textarea name="${f.k}">${esc(vals[f.k]||'')}</textarea>`:`<input name="${f.k}" type="${f.t||'text'}" ${f.t==='number'?'step="any" min="0" inputmode="decimal"':''} value="${esc(vals[f.k]??'')}">`}<span class="err" data-e="${f.k}"></span></label>`).join('')}</div><div class="btns" style="grid-template-columns:1fr 1fr"><button class="btn p" id="fs">حفظ</button><button class="btn" id="fc">إلغاء</button></div></div>`;
$('fc').onclick=closeM;$('fs').onclick=()=>{const o={};let ok=true;fields.forEach(f=>{const el=document.querySelector(`[name="${f.k}"]`);o[f.k]=el.value.trim();const e=document.querySelector(`[data-e="${f.k}"]`);e.textContent='';if(f.r&&!o[f.k]){e.textContent='هذا الحقل مطلوب';ok=false}else if(f.t==='number'&&o[f.k]&&!(+o[f.k]>0)){e.textContent='أدخل رقماً أكبر من صفر';ok=false}});if(ok)onSave(o)}}
function txForm(t){if(t.type==='profit'&&!t.id)return profitMulti(t.date||todayStr());const isNew=!t.id,type=t.type,refs=type==='profit'?S.items:type==='withdrawal'?S.workers:S.cats;const opts=refs.filter(x=>x.active||x.id===t.refId).map(x=>[x.id,x.name]);
if(!opts.length){toast('أضف عنصراً نشطاً من الإعدادات أولاً','err');return}
const F=[{k:'date',l:'التاريخ',t:'date',r:1},{k:'refId',l:type==='profit'?'الصنف':type==='withdrawal'?'العامل':'التصنيف',t:'select',o:opts}];
if(type==='profit')F.push({k:'qty',l:'الكمية',t:'number',r:1});F.push({k:'amount',l:type==='profit'?'إجمالي الربح':'المبلغ',t:'number',r:1});if(type==='expense')F.push({k:'desc',l:'الوصف',r:1});F.push({k:'note',l:'ملاحظات (اختياري)',t:'area'});
form((isNew?'إضافة ':'تعديل ')+TYPE[type][0],F,t,o=>{const ref=refs.find(x=>x.id===o.refId),n={...t,...o,amount:+o.amount,qty:+o.qty||0,name:ref?ref.name:t.name};
if(isNew){n.id=uid();S.tx.push(n);S.log.push({id:uid(),txId:n.id,op:'create',before:null,after:n,at:Date.now()})}else{const i=S.tx.findIndex(x=>x.id===t.id);S.log.push({id:uid(),txId:t.id,op:'edit',before:S.tx[i],after:n,at:Date.now()});S.tx[i]=n}
save();closeM();render();toast(isNew?'تمت الإضافة':'تم حفظ التعديل')})}
function mForm(k,it){const isNew=!it;form(isNew?'إضافة':'تعديل',[{k:'name',l:'الاسم',r:1}],it||{},o=>{if(S[k].some(x=>x.name===o.name&&(!it||x.id!==it.id))){toast('الاسم موجود مسبقاً','err');return}
if(isNew)S[k].push({id:uid(),name:o.name,active:true});else{it.name=o.name;S.tx.forEach(t=>{});}save();closeM();render();toast('تم الحفظ')})}
function csv(){const{a,b,l}=rep.cur,T={profit:'ربح صنف',expense:'مصروف',withdrawal:'سحبية'};const r=[['النوع','التاريخ','الاسم','الكمية','المبلغ','الوصف']].concat(l.map(t=>[T[t.type],t.date,t.name,t.qty||'',t.amount,t.desc||'']));const s=sums(l);r.push([],['إجمالي الأرباح','','','',s.profit],['إجمالي المصروفات (تشمل السحبيات)','','','',s.totalExp],['منها سحبيات','','','',s.wd],['صافي النتيجة','','','',s.net]);
try{const blob=new Blob(['\ufeff'+r.map(x=>x.map(c=>`"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\n')],{type:'text/csv;charset=utf-8'}),u=URL.createObjectURL(blob),el=document.createElement('a');el.href=u;el.download=`mowxback-${a}_${b}.csv`;el.click();setTimeout(()=>URL.revokeObjectURL(u),1000);toast('تم التصدير')}catch(e){toast('فشل التصدير','err')}}
document.addEventListener('click',e=>{const el=e.target.closest('[data-act],[data-go]');if(!el)return;if(el.dataset.go)return go(el.dataset.go);const d=el.dataset,a=d.act;
if(a==='add')txForm({type:d.type,date:d.date,refId:'',amount:'',qty:'',desc:'',note:''});
else if(a==='edit')txForm(S.tx.find(x=>x.id===d.id));
else if(a==='madd')mForm(d.k);else if(a==='medit')mForm(d.k,S[d.k].find(x=>x.id===d.id));
else if(a==='mtog'){const it=S[d.k].find(x=>x.id===d.id);it.active=!it.active;save();render();toast(it.active?'تم التفعيل':'تم الإيقاف')}
else if(a==='cats')go('cats');
else if(a==='more'){$('modal').hidden=false;$('modal').innerHTML=`<div class="sheet"><h3>المزيد</h3><div class="grid">${PAGES.filter(x=>!MAIN.includes(x[0])).map(x=>`<button class="btn" data-go="${x[0]}">${ic(x[2])}${x[1]}</button>`).join('')}<button class="btn" id="fc2">إغلاق</button></div></div>`;$('fc2').onclick=closeM}
else if(a==='detail')profitDetail(d.id);
else if(a==='bpick'||a==='bdel'||a==='bdl'||a==='bsave'){(async()=>{if(a==='bpick')await Backup.pick();else if(a==='bdel')await Backup.remove();else if(a==='bdl')Backup.download();else await Backup.save();render()})()}
else if(a==='cur'){const code=$('curCode').value,v=$('cur').value.trim();if(code==='custom'&&!v)return toast('أدخل اسم العملة','err');S.currencyCode=code;S.currency=code==='custom'?v:CURS[code];save();render();toast('تم تغيير العملة')}
else if(a==='wipe'){if(confirm('مسح كل العمليات؟')){S.tx=[];S.log=[];S.demo=false;save();render();toast('تم المسح')}}
else if(a==='reset'){if(confirm('إعادة ضبط كل البيانات؟')){S=Store.seed();save();render();toast('تمت إعادة الضبط')}}
else if(a==='pdf'){try{window.print()}catch(x){toast('تعذرت الطباعة','err')}}else if(a==='xls')csv()});
document.addEventListener('change',e=>{const t=e.target;if(t.id==='dayIn'&&t.value){day=t.value;render()}else if(t.dataset.rng){rng[t.dataset.rng]=t.value;render()}else if(t.id==='repKind'){rep.kind=t.value;render()}else if(t.dataset.rep){rep[t.dataset.rep]=t.value;render()}});
document.addEventListener('input',e=>{if(e.target.id==='q'){q=e.target.value;const p=e.target.selectionStart;render();const n=$('q');n.focus();n.setSelectionRange(p,p)}});
$('modal').addEventListener('click',e=>{if(e.target.id==='modal')closeM()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeM()});
window.addEventListener('online',render);window.addEventListener('offline',render);
const CURS={SAR:'﷼',JOD:'د.أ',AED:'د.إ',KWD:'د.ك',USD:'$',EGP:'ج.م'};
const fmtNum=n=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(+n||0);

/* ===== سجل أسماء الأصناف المستخدمة في الأرباح + الإكمال التلقائي ===== */
const normName=n=>String(n||'').replace(/\s+/g,' ').trim();
const nameKey=n=>normName(n).toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه');
function addNames(arr){S.names=Array.isArray(S.names)?S.names:[];const seen=new Set(S.names.map(nameKey));let ch=false;
  (arr||[]).forEach(x=>{const n=normName(x),k=nameKey(n);if(n&&!seen.has(k)){seen.add(k);S.names.push(n);ch=true}});return ch}
function suggestNames(text){const k=nameKey(text);if(k.length<2)return[];const names=Array.isArray(S.names)?S.names:[];
  const st=[],mid=[];names.forEach(n=>{const nk=nameKey(n);if(nk===k)return;if(nk.startsWith(k))st.push(n);else if(nk.includes(k))mid.push(n)});return st.concat(mid).slice(0,8)}
function attachSuggest(input){if(!input)return;const box=document.createElement('div');box.className='sugbox';box.hidden=true;box.setAttribute('role','listbox');input.insertAdjacentElement('afterend',box);
  input.setAttribute('autocomplete','off');let items=[],hi=-1;
  const close=()=>{box.hidden=true;box.innerHTML='';items=[];hi=-1};
  const pick=n=>{input.value=n;close();input.focus()};
  const paint=()=>{[...box.children].forEach((c,i)=>c.classList.toggle('on',i===hi))};
  const open=()=>{items=suggestNames(input.value);if(!items.length){close();return}box.innerHTML=items.map((n,i)=>`<div class="sug" role="option" data-i="${i}">${esc(n)}</div>`).join('');box.hidden=false;hi=-1};
  input.addEventListener('input',open);
  input.addEventListener('keydown',e=>{if(box.hidden)return;if(e.key==='ArrowDown'){e.preventDefault();hi=(hi+1)%items.length;paint()}else if(e.key==='ArrowUp'){e.preventDefault();hi=(hi-1+items.length)%items.length;paint()}else if(e.key==='Enter'&&hi>=0){e.preventDefault();pick(items[hi])}else if(e.key==='Escape'){e.stopPropagation();close()}});
  box.addEventListener('mousedown',e=>{const el=e.target.closest('.sug');if(el){e.preventDefault();pick(items[+el.dataset.i])}});
  document.addEventListener('mousedown',function f(e){if(!document.body.contains(input)){document.removeEventListener('mousedown',f);return}if(e.target!==input&&!box.contains(e.target))close()});
  document.addEventListener('touchstart',function f(e){if(!document.body.contains(input)){document.removeEventListener('touchstart',f);return}if(e.target!==input&&!box.contains(e.target))close()},{passive:true})}
function live(){return S.tx.filter(t=>!t.void)}
function aLines(t){return t.lines?t.lines.filter(l=>!l.deleted):[t]}
function retotal(t){const a=aLines(t);t.amount=a.reduce((s,l)=>s+ +l.amount,0);t.qty=a.reduce((s,l)=>s+ +l.qty,0);t.void=!a.length;t.name=a.length===1?a[0].name:'حركة أرباح أصناف'}
function prow(t){const a=aLines(t);return`<div class="row"><span class="gain">${ic('up','l')}</span><div class="m"><div class="d">${a.length===1?esc(a[0].name):'حركة أرباح أصناف'}</div><div class="s">عدد الأصناف <span class="num">${a.length}</span> · الكمية <span class="num">${t.qty}</span> · <span class="num">${t.date}</span></div></div><b class="gain">+${money(t.amount)}</b><button class="btn" data-act="detail" data-id="${t.id}">عرض التفاصيل</button></div>`}
function lineEdit(t,l){
  form('تعديل صنف',[{k:'name',l:'اسم الصنف',r:1},{k:'qty',l:'الكمية',t:'number',r:1},{k:'amount',l:'إجمالي الربح',t:'number',r:1},{k:'note',l:'ملاحظات (اختياري)',t:'area'}],l,o=>{
    const b={name:l.name,qty:l.qty,amount:l.amount},nm=normName(o.name);
    if(!nm){toast('أدخل اسم الصنف','err');return}
    Object.assign(l,{name:nm,qty:+o.qty,amount:+o.amount,note:o.note});if(l.refId&&!S.items.some(x=>x.id===l.refId&&x.name===nm))delete l.refId;retotal(t);addNames([nm]);
    S.log.push({id:uid(),txId:t.id,lineId:l.id,op:'edit',before:b,after:{name:l.name,qty:l.qty,amount:l.amount},at:Date.now()});
    save();render();toast('تم حفظ التعديل');profitDetail(t.id)});attachSuggest(document.querySelector('#ff [name="name"]'))}
function profitDetail(id){const t=S.tx.find(x=>x.id===id);if(!t||t.void||!t.lines){closeM();return}
  $('modal').hidden=false;
  $('modal').innerHTML=`<div class="sheet" style="max-width:640px"><h3>تفاصيل حركة أرباح</h3><div class="sub"><span class="num">${t.date}</span></div><div class="scroll"><table style="min-width:420px"><thead><tr><th>الصنف</th><th>الكمية</th><th>إجمالي الربح</th><th>الإجراءات</th></tr></thead><tbody>${aLines(t).map(l=>`<tr><td>${esc(l.name)}${l.note?`<div class="s">${esc(l.note)}</div>`:''}</td><td><span class="num">${l.qty}</span></td><td><b class="gain">${money(l.amount)}</b></td><td style="white-space:nowrap"><button class="btn i" data-le="${l.id}" aria-label="تعديل ${esc(l.name)}">${ic('pencil')}</button> <button class="btn i" data-ld="${l.id}" aria-label="حذف ${esc(l.name)}">${ic('x')}</button></td></tr>`).join('')}</tbody></table></div><div class="row"><b class="m">إجمالي أرباح الحركة</b><b class="gain" style="font-size:20px">${money(t.amount)}</b></div><button class="btn" id="pdClose" style="width:100%;margin-top:12px">إغلاق</button></div>`;
  $('pdClose').onclick=closeM;
  $('modal').querySelectorAll('[data-le]').forEach(b=>b.onclick=()=>lineEdit(t,t.lines.find(l=>l.id===b.dataset.le)));
  $('modal').querySelectorAll('[data-ld]').forEach(b=>b.onclick=()=>{const l=t.lines.find(x=>x.id===b.dataset.ld);if(!confirm('حذف هذا الصنف من الحركة؟ يبقى أثره في سجل التغييرات.'))return;
    const bf={name:l.name,qty:l.qty,amount:l.amount};l.deleted=true;retotal(t);
    S.log.push({id:uid(),txId:t.id,lineId:l.id,op:'delete',before:bf,after:{name:l.name,qty:0,amount:0},at:Date.now()});save();render();toast('تم حذف الصنف');profitDetail(t.id)})}
function backupCard(){const B=Backup;return`<h2>مجلد النسخ الاحتياطي</h2><div class="card"><div class="sub" style="margin-bottom:12px">اختر مجلداً على جهازك لحفظ ملفات النسخ الاحتياطي (JSON) فيه. لا يوجد نسخ سحابي، وقد يطلب المتصفح الإذن من جديد عند كل حفظ.</div>${B.supported?`<div class="row"><div class="m"><div class="s">المجلد المحدد</div><div class="d">${B.name?esc(B.name):'لم يُحدد مجلد'}</div></div></div><div class="btns"><button class="btn p" data-act="bpick">${B.name?'تغيير المجلد':'اختيار مجلد'}</button>${B.name?`<button class="btn" data-act="bsave">حفظ نسخة في المجلد</button><button class="btn" data-act="bdel">إزالة اختيار المجلد</button>`:''}</div>`:'<div class="warn" style="margin-bottom:12px">هذا المتصفح لا يدعم اختيار مجلد دائم. استخدم التنزيل اليدوي.</div>'}<div style="height:8px"></div><button class="btn" data-act="bdl">${ic('download')} تنزيل نسخة احتياطية</button></div>`}
Backup.init().then(render);
render();

function profitMulti(date){
  let rows=[],edit=-1,cur={name:'',qty:'',amount:'',note:''};
  const total=()=>rows.reduce((a,r)=>a+r.amount,0);
  const val=n=>document.querySelector(`#pm [name="${n}"]`);
  const err=(k,m)=>{const e=document.querySelector(`#pm [data-e="${k}"]`);if(e)e.textContent=m||''};
  let saving=false;
  const readRow=()=>{date=val('date').value;['date','qty','amount'].forEach(k=>err(k));let ok=true;
    if(!date){err('date','هذا الحقل مطلوب');ok=false}
    const q=+val('qty').value,a=+val('amount').value;
    if(!(q>0)){err('qty','أدخل كمية أكبر من صفر');ok=false}
    if(!(a>0)){err('amount','أدخل رقماً أكبر من صفر');ok=false}
    const nm=normName(val('name').value);if(!nm){err('name','أدخل اسم الصنف');ok=false}else err('name');
    return ok?{name:nm,qty:q,amount:a,note:val('note').value.trim()}:null};
  const commit=()=>{const r=readRow();if(!r)return false;if(edit>=0)rows[edit]=r;else rows.push(r);edit=-1;cur={name:'',qty:'',amount:'',note:''};return true};
  const draw=()=>{
    $('modal').hidden=false;
    $('modal').innerHTML=`<div class="sheet" id="pm" role="dialog" aria-label="إضافة أرباح أصناف" style="max-width:640px"><h3>إضافة أرباح أصناف</h3>
    <label class="fld">التاريخ<input name="date" type="date" value="${date}"><span class="err" data-e="date"></span></label>
    <label class="fld">اسم الصنف<input name="name" type="text" value="${esc(cur.name)}" placeholder="اكتب اسم الصنف" autocomplete="off"><span class="err" data-e="name"></span></label>
    <div class="grid c2"><label class="fld">الكمية<input name="qty" type="number" step="any" min="0" inputmode="decimal" value="${esc(cur.qty)}"><span class="err" data-e="qty"></span></label>
    <label class="fld">إجمالي الربح<input name="amount" type="number" step="any" min="0" inputmode="decimal" value="${esc(cur.amount)}"><span class="err" data-e="amount"></span></label></div>
    <label class="fld">ملاحظات (اختياري)<textarea name="note">${esc(cur.note)}</textarea></label>
    <div class="btns" style="grid-template-columns:1fr${edit>=0?' 1fr':''};margin-bottom:16px"><button class="btn" id="pmAdd">${ic(edit>=0?'check':'plus')} ${edit>=0?'تحديث الصنف':'إضافة إلى القائمة'}</button>${edit>=0?'<button class="btn" id="pmCancel">إلغاء التعديل</button>':''}</div>
    <div class="scroll"><table style="min-width:420px"><thead><tr><th>الصنف</th><th>الكمية</th><th>إجمالي الربح</th><th>الإجراءات</th></tr></thead><tbody>
    ${rows.length?rows.map((r,i)=>`<tr${i===edit?' style="background:#eaf0fe"':''}><td>${esc(r.name)}${r.note?`<div class="s">${esc(r.note)}</div>`:''}</td><td><span class="num">${r.qty}</span></td><td><b class="gain">${money(r.amount)}</b></td><td style="white-space:nowrap"><button class="btn i" data-pe="${i}" aria-label="تعديل ${esc(r.name)}">${ic('pencil')}</button> <button class="btn i" data-pr="${i}" aria-label="إزالة ${esc(r.name)}">${ic('x')}</button></td></tr>`).join(''):'<tr><td colspan="4" class="empty">لم تُضف أصناف بعد</td></tr>'}
    </tbody></table></div>
    <div class="row"><b class="m">إجمالي أرباح جميع الأصناف (<span class="num">${rows.length}</span>)</b><b class="gain" style="font-size:20px" id="pmTotal">${money(total())}</b></div>
    <div class="btns" style="grid-template-columns:1fr 1fr;margin-top:12px"><button class="btn p" id="pmSave">حفظ جميع الأصناف</button><button class="btn" id="pmClose">إلغاء</button></div></div>`;
    attachSuggest(val('name'));
    const keep=()=>{date=val('date').value};
    val('date').onchange=keep;
    $('pmClose').onclick=closeM;
    if($('pmCancel'))$('pmCancel').onclick=()=>{edit=-1;cur={name:'',qty:'',amount:'',note:''};draw()};
    $('pmAdd').onclick=()=>{if(commit())draw()};
    $('modal').querySelectorAll('[data-pe]').forEach(b=>b.onclick=()=>{keep();edit=+b.dataset.pe;const r=rows[edit];cur={name:r.name,qty:r.qty,amount:r.amount,note:r.note};draw()});
    $('modal').querySelectorAll('[data-pr]').forEach(b=>b.onclick=()=>{keep();const i=+b.dataset.pr;rows.splice(i,1);if(edit===i){edit=-1;cur={name:'',qty:'',amount:'',note:''}}else if(edit>i)edit--;draw()});
    $('pmSave').onclick=()=>{
      if(saving)return;date=val('date').value;err('date');
      if(!date){err('date','هذا الحقل مطلوب');return}
      if(val('qty').value||val('amount').value||edit>=0){if(!commit())return}
      if(!rows.length){toast('أضف صنفاً واحداً على الأقل','err');return}
      saving=true;$('pmSave').disabled=true;
      const nTx=S.tx.length,nLog=S.log.length,nNames=Array.isArray(S.names)?S.names.slice():[];
      try{const t={id:uid(),type:'profit',date,name:'',desc:'',note:'',qty:0,amount:0,lines:rows.map(r=>({id:uid(),...r}))};retotal(t);S.tx.push(t);addNames(rows.map(r=>r.name));S.log.push({id:uid(),txId:t.id,op:'create',before:null,after:{name:t.name,qty:t.qty,amount:t.amount},at:Date.now()});if(!save())throw new Error('save')}
      catch(e){S.tx.length=nTx;S.log.length=nLog;S.names=nNames;saving=false;draw();toast('فشل الحفظ، لم تُحفظ أي أصناف','err');return}
      const c=rows.length;closeM();render();toast(`تم حفظ حركة تحتوي ${c} من الأصناف`);
    };
  };
  draw();
}
