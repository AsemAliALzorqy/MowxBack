const Store={key:'mowxback_demo_v1',
load(){try{return JSON.parse(localStorage.getItem(this.key))}catch(e){return null}},
save(s){try{localStorage.setItem(this.key,JSON.stringify(s));return true}catch(e){toast('تعذر الحفظ محلياً','err');return false}},
clear(){try{localStorage.removeItem(this.key)}catch(e){}},
migrate(s){if((s.v||1)<2)s=this.migrate1(s);
if(s.v<3){try{localStorage.setItem(this.key+'_backup_v2',localStorage.getItem(this.key))}catch(e){}
const seen=new Set();s.names=[];(s.tx||[]).forEach(t=>(t.lines||[]).forEach(l=>{const n=String(l.name||'').replace(/\s+/g,' ').trim(),k=n.toLowerCase();if(n&&!seen.has(k)){seen.add(k);s.names.push(n)}}));s.v=3}
return s},
migrate1(s){
try{localStorage.setItem(this.key+'_backup_v1',localStorage.getItem(this.key))}catch(e){}
(s.tx||[]).forEach(t=>{if(t.type==='profit'&&!t.lines)t.lines=[{id:uid(),refId:t.refId,name:t.name,qty:+t.qty||0,amount:+t.amount||0,note:t.note||''}]});
s.log=s.log||[];s.currencyCode=s.currencyCode||'custom';s.v=2;return s},
seed(){const t=todayStr();
return{v:3,names:['المنتج A'],currencyCode:'custom',currency:'ريال',demo:true,
items:[{id:'i1',name:'المنتج A',active:true},{id:'i2',name:'المنتج B',active:true},{id:'i3',name:'المنتج C',active:true}],
workers:[{id:'w1',name:'عامل تجريبي',active:true}],
cats:[{id:'c1',name:'الطعام',active:true},{id:'c2',name:'المحروقات',active:true},{id:'c3',name:'الصيانة والأعطال',active:true}],
tx:[{id:uid(),type:'profit',date:t,refId:'i1',name:'المنتج A',qty:20,amount:50,desc:'',note:'بيانات تجريبية',lines:[{id:'l1',refId:'i1',name:'المنتج A',qty:20,amount:50,note:''}]},
{id:uid(),type:'expense',date:t,refId:'c1',name:'الطعام',amount:15,desc:'وجبة تجريبية',note:''},
{id:uid(),type:'withdrawal',date:t,refId:'w1',name:'عامل تجريبي',amount:10,desc:'',note:''}],log:[]}}};
