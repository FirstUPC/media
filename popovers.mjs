// Native details keep click/touch/keyboard access. Hover/focus also opens help;
// an explicit click pins it so editable notes do not disappear while typing.
export function enhancePopovers(root){
  for(const details of root.querySelectorAll('.popover')){
    const summary=details.querySelector('summary'),panel=details.querySelector('.popover-panel');
    let pinned=false,hovered=false,dismissed=false,closeTimer;
    function position(){
      if(!details.open)return;
      const anchor=summary.getBoundingClientRect(),box=panel.getBoundingClientRect();
      const width=document.documentElement.clientWidth,height=window.innerHeight;
      const below=anchor.bottom+8,above=anchor.top-box.height-8;
      const top=below+box.height<=height-12?below:Math.max(12,above);
      panel.style.setProperty('--popover-left',Math.max(12,Math.min(anchor.left,width-box.width-12))+'px');
      panel.style.setProperty('--popover-top',top+'px');
    }
    function open(){clearTimeout(closeTimer);if(dismissed)return;details.open=true;position();}
    function close(){clearTimeout(closeTimer);details.open=false;pinned=false;}
    function leave(){
      clearTimeout(closeTimer);
      closeTimer=setTimeout(()=>{if(!pinned&&!hovered&&!details.contains(document.activeElement))close();},160);
    }
    details.addEventListener('pointerenter',()=>{hovered=true;dismissed=false;open();});
    details.addEventListener('pointerleave',()=>{hovered=false;leave();});
    details.addEventListener('focusin',open);
    details.addEventListener('focusout',()=>{dismissed=false;leave();});
    summary.addEventListener('click',event=>{
      event.preventDefault();pinned=!pinned;dismissed=!pinned;
      if(pinned){dismissed=false;open();}else close();
    });
    details.addEventListener('keydown',event=>{
      if(event.key!=='Escape')return;
      event.preventDefault();dismissed=true;close();summary.focus();
    });
    document.addEventListener('pointerdown',event=>{
      if(!details.contains(event.target)){close();dismissed=false;}
    });
    details.addEventListener('toggle',position);
    window.addEventListener('resize',position);
    window.addEventListener('scroll',position,{passive:true});
    new ResizeObserver(position).observe(panel);
  }
}
