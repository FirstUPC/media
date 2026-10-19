const {test}=require('node:test');
const assert=require('node:assert/strict');
const effects=()=>import('../title-effects.mjs');
const word=(text,confidence=95)=>({text,confidence,bbox:{x0:10,y0:20,x1:100,y1:60}});

test('positions require every confirmed title word and retain server casing',async()=>{
  const {matchTitleWords}=await effects();
  const words=['CHURCH','THE','COST','OF','A','WEDDING','Sunday'].map(text=>word(text));
  const matched=matchTitleWords('The Cost of a Wedding',words);
  assert.deepEqual(matched.map(w=>w.title),['The','Cost','of','a','Wedding']);
  assert.equal(matched[0].text,'THE');
  assert.equal(matchTitleWords('The Cost of a Wedding',[word('THE'),word('WEDDING')]),null);
  assert.equal(matchTitleWords('Hope',[word('Hope',20)]),null);
  assert.equal(matchTitleWords('',words),null);
});

test('uncertain scripts do not change the confirmed title or fabricate positions',async()=>{
  const {matchTitleWords}=await effects();
  assert.equal(matchTitleWords('希望',[word('Hope')]),null);
  assert.equal(matchTitleWords('God’s Promise',[word("GOD'S"),word('PROMISE')])[0].title,'God’s');
});

test('scattered title words match their own boxes without requiring reading order',async()=>{
  const {matchTitleWords}=await effects();
  const words=['WEDDING','THE','Sunday','A','COST','OF'].map((text,i)=>({...word(text),bbox:{x0:i*100,y0:i*30,x1:i*100+90,y1:i*30+25}}));
  const matched=matchTitleWords('The Cost of a Wedding',words);
  assert.deepEqual(matched.map(w=>w.text),['THE','COST','OF','A','WEDDING']);
  assert.deepEqual(matched.map(w=>w.bbox.x0),[100,400,500,300,0]);
  assert.equal(matchTitleWords('The Cost of a Wedding',[...words,word('THE')]),null);
  assert.equal(matchTitleWords('The Cost of a Wedding',words.filter(w=>w.text!=='OF')),null);
});

test('letter positions preserve the source shapes and the server casing',async()=>{
  const {matchTitleLetters}=await effects();
  const source={...word("GOD'S"),title:'God’s',symbols:Array.from("GOD'S",(text,i)=>({...word(text),bbox:{x0:i*20,y0:i*3,x1:i*20+16,y1:i*3+24}}))};
  const letters=matchTitleLetters(source);
  assert.equal(letters.map(l=>l.text).join(''),"GOD'S");
  assert.equal(letters.map(l=>l.title).join(''),'God’s');
  assert.deepEqual(letters.map(l=>l.bbox),source.symbols.map(l=>l.bbox));
});

test('incomplete, low-confidence or invalid letter boxes fall back to the word',async()=>{
  const {matchTitleLetters}=await effects();
  const source={...word('HOPE'),title:'Hope',symbols:Array.from('HOPE',text=>word(text))};
  assert.equal(matchTitleLetters({...source,symbols:source.symbols.slice(1)}),null);
  assert.equal(matchTitleLetters({...source,symbols:[word('H',20),...source.symbols.slice(1)]}),null);
  assert.equal(matchTitleLetters({...source,symbols:[word('N'),...source.symbols.slice(1)]}),null);
  assert.equal(matchTitleLetters({...source,symbols:[{...word('H'),bbox:{x0:2,y0:0,x1:2,y1:30}},...source.symbols.slice(1)]}),null);
});

test('letterboxed image coordinates stay inside the visible image',async()=>{
  const {contentRect}=await effects();
  const rect=contentRect({naturalWidth:400,naturalHeight:400,getBoundingClientRect:()=>({left:20,top:100,width:640,height:360})});
  assert.deepEqual(rect,{left:160,top:100,width:360,height:360});
});

test('percentage starts at zero and uses the observed 78-second initial estimate',async()=>{
  const {estimatedProgress}=await effects();
  assert.equal(estimatedProgress('uploading',0),0);
  assert.equal(estimatedProgress('uploading',300),5);
  assert.equal(estimatedProgress('queued',0),8);
  assert.equal(estimatedProgress('processing',39),46);
  assert.equal(estimatedProgress('processing',78),92);
  assert.equal(estimatedProgress('processing',900),92);
});

test('observed duration samples adapt progress without claiming completion',async()=>{
  const {estimatedProgress}=await effects();
  assert.equal(estimatedProgress('processing',10,[18,20,22]),46);
  assert.equal(estimatedProgress('processing',10,[18,20]),92*10/78);
  assert.equal(estimatedProgress('processing',39,[NaN,-1,900]),46);
  const values=Array.from({length:120},(_,seconds)=>estimatedProgress('processing',seconds,[18,20,22]));
  assert.ok(values.every((value,i)=>value<100&&(!i||value>=values[i-1])));
});
