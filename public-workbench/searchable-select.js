import {icon} from './components.js';

const installations=new WeakMap();
let sequence=0;
const normalized=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replaceAll('\\','/');

// Keep the native select as the form control; only replace its oversized popup.
export function installSearchableSelects(root=document,{minimumOptions=8,signal}={}){
  if(installations.has(root))return installations.get(root);
  const doc=root.ownerDocument||root,win=doc.defaultView,lifetime=new AbortController();
  let active=null;
  if(!doc.querySelector('link[data-searchable-select-style]')){
    const style=doc.createElement('link');style.rel='stylesheet';style.href=new URL('./searchable-select.css',import.meta.url).href;style.dataset.searchableSelectStyle='';doc.head.append(style);
  }
  const eligible=select=>select?.tagName==='SELECT'&&!select.multiple&&select.size<=1&&!select.matches(':disabled')&&select.dataset.searchable!=='false'&&(select.hasAttribute('data-searchable')||select.options.length>=minimumOptions||[...select.options].some(option=>option.text.length>100));
  const visible=select=>select.isConnected&&!select.matches(':disabled')&&select.getClientRects().length>0;
  function close(restoreFocus=false){
    const state=active;if(!state)return;active=null;
    state.observer.disconnect();state.controller.abort();
    if(state.popup.matches(':popover-open'))state.popup.hidePopover();state.popup.remove();
    for(const [name,value] of state.attributes){if(value===null)state.select.removeAttribute(name);else state.select.setAttribute(name,value);}
    if(restoreFocus&&visible(state.select))state.select.focus({preventScroll:true});
  }
  function open(select,query=''){
    if(active?.select===select){active.input.focus();return;}
    close();
    if(!visible(select))return;
    const name=select.getAttribute('aria-label')||[...select.labels].map(label=>label.textContent.trim()).join(' ')||'选项';
    const id='search-select-'+(++sequence),popup=doc.createElement('div');popup.className='search-select-popup';popup.dataset.searchSelectPopup='';popup.popover='auto';popup.setAttribute('role','dialog');popup.setAttribute('aria-label',name+'选择');
    const search=doc.createElement('div');search.className='search-select-search';search.innerHTML=icon('search');
    const input=doc.createElement('input');input.type='search';input.placeholder='搜索名称或路径';input.autocomplete='off';input.spellcheck=false;input.dataset.searchSelectInput='';input.value=query;input.setAttribute('role','combobox');input.setAttribute('aria-label','搜索'+name);input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','true');input.setAttribute('aria-controls',id);search.append(input);
    const list=doc.createElement('div');list.id=id;list.className='search-select-options';list.setAttribute('role','listbox');list.setAttribute('aria-label',name);
    const status=doc.createElement('p');status.className='search-select-status';status.dataset.searchSelectStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    popup.append(search,list,status);(select.closest('dialog')||doc.body).append(popup);
    const attributes=['aria-expanded','aria-controls'].map(key=>[key,select.getAttribute(key)]);
    select.setAttribute('aria-expanded','true');select.setAttribute('aria-controls',id);
    const controller=new AbortController(),local={signal:controller.signal};
    const state={select,popup,input,list,status,attributes,controller,observer:null,items:[],current:null,currentKey:null,composing:false};active=state;
    const enabled=option=>!option.disabled&&!(option.parentElement?.tagName==='OPTGROUP'&&option.parentElement.disabled);
    const optionKey=option=>JSON.stringify([option.value,option.text,option.dataset.label||'',option.dataset.description||'',option.parentElement?.tagName==='OPTGROUP'?option.parentElement.label:'']);
    function position(){
      if(active!==state)return;
      const rect=select.getBoundingClientRect();
      if(!visible(select)||rect.bottom<0||rect.top>win.innerHeight||rect.right<0||rect.left>win.innerWidth){close();return;}
      const margin=12,gap=6,width=Math.min(760,Math.max(300,rect.width),win.innerWidth-margin*2);
      const below=win.innerHeight-rect.bottom-margin-gap,above=rect.top-margin-gap,down=below>=260||below>=above;
      popup.style.width=width+'px';popup.style.maxHeight=Math.max(80,Math.min(420,down?below:above))+'px';
      popup.style.left=Math.max(margin,Math.min(rect.left,win.innerWidth-width-margin))+'px';
      popup.style.top=Math.max(margin,Math.min(down?rect.bottom+gap:rect.top-gap-popup.getBoundingClientRect().height,win.innerHeight-popup.getBoundingClientRect().height-margin))+'px';
    }
    function highlight(option,scroll=true){
      state.current=option||null;
      state.currentKey=option?optionKey(option):null;
      list.querySelector('[data-active]')?.removeAttribute('data-active');
      const row=option&&list.querySelector('[data-search-select-option="'+option.index+'"]');
      if(row){row.dataset.active='';input.setAttribute('aria-activedescendant',row.id);if(scroll)row.scrollIntoView({block:'nearest'});}else input.removeAttribute('aria-activedescendant');
    }
    function render(){
      if(active!==state)return;
      const words=normalized(input.value).trim().split(/\s+/).filter(Boolean);
      state.items=[...select.options].filter(option=>!option.hidden&&!option.parentElement?.hidden&&words.every(word=>normalized([option.text,option.value,option.dataset.label,option.dataset.description,option.parentElement?.label].join(' ')).includes(word)));
      const fragment=doc.createDocumentFragment();
      for(const option of state.items){
        const row=doc.createElement('div');row.id=id+'-'+option.index;row.className='search-select-option';row.dataset.searchSelectOption=String(option.index);row.setAttribute('role','option');row.setAttribute('aria-selected',String(option.selected));row.setAttribute('aria-disabled',String(!enabled(option)));row.title=option.text;
        const split=option.text.indexOf(' · '),label=option.dataset.label||(split>0?option.text.slice(0,split):option.text),description=option.dataset.description||(split>0?option.text.slice(split+3):'');
        const title=doc.createElement('span');title.className='search-select-label';title.textContent=label;row.append(title);
        if(description){const detail=doc.createElement('span');detail.className='search-select-description';detail.textContent=description;row.append(detail);}
        fragment.append(row);
      }
      list.replaceChildren(fragment);status.textContent=state.items.length?`${state.items.length} 项`:'没有匹配的选项';
      let retained=state.items.includes(state.current)?state.current:null;
      // Polling may rebuild every option. Retain only an unambiguous identity,
      // never an old index or a duplicate value belonging to another option.
      if(!retained&&state.current&&!select.contains(state.current)){
        const matches=state.items.filter(option=>optionKey(option)===state.currentKey);
        if(matches.length===1)retained=matches[0];
      }
      const current=retained&&enabled(retained)?retained:state.items.find(option=>option.selected&&enabled(option))||state.items.find(enabled);
      position();highlight(current);
    }
    function choose(option){
      if(!option||!visible(select)||select.options[option.index]!==option||!enabled(option))return;
      const previous=select.selectedIndex;select.selectedIndex=option.index;close(true);
      if(previous!==select.selectedIndex){select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));}
    }
    input.addEventListener('input',()=>{state.current=null;state.currentKey=null;render();},local);
    input.addEventListener('compositionstart',()=>{state.composing=true;},local);
    input.addEventListener('compositionend',()=>{state.composing=false;render();},local);
    input.addEventListener('keydown',event=>{
      if(event.isComposing||state.composing||event.keyCode===229)return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
      else if(event.key==='Enter'){event.preventDefault();event.stopPropagation();choose(state.current);}
      else if(['ArrowDown','ArrowUp','PageDown','PageUp'].includes(event.key)){
        event.preventDefault();const options=state.items.filter(enabled),index=options.indexOf(state.current),step=event.key.startsWith('Page')?8:1,direction=event.key.endsWith('Down')?1:-1;
        highlight(options[Math.max(0,Math.min(options.length-1,index<0?0:index+step*direction))]);
      }else if(event.key==='Tab')close(true);
    },local);
    list.addEventListener('pointerdown',event=>event.preventDefault(),local);
    list.addEventListener('pointermove',event=>{const row=event.target.closest('[data-search-select-option]'),option=row&&select.options[Number(row.dataset.searchSelectOption)];if(option&&enabled(option))highlight(option,false);},local);
    list.addEventListener('click',event=>{const row=event.target.closest('[data-search-select-option]');if(row)choose(select.options[Number(row.dataset.searchSelectOption)]);},local);
    popup.addEventListener('toggle',event=>{if(event.newState==='closed'&&active===state)close();},local);
    select.addEventListener('change',render,local);
    win.addEventListener('resize',position,local);
    doc.addEventListener('scroll',event=>{if(!popup.contains(event.target))position();},{...local,capture:true});
    state.observer=new MutationObserver(records=>{
      if(!visible(select)){close();return;}
      if(records.some(record=>select.contains(record.target)))render();
    });
    popup.showPopover();render();input.focus();
    state.observer.observe(doc.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','hidden','selected','value','label']});
  }
  function pointer(event){
    if(event.type==='pointerdown'&&event.button!==0)return;
    const select=event.target.closest?.('select');
    if(eligible(select)){event.preventDefault();if(event.type==='click')open(select);else select.focus({preventScroll:true});}
    else if(active&&!active.popup.contains(event.target)&&event.target!==active.select)close();
  }
  root.addEventListener('pointerdown',pointer,{capture:true,signal:lifetime.signal});
  root.addEventListener('click',pointer,{capture:true,signal:lifetime.signal});
  root.addEventListener('keydown',event=>{
    const select=event.target;if(!eligible(select)||event.ctrlKey||event.metaKey||event.isComposing||event.keyCode===229)return;
    if(['ArrowDown','ArrowUp','Enter',' '].includes(event.key)||event.key.length===1){event.preventDefault();open(select,event.key.length===1&&event.key!==' '?event.key:'');}
  },{capture:true,signal:lifetime.signal});
  root.addEventListener('focusin',event=>{if(active&&!active.popup.contains(event.target)&&event.target!==active.select)close();},{signal:lifetime.signal});
  const dispose=()=>{close();lifetime.abort();installations.delete(root);};installations.set(root,dispose);
  if(signal?.aborted)dispose();else signal?.addEventListener('abort',dispose,{once:true,signal:lifetime.signal});
  return dispose;
}
