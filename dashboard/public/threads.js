(function(window,document){
  'use strict';
  // "Story threads": the right-rail panel over the `threads` summary of a sweep snapshot (lib/intelligence/threads.mjs summarizeThreads():
  // {at, count, top:[{id,title,status,first,last,memberCount,kinds,sources,reports,observations,maxLevel,countries,entities,members}]}) and a
  // modal thread sheet over GET /api/threads/:id and GET /api/entities/:id (lib/intelligence/risk-routes.mjs). A thread is events the
  // entity graph links by rule (one story from several outlets; a report and an observation of the same strait, site or CVE; observations of
  // different kinds at one place): a reading aid, not a confirmation. The source count is of outlets and providers, not of independent proof.
  // mount(options):
  //   t(key, fallback), locale   the page's text (groups `threads`, `intelligence.kind_*`, `inspector.level.*`) and time locale
  //   getThreads()               the snapshot's own threads object (the page's D.threads)
  //   isReplay()                 a sweep replay holds the page: the sheet reads the live graph, so the entry points are off then
  //   fetchJson(url)             reads the API (without it the sheet is off: file pages, offline shell)
  //   openEvent(id), openCountry(iso3)   the record inspector and the country sheet (defaults: CrucixIntelligence / CrucixCountry)
  //   now()                      the page clock of the age labels
  const THREAD=/^thread-[a-f0-9]{16}$/,EVENT_ID=/^event-[0-9a-f]{32}$/,ISO3=/^[A-Z]{3}$/,ENTITY=/^(?:country|chokepoint|site|actor|cve):[A-Za-z0-9_.-]{1,80}$/;
  const ISO_TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
  const LEVELS=['critical','high','watch','info'],STATUSES=['emerging','escalating','active','fading'],TYPES=['country','chokepoint','site','actor','cve'],TOP=8,
    TOPICS=['conflict','politics','technology','disaster','health','economy'],FILTER_KEY='crucix_threads_topic_v1';
  // The panel's topic filter: 'all' or one of TOPICS, remembered on this browser (a convenience; storage may be blocked).
  let topicFilter=(()=>{try{const saved=window.localStorage?.getItem(FILTER_KEY);return TOPICS.includes(saved)?saved:'all';}catch{return 'all';}})();
  const COPY={title:'Story threads',intro:'Records the entity graph links: one story from several outlets, a report and an observation of the same strait, site or CVE, or observations of different kinds at one place. Linked is not confirmed.',
    unavailable:'Story threads are not available.',empty:'No linked story in the last 72 hours.',summary:'{count} threads in the last 72 hours',
    status_emerging:'Emerging',status_active:'Active',status_fading:'Fading',status_escalating:'Escalating',conflict:'Armed conflict',filterLabel:'Show threads by topic',filterAll:'All',filterEmpty:'No thread of this topic in the last 72 hours.',
    topic_conflict:'Conflict',topic_politics:'Politics',topic_technology:'Technology',topic_disaster:'Disaster',topic_health:'Health',topic_economy:'Economy',meta:'{members} records · {sources} sources',observations:'{count} observations',
    sheet:'Story thread',close:'Close',loading:'Loading the thread…',error:'Could not load the thread. Close and reopen it to try again.',notFound:'This thread is no longer in the last 72 hours.',
    span:'{first} – {last}',records:'Records',links:'Links',linksSummary:'{story} same-story links · {cooccurs} co-occurrence links',
    linkHelp:'A same-story link joins reports with alike titles from different outlets; a co-occurrence joins records naming the same strait, site, actor or CVE, or observations within 100 km and a day. Syndicated copies of one wire story are one source.',
    entities:'Named in the thread',countries:'Countries',entity:'Entity',entityEvents:'Records in the last 7 days',neighbors:'Named together with',neighborCount:'{count} records',entityThreads:'Threads',
    entityNone:'No record names this entity in the last 7 days.',back:'Back to the thread',type_country:'Country',type_chokepoint:'Chokepoint',type_site:'Military area',type_actor:'Threat actor',type_cve:'Vulnerability',
    rel_located:'located',rel_near:'nearby','rel_located-in':'located',rel_mentions:'named',rel_involves:'named',untitled:'Title unavailable',open:'Open the thread',
    replayNote:'The thread sheet reads the live graph, so it is off during the replay. The list shown is the replayed sweep’s own.'};
  let opts=null,nodes=null,seq=0,opener=null,finished=true,current=null;
  const log=error=>{try{console.error('[threads]',error);}catch{}};
  const guarded=fn=>(...args)=>{try{return fn(...args);}catch(error){log(error);}};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  function tx(path,fallback){try{const value=opts&&typeof opts.t==='function'?opts.t(path,fallback):fallback;return typeof value==='string'&&value?value:fallback;}catch{return fallback;}}
  function fill(value,values){for(const [from,to] of Object.entries(values||{}))value=value.split('{'+from+'}').join(String(to));return value;}
  const say=(key,values)=>fill(tx('threads.'+key,COPY[key]),values);
  const kindName=kind=>tx('intelligence.kind_'+kind,kind);
  function inReplay(){try{if(opts&&typeof opts.isReplay==='function')return !!opts.isReplay();const replay=window.CrucixReplay;return !!(replay&&typeof replay.active==='function'&&replay.active());}catch{return false;}}
  const live=()=>!!opts&&typeof opts.fetchJson==='function';
  const isoMs=value=>{const ms=typeof value==='string'&&ISO_TIME.test(value)?Date.parse(value):NaN;return Number.isFinite(ms)?ms:null;};
  const nowMs=()=>{try{const value=opts&&typeof opts.now==='function'?opts.now():NaN;return Number.isFinite(value)?value:Date.now();}catch{return Date.now();}};
  function clock(ms){try{return new Date(ms).toLocaleString(opts&&opts.locale||undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch{return new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC';}}
  function age(ms){const R=window.CrucixRecords;return ms===null?'':R&&typeof R.ageLabel==='function'?R.ageLabel(ms,nowMs()):clock(ms);}
  const glyphOf=level=>{const R=window.CrucixRecords;return R&&R.GLYPH&&R.GLYPH[level]||'';};
  const levelOf=value=>LEVELS.includes(value)?value:'unknown';
  const levelTag=level=>`<span class="cs-sev sev-${level}"><i aria-hidden="true">${esc(glyphOf(level))}</i> ${esc(tx('inspector.level.'+level,level[0].toUpperCase()+level.slice(1)))}</span>`;
  const entityLabel=row=>row.type==='country'?row.id.slice(8):text(row.label,120)||row.id.split(':').slice(1).join(':');

  // ===== The summary =====
  function readRow(item){
    if(!isObject(item)||typeof item.id!=='string'||!THREAD.test(item.id))return null;
    return {id:item.id,title:text(item.title,300),status:STATUSES.includes(item.status)?item.status:'active',first:isoMs(item.first),last:isoMs(item.last),members:count(item.memberCount),
      sources:count(item.sources),observations:count(item.observations),level:levelOf(item.maxLevel),conflict:count(item.conflictReports)>0,
      topic:TOPICS.includes(item.topic)?item.topic:null,
      kinds:(Array.isArray(item.kinds)?item.kinds:[]).filter(kind=>typeof kind==='string'&&/^[a-z-]{2,40}$/.test(kind)).slice(0,8),
      countries:(Array.isArray(item.countries)?item.countries:[]).filter(row=>isObject(row)&&typeof row.iso3==='string'&&ISO3.test(row.iso3)).slice(0,4).map(row=>row.iso3),
      entities:(Array.isArray(item.entities)?item.entities:[]).filter(row=>isObject(row)&&typeof row.id==='string'&&ENTITY.test(row.id)).slice(0,4).map(row=>({id:row.id,type:row.id.split(':')[0],label:text(row.label,120)}))};
  }
  function read(threads){
    if(!isObject(threads))return null;
    return {count:count(threads.count),top:(Array.isArray(threads.top)?threads.top:[]).map(readRow).filter(Boolean).slice(0,60)};
  }

  // ===== The panel =====
  function rowHtml(item,off){
    const tags=[...item.countries,...item.entities.filter(row=>row.type!=='country').map(entityLabel)].slice(0,5).map(name=>`<span class="th-tag">${esc(name)}</span>`).join('');
    const meta=[say('meta',{members:item.members,sources:item.sources}),item.observations?say('observations',{count:item.observations}):'',item.kinds.map(kindName).join(', ')].filter(Boolean).join(' · ');
    const topic=item.topic&&!(item.topic==='conflict'&&item.conflict)?` · <span class="th-topic" data-topic="${item.topic}">${esc(say('topic_'+item.topic))}</span>`:'';
    const inner=`<span class="th-status" data-status="${item.status}">${esc(say('status_'+item.status))}${item.conflict?` · <span class="th-conflict">${esc(say('conflict'))}</span>`:''}${topic}</span><span class="th-title">${esc(item.title||say('untitled'))}</span><span class="th-meta">${esc(meta)}</span>${tags?`<span class="th-tags">${tags}</span>`:''}`;
    return `<li class="th-item">${live()||off?`<button type="button" class="th-row" data-thread-open="${item.id}" data-level="${item.level}"${off?' aria-disabled="true" aria-describedby="storyThreadsReplay"':''}>${inner}</button>`:`<div class="th-row" data-level="${item.level}">${inner}</div>`}</li>`;
  }
  function build(threads,options){
    const o=isObject(options)?options:{},replay=typeof o.replay==='boolean'?o.replay:inReplay(),data=read(threads);
    const head=`<div class="sec-head"><h3 id="storyThreadsTitle" tabindex="-1">${esc(say('title'))}</h3></div>`;
    const note=replay?`<p class="rk-note rk-replay" id="storyThreadsReplay">${esc(say('replayNote'))}</p>`:'';
    let main;
    if(!data)main=`<p class="rk-calm" data-threads-state="unavailable">${esc(say('unavailable'))}</p>`;
    else{
      // The topic filter: a chip per topic that has threads, with its count; the list shows the first TOP of the chosen topic.
      const counts={};for(const item of data.top)if(item.topic)counts[item.topic]=(counts[item.topic]||0)+1;
      const chosen=topicFilter==='all'||counts[topicFilter]?topicFilter:'all';
      const chip=(value,label,n)=>`<button type="button" class="th-chip" data-thread-topic="${value}" aria-pressed="${chosen===value}">${esc(label)}${n!==null?` <span class="th-n">${n}</span>`:''}</button>`;
      const chips=data.top.length?`<div class="th-filter" role="group" aria-label="${esc(say('filterLabel'))}">${chip('all',say('filterAll'),null)}${TOPICS.filter(topic=>counts[topic]).map(topic=>chip(topic,say('topic_'+topic),counts[topic])).join('')}</div>`:'';
      const shown=data.top.filter(item=>chosen==='all'||item.topic===chosen).slice(0,TOP);
      main=`<p class="rk-intro">${esc(say('intro'))}</p>${data.count?`<p class="rk-sum">${esc(say('summary',{count:data.count}))}</p>`:''}${chips}${shown.length?`<ul class="th-list">${shown.map(item=>rowHtml(item,replay)).join('')}</ul>`:`<p class="rk-calm" data-threads-state="empty">${esc(say(data.top.length?'filterEmpty':'empty'))}</p>`}`;
    }
    return `<div class="g-panel threads-panel" id="storyThreadsPanel" role="region" aria-labelledby="storyThreadsTitle"${replay?' data-replay="true"':''}>${head}${note}${main}</div>`;
  }
  function panelHtml(threads,options){try{return build(threads,options);}catch(error){log(error);return '';}}

  // ===== The sheet =====
  function eventsHtml(list){
    const rows=(Array.isArray(list)?list:[]).filter(isObject).slice(0,60).map(item=>{
      const level=levelOf(item.level),ms=isoMs(item.time),id=typeof item.id==='string'&&EVENT_ID.test(item.id)?item.id:null;
      const meta=[typeof item.kind==='string'&&item.kind?kindName(item.kind.slice(0,40)):'',text(item.source,120),age(ms)].filter(Boolean).join(' · ');
      const inner=`${levelTag(level)}<span class="cs-ev-title">${esc(text(item.title,300)||say('untitled'))}</span><span class="cs-ev-meta">${esc(meta)}</span>`;
      return `<li>${id?`<button type="button" class="cs-ev" data-thread-event="${id}">${inner}</button>`:`<div class="cs-ev">${inner}</div>`}</li>`;
    });
    return rows.length?`<ul class="cs-list">${rows.join('')}</ul>`:'';
  }
  function chips(list,attr){
    const rows=(Array.isArray(list)?list:[]).filter(row=>isObject(row)&&typeof row.id==='string'&&ENTITY.test(row.id)).slice(0,12).map(row=>{
      const type=row.id.split(':')[0],label=type==='country'?(text(row.displayName,120)||row.id.slice(8)):text(row.label,120)||row.id;
      return `<li><button type="button" class="cs-link" ${attr}="${esc(row.id)}"><span class="th-type">${esc(say('type_'+type))}</span> ${esc(label)}${Number.isSafeInteger(row.count)?` <span class="cs-n">${esc(say('neighborCount',{count:row.count}))}</span>`:''}</button></li>`;
    });
    return rows.length?`<ul class="cs-links">${rows.join('')}</ul>`:'';
  }
  /** The sheet's markup for one /api/threads/:id answer (pure; every dynamic string escaped). */
  function renderThread(data){
    if(!isObject(data)||typeof data.id!=='string'||!THREAD.test(data.id))return '';
    const row=readRow(data);
    const span=row.first!==null&&row.last!==null?say('span',{first:clock(row.first),last:clock(row.last)}):'';
    const head=`<div class="cs-head"><p class="cs-value"><span class="th-status" data-status="${row.status}">${esc(say('status_'+row.status))}</span> ${esc(say('meta',{members:row.members,sources:row.sources}))}${row.observations?' · '+esc(say('observations',{count:row.observations})):''}</p>${span?`<p class="cs-cite">${esc(span)}</p>`:''}<p class="cs-cite">${esc(say('linkHelp'))}</p></div>`;
    const countries=(Array.isArray(data.countries)?data.countries:[]).filter(item=>isObject(item)&&typeof item.iso3==='string'&&ISO3.test(item.iso3)).slice(0,8)
      .map(item=>`<li><button type="button" class="cs-link" data-thread-country="${item.iso3}">${esc(text(item.displayName,120)||item.iso3)} <span class="cs-n">${esc(say('neighborCount',{count:count(item.count)}))}</span></button></li>`).join('');
    const named=chips(data.entities,'data-thread-entity');
    const edges=isObject(data.edges)?data.edges:{};
    return head
      +(countries?`<section class="cs-sec" aria-labelledby="th-countries"><h3 id="th-countries">${esc(say('countries'))}</h3><ul class="cs-links">${countries}</ul></section>`:'')
      +(named?`<section class="cs-sec" aria-labelledby="th-entities"><h3 id="th-entities">${esc(say('entities'))}</h3>${named}</section>`:'')
      +`<section class="cs-sec" aria-labelledby="th-records"><h3 id="th-records">${esc(say('records'))}</h3>${eventsHtml(data.events)}</section>`
      +`<section class="cs-sec" aria-labelledby="th-links"><h3 id="th-links">${esc(say('links'))}</h3><p class="cs-cite">${esc(say('linksSummary',{story:count(edges['same-story']),cooccurs:count(edges['co-occurs'])}))}</p></section>`;
  }
  /** The sheet's markup for one /api/entities/:id answer (pure). */
  function renderEntity(data){
    if(!isObject(data)||typeof data.id!=='string'||!ENTITY.test(data.id))return '';
    const back=current&&current.thread?`<p class="cs-actions"><button type="button" class="cs-link" data-thread-back="${current.thread}">${esc(say('back'))}</button></p>`:'';
    const threads=(Array.isArray(data.threads)?data.threads:[]).map(readRow).filter(Boolean).slice(0,5)
      .map(item=>`<li><button type="button" class="cs-ev" data-thread-open="${item.id}">${levelTag(item.level)}<span class="cs-ev-title">${esc(item.title||say('untitled'))}</span><span class="cs-ev-meta">${esc(say('meta',{members:item.members,sources:item.sources}))}</span></button></li>`).join('');
    const neighbors=chips(data.neighbors,'data-thread-entity');
    const records=eventsHtml(data.events);
    return back+`<p class="cs-cite">${esc(say('type_'+data.id.split(':')[0]))}</p>`
      +(threads?`<section class="cs-sec" aria-labelledby="th-ethreads"><h3 id="th-ethreads">${esc(say('entityThreads'))}</h3><ul class="cs-list">${threads}</ul></section>`:'')
      +`<section class="cs-sec" aria-labelledby="th-erecords"><h3 id="th-erecords">${esc(say('entityEvents'))}</h3>${records||`<p class="cs-calm">${esc(say('entityNone'))}</p>`}</section>`
      +(neighbors?`<section class="cs-sec" aria-labelledby="th-neighbors"><h3 id="th-neighbors">${esc(say('neighbors'))}</h3>${neighbors}</section>`:'');
  }

  // ===== The dialog =====
  function element(tag,className,content){const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;}
  function buildDialog(){
    const dialog=element('dialog','cs-dialog th-dialog'),box=element('div','cs-box'),top=element('div','cs-top'),title=element('h2','cs-title',say('sheet'));
    dialog.id='thread-sheet';dialog.setAttribute('aria-labelledby','th-title');title.id='th-title';title.setAttribute('tabindex','-1');
    const closeButton=element('button','cs-close',say('close'));closeButton.type='button';
    top.append(title,closeButton);
    const status=element('p','cs-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const body=element('div','cs-body');
    box.append(top,status,body);dialog.append(box);
    let press={down:false,up:false};
    dialog.addEventListener('pointerdown',guarded(event=>{press={down:event.target===dialog,up:false};}));
    dialog.addEventListener('pointerup',guarded(event=>{press.up=event.target===dialog;}));
    dialog.addEventListener('click',guarded(event=>{const both=press.down&&press.up;press={down:false,up:false};if(event.target===dialog&&both)closeDialog();}));
    dialog.addEventListener('close',guarded(()=>finish(false)));
    closeButton.addEventListener('click',guarded(()=>closeDialog()));
    body.addEventListener('click',guarded(chosen));
    document.body.append(dialog);
    nodes={dialog,title,status,body,closeButton};
  }
  function busy(on,key){nodes.body.setAttribute('aria-busy',String(on));nodes.status.textContent=on?say(key||'loading'):'';}
  function show(){
    if(!nodes)buildDialog();
    if(!nodes.dialog.open){opener=document.activeElement||null;finished=false;nodes.dialog.showModal();}
    if(inReplay()){nodes.title.textContent=say('sheet');nodes.body.innerHTML='';nodes.body.setAttribute('aria-busy','false');nodes.status.textContent=say('replayNote');nodes.dialog.setAttribute('data-replay','true');return false;}
    nodes.dialog.removeAttribute('data-replay');
    return true;
  }
  async function load(url,render,titleOf,state){
    const mine=++seq;
    if(!show())return false;
    const moveFocus=nodes.body.contains(document.activeElement);
    nodes.body.innerHTML='';busy(true);
    if(moveFocus)nodes.title.focus();
    let data;
    try{data=await opts.fetchJson(url);}
    catch(error){if(mine!==seq)return false;busy(false);nodes.status.textContent=say(error&&error.status===404?'notFound':'error');return false;}
    if(mine!==seq)return false;
    let markup='';
    current=state;
    try{markup=render(data);}catch(error){log(error);markup='';}
    busy(false);
    if(!markup){nodes.status.textContent=say('error');return false;}
    nodes.title.textContent=titleOf(data);
    nodes.body.innerHTML=markup;nodes.body.scrollTop=0;
    return true;
  }
  function open(id){
    if(!live()||typeof id!=='string'||!THREAD.test(id))return Promise.resolve(false);
    return load('/api/threads/'+id,renderThread,data=>text(data.title,200)||say('sheet'),{thread:id});
  }
  function openEntity(id){
    if(!live()||typeof id!=='string'||!ENTITY.test(id))return Promise.resolve(false);
    const from=current&&current.thread?current.thread:null;
    return load('/api/entities/'+encodeURIComponent(id),renderEntity,data=>say('type_'+id.split(':')[0])+' · '+(text(data.label,120)||id),{thread:from,entity:id});
  }
  const usable=node=>!!node&&node!==document.body&&node.isConnected!==false&&typeof node.focus==='function';
  function finish(skipFocus){
    if(finished||(nodes&&nodes.dialog.open))return;
    finished=true;seq++;current=null;
    const from=opener;opener=null;
    if(!skipFocus&&usable(from))from.focus();
  }
  function closeDialog(options){
    if(!nodes||!nodes.dialog.open)return;
    nodes.dialog.close();
    finish(!!options&&options.focus===false);
  }
  // A record opens in the inspector and a country in its sheet after this sheet closed; an entity or another thread opens in place.
  function chosen(event){
    const target=event.target&&typeof event.target.closest==='function'?event.target:null;
    if(!target)return;
    const record=target.closest('[data-thread-event]');
    if(record){
      const id=record.getAttribute('data-thread-event');
      if(typeof id!=='string'||!EVENT_ID.test(id))return;
      closeDialog();
      const intelligence=window.CrucixIntelligence,fn=typeof opts.openEvent==='function'?opts.openEvent:intelligence&&intelligence.openEvent;
      if(typeof fn==='function')Promise.resolve(fn(id)).catch(log);
      return;
    }
    const country=target.closest('[data-thread-country]');
    if(country){
      const code=country.getAttribute('data-thread-country');
      if(typeof code!=='string'||!ISO3.test(code))return;
      closeDialog();
      const fn=typeof opts.openCountry==='function'?opts.openCountry:window.CrucixCountry&&window.CrucixCountry.open;
      if(typeof fn==='function')Promise.resolve(fn(code)).catch(log);
      return;
    }
    const entity=target.closest('[data-thread-entity]');
    if(entity){const id=entity.getAttribute('data-thread-entity');if(id&&id.startsWith('country:')&&ISO3.test(id.slice(8))){closeDialog();const fn=typeof opts.openCountry==='function'?opts.openCountry:window.CrucixCountry&&window.CrucixCountry.open;if(typeof fn==='function')Promise.resolve(fn(id.slice(8))).catch(log);return;}openEntity(id).catch(log);return;}
    const other=target.closest('[data-thread-open]')||target.closest('[data-thread-back]');
    if(other){const id=other.getAttribute('data-thread-open')||other.getAttribute('data-thread-back');open(id).catch(log);}
  }
  // The panel rows (anywhere on the page): a row opens its thread unless a replay holds the page.
  function onPageClick(event){
    const target=event.target&&typeof event.target.closest==='function'?event.target:null;
    if(!target||!opts)return;
    // A topic chip re-draws the panel in place (the page's next render keeps the choice).
    const chip=target.closest('#storyThreadsPanel [data-thread-topic]');
    if(chip){
      const value=chip.getAttribute('data-thread-topic');
      topicFilter=TOPICS.includes(value)?value:'all';
      try{window.localStorage?.setItem(FILTER_KEY,topicFilter);}catch{}
      const panel=document.getElementById('storyThreadsPanel');
      if(panel&&typeof opts.getThreads==='function'){panel.outerHTML=panelHtml(opts.getThreads());document.querySelector?.(`#storyThreadsPanel [data-thread-topic="${topicFilter}"]`)?.focus?.();}
      return;
    }
    const row=target.closest('#storyThreadsPanel [data-thread-open]');
    if(!row||inReplay()||row.getAttribute('aria-disabled')==='true')return;
    open(row.getAttribute('data-thread-open')).catch(log);
  }
  function mount(options){
    if(opts||!options||typeof options!=='object')return false;
    opts=options;
    document.addEventListener('click',guarded(onPageClick));
    return true;
  }
  window.CrucixThreads=Object.freeze({mount,panelHtml,open:id=>open(id).catch(error=>{log(error);return false;}),openEntity:id=>openEntity(id).catch(error=>{log(error);return false;}),
    close:guarded(closeDialog),renderThread,renderEntity,mounted:()=>!!opts});
})(window,document);
