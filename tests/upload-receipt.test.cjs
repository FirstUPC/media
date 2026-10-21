const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const source=fs.readFileSync('auto-title.js','utf8').replace(/^import .*\n/,'');
const modulePromise=import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const missing=()=>Object.assign(new Error('No receipt'),{status:404});
const file=()=>Object.assign(new Blob(['original slide']),{name:'slide.png'});

async function fixture(options={}){
  const {createUploadReceipt}=await modulePromise;
  const calls=[],saved=[];let attempt=0;
  const api={upload:async(...args)=>{calls.push(args);if(!attempt++)throw new Error('Response lost');return {id:'accepted',availableStartingDate:args[3]};},recover:async()=>{throw missing();},...options};
  const receipt=createUploadReceipt(api,{save:value=>saved.push(value),createId:()=> 'original-request'});
  return {receipt,calls,saved};
}

test('lost response recovers the accepted receipt without issuing another POST',async()=>{
  const f=await fixture({recover:async()=>({id:'accepted',availableStartingDate:'2026-10-25'})});
  await assert.rejects(()=>f.receipt.begin(file(),null,'2026-10-25'),/Response lost/);
  assert.equal(f.receipt.pending.requestId,'original-request');
  const result=await f.receipt.retry(new Blob(['different newly selected slide']));
  assert.equal(result.recovered,true);assert.equal(result.row.id,'accepted');assert.equal(f.calls.length,1);
  assert.equal(f.receipt.pending,null);assert.deepEqual(f.saved.at(-1),{id:'accepted'});
});

test('unconfirmed retry reuses exact original request, file, date and replacement revision',async()=>{
  const f=await fixture();const original=file(),prior={id:'existing',revision:7};
  await assert.rejects(()=>f.receipt.begin(original,prior,'2026-10-25'));
  const result=await f.receipt.retry();
  assert.equal(result.recovered,false);
  assert.deepEqual(f.calls[1],f.calls[0]);assert.equal(f.calls[1][0],original);
  assert.equal(f.calls[1][1],'original-request');assert.equal(f.calls[1][3],'2026-10-25');
});

test('different file cannot replace the ambiguous pending upload',async()=>{
  const f=await fixture();await assert.rejects(()=>f.receipt.begin(file(),null,''));
  await assert.rejects(()=>f.receipt.retry(new Blob(['other slide'])),/different slide/);
  await assert.rejects(()=>f.receipt.begin(file(),null,''),/Resolve the pending upload/);
  assert.equal(f.calls.length,1);assert.equal(f.receipt.pending.requestId,'original-request');
});

test('after reload only original file bytes can retry the persisted identity',async()=>{
  const f=await fixture();await assert.rejects(()=>f.receipt.begin(file(),null,'2026-10-25'));
  const restored=await fixture({upload:async(...args)=>({id:'accepted',requestId:args[1],availableStartingDate:args[3]})});
  restored.receipt.restore(JSON.parse(JSON.stringify(f.saved[0])));
  await assert.rejects(()=>restored.receipt.retry(),/Select the original pending file/);
  await assert.rejects(()=>restored.receipt.retry(new Blob(['wrong bytes'])),/different slide/);
  const result=await restored.receipt.retry(file());
  assert.equal(result.row.requestId,'original-request');assert.equal(result.row.availableStartingDate,'2026-10-25');
});

test('temporary receipt lookup errors do not submit a new upload',async()=>{
  const f=await fixture({recover:async()=>{throw new Error('Offline');}});
  await assert.rejects(()=>f.receipt.begin(file(),null,''));
  await assert.rejects(()=>f.receipt.retry(),/Offline/);
  assert.equal(f.calls.length,1);assert.ok(f.receipt.pending);
});

test('definitive rejection releases pending state but transient errors retain it',async()=>{
  for(const status of [400,409,413,429,500]){
    const f=await fixture({upload:async()=>{throw Object.assign(new Error('Rejected'),{status});}});
    await assert.rejects(()=>f.receipt.begin(file(),{id:'prior',revision:2},'2026-10-25'));
    if([429,500].includes(status))assert.ok(f.receipt.pending);
    else{assert.equal(f.receipt.pending,null);assert.deepEqual(f.saved.at(-1),{id:'prior'});}
  }
});
