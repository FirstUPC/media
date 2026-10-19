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

test('letterboxed image coordinates stay inside the visible image',async()=>{
  const {contentRect}=await effects();
  const rect=contentRect({naturalWidth:400,naturalHeight:400,getBoundingClientRect:()=>({left:20,top:100,width:640,height:360})});
  assert.deepEqual(rect,{left:160,top:100,width:360,height:360});
});

test('remaining time needs measured history and never claims a finished server job',async()=>{
  const {timeEstimate}=await effects();
  assert.equal(timeEstimate([],5),null);
  assert.equal(timeEstimate([10,12],5),null);
  assert.equal(timeEstimate([10,12,14],5),'Est. 3–13s left');
  assert.equal(timeEstimate([10,12,14],25),'Longer than recent scans');
  assert.equal(timeEstimate([NaN,-1,900],5),null);
});
