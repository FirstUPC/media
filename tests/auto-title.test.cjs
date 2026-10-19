const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const timers=[];
 const context={setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},fetch(){},FormData,console};
 vm.createContext(context);vm.runInContext(fs.readFileSync('auto-title.js','utf8').replaceAll('export ',''),context);
 class E{constructor(){this.value='';this.disabled=false;this.readOnly=false;this.textContent='';}setAttribute(){}addEventListener(){}focus(){}}
 const input=new E(),button=new E(),status=new E(),box={querySelector:s=>({'input':input,'button':button,'.status':status}[s])};
 let current={id:'one',revision:1,titleStatus:'queued',title:null,published:false};const updates=[];
 const api={get:async()=>current,update:async(row,value)=>{updates.push({row,value});current={...row,...value,revision:row.revision+1};return current;}};
 return {field:context.createTitleField(box,api),input,button,status,timers,updates,set:v=>{current=v;},flush:async()=>{for(let i=0;i<8;i++)await Promise.resolve();}};
}
test('pencil stays locked until completion; editing explicitly saves a revision',async()=>{
 const f=fixture();f.field.show({id:'one',revision:1,titleStatus:'queued'});await f.flush();
 assert.equal(f.button.disabled,true);assert.equal(f.input.readOnly,true);
 f.set({id:'one',revision:2,titleStatus:'complete',title:'The Cost of a Wedding',published:true});f.timers.at(-1)();await f.flush();
 assert.equal(f.button.disabled,false);assert.equal(f.input.readOnly,true);
 await f.button.onclick();assert.equal(f.input.readOnly,false);f.input.value='When Methuselah is Gone';
 await f.button.onclick();assert.equal(f.input.readOnly,true);assert.equal(f.updates[0].row.revision,2);assert.equal(f.updates[0].value.title,'When Methuselah is Gone');
 f.field.close();
});
test('late response from a previous slide cannot unlock or fill its replacement',async()=>{
 const f=fixture();f.field.show({id:'old',titleStatus:'complete',title:'Old'});
 f.set({id:'new',revision:1,titleStatus:'queued'});f.field.show({id:'new',revision:1,titleStatus:'queued'});await f.flush();
 assert.equal(f.field.row.id,'new');assert.equal(f.input.value,'');assert.equal(f.button.disabled,true);f.field.close();
});
test('client uploads immediately with auth, idempotency ID, and replacement revision',async()=>{
 const source=fs.readFileSync('auto-title.js','utf8');const {createMediaClient}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const calls=[];const api=createMediaClient(async()=>'test-token',async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:'one'})};});
 await api.upload(new Blob(['image']),'same-request');await api.upload(new Blob(['new']),'new-request',{id:'one',revision:7});
 assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.headers.Authorization,'Bearer test-token');assert.equal(calls[0].options.body.get('requestId'),'same-request');assert.equal(calls[1].options.body.get('revision'),'7');
 await api.update({id:'one',revision:8},{title:'Corrected'});assert.equal(JSON.parse(calls[2].options.body).revision,8);
});
