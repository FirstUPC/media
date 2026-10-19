// Presentation only. FUPCJ Server remains the sole source of title text/casing.
// The optional local worker finds positions; it never supplies a saved title.
const ENGINE='https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/';
const TIMING_KEY='fupcj-title-duration-v2';
let enginePromise;
const normalized=text=>String(text).normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]/gu,'');

export function matchTitleWords(title,words){
  const tokens=title.trim().split(/\s+/);
  if(!tokens.length||tokens.some(token=>!normalized(token)))return null;
  // Prefer an exact reading-order match when the slide has ordinary lines.
  for(let i=0;i<=words.length-tokens.length;i++){
    const group=words.slice(i,i+tokens.length);
    if(group.every((word,j)=>word.confidence>=50&&normalized(word.text)===normalized(tokens[j])))
      return group.map((word,j)=>({...word,title:tokens[j]}));
  }
  // Scattered layouts can be read in a different order. Use every title word
  // once, but reject ambiguous duplicates rather than choosing a wrong location.
  const names=tokens.map(normalized),groups=new Map();
  for(const name of new Set(names)){
    const candidates=words.filter(word=>word.confidence>=50&&normalized(word.text)===name);
    if(candidates.length!==names.filter(value=>value===name).length)return null;
    groups.set(name,candidates);
  }
  return tokens.map((token,i)=>({...groups.get(names[i]).shift(),title:token}));
}

const graphemes=text=>globalThis.Intl?.Segmenter
  ?Array.from(new Intl.Segmenter('en',{granularity:'grapheme'}).segment(text),part=>part.segment):Array.from(text);
const sameLetter=(a,b)=>a.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[‘’]/g,"'").replace(/[“”]/g,'"')===b.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[‘’]/g,"'").replace(/[“”]/g,'"');
const validBox=box=>box&&[box.x0,box.y0,box.x1,box.y1].every(Number.isFinite)&&box.x1>box.x0&&box.y1>box.y0;

export function matchTitleLetters(word){
  const letters=graphemes(word.title),symbols=word.symbols||[];
  if(!letters.length||letters.length>100||symbols.length!==letters.length||
    !sameLetter(symbols.map(symbol=>symbol.text).join(''),word.text))return null;
  if(!symbols.every((symbol,i)=>symbol.confidence>=50&&validBox(symbol.bbox)&&sameLetter(symbol.text,letters[i])))return null;
  return symbols.map((symbol,i)=>({...symbol,title:letters[i]}));
}

export function contentRect(image){
  const r=image.getBoundingClientRect();
  const scale=Math.min(r.width/image.naturalWidth,r.height/image.naturalHeight);
  const width=image.naturalWidth*scale,height=image.naturalHeight*scale;
  return {left:r.left+(r.width-width)/2,top:r.top+(r.height-height)/2,width,height};
}

export function estimatedProgress(state,elapsed,samples=[]){
  const times=samples.filter(n=>Number.isFinite(n)&&n>=1&&n<=600).sort((a,b)=>a-b);
  const expected=times.length>=3?Math.max(5,times[Math.floor(times.length/2)]):78;
  const seconds=Number.isFinite(elapsed)?Math.max(0,elapsed):0;
  if(state==='uploading')return Math.min(5,seconds/2);
  // Measured duration is an estimate, never evidence of a finished server job.
  return Math.max(state==='processing'?10:8,Math.min(92,92*seconds/expected));
}

function loadEngine(){
  if(!enginePromise)enginePromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    const timer=setTimeout(()=>{script.remove();reject(new Error('Layout helper unavailable'));},8000);
    script.src=ENGINE+'tesseract.min.js';script.crossOrigin='anonymous';
    script.onload=()=>{clearTimeout(timer);resolve(globalThis.Tesseract);};
    script.onerror=()=>{clearTimeout(timer);script.remove();reject(new Error('Layout helper unavailable'));};
    document.head.append(script);
  }).catch(error=>{enginePromise=null;throw error;});
  return enginePromise;
}

// Bounded, cancellable work on a resized copy, never a second server model.
function locateWords(image){
  let stopped=false,worker,timer;
  const cancel=()=>{stopped=true;clearTimeout(timer);if(worker){void worker.terminate();worker=null;}};
  const promise=(async()=>{
    timer=setTimeout(cancel,20000);
    try{
      await image.decode();if(stopped)return null;
      const canvas=document.createElement('canvas');
      const scale=Math.min(1,1400/Math.max(image.naturalWidth,image.naturalHeight));
      canvas.width=Math.round(image.naturalWidth*scale);canvas.height=Math.round(image.naturalHeight*scale);
      const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
      const engine=await loadEngine();if(stopped)return null;
      const created=await engine.createWorker('eng',1,{
        workerPath:ENGINE+'worker.min.js',
        corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',
        langPath:'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
        errorHandler:()=>{}
      });
      if(stopped){void created.terminate();return null;}worker=created;
      await worker.setParameters({tessedit_pageseg_mode:'11'});
      const result=await worker.recognize(canvas,{}, {blocks:true,text:false,imageBinary:true});
      if(stopped)return null;
      const words=(result.data.blocks||[]).flatMap(block=>(block.paragraphs||[]).flatMap(paragraph=>(paragraph.lines||[]).flatMap(line=>line.words||[])))
        .filter(word=>word.text?.trim()&&word.bbox&&word.bbox.x1>word.bbox.x0&&word.bbox.y1>word.bbox.y0).slice(0,300);
      let binary;
      if(result.data.imageBinary){
        const mask=new Image();mask.src=result.data.imageBinary;await mask.decode();if(stopped)return null;
        if(mask.naturalWidth===canvas.width&&mask.naturalHeight===canvas.height){
          const maskCanvas=document.createElement('canvas');maskCanvas.width=canvas.width;maskCanvas.height=canvas.height;
          const maskContext=maskCanvas.getContext('2d');maskContext.drawImage(mask,0,0);binary=maskContext.getImageData(0,0,canvas.width,canvas.height).data;
        }
      }
      return {canvas,words,binary};
    }catch{return null;}finally{cancel();}
  })();
  return {promise,cancel};
}

// Cut out the actual ink so letters can lift without carrying image rectangles.
function inkCrop(layout,box){
  if(!layout.binary||!validBox(box))return null;
  const {canvas,binary}=layout,x=Math.max(0,Math.floor(box.x0)),y=Math.max(0,Math.floor(box.y0));
  const width=Math.min(canvas.width,Math.ceil(box.x1))-x,height=Math.min(canvas.height,Math.ceil(box.y1))-y;
  if(width<=0||height<=0)return null;
  const crop=document.createElement('canvas');crop.width=width;crop.height=height;
  const ctx=crop.getContext('2d');ctx.drawImage(canvas,x,y,width,height,0,0,width,height);
  const pixels=ctx.getImageData(0,0,width,height);
  for(let row=0;row<height;row++)for(let col=0;col<width;col++){
    pixels.data[(row*width+col)*4+3]=255-binary[((y+row)*canvas.width+x+col)*4];
  }
  ctx.putImageData(pixels,0,0);return crop.toDataURL();
}

export function createTitleEffects(container,input,target,onFinish){
  const panel=container.querySelector('.title-progress');
  const label=container.querySelector('.title-progress-label');
  const percentLabel=container.querySelector('.title-progress-percent');
  const progress=container.querySelector('progress');
  const reduced=()=>globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let generation=0,state='idle',key='',watched=false,started=0,canSample=false,percent=0,bucket='unknown',bucketChosen=false;
  let interval,layoutTask,layout=null,source='',flight=null,animations=[],moving=false,motionTitle='',stopFlight=null,landTimer,completionTimer;
  let samples={cold:[],warm:[],unknown:[]};
  try{const saved=JSON.parse(localStorage.getItem(TIMING_KEY)||'{}');for(const name of Object.keys(samples))if(Array.isArray(saved?.[name]))samples[name]=saved[name].filter(n=>Number.isFinite(n)&&n>=1&&n<=600).slice(-12);}catch{}
  function showProgress(value,estimated=true){
    percent=Math.max(percent,Math.min(100,value));
    if(!panel)return;
    progress.max=100;progress.value=percent;
    percentLabel.textContent=`${estimated?'Estimated ':''}${Math.floor(percent)}%`;
    progress.setAttribute('aria-valuetext',`${Math.floor(percent)}% complete${estimated?' (estimated)':''}`);
  }
  function clock(){
    if(!panel||panel.hidden||moving)return;
    showProgress(estimatedProgress(state,(performance.now()-started)/1000,samples[bucket]));
  }
  function clearFlight(){
    animations.forEach(animation=>animation.cancel());animations=[];
    flight?.remove();flight=null;
    stopFlight?.();stopFlight=null;
  }
  function cancel(){
    generation++;clearInterval(interval);clearTimeout(landTimer);clearTimeout(completionTimer);completionTimer=null;
    layoutTask?.cancel();layoutTask=null;layout=null;source='';
    clearFlight();moving=false;watched=false;state='idle';key='';canSample=false;percent=0;bucket='unknown';bucketChosen=false;
    container.removeAttribute('data-title-landed');if(panel)panel.hidden=true;
  }
  function locate(){
    if(reduced()||layoutTask||layout)return;
    const image=target?.querySelector('img');if(!image?.src)return;
    source=image.src;const version=generation;layoutTask=locateWords(image);
    void layoutTask.promise.then(result=>{if(version===generation)layout=result;});
  }
  function busy(next,row){
    if(state==='idle'){
      started=performance.now();
    }
    if(row&&!bucketChosen){
      bucket=row.worker?row.worker.ready?'warm':'cold':'unknown';bucketChosen=true;
    }
    clearInterval(interval);interval=setInterval(clock,250);
    state=next;watched=true;
    if(panel){panel.hidden=false;label.textContent=next==='uploading'?'Uploading image…':next==='queued'?'Preparing analysis…':'Analyzing text…';progress.setAttribute('aria-label','Title processing');}
    clock();locate();
  }
  function stage(text,value){
    if(panel){panel.hidden=false;label.textContent=text;showProgress([93,95,97,99][value],false);}
  }
  function completedProgress(){
    clearInterval(interval);
    if(!panel)return;
    panel.hidden=false;label.textContent='Analysis complete';showProgress(100,false);
    clearTimeout(completionTimer);const version=generation;
    completionTimer=setTimeout(()=>{if(version===generation){panel.hidden=true;completionTimer=null;}},1200);
  }
  function finish(version){
    if(version!==generation)return;
    generation++;clearFlight();layoutTask?.cancel();layoutTask=null;layout=null;
    moving=false;state='complete';completedProgress();
    container.setAttribute('data-title-landed','');
    landTimer=setTimeout(()=>container.removeAttribute('data-title-landed'),900);onFinish();
  }
  async function animate(element,frames,options){
    const animation=element.animate(frames,{fill:'forwards',...options});animations.push(animation);
    try{await animation.finished;}catch{}
  }
  async function reveal(title,version){
    if(version!==generation)return;
    // Fast server replies should not discard a nearly finished local layout.
    if(!layout&&layoutTask){
      stage('Locating letters…',0);
      let timeout;
      await Promise.race([layoutTask.promise,new Promise(resolve=>{timeout=setTimeout(resolve,1200);})]);
      clearTimeout(timeout);if(version!==generation)return;
    }
    const image=target?.querySelector('img');
    const imageRect=image?.naturalWidth?contentRect(image):target?.getBoundingClientRect();
    const field=input.getBoundingClientRect();
    if(reduced()||document.hidden||!imageRect?.width||!field.width||!input.animate){finish(version);return;}
    const matches=layout&&image?.src===source?matchTitleWords(title,layout.words):null;
    const tokens=title.trim().split(/\s+/);
    // An overlay outside the clipped preview lets individually located letters fly.
    flight=document.createElement('div');flight.className='title-flight';flight.setAttribute('aria-hidden','true');document.body.append(flight);
    const abort=()=>finish(version);
    const mediaQuery=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    window.addEventListener('resize',abort);window.addEventListener('scroll',abort,{passive:true});
    document.addEventListener('visibilitychange',abort);mediaQuery?.addEventListener('change',abort);
    stopFlight=()=>{window.removeEventListener('resize',abort);window.removeEventListener('scroll',abort);document.removeEventListener('visibilitychange',abort);mediaQuery?.removeEventListener('change',abort);};
    const style=getComputedStyle(input),fontSize=parseFloat(style.fontSize),weight=style.fontWeight;
    const measure=document.createElement('canvas').getContext('2d');
    const font=style.fontFamily;measure.font=`${weight} ${fontSize}px ${font}`;
    const widths=tokens.map(token=>measure.measureText(token).width),space=measure.measureText(' ').width;
    const total=widths.reduce((sum,width)=>sum+width,0)+space*(tokens.length-1);
    const groupScale=Math.min(1.65,(imageRect.width-28)/Math.max(total,1));
    const groupLeft=imageRect.left+(imageRect.width-total*groupScale)/2;
    const groupTop=imageRect.top+imageRect.height*.5-fontSize*groupScale/2;
    let offset=0;
    const units=tokens.flatMap((token,i)=>{
      const match=matches?.[i],letters=match&&matchTitleLetters(match);
      const parts=letters||[{text:match?.text||token,title:token,bbox:match?.bbox}];
      let prefix='';
      const units=parts.map(part=>{
        prefix+=part.title;const finalWidth=measure.measureText(part.title).width;
        return {...part,offset:offset+measure.measureText(prefix).width-finalWidth,finalWidth,letter:!!letters};
      });
      offset+=widths[i]+space;return units;
    });
    const words=units.map(unit=>{
      const {bbox:box,offset,finalWidth,letter}=unit,token=unit.title;
      const left=box?imageRect.left+box.x0/layout.canvas.width*imageRect.width:groupLeft+offset*groupScale;
      const top=box?imageRect.top+box.y0/layout.canvas.height*imageRect.height:groupTop;
      const width=box?(box.x1-box.x0)/layout.canvas.width*imageRect.width:finalWidth*groupScale;
      const height=box?(box.y1-box.y0)/layout.canvas.height*imageRect.height:fontSize*groupScale;
      const node=document.createElement('span');node.className='title-flight-word';
      node.dataset.titleUnit=letter?'letter':box?'word':'fallback';
      Object.assign(node.style,{left:left+'px',top:top+'px',width:width+'px',height:height+'px',fontFamily:font,fontWeight:weight,fontSize:fontSize+'px'});
      const type=document.createElement('span');type.className='title-flight-type';type.textContent=unit.text;
      measure.font=`${weight} ${fontSize}px ${font}`;
      const rawWidth=Math.max(1,measure.measureText(type.textContent).width);
      type.style.transform=`scale(${width/rawWidth},${height/fontSize})`;type.style.transformOrigin='0 0';
      node.append(type);let ink;
      const crop=box&&inkCrop(layout,box);
      if(crop){
        ink=document.createElement('img');ink.src=crop;ink.alt='';node.append(ink);type.style.opacity='0';
      }
      flight.append(node);return {node,type,ink,left,top,width,height,offset,token,finalWidth};
    });
    const valid=()=>version===generation;
    stage(matches?'Recognized text':'Title recognized',1);
    // Reveal in spatial order, independent of the final title's word order.
    const spatial=[...words].sort((a,b)=>a.left-b.left||a.top-b.top);
    await Promise.all(spatial.map((word,i)=>animate(word.node,[
      {opacity:0,filter:'brightness(1) drop-shadow(0 0 0 transparent)'},
      {opacity:1,filter:'brightness(1.5) drop-shadow(0 0 12px #cce6ff)',offset:.65},
      {opacity:1,filter:'brightness(1.15) drop-shadow(0 0 8px #b8d7ff)'}
    ],{duration:600,delay:i/Math.max(1,words.length-1)*450})));
    if(!valid())return;
    await Promise.all(words.map(word=>animate(word.node,[
      {transform:'translate(0,0) scale(1)'},
      {transform:'translate(0,-8px) scale(1.08)',offset:.65},
      {transform:'translate(0,-6px) scale(1.04)'}
    ],{duration:380,easing:'cubic-bezier(.22,1,.36,1)'})));
    if(!valid())return;
    stage('Formatting title…',2);
    await Promise.all(words.flatMap(word=>[
      animate(word.type,[{opacity:word.ink?0:1,filter:'blur(2px)'},{opacity:1,filter:'blur(0px)'}],{duration:700}),
      ...(word.ink?[animate(word.ink,[{opacity:1,filter:'blur(0px)'},{opacity:0,filter:'blur(2px)'}],{duration:700})]:[])
    ]));
    if(!valid())return;
    // Use server casing exactly, including articles, names, and acronyms.
    words.forEach(word=>{word.type.textContent=word.token;word.type.style.transform=`scale(${word.width/Math.max(1,word.finalWidth)},${word.height/fontSize})`;});
    await Promise.all(words.map(word=>animate(word.node,[{transform:'translate(0,-6px) scale(1.04)'},{transform:`translate(${groupLeft+word.offset*groupScale-word.left}px,${groupTop-word.top}px) scale(${word.finalWidth*groupScale/word.width},${fontSize*groupScale/word.height})`}],{duration:650,easing:'cubic-bezier(.22,1,.36,1)'})));
    if(!valid())return;
    stage('Placing title…',3);
    const destination=input.getBoundingClientRect();
    const left=destination.left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft);
    const top=destination.top+(destination.height-fontSize)/2;
    const visibleWidth=destination.width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-2;
    await Promise.all(words.map((word,i)=>animate(word.node,[
      {transform:`translate(${groupLeft+word.offset*groupScale-word.left}px,${groupTop-word.top}px) scale(${word.finalWidth*groupScale/word.width},${fontSize*groupScale/word.height})`,opacity:1},
      {transform:`translate(${left+word.offset-word.left}px,${top-word.top}px) scale(${word.finalWidth/word.width},${fontSize/word.height})`,opacity:word.offset+word.finalWidth>visibleWidth?0:1,filter:'drop-shadow(0 0 0 transparent)'}
    ],{duration:850,delay:Math.min(i*18,180),easing:'cubic-bezier(.32,0,.16,1)'})));
    finish(version);
  }
  return {
    beginUpload(){cancel();canSample=true;busy('uploading');},
    update(row){
      const nextKey=row?`${row.id}:${row.imageKey||row.imageRevision||''}`:'';
      if(key&&key!==nextKey)cancel();key=nextKey;
      if(!row){cancel();return false;}
      if(moving){
        if(row.titleStatus==='complete'&&row.title===motionTitle)return true;
        cancel();key=nextKey;
      }
      if(row.titleStatus==='queued'||row.titleStatus==='processing'){busy(row.titleStatus,row);return false;}
      clearInterval(interval);
      if(row.titleStatus==='complete'&&watched){
        watched=false;
        if(canSample){
          const seconds=(performance.now()-started)/1000;
          if(seconds>=1&&seconds<=600){samples[bucket]=[...samples[bucket],seconds].slice(-12);try{localStorage.setItem(TIMING_KEY,JSON.stringify(samples));}catch{}}
        }
        if(row.title?.trim()&&!reduced()){
          moving=true;motionTitle=row.title;state='revealing';const version=generation;
          // Begin after render so the field has its final font and value.
          queueMicrotask(()=>{void reveal(row.title,version).catch(()=>finish(version));});return true;
        }
        completedProgress();
      }
      layoutTask?.cancel();layoutTask=null;layout=null;state=row.titleStatus;
      if(panel&&!completionTimer)panel.hidden=true;return false;
    },
    pause(){
      if(moving){finish(generation);return;}
      clearInterval(interval);state='paused';canSample=false;
      if(panel&&!panel.hidden)label.textContent='Connection interrupted…';
    },
    cancel,
    get moving(){return moving;}
  };
}
