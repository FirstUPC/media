import {createTitleEffects} from './title-effects.mjs?v=1.3.0';
// FUPCJ Server owns uploaded slides, extraction, edits, and durable publication.
export const BACKEND='https://desktop-vjt2br2.tail385c9d.ts.net';
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
    upload:(file,rid,prior)=>{const form=new FormData();form.append('image',file);form.append('requestId',rid);if(prior)form.append('revision',prior.revision);return request(prior?item(prior.id):'drops',{method:'POST',body:form});},
    update:(row,changes)=>request(item(row.id),{method:'PATCH',body:{...changes,revision:row.revision}}),
    remove:row=>request(item(row.id),{method:'DELETE',body:{revision:row.revision}})
  };
}

export function createTitleField(container,api,onChange=()=>{},scanTarget=null) {
  container.innerHTML='<label class="field-label">Auto Title</label><div class="auto-title-row"><input aria-label="Auto Title" maxlength="100" readonly placeholder="Choose a slide to read its title"><button class="btn" type="button" aria-label="Edit title" title="Edit title" disabled>✎</button></div><div class="title-progress" hidden><div class="title-progress-heading"><span class="title-progress-label" role="status" aria-live="polite"></span><span class="title-progress-time"></span></div><progress aria-label="Title processing"></progress></div><div class="status" role="status" aria-live="polite"></div>';
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
    catch(e){if(version===epoch){status.textContent=e.message;saving=false;button.disabled=false;input.readOnly=false;return;}}
    finally{if(version===epoch)saving=false;}
    if(version===epoch)render();
  };
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();button.click();}if(e.key==='Escape'){editing=false;render();}});
  return {
    beginUpload(){clearTimeout(timer);epoch++;row=null;editing=false;saving=false;uploadPending=true;input.value='';button.disabled=true;input.readOnly=true;effects.beginUpload();scanning('uploading');status.textContent='Keep this page open until the image is received.';},
    show(next){clearTimeout(timer);epoch++;if(!uploadPending)effects.cancel();uploadPending=false;editing=false;saving=false;row=next;render();if(next)void poll(next.id,epoch);},
    message(text){effects.pause();scanning('paused');status.textContent=text;},
    get row(){return row;},
    close(){clearTimeout(timer);epoch++;effects.cancel();uploadPending=false;row=null;editing=false;render();}
  };
}
