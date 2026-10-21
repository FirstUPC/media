import {createTitleEffects} from './title-effects.mjs?v=1.3.2';
// FUPCJ Server owns uploaded slides, extraction, edits, and durable publication.
export const BACKEND='https://desktop-vjt2br2.tail385c9d.ts.net';
export function workerLabel(worker){
  if(!worker)return 'Model status unavailable';
  if(worker.ready)return worker.temporaryWarmup?'Model ready · temporary warm standby':worker.scheduled?'Model ready · warm standby':'Model ready';
  if(worker.loaded)return 'Warming title model…';
  return worker.phase&&!['Off','Ready'].includes(worker.phase)?worker.phase:'Title model is not loaded';
}
// Calendar dates remain plain YYYY-MM-DD strings. The server evaluates them in
// America/New_York; converting through the browser's timezone would shift dates.
export function normalizeAvailabilityDate(value){
  if(value==null||value==='')return '';
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('Choose a valid service date.');
  const [year,month,day]=value.split('-').map(Number);
  const date=new Date(value+'T12:00:00Z');
  if(year<1||!Number.isFinite(date.getTime())||date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)throw new Error('Choose a valid service date.');
  return value;
}
export function isSundayDate(value){
  const date=normalizeAvailabilityDate(value);
  return !!date&&new Date(date+'T12:00:00Z').getUTCDay()===0;
}
export function normalizeTargetServicePeriod(value,date,{required=false}={}){
  if(value==null)value='';
  if(!['','am','pm'].includes(value))throw new Error('Choose AM or PM for the Sunday service.');
  if(!isSundayDate(date)){
    if(value)throw new Error('AM or PM can only be selected with a Sunday date.');
    return '';
  }
  if(required&&!value)throw new Error('Choose AM or PM for the Sunday service before uploading or saving.');
  return value;
}
export function createAvailabilityField(input,{container,am,pm,onRender=()=>{}}={}){
  let dirty=false,period='';
  function readDate(){if(input.validity&&!input.validity.valid)throw new Error('Choose a valid service date.');return normalizeAvailabilityDate(input.value);}
  function render(){
    let sunday=false;try{sunday=isSundayDate(input.value);}catch{}
    if(!sunday)period='';
    if(container)container.hidden=!sunday;
    if(am)am.checked=period==='am';
    if(pm)pm.checked=period==='pm';
    onRender(input.value);
  }
  input.addEventListener('input',()=>{dirty=true;render();});
  for(const [control,value] of [[am,'am'],[pm,'pm']])control?.addEventListener('change',()=>{dirty=true;period=control.checked?value:'';render();});
  render();
  return {
    get value(){return readDate();},
    get targetServicePeriod(){return normalizeTargetServicePeriod(period,readDate(),{required:!!container});},
    sync(row,{force=false}={}){if(force||!dirty){input.value=normalizeAvailabilityDate(row?.availableStartingDate);period=normalizeTargetServicePeriod(row?.targetServicePeriod,input.value);dirty=false;render();}},
    reset(){input.value='';period='';dirty=false;render();},
    set disabled(value){input.disabled=value;if(am)am.disabled=value;if(pm)pm.disabled=value;}
  };
}

export function createMediaClient(getToken, fetcher=fetch) {
  async function request(path, {method='GET', body}={}) {
    const headers={Authorization:'Bearer '+await getToken()};
    if(body && !(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
    const response=await fetcher(BACKEND+'/api/media-share/'+path,{method,headers,body});
    const value=await response.json();
    if(!response.ok){const e=new Error(value.error||'FUPCJ Server could not accept this change.');e.status=response.status;throw e;}
    return value;
  }
  const item=id=>'drops/'+encodeURIComponent(id);
  return {
    get:id=>request(item(id)),
    recover:rid=>request('requests/'+encodeURIComponent(rid)),
    upload:(file,rid,prior,availableStartingDate=prior?.availableStartingDate||'',targetServicePeriod=availableStartingDate===prior?.availableStartingDate?(prior?.targetServicePeriod||''):'')=>{const form=new FormData();form.append('image',file);form.append('requestId',rid);form.append('availableStartingDate',normalizeAvailabilityDate(availableStartingDate));form.append('targetServicePeriod',normalizeTargetServicePeriod(targetServicePeriod,availableStartingDate));if(prior)form.append('revision',prior.revision);return request(prior?item(prior.id):'drops',{method:'POST',body:form});},
    update:(row,changes)=>request(item(row.id),{method:'PATCH',body:{...changes,revision:row.revision}}),
    remove:row=>request(item(row.id),{method:'DELETE',body:{revision:row.revision}})
  };
}

// A lost response is not evidence that an upload failed. Retain its exact
// request identity and payload until a receipt or definitive rejection arrives.
export function createUploadReceipt(api,{save,fingerprint=async file=>{
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
},createId=()=>crypto.randomUUID()}={}){
  let pending=null,originalFile=null;
  function settle(row){pending=null;originalFile=null;save({id:row.id});return row;}
  async function send(){
    try{return settle(await api.upload(originalFile,pending.requestId,pending.prior,pending.availableStartingDate,pending.targetServicePeriod||''));}
    catch(error){
      // 408/429 and 5xx can be retried with the same identity. Other 4xx are
      // explicit rejections, so retaining an ambiguous receipt is unnecessary.
      if(error.status>=400&&error.status<500&&![408,429].includes(error.status)){
        const prior=pending.prior;pending=null;originalFile=null;save(prior?{id:prior.id}:null);
      }
      throw error;
    }
  }
  async function recover(){
    if(!pending)return null;
    try{return settle(await api.recover(pending.requestId));}
    catch(error){if(error.status===404)return null;throw error;}
  }
  return {
    get pending(){return pending;},
    restore(value){if(value?.requestId){pending=value;originalFile=null;}},
    recover,
    async begin(file,prior,availableStartingDate,targetServicePeriod=''){
      if(pending)throw new Error('Resolve the pending upload before choosing a new slide.');
      const hash=await fingerprint(file);
      pending={requestId:createId(),fingerprint:hash,name:file.name,availableStartingDate,targetServicePeriod:normalizeTargetServicePeriod(targetServicePeriod,availableStartingDate),prior:prior?{id:prior.id,revision:prior.revision}:null};
      originalFile=file;save(pending);
      return send();
    },
    async retry(candidate){
      if(!pending)throw new Error('There is no pending upload.');
      const row=await recover();if(row)return {row,recovered:true};
      if(candidate){
        if(!pending.fingerprint||await fingerprint(candidate)!==pending.fingerprint)throw new Error('This is a different slide. Select the original pending file, then use New drop after its upload is resolved.');
        originalFile=candidate;
      }
      if(!originalFile)throw new Error('Select the original pending file to retry, or check its receipt again.');
      return {row:await send(),recovered:false};
    }
  };
}

export function createTitleField(container,api,onChange=()=>{},scanTarget=null) {
  container.innerHTML='<label class="field-label">Auto Title</label><div class="auto-title-row"><input aria-label="Auto Title" maxlength="100" readonly placeholder="Slide title appears here"><button class="btn" type="button" aria-label="Edit title" title="Edit title" disabled>✎</button></div><div class="title-progress" hidden><div class="title-progress-heading"><span class="title-progress-label" role="status" aria-live="polite"></span><span class="title-progress-percent"></span></div><progress aria-label="Title processing" max="100" value="0"></progress></div><div class="title-worker-status" hidden></div><div class="status" role="status" aria-live="polite"></div>';
  const input=container.querySelector('input'),button=container.querySelector('button'),status=container.querySelector('.status');
  let row=null,epoch=0,timer,editing=false,saving=false,uploadPending=false;
  const effects=createTitleEffects(container,input,scanTarget,()=>render());
  function scanning(state='idle') {
    const busy=['uploading','queued','processing','revealing'].includes(state);
    for(const element of [container,scanTarget])if(element){
      element.setAttribute('data-ai-state',state);
      element.setAttribute('aria-busy',String(busy));
    }
  }
  function render() {
    const moving=effects.update(row);
    const workerStatus=container.querySelector('.title-worker-status');
    if(workerStatus){workerStatus.hidden=!row;workerStatus.textContent=row?workerLabel(row.worker):'';}
    scanning(moving?'revealing':row?.titleStatus||'idle');
    if(!editing)input.value=row?.title||'';
    const complete=row?.titleStatus==='complete';
    button.disabled=!complete||saving||moving;input.readOnly=!editing||saving||moving;
    button.textContent=editing?'Save':'✎';button.setAttribute('aria-label',editing?'Save title':'Edit title');
    status.textContent=moving?'Text recognized. Arranging it in the title field…':!row?'Upload a slide. The title will appear here.':
      row.titleStatus==='error'?'The title could not be read. Replace the slide to try again.':
      !complete?(row.phase||'Reading the title on FUPCJ Server…'):
      !row.published?(row.publishError||'Title ready. Syncing to MediaShare…'):
      row.uncertain?'Please review the title before using it.':!row.title?'No distinct title found. Use the pencil to enter one.':'Title ready. Use the pencil to make a correction.';
  }
  async function poll(id,version) {
    try {
      const next=await api.get(id);if(version!==epoch)return;
      // Keep an in-progress edit and its original revision. A conflicting save
      // is rejected by the server, never silently written over a newer image.
      if(!editing&&!saving){row=next;render();onChange(row);}
    } catch(e){if(version!==epoch)return;effects.pause();if(row?.titleStatus==='complete')render();scanning('paused');status.textContent=e.message;}
    if(version===epoch)timer=setTimeout(()=>poll(id,version),2500);
  }
  button.onclick=async()=>{
    if(!row||row.titleStatus!=='complete'||saving||effects.moving)return;
    if(!editing){editing=true;render();input.focus();return;}
    const version=epoch;saving=true;render();
    try{const next=await api.update(row,{title:input.value});if(version!==epoch)return;row=next;editing=false;onChange(row);}
    catch(e){if(version===epoch){scanning('paused');status.textContent=e.message;saving=false;button.disabled=false;input.readOnly=false;return;}}
    finally{if(version===epoch)saving=false;}
    if(version===epoch)render();
  };
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();button.click();}if(e.key==='Escape'){editing=false;render();}});
  return {
    beginUpload(){clearTimeout(timer);epoch++;row=null;editing=false;saving=false;uploadPending=true;input.value='';button.disabled=true;input.readOnly=true;const workerStatus=container.querySelector('.title-worker-status');if(workerStatus)workerStatus.hidden=true;effects.beginUpload();scanning('uploading');status.textContent='Keep this page open until the image is received.';},
    show(next){clearTimeout(timer);epoch++;if(!uploadPending)effects.cancel();uploadPending=false;editing=false;saving=false;row=next;render();if(next)void poll(next.id,epoch);},
    message(text){effects.pause();scanning('paused');status.textContent=text;},
    get row(){return row;},
    close(){clearTimeout(timer);epoch++;effects.cancel();uploadPending=false;row=null;editing=false;render();}
  };
}
