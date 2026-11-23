const Backup={dir:null,name:'',supported:'showDirectoryPicker' in window,
idb(){return new Promise((res,rej)=>{const r=indexedDB.open('mowxback_fs',1);r.onupgradeneeded=()=>r.result.createObjectStore('h');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})},
async put(v){const d=await this.idb();return new Promise((res,rej)=>{const t=d.transaction('h','readwrite'),o=t.objectStore('h');v?o.put(v,'dir'):o.delete('dir');t.oncomplete=res;t.onerror=()=>rej(t.error)})},
async get(){const d=await this.idb();return new Promise((res,rej)=>{const r=d.transaction('h').objectStore('h').get('dir');r.onsuccess=()=>res(r.result||null);r.onerror=()=>rej(r.error)})},
async init(){try{this.dir=await this.get();this.name=this.dir?this.dir.name:''}catch(e){this.dir=null;this.name=''}},
async pick(){if(!this.supported)return toast('المتصفح لا يدعم اختيار مجلد. استخدم تنزيل النسخة.','err');
try{const h=await window.showDirectoryPicker({mode:'readwrite'});this.dir=h;this.name=h.name;try{await this.put(h)}catch(e){toast('تم التحديد لهذه الجلسة فقط (تعذر حفظ المرجع)','err');return}toast('تم تحديد المجلد: '+h.name)}
catch(e){toast(e&&e.name==='AbortError'?'لم يتم تحديد مجلد':'رُفض الإذن أو تعذر اختيار المجلد','err')}},
async remove(){this.dir=null;this.name='';try{await this.put(null)}catch(e){}toast('تمت إزالة اختيار المجلد')},
payload(){return JSON.stringify({app:'MowxBack',schema:2,exportedAt:new Date().toISOString(),data:S},null,2)},
fname(){return`mowxback-backup-${todayStr()}.json`},
download(){try{const u=URL.createObjectURL(new Blob([this.payload()],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download=this.fname();a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);toast('تم تنزيل النسخة')}catch(e){toast('فشل التنزيل','err')}},
async save(){if(!this.dir)return toast('لم يُحدد مجلد','err');
try{let p=await this.dir.queryPermission({mode:'readwrite'});if(p!=='granted')p=await this.dir.requestPermission({mode:'readwrite'});if(p!=='granted')throw new Error('perm');
const f=await this.dir.getFileHandle(this.fname(),{create:true}),w=await f.createWritable();await w.write(this.payload());await w.close();toast('تم حفظ النسخة في المجلد: '+this.name)}
catch(e){toast('تعذرت الكتابة في المجلد (إذن مرفوض أو المجلد غير متاح). استخدم التنزيل اليدوي.','err')}}};
