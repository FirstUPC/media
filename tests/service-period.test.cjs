const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const source=fs.readFileSync('auto-title.js','utf8').replace(/^import .*\n/,'');
const modulePromise=import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function control(){return {value:'',checked:false,disabled:false,events:{},addEventListener(name,fn){this.events[name]=fn;}};}

test('Sunday choices are visible only on Sunday, mutually exclusive, and required before submission',async()=>{
  const {createAvailabilityField}=await modulePromise;
  const input=control(),am=control(),pm=control(),container={hidden:false};
  const field=createAvailabilityField(input,{container,am,pm});
  assert.equal(container.hidden,true);assert.equal(field.targetServicePeriod,'');
  input.value='2026-10-25';input.events.input();assert.equal(container.hidden,false);
  assert.throws(()=>field.targetServicePeriod,/Choose AM or PM/);
  am.checked=true;am.events.change();assert.equal(field.targetServicePeriod,'am');
  pm.checked=true;pm.events.change();assert.equal(am.checked,false);assert.equal(field.targetServicePeriod,'pm');
  pm.checked=false;pm.events.change();assert.throws(()=>field.targetServicePeriod,/Choose AM or PM/);
  am.checked=true;am.events.change();input.value='2026-10-28';input.events.input();
  assert.equal(container.hidden,true);assert.equal(am.checked,false);assert.equal(field.targetServicePeriod,'');
  input.value='2026-11-01';input.events.input();assert.equal(container.hidden,false);
  assert.throws(()=>field.targetServicePeriod,/Choose AM or PM/);
});

test('Sunday edits survive title polling and reopening restores date and period together',async()=>{
  const {createAvailabilityField}=await modulePromise;
  const input=control(),am=control(),pm=control(),container={hidden:true};
  const field=createAvailabilityField(input,{container,am,pm});
  field.sync({availableStartingDate:'2026-10-25',targetServicePeriod:'pm'});
  assert.equal(pm.checked,true);
  am.checked=true;am.events.change();
  field.sync({availableStartingDate:'2026-10-25',targetServicePeriod:'pm'});
  assert.equal(field.targetServicePeriod,'am');
  field.sync({availableStartingDate:'2026-11-01',targetServicePeriod:'pm'},{force:true});
  assert.equal(field.value,'2026-11-01');assert.equal(field.targetServicePeriod,'pm');
  field.disabled=true;assert.ok(input.disabled&&am.disabled&&pm.disabled);
  field.reset();assert.equal(container.hidden,true);assert.equal(field.targetServicePeriod,'');
});

test('AM/PM metadata travels atomically with image and date, including replacement and clearing',async()=>{
  const {createMediaClient,normalizeTargetServicePeriod}=await modulePromise;
  const requests=[];
  const api=createMediaClient(async()=>'token',async(url,options)=>{requests.push(options);return {ok:true,json:async()=>({id:'slide'})};});
  const file=new Blob(['image']),prior={id:'slide',revision:3,availableStartingDate:'2026-10-25',targetServicePeriod:'pm'};
  await api.upload(file,'new',null,'2026-10-25','am');
  await api.upload(file,'replace',prior);
  await api.upload(file,'clear',prior,'');
  await api.upload(file,'weekday',prior,'2026-10-28');
  assert.deepEqual(requests.map(x=>x.body.get('targetServicePeriod')),['am','pm','','']);
  await api.update(prior,{availableStartingDate:'2026-10-25',targetServicePeriod:'am'});
  assert.deepEqual(JSON.parse(requests.at(-1).body),{availableStartingDate:'2026-10-25',targetServicePeriod:'am',revision:3});
  assert.throws(()=>normalizeTargetServicePeriod('pm','2026-10-28'),/only.*Sunday/);
  assert.throws(()=>normalizeTargetServicePeriod('both','2026-10-25'),/Choose AM or PM/);
});

test('lost upload receipt preserves exact Sunday choice across reload and retry',async()=>{
  const {createUploadReceipt}=await modulePromise;
  let saved;
  const file=Object.assign(new Blob(['original']),{name:'slide.png'});
  const first=createUploadReceipt({upload:async()=>{throw new Error('Lost response');}},
    {save:value=>{saved=value;},createId:()=> 'original-request'});
  await assert.rejects(()=>first.begin(file,null,'2026-10-25','pm'),/Lost response/);
  const calls=[];
  const restored=createUploadReceipt({recover:async()=>{throw Object.assign(new Error('Missing'),{status:404});},
    upload:async(...args)=>{calls.push(args);return {id:'saved'};}},{save(){}});
  restored.restore(JSON.parse(JSON.stringify(saved)));
  await restored.retry(file);
  assert.equal(calls[0][1],'original-request');assert.equal(calls[0][3],'2026-10-25');assert.equal(calls[0][4],'pm');
});

test('Sunday determination uses the plain calendar date across DST boundaries',async()=>{
  const {isSundayDate}=await modulePromise;
  for(const value of ['2026-03-08','2026-11-01','2026-10-25'])assert.equal(isSundayDate(value),true);
  for(const value of ['','2026-03-09','2026-10-28'])assert.equal(isSundayDate(value),false);
});
