// Presentation only. FUPCJ Server remains the sole source of title text/casing.
// The optional local worker finds positions; it never supplies a saved title.
const ENGINE='https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/';
const TIMING_KEY='fupcj-title-processing-times-v1';
let enginePromise;
const normalized=text=>String(text).normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]/gu,'');

export function matchTitleWords(title,words){
  const tokens=title.trim().split(/\s+/);
  if(!tokens.length||tokens.some(token=>!normalized(token)))return null;
  // Require the entire confirmed title in reading order. Do not invent boxes
  // for decorative lettering, scripts, or words this auxiliary pass missed.
  for(let i=0;i<=words.length-tokens.length;i++){
    const group=words.slice(i,i+tokens.length);
    if(group.every((word,j)=>word.confidence>=50&&normalized(word.text)===normalized(tokens[j])))
      return group.map((word,j)=>({...word,title:tokens[j]}));
  }
  return null;
}

export function contentRect(image){
  const r=image.getBoundingClientRect();
  const scale=Math.min(r.width/image.naturalWidth,r.height/image.naturalHeight);
  const width=image.naturalWidth*scale,height=image.naturalHeight*scale;
  return {left:r.left+(r.width-width)/2,top:r.top+(r.height-height)/2,width,height};
}

export function timeEstimate(samples,elapsed){
  const times=samples.filter(n=>Number.isFinite(n)&&n>=1&&n<=600).sort((a,b)=>a-b);
  if(times.length<3)return null;
  const low=times[Math.floor((times.length-1)*.2)]*.8;
  const high=times[Math.ceil((times.length-1)*.8)]*1.25;
  if(elapsed>=high)return 'Longer than recent scans';
  return `Est. ${Math.max(1,Math.ceil(low-elapsed))}–${Math.max(2,Math.ceil(high-elapsed))}s left`;
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
      const result=await worker.recognize(canvas,{}, {blocks:true,text:false});
      if(stopped)return null;
      const words=(result.data.blocks||[]).flatMap(block=>(block.paragraphs||[]).flatMap(paragraph=>(paragraph.lines||[]).flatMap(line=>line.words||[])))
        .filter(word=>word.text?.trim()&&word.bbox&&word.bbox.x1>word.bbox.x0&&word.bbox.y1>word.bbox.y0).slice(0,300);
      return {canvas,words};
    }catch{return null;}finally{cancel();}
  })();
  return {promise,cancel};
}

export function createTitleEffects(container,input,target,onFinish){
  const panel=container.querySelector('.title-progress');
  const label=container.querySelector('.title-progress-label');
  const timing=container.querySelector('.title-progress-time');
  const progress=container.querySelector('progress');
  const reduced=()=>globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let generation=0,state='idle',key='',watched=false,started=0,processingStarted=0,canSample=false;
  let interval,layoutTask,layout=null,source='',flight=null,animations=[],moving=false,motionTitle='',stopFlight=null,landTimer;
  let samples=[];
  try{samples=JSON.parse(localStorage.getItem(TIMING_KEY)||'[]');if(!Array.isArray(samples))samples=[];}catch{}
  function clock(){
    if(!panel||panel.hidden||moving)return;
    const elapsed=Math.max(0,Math.floor((performance.now()-started)/1000));
    const estimate=state==='processing'&&canSample?timeEstimate(samples,(performance.now()-processingStarted)/1000):null;
    timing.textContent=estimate?`${estimate} · ${elapsed}s elapsed`:
      state==='processing'?`Estimating time · ${elapsed}s elapsed`:`${elapsed}s elapsed`;
  }
  function clearFlight(){
    animations.forEach(animation=>animation.cancel());animations=[];
    flight?.remove();flight=null;
    stopFlight?.();stopFlight=null;
  }
  function cancel(){
    generation++;clearInterval(interval);clearTimeout(landTimer);
    layoutTask?.cancel();layoutTask=null;layout=null;source='';
    clearFlight();moving=false;watched=false;state='idle';key='';processingStarted=0;canSample=false;
    container.removeAttribute('data-title-landed');if(panel)panel.hidden=true;
  }
  function locate(){
    if(reduced()||layoutTask||layout)return;
    const image=target?.querySelector('img');if(!image?.src)return;
    source=image.src;const version=generation;layoutTask=locateWords(image);
    void layoutTask.promise.then(result=>{if(version===generation)layout=result;});
  }
  function busy(next){
    if(state==='idle'){
      started=performance.now();clearInterval(interval);interval=setInterval(clock,1000);
    }
    if(next==='processing'&&state!=='processing'){
      processingStarted=performance.now();canSample=state==='queued';
    }
    state=next;watched=true;
    if(panel){panel.hidden=false;label.textContent=next==='uploading'?'Uploading image…':next==='queued'?'Waiting to analyze…':'Analyzing text…';progress.removeAttribute('value');progress.setAttribute('aria-label',label.textContent);}
    clock();locate();
  }
  function stage(text,value){
    if(panel){panel.hidden=false;label.textContent=text;timing.textContent='Finishing title';progress.max=4;progress.value=value;progress.setAttribute('aria-label','Title animation');}
  }
  function finish(version){
    if(version!==generation)return;
    generation++;clearFlight();layoutTask?.cancel();layoutTask=null;layout=null;
    moving=false;state='complete';if(panel){progress.value=4;panel.hidden=true;}
    container.setAttribute('data-title-landed','');
    landTimer=setTimeout(()=>container.removeAttribute('data-title-landed'),900);onFinish();
  }
  async function animate(element,frames,options){
    const animation=element.animate(frames,{fill:'forwards',...options});animations.push(animation);
    try{await animation.finished;}catch{}
  }
  async function reveal(title,version){
    if(version!==generation)return;
    const image=target?.querySelector('img');
    const imageRect=image?.naturalWidth?contentRect(image):target?.getBoundingClientRect();
    const field=input.getBoundingClientRect();
    if(reduced()||document.hidden||!imageRect?.width||!field.width||!input.animate){finish(version);return;}
    const matches=layout&&image?.src===source?matchTitleWords(title,layout.words):null;
    const tokens=title.trim().split(/\s+/);
    // A single overlay outside the clipped preview allows the words to fly down.
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
    const words=tokens.map((token,i)=>{
      const match=matches?.[i],box=match?.bbox;
      const left=box?imageRect.left+box.x0/layout.canvas.width*imageRect.width:groupLeft+offset*groupScale;
      const top=box?imageRect.top+box.y0/layout.canvas.height*imageRect.height:groupTop;
      const width=box?(box.x1-box.x0)/layout.canvas.width*imageRect.width:widths[i]*groupScale;
      const height=box?(box.y1-box.y0)/layout.canvas.height*imageRect.height:fontSize*groupScale;
      const node=document.createElement('span');node.className='title-flight-word';
      Object.assign(node.style,{left:left+'px',top:top+'px',width:width+'px',height:height+'px',fontFamily:font,fontWeight:weight,fontSize:fontSize+'px'});
      const type=document.createElement('span');type.className='title-flight-type';type.textContent=match?.text||token;
      measure.font=`${weight} ${fontSize}px ${font}`;
      const rawWidth=Math.max(1,measure.measureText(type.textContent).width);
      type.style.transform=`scale(${width/rawWidth},${height/fontSize})`;type.style.transformOrigin='0 0';
      node.append(type);let ink;
      if(box){
        const crop=document.createElement('canvas');crop.width=box.x1-box.x0;crop.height=box.y1-box.y0;
        crop.getContext('2d').drawImage(layout.canvas,box.x0,box.y0,crop.width,crop.height,0,0,crop.width,crop.height);
        ink=document.createElement('img');ink.src=crop.toDataURL();ink.alt='';node.append(ink);type.style.opacity='0';
      }
      flight.append(node);const word={node,type,ink,left,top,width,height,offset,token,finalWidth:widths[i]};offset+=widths[i]+space;return word;
    });
    const valid=()=>version===generation;
    stage(matches?'Recognized text':'Title recognized',1);
    await Promise.all(words.map((word,i)=>animate(word.node,[{opacity:0,filter:'blur(5px) drop-shadow(0 0 14px #cce6ff)'},{opacity:1,filter:'blur(0px) drop-shadow(0 0 9px #b8d7ff99)'}],{duration:500,delay:Math.min(i*65,650)})));
    if(!valid())return;
    stage('Formatting title…',2);
    await Promise.all(words.flatMap(word=>[
      animate(word.type,[{opacity:word.ink?0:1},{opacity:1}],{duration:650}),
      ...(word.ink?[animate(word.ink,[{opacity:1},{opacity:0}],{duration:650})]:[])
    ]));
    if(!valid())return;
    // Use server casing exactly, including articles, names, and acronyms.
    words.forEach(word=>{word.type.textContent=word.token;word.type.style.transform=`scale(${word.width/Math.max(1,word.finalWidth)},${word.height/fontSize})`;});
    await Promise.all(words.map(word=>animate(word.node,[{transform:'translate(0,0) scale(1,1)'},{transform:`translate(${groupLeft+word.offset*groupScale-word.left}px,${groupTop-word.top}px) scale(${word.finalWidth*groupScale/word.width},${fontSize*groupScale/word.height})`}],{duration:650,easing:'cubic-bezier(.22,1,.36,1)'})));
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
    beginUpload(){cancel();busy('uploading');},
    update(row){
      const nextKey=row?`${row.id}:${row.imageKey||row.imageRevision||''}`:'';
      if(key&&key!==nextKey)cancel();key=nextKey;
      if(!row){cancel();return false;}
      if(moving){
        if(row.titleStatus==='complete'&&row.title===motionTitle)return true;
        cancel();key=nextKey;
      }
      if(row.titleStatus==='queued'||row.titleStatus==='processing'){busy(row.titleStatus);return false;}
      clearInterval(interval);
      if(row.titleStatus==='complete'&&watched){
        watched=false;
        if(canSample&&processingStarted){
          const seconds=(performance.now()-processingStarted)/1000;
          if(seconds>=1&&seconds<=600){samples=[...samples,seconds].slice(-12);try{localStorage.setItem(TIMING_KEY,JSON.stringify(samples));}catch{}}
        }
        if(row.title?.trim()&&!reduced()){
          moving=true;motionTitle=row.title;state='revealing';const version=generation;
          // Begin after render so the field has its final font and value.
          queueMicrotask(()=>{void reveal(row.title,version).catch(()=>finish(version));});return true;
        }
      }
      layoutTask?.cancel();layoutTask=null;layout=null;state=row.titleStatus;
      if(panel)panel.hidden=true;return false;
    },
    pause(){cancel();},
    cancel,
    get moving(){return moving;}
  };
}
