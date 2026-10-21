const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const source=fs.readFileSync('auto-title.js','utf8').replace(/^import .*\n/,'');
const modulePromise=import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

test('calendar dates stay timezone independent, permit older slides, and validate real dates',async()=>{
  const {normalizeAvailabilityDate}=await modulePromise;
  for(const value of [undefined,null,''])assert.equal(normalizeAvailabilityDate(value),'');
  for(const value of ['2026-10-25','2020-01-01','2028-02-29'])assert.equal(normalizeAvailabilityDate(value),value);
  for(const value of ['2026-02-29','2026-04-31','2026-13-01','10/25/2026','2026-10-25T00:00:00Z','0000-01-01',42])assert.throws(()=>normalizeAvailabilityDate(value),/valid available starting date/);
});

test('initial upload sends a date atomically; replacement preserves it unless explicitly cleared',async()=>{
  const {createMediaClient}=await modulePromise;
  const calls=[];
  const api=createMediaClient(async()=>'token',async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:'saved'})};});
  const file=new Blob(['image']);
  await api.upload(file,'request',null,'2026-10-25');
  const prior={id:'saved',revision:3,availableStartingDate:'2026-10-25'};
  await api.upload(file,'replace',prior);
  await api.upload(file,'clear',prior,'');
  await api.upload(file,'legacy');
  assert.deepEqual(calls.map(c=>c.options.body.get('availableStartingDate')),['2026-10-25','2026-10-25','','']);
  await api.update(prior,{availableStartingDate:''});
  assert.deepEqual(JSON.parse(calls[4].options.body),{availableStartingDate:'',revision:3});
});

test('status polling cannot discard an unsaved calendar edit; reopen and New drop restore correct values',async()=>{
  const {createAvailabilityField}=await modulePromise;
  const events={};
  const input={value:'',disabled:false,addEventListener:(name,fn)=>{events[name]=fn;}};
  const field=createAvailabilityField(input);
  field.sync({availableStartingDate:'2026-10-25'},{force:true});
  assert.equal(field.value,'2026-10-25');
  input.value='2026-10-27';events.input();
  field.sync({availableStartingDate:'2026-10-25'});
  assert.equal(field.value,'2026-10-27');
  field.sync({availableStartingDate:'2026-10-27'},{force:true});
  field.sync({availableStartingDate:'2026-10-28'});
  assert.equal(field.value,'2026-10-28');
  field.sync({id:'legacy'},{force:true});assert.equal(field.value,'');
  field.disabled=true;assert.equal(input.disabled,true);
  field.reset();assert.equal(field.value,'');
  input.validity={valid:false};assert.throws(()=>field.value,/valid available starting date/);
});

test('date picker explains start-date semantics and church timezone without excluding past dates',()=>{
  const html=fs.readFileSync('index.html','utf8');
  assert.match(html,/<label[^>]*for="availableStartingDate"[^>]*><strong>Optional<\/strong> — Available Starting Date<\/label>/);
  const input=html.match(/<input[^>]*id="availableStartingDate"[^>]*>/)[0];
  assert.match(input,/type="date"/);assert.doesNotMatch(input,/\bmin=/);
  assert.match(html,/stays eligible from this date until used, in America\/New_York/);
});

test('recovering an accepted upload restores its original restriction and text',async()=>{
  const vm=require('node:vm');
  const html=fs.readFileSync('index.html','utf8');
  const source=html.slice(html.indexOf('async function resumeUpload()'),html.indexOf('// Restore the accepted image'));
  const row={id:'accepted',availableStartingDate:'2026-10-25',text:'Saved text'};
  const field={sync(value){this.value=value.availableStartingDate;}};
  const recovered=[];
  const context={
    localStorage:{getItem:()=>JSON.stringify({requestId:'interrupted-request'})},pendingKey:()=>'',
    uploadReceipt:{restore(value){this.pending=value;},recover:async()=>{recovered.push('interrupted-request');return row;}},renderUploadReceipt(){},
    availabilityField:field,textInput:{value:''},composeTitle:{show(){}},renderStaged(){},restoreSlidePreview(){},setStatus(){}
  };
  vm.createContext(context);vm.runInContext(source,context);await context.resumeUpload();
  assert.deepEqual(recovered,['interrupted-request']);
  assert.equal(field.value,'2026-10-25');assert.equal(context.textInput.value,'Saved text');
  assert.equal(context.composeDrop,row);
});
