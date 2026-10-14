import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { DEFAULT_RULES, mergeRules, validateRule } from '../lib/alerts/rules.mjs';
import { METRICS } from '../lib/alerts/metrics.mjs';
import { LIVE_KINDS } from '../lib/intelligence/live-sources.mjs';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertEngine } from '../lib/alerts/engine.mjs';
import { installAlertRoutes } from '../lib/alerts/routes.mjs';
import { dom } from './fixtures/alert-dom.mjs';
const read=file=>readFileSync(new URL('../dashboard/public/'+file,import.meta.url),'utf8');
// record-core.js, alerts-core.js and alert-rules.js share one realm, as in the page; a fresh realm per test.
// Results cross the realm boundary: compare plain data through JSON (prototypes differ).
const load=(files=['record-core.js','alerts-core.js','alert-rules.js'])=>{const window={},context=vm.createContext({window,Date,URL});for(const file of files)vm.runInContext(read(file),context);return window;};
const plain=value=>JSON.parse(JSON.stringify(value));
const t=(_,fallback)=>fallback;
const pageT=locale=>(keyPath,fallback)=>{let value=locale;for(const key of keyPath.split('.')){if(value&&typeof value==='object'&&key in value)value=value[key];else return fallback||keyPath;}return typeof value==='string'?value:(fallback||keyPath);};
const HOSTILE='"><img onerror=x>',E='&quot;&gt;&lt;img onerror=x&gt;';
const hasInlineHandler=html=>(html.match(/<[a-z][^>]*>/gi)||[]).some(tag=>/[\s"'/]on\w+\s*=/i.test(tag.replace(/"[^"]*"/g,'""')));
const count=(html,needle)=>html.split(needle).length-1;
const flatten=(value,prefix)=>Object.entries(value||{}).flatMap(([key,item])=>item&&typeof item==='object'?flatten(item,`${prefix}.${key}`):[[`${prefix}.${key}`,item]]);
const locale=lang=>JSON.parse(readFileSync(new URL(`../locales/${lang}.json`,import.meta.url),'utf8'));

// The effective rules as the server merges them: the eight built-ins (one overridden) and two user rules.
const RULES=mergeRules(DEFAULT_RULES,[
  {id:'vix-watch',rule:{name:'VIX above 30',kind:'threshold',severity:'high',notify:true,params:{metric:'vix',op:'>',value:30,clearValue:28}}},
  {id:'hy-spread-wide',override:{enabled:false,params:{metric:'hy_spread',op:'>',value:6}}},
  {id:'quiet-feed',rule:{name:'Feed gone quiet',kind:'absence',enabled:false,severity:'watch',params:{source:'ACLED',minFailSweeps:4,maxAgeMinutes:120}}},
]);
const VALUES={vix:17.4,hy_spread:3.9,sources_ok:28,eurhuf:null};
const METRIC_VIEW=METRICS.map(({key,label,unit,kind})=>({key,label,unit,kind,value:Object.hasOwn(VALUES,key)?VALUES[key]:1.5}));
const view=(more={})=>({rules:RULES,metrics:METRIC_VIEW,editing:null,...more});
const byId=id=>RULES.find(rule=>rule.id===id);
const editing=(id,more={})=>({id,draft:null,error:null,...more});
// The markup of one rule row: the chunk whose <li> carries the rule id.
const row=(html,id)=>{const chunk=html.split('<li class="ar-rule').slice(1).find(part=>part.slice(0,part.indexOf('>')).includes(`data-rule-id="${id}"`));assert(chunk,'a row for '+id);return chunk.slice(0,chunk.indexOf('</li>'));};
// The wrappers of the form fields: from one class="ar-field" to the next.
const fieldBlocks=html=>{const out=new Map();const parts=html.split(/<(?:div|fieldset) class="ar-field/).slice(1);for(const part of parts){const m=/data-rule-field="([^"]*)"/.exec(part);if(m)out.set(m[1],part);}return out;};
const fieldPaths=html=>[...fieldBlocks(html).keys()];

test('the rule list: name, kind, source badge, severity, toggles, summary and actions',()=>{
  const R=load().CrucixAlertRules,html=R.renderRules(view(),t);
  for(const rule of RULES)assert(html.includes(`<li class="ar-rule`)&&html.includes(`data-rule-id="${rule.id}"`),rule.id);
  assert.equal(count(html,'<li class="ar-rule'),RULES.length);
  assert(html.includes('<h3 class="ar-heading" id="ar-heading">Rules</h3>'),'a heading'); assert(html.includes('data-rule-action="new"')&&html.includes('New rule'));
  // Source badges: pristine built-in, overridden built-in, user rule.
  assert.equal(count(html,'ar-source-builtin'),8); assert.equal(count(html,'ar-source-override'),1); assert.equal(count(html,'ar-source-user'),2);
  assert(row(html,'vix-spike').includes('>Built-in<')&&row(html,'hy-spread-wide').includes('>Modified<')&&row(html,'vix-watch').includes('>Custom<'));
  // Kind labels and summaries (English fallbacks; the symbols are language-neutral).
  assert(row(html,'vix-spike').includes('>Threshold<')&&row(html,'vix-spike').includes('VIX &gt; 30'));
  assert(row(html,'vix-watch').includes('VIX &gt; 30 (clears at 28)'),'a clear value is part of the summary');
  assert(row(html,'hy-spread-wide').includes('HY spread &gt; 6'),'the override shows the effective parameters');
  assert(row(html,'events-critical').includes('>Event<')&&row(html,'events-critical').includes('≥ Critical'));
  assert(row(html,'events-high').includes('= High'),'maxLevel equal to minLevel reads as exactly that level');
  assert(row(html,'hungary-region').includes('≥ Watch')&&row(html,'hungary-region').includes('500 km @ 47.5, 19'));
  assert(row(html,'convergence-default').includes('3+ event types within one 2° cell in 24 h at Watch or above'));
  assert(row(html,'source-stale').includes('any source: 3+ failed sweeps in a row'));
  assert(row(html,'quiet-feed').includes('ACLED: 4+ failed sweeps in a row, older than 120 min'));
  assert(row(html,'delta-critical').includes('≥ Critical')&&row(html,'delta-critical').includes('>Delta<'));
  assert(row(html,'vix-watch').includes('<span class="ri-glyph sev-high" aria-hidden="true">▲</span>')&&row(html,'vix-watch').includes('High'),'severity glyph and name');
  assert(row(html,'events-critical').includes('Same as event'),'auto severity says so');
  // Toggles: one checkbox per flag, named by the rule, checked as the rule is.
  const toggle=(id,flag)=>{const m=new RegExp(`<input[^>]*data-rule-toggle="${flag}" data-rule-id="${id}"[^>]*>`).exec(html);assert(m,id+' '+flag);return m[0];};
  assert(/ checked/.test(toggle('vix-spike','enabled'))&&/ checked/.test(toggle('vix-spike','notify')));
  assert(!/ checked/.test(toggle('hy-spread-wide','enabled'))&&!/ checked/.test(toggle('hy-spread-wide','notify')));
  assert(!/ checked/.test(toggle('quiet-feed','enabled'))); assert(/type="checkbox"/.test(toggle('quiet-feed','notify')));
  assert(row(html,'vix-spike').includes('Enabled<span class="ri-sr"> · VIX spike</span>'),'a toggle is named by its rule for screen readers');
  // Actions: edit for all; delete for user rules only; reset for an overridden built-in only; nothing destructive on a pristine one.
  for(const rule of RULES)assert(row(html,rule.id).includes(`data-rule-action="edit" data-rule-id="${rule.id}"`),'edit '+rule.id);
  assert(row(html,'vix-watch').includes('data-rule-action="delete"')&&!row(html,'vix-watch').includes('data-rule-action="reset"'));
  assert(row(html,'hy-spread-wide').includes('data-rule-action="reset"')&&!row(html,'hy-spread-wide').includes('data-rule-action="delete"'));
  for(const id of ['vix-spike','events-high'])assert(!row(html,id).includes('data-rule-action="delete"')&&!row(html,id).includes('data-rule-action="reset"'),id);
  assert(html.includes('>Reset to default<')&&html.includes('>Delete<'));
});

test('the delete confirmation, the busy state, the loading, error and unavailable states',()=>{
  const R=load().CrucixAlertRules;
  const asking=R.renderRules(view({confirm:'vix-watch'}),t);
  assert(row(asking,'vix-watch').includes('data-rule-action="delete-confirm" data-rule-id="vix-watch"')&&row(asking,'vix-watch').includes('data-rule-action="cancel-confirm"')&&row(asking,'vix-watch').includes('Delete this rule?'));
  assert(!row(asking,'quiet-feed').includes('delete-confirm'),'only the asked rule');
  const busy=R.renderRules(view({busy:true}),t);
  assert(busy.includes('aria-busy="true"')); for(const tag of busy.match(/<(?:input|button|select)[^>]*>/g))assert(/ disabled/.test(tag),'disabled while a request is in flight: '+tag);
  // The form too: every field and button, including the checkbox group and the preset.
  for(const kind of ['event','threshold','convergence']){const form=R.renderRules(view({busy:true,editing:{id:null,draft:R.newDraft(kind,METRIC_VIEW),error:null}}),t);for(const tag of form.match(/<(?:input|button|select)[^>]*>/g))assert(/ disabled/.test(tag),kind+': '+tag);}
  const idle=R.renderRules(view(),t); assert(idle.includes('aria-busy="false"')&&!/<(?:input|button)[^>]* disabled/.test(idle));
  const loading=R.renderRules({rules:[],metrics:[],editing:null,loaded:false},t); assert(loading.includes('Loading rules…')&&!loading.includes('<li'));
  const failed=R.renderRules({rules:[],metrics:[],editing:null,loaded:false,loadFailed:true},t); assert(failed.includes('Could not load the rules')&&failed.includes('data-rule-action="retry"'));
  const notice=R.renderRules(view({notice:{key:'alerts.rules.errorSave',fallback:'Could not save the rule',detail:'At most 50 user rules'}}),t);
  assert(notice.includes('Could not save the rule: At most 50 user rules')&&notice.includes('class="al-notice'));
  const status=R.renderRules(view({status:{key:'alerts.rules.deleted',fallback:'Rule deleted'}}),t); assert(status.includes('Rule deleted'));
  const readOnly=R.renderRules(view({readOnly:true}),t); assert(readOnly.includes('Rules are only available on the live dashboard')&&!readOnly.includes('<li')&&!readOnly.includes('data-rule-action'));
  const empty=R.renderRules(view({rules:[]}),t); assert(empty.includes('Nothing here')&&empty.includes('data-rule-action="new"'));
});

test('the form shows exactly the fields of its kind, a new rule starts from sensible defaults',()=>{
  const R=load().CrucixAlertRules,common=['name','id','kind','severity','forSweeps','cooldownMinutes','enabled','notify'];
  const perKind={
    event:['params.minLevel','params.maxLevel','scope.kinds','scope.sources','scope.keywords','scope.radius.lat','scope.radius.lon','scope.radius.km'],
    threshold:['params.metric','params.op','params.value','params.clearValue'],
    change:['params.metric','params.pct'],
    absence:['params.source','params.minFailSweeps','params.maxAgeMinutes'],
    convergence:['params.cellDegrees','params.windowHours','params.minKinds','params.minLevel','params.kinds'],
    delta:['params.minSeverity'],
  };
  for(const [kind,fields] of Object.entries(perKind)){
    const html=R.renderRules(view({editing:{id:null,draft:R.newDraft(kind,METRIC_VIEW),error:null}}),t);
    assert.deepEqual(fieldPaths(html).sort(),[...common,...fields].sort(),kind);
    assert(html.includes('<form class="ar-form"')&&html.includes('novalidate')&&html.includes('type="submit"')&&html.includes('data-rule-action="cancel"'),kind+' form chrome');
    assert(!html.includes('<ul class="ar-list"'),'the form replaces the list');
    assert(html.includes(`<option value="${kind}" selected>`),'the kind select shows '+kind);
  }
  assert.equal(count(R.renderRules(view({editing:{id:null,draft:R.newDraft('event',METRIC_VIEW),error:null}}),t),'data-rule-action="preset-hungary"'),1,'event rules get the Hungary preset');
  assert(!R.renderRules(view({editing:{id:null,draft:R.newDraft('threshold',METRIC_VIEW),error:null}}),t).includes('preset-hungary'));
  // Editing a user rule: the kind and id are fixed, shown as text.
  const user=R.renderRules(view({editing:{id:'vix-watch',draft:R.draftOf(byId('vix-watch')),error:null}}),t);
  assert.deepEqual(fieldPaths(user).sort(),[...common.filter(name=>name!=='id'&&name!=='kind'),...perKind.threshold].sort(),'edit: no id and kind inputs');
  assert(user.includes('value="VIX above 30"')&&user.includes('value="28"')&&user.includes('value="30"')); assert(/<input[^>]*name="notify"[^>]* checked/.test(user));
  assert(user.includes('vix-watch')&&user.includes('Threshold'),'the fixed id and kind are shown');
  // A built-in: name, id and kind are fixed too (the server refuses to change them).
  const builtin=R.renderRules(view({editing:{id:'events-high',draft:R.draftOf(byId('events-high')),error:null}}),t);
  assert.deepEqual(fieldPaths(builtin).sort(),[...common.filter(name=>!['id','kind','name'].includes(name)),...perKind.event].sort());
  assert(!/name="name"/.test(builtin)&&builtin.includes('High-severity events'));
  assert.match(/<select[^>]*name="maxLevel"[^>]*>([^]*?)<\/select>/.exec(builtin)[1],/<option value="high" selected>/,'maxLevel high is carried by the form');
  assert(builtin.includes('data-rule-action="cancel"'));
  // Defaults of a new rule.
  const draft=kind=>plain(R.newDraft(kind,METRIC_VIEW));
  assert.deepEqual([draft('event').severity,draft('event').minLevel,draft('event').maxLevel,draft('event').forSweeps],['auto','high','','1']);
  assert.deepEqual([draft('threshold').severity,draft('threshold').metric,draft('threshold').op,draft('threshold').forSweeps],['high','vix','>','2']);
  assert.deepEqual([draft('absence').source,draft('absence').minFailSweeps],['any','3']);
  assert.deepEqual([draft('convergence').cellDegrees,draft('convergence').windowHours,draft('convergence').minKinds,draft('convergence').minLevel],['2','24','3','watch']);
  assert.equal(draft('delta').minSeverity,'critical'); assert.equal(draft('nonsense').kind,'event','an unknown kind falls back to event');
  for(const kind of Object.keys(perKind))assert.deepEqual([draft(kind).enabled,draft(kind).notify,draft(kind).cooldownMinutes,draft(kind).name,draft(kind).id],[true,false,'30','','']);
});

test('the metric select lists the catalog with current values and units; auto severity is for events only',()=>{
  const R=load().CrucixAlertRules,form=(kind,metric)=>{const draft={...R.newDraft(kind,METRIC_VIEW),...(metric?{metric}:{})};return R.renderRules(view({editing:{id:null,draft,error:null}}),t);};
  const html=form('threshold');
  const select=/<select[^>]*name="metric"[^>]*>([^]*?)<\/select>/.exec(html)[1];
  assert.equal(count(select,'<option'),METRICS.length,'every catalog metric is offered');
  for(const metric of METRICS)assert(select.includes(`<option value="${metric.key}"`),metric.key);
  assert(select.includes('<option value="vix" selected>VIX — 17.4 index</option>'),'label, current value and unit'); assert(select.includes('<option value="eurhuf">EUR/HUF — —</option>'),'a metric without a value says so');
  assert(select.includes('Sources OK — 28 sources')); assert(html.includes('current: 17.4 index'),'the current value of the selected metric');
  assert(form('change','hy_spread').includes('current: 3.9 %'),'the hint follows the selected metric');
  assert(form('threshold','wti').includes('<option value="wti" selected>'));
  // A unit with one slash is a locale key too; units with capitals (EUR/MWh, Hz) are shown as they are.
  const hu=R.renderRules(view({editing:{id:null,draft:{...R.newDraft('threshold',METRIC_VIEW),metric:'hormuz_transits'},error:null}}),pageT(locale('hu')));
  assert(hu.includes('<option value="hormuz_transits" selected>Hormuzi-szoros, áthaladások (7 napos átlag) — 1.5 áthaladás/nap</option>'),'localised label and unit');
  assert(hu.includes('<option value="hu_power_price">Magyar másnapi áramár — 1.5 EUR/MWh</option>')&&hu.includes('— 1.5 Hz</option>'));
  assert(R.renderRules(view({editing:{id:null,draft:{...R.newDraft('threshold',[]),metric:'vix'},error:null},metrics:[]}),t).includes('<option value="vix" selected>'),'a draft metric missing from the catalog stays selectable');
  // Severity: auto only for event rules.
  const severities=kind=>[.../<select[^>]*name="severity"[^>]*>([^]*?)<\/select>/.exec(form(kind))[1].matchAll(/<option value="([^"]*)"/g)].map(m=>m[1]);
  assert.deepEqual(severities('event'),['auto','critical','high','watch','info']);
  for(const kind of ['threshold','change','absence','convergence','delta'])assert.deepEqual(severities(kind),['critical','high','watch','info'],kind);
  assert(form('event').includes('>Same as event<'));
  // The operator select carries the ASCII operators the server wants.
  const operators=[.../<select[^>]*name="op"[^>]*>([^]*?)<\/select>/.exec(html)[1].matchAll(/<option value="([^"]*)"/g)].map(m=>m[1]);
  assert.deepEqual(operators,['&gt;','&gt;=','&lt;','&lt;='],'escaped in the attribute, the browser reads them back as > >= < <=');
});

test('the event kinds are a checkbox group that keeps tokens the rule already has',()=>{
  const R=load().CrucixAlertRules,draft={...R.newDraft('event',METRIC_VIEW),kinds:['conflict','custom-kind']};
  const html=R.renderRules(view({editing:{id:null,draft,error:null}}),t),group=fieldBlocks(html).get('scope.kinds');
  assert(/<input type="checkbox" name="kinds" value="conflict"[^>]* checked/.test(group)&&/value="custom-kind"[^>]* checked/.test(group),'a token outside the known list stays, checked');
  assert(/value="earthquake"(?![^>]* checked)/.test(group)); assert(group.includes('>Conflict<')&&group.includes('>Space weather<'),'English fallback labels come from the token');
  // Every kind an event can have (lib/intelligence/history.mjs KINDS) is offered, the live-source kinds included.
  for(const kind of ['news','osint','health','outage','conflict','signal',...LIVE_KINDS])assert(group.includes(`name="kinds" value="${kind}"`),kind);
  const named=R.renderRules(view({editing:{id:null,draft,error:null}}),pageT({intelligence:{'kind_space-weather':'Űridőjárás',kind_conflict:'Konfliktus'}}));
  assert(named.includes('Űridőjárás')&&named.includes('Konfliktus'),'kind labels come from the intelligence locale group');
  const conv=R.renderRules(view({editing:{id:null,draft:{...R.newDraft('convergence',METRIC_VIEW),kinds:['weather']},error:null}}),t);
  assert(fieldBlocks(conv).get('params.kinds').includes('name="kinds" value="weather"'));
});

test('a server error sits next to its field, the rest at the top of the form; all of it is plain text',()=>{
  const R=load().CrucixAlertRules,draft=R.newDraft('threshold',METRIC_VIEW);
  const render=error=>R.renderRules(view({editing:{id:null,draft,error}}),t);
  const mapped=render({field:'params.value',message:'is required'}),blocks=fieldBlocks(mapped);
  assert(blocks.get('params.value').includes('<p class="ar-error"')&&blocks.get('params.value').includes('is required'),'inside the field wrapper');
  assert(!blocks.get('params.op').includes('is required'),'only that field');
  assert(/<input[^>]*name="value"[^>]*aria-invalid="true"/.test(blocks.get('params.value'))||/aria-invalid="true"[^>]*name="value"/.test(blocks.get('params.value')),'the input is marked invalid');
  assert(mapped.includes('class="al-notice ar-notice"')&&mapped.includes('Could not save the rule'),'the form says it did not save');
  assert.match(blocks.get('params.value'),/aria-describedby="ar-err-params-value"/); assert(blocks.get('params.value').includes('id="ar-err-params-value"'));
  assert(render({field:'name',message:'must not be empty'}).includes('must not be empty')&&fieldBlocks(render({field:'name',message:'must not be empty'})).get('name').includes('must not be empty'));
  assert(fieldBlocks(render({field:'forSweeps',message:'must be an integer from 1 to 10'})).get('forSweeps').includes('integer from 1 to 10'));
  const kw=R.renderRules(view({editing:{id:null,draft:R.newDraft('event',METRIC_VIEW),error:{field:'scope.keywords[3]',message:'must be at most 40 characters'}}}),t);
  assert(fieldBlocks(kw).get('scope.keywords').includes('at most 40 characters'),'an index suffix maps to the list field');
  assert(fieldBlocks(R.renderRules(view({editing:{id:null,draft:R.newDraft('event',METRIC_VIEW),error:{field:'scope.radius.lat',message:'is required'}}}),t)).get('scope.radius.lat').includes('is required'));
  // A field the form does not show (or none at all) is named at the top.
  const top=render({field:'rule',message:'must be an object'}); assert(top.includes('Could not save the rule: rule must be an object')); assert(!/<p class="ar-error"/.test(top));
  assert(render({field:'',message:'At most 50 user rules'}).includes('Could not save the rule: At most 50 user rules'));
  assert(render({field:'params.value',message:''}).includes('Could not save the rule'),'an empty message is fine');
  // Hostile server text: text only.
  for(const html of [render({field:'params.value',message:HOSTILE}),render({field:HOSTILE,message:HOSTILE}),render({field:'params.value[3]'+HOSTILE,message:'x'})]){
    assert(!html.includes('<img')&&!hasInlineHandler(html)&&!html.includes('><img'));
  }
  assert(render({field:HOSTILE,message:HOSTILE}).includes(`Could not save the rule: ${E} ${E}`));
  assert(fieldBlocks(render({field:'params.value',message:HOSTILE})).get('params.value').includes(E));
});

test('every dynamic value is escaped in text and attribute context, nothing is an inline handler',()=>{
  const R=load().CrucixAlertRules;
  const evil={id:'evil-rule',name:HOSTILE,kind:'event',enabled:true,severity:'auto',notify:true,forSweeps:1,cooldownMinutes:30,params:{minLevel:'high'},scope:{kinds:[HOSTILE],sources:[HOSTILE],keywords:[HOSTILE],radius:{lat:HOSTILE,lon:2,km:3}},source:'user'};
  const rules=[evil,{...evil,id:'evil-2',kind:'threshold',scope:undefined,params:{metric:HOSTILE,op:HOSTILE,value:HOSTILE,clearValue:HOSTILE},source:HOSTILE},{...evil,id:'evil-3',kind:'absence',scope:undefined,params:{source:HOSTILE,minFailSweeps:HOSTILE,maxAgeMinutes:HOSTILE}},
    {...evil,id:'evil-4',kind:HOSTILE,severity:HOSTILE,params:null,scope:null},{...evil,id:HOSTILE},{...evil,id:'evil-6',kind:'convergence',params:{minKinds:HOSTILE,cellDegrees:HOSTILE,windowHours:HOSTILE,minLevel:HOSTILE,kinds:[HOSTILE]},scope:undefined},{...evil,id:'evil-7',kind:'change',params:{metric:HOSTILE,pct:HOSTILE},scope:undefined}];
  const metrics=[{key:HOSTILE,label:HOSTILE,unit:HOSTILE,kind:'number',value:HOSTILE},{key:'vix',label:HOSTILE,unit:HOSTILE,kind:'number',value:HOSTILE}];
  const outputs=[R.renderRules({rules,metrics,editing:null,confirm:HOSTILE},t),R.renderRules({rules,metrics,editing:null,notice:{key:'x',fallback:HOSTILE,detail:HOSTILE},status:{key:'x',fallback:HOSTILE}},t)];
  for(const rule of rules)for(const id of [rule.id,'evil-rule'])outputs.push(R.renderRules({rules,metrics,editing:{id,draft:R.draftOf(rule),error:{field:HOSTILE,message:HOSTILE}},confirm:id},t));
  // Hand-made drafts: every field a user can type into, hostile.
  const draft=Object.fromEntries(['name','id','kind','severity','forSweeps','cooldownMinutes','minLevel','maxLevel','sources','keywords','lat','lon','km','metric','op','value','clearValue','pct','source','minFailSweeps','maxAgeMinutes','cellDegrees','windowHours','minKinds','minSeverity'].map(key=>[key,HOSTILE]));
  for(const kind of ['event','threshold','change','absence','convergence','delta'])outputs.push(R.renderRules({rules,metrics,editing:{id:null,draft:{...draft,kind,kinds:[HOSTILE]},error:null}},t));
  for(const html of outputs){assert(!html.includes('<img'),'no raw markup'); assert(!html.includes('><img'),'no attribute breakout'); assert(!hasInlineHandler(html),'no inline handler'); assert(!/javascript:/i.test(html));}
  const list=outputs[0]; assert(list.includes(E),'the hostile text is there, escaped'); assert(list.includes(`data-rule-id="${E}"`),'a hostile id is escaped in the attribute');
  const form=R.renderRules({rules,metrics,editing:{id:null,draft:{...draft,kind:'event',kinds:[HOSTILE]},error:null}},t);
  assert(form.includes(`value="${E}"`)&&form.includes(`name="kinds" value="${E}"`),'draft values are escaped in the value attributes');
  // Translators that throw or answer with markup never inject it.
  for(const tr of [()=>{throw new Error('boom');},()=>HOSTILE,()=>42,null])assert(!R.renderRules(view(),tr).includes('<img'));
  assert(R.renderRules(view(),()=>HOSTILE).includes(E)); assert(R.renderRules(view(),()=>{throw new Error('boom');}).includes('New rule'),'the fallback is used when t throws');
});

test('rule names and metric labels are localised by key, with the server text as the fallback',()=>{
  const R=load().CrucixAlertRules,tr=pageT({alerts:{ruleNames:{'vix-spike':'VIX-kiugrás'},level:{high:'Magas'},rules:{metric:{vix:'VIX (volatilitás)',hy_spread:'HY-felár'},unit:{index:'index'},kind:{threshold:'Küszöb'},source:{builtin:'Beépített'},add:'Új szabály'}}});
  const html=R.renderRules(view(),tr);
  assert(row(html,'vix-spike').includes('VIX-kiugrás')&&row(html,'vix-spike').includes('Küszöb')&&row(html,'vix-spike').includes('Beépített')&&html.includes('Új szabály'));
  assert(row(html,'vix-spike').includes('VIX (volatilitás) &gt; 30'),'the summary uses the localised metric label'); assert(row(html,'hy-spread-wide').includes('HY-felár &gt; 6'));
  assert(row(html,'vix-watch').includes('VIX above 30'),'a rule without a locale name keeps its own');
  const form=R.renderRules(view({editing:{id:null,draft:R.newDraft('threshold',METRIC_VIEW),error:null}}),tr);
  assert(form.includes('VIX (volatilitás) — 17.4 index')&&form.includes('HY-felár — 3.9 %')&&form.includes('WTI crude'),'localised labels, server label as fallback');
  // Odd metric keys and a prototype-named rule id never reach the locale lookup as something else.
  const proto=R.renderRules({rules:[{...byId('vix-watch'),id:'constructor',name:'Prototype rule'},{...byId('vix-watch'),id:'prototype',name:'Other rule',params:{metric:'constructor',op:'>',value:1}}],metrics:[{key:'constructor',label:'Ctor metric',unit:'u',kind:'number',value:1}],editing:null},tr);
  assert(proto.includes('Prototype rule')&&proto.includes('Other rule')&&proto.includes('Ctor metric &gt; 1')&&!proto.includes('function'));
  assert(proto.includes('data-rule-id="constructor"')&&proto.includes('data-rule-id="prototype"'));
});

test('parseDraft: strings become numbers, comma lists arrays, checkboxes booleans; nothing is mutated',()=>{
  const R=load().CrucixAlertRules,parse=values=>plain(R.parseDraft(values));
  const threshold={name:' VIX above 30 ',id:'x',kind:'threshold',enabled:true,notify:'on',severity:'high',forSweeps:'2',cooldownMinutes:'30',metric:'vix',op:'>',value:'30',clearValue:' 28,5 ',minLevel:'high'};
  const before=JSON.stringify(threshold);
  assert.deepEqual(parse(threshold),{name:'VIX above 30',kind:'threshold',enabled:true,severity:'high',notify:true,forSweeps:2,cooldownMinutes:30,params:{metric:'vix',op:'>',value:30,clearValue:28.5}});
  assert.equal(JSON.stringify(threshold),before,'the input is not mutated'); assert(!('scope' in parse(threshold)),'only event rules carry a scope'); assert(!('id' in parse(threshold)),'the id comes from the URL');
  // Optional numbers left empty are omitted, required ones too (the server says "is required").
  assert.deepEqual(parse({...threshold,clearValue:''}).params,{metric:'vix',op:'>',value:30}); assert.deepEqual(parse({...threshold,value:'  ',clearValue:''}).params,{metric:'vix',op:'>'});
  assert.deepEqual(parse({...threshold,forSweeps:''}).forSweeps,undefined);
  // A value that is not a number goes through as typed, so the server can name the field.
  assert.equal(parse({...threshold,value:'abc'}).params.value,'abc'); assert.equal(parse({...threshold,value:'1e999'}).params.value,'1e999','a number that does not survive JSON is not sent as null');
  assert.equal(parse({...threshold,value:'-0.5'}).params.value,-0.5); assert.equal(parse({...threshold,value:'.5'}).params.value,0.5); assert.equal(parse({...threshold,value:'1e2'}).params.value,100);
  assert.equal(parse({...threshold,value:'1,5'}).params.value,1.5,'a decimal comma is accepted'); assert.equal(parse({...threshold,value:'1,000,5'}).params.value,'1,000,5');
  // Checkboxes.
  for(const [input,expected] of [[true,true],['on',true],['true',true],[false,false],['',false],[undefined,false],['off',false],[0,false]])assert.equal(parse({...threshold,enabled:input,notify:input}).enabled,expected,String(input));
  // Event: levels, lists, radius; the scope is always there.
  const event={name:'Quakes',kind:'event',enabled:true,notify:false,severity:'auto',forSweeps:'1',cooldownMinutes:'30',minLevel:'high',maxLevel:'',kinds:['conflict','weather'],sources:'',keywords:' flood , , fire,flood ',lat:'47,5',lon:'19',km:'500'};
  assert.deepEqual(parse(event),{name:'Quakes',kind:'event',enabled:true,severity:'auto',notify:false,forSweeps:1,cooldownMinutes:30,scope:{kinds:['conflict','weather'],keywords:['flood','fire','flood'],radius:{lat:47.5,lon:19,km:500}},params:{minLevel:'high'}});
  assert.deepEqual(parse({...event,kinds:[],keywords:'',lat:'',lon:'',km:'',maxLevel:'high',sources:'ACLED, USGS'}).scope,{sources:['ACLED','USGS']}); assert.deepEqual(parse({...event,kinds:[],keywords:'',lat:'',lon:'',km:'',maxLevel:'high'}).scope,{},'an empty scope is an empty object (an override replaces the old scope)');
  assert.equal(parse({...event,maxLevel:'high'}).params.maxLevel,'high');
  assert.deepEqual(parse({...event,keywords:'1, 2 ,3'}).scope.keywords,['1','2','3'],'keywords stay strings: the server refuses numbers');
  assert.deepEqual(parse({...event,keywords:',, ,'}).scope.keywords,undefined,'only empty items: no list');
  assert.deepEqual(parse({...event,lat:'47.5',lon:'',km:''}).scope.radius,{lat:47.5},'a half-filled radius is sent as it is, the server names what is missing');
  assert(parse({...event,keywords:'a,'.repeat(5000)}).scope.keywords.length<=100,'a hostile list is bounded');
  // The other kinds.
  assert.deepEqual(parse({name:'c',kind:'change',metric:'btc',pct:'5'}).params,{metric:'btc',pct:5});
  assert.deepEqual(parse({name:'a',kind:'absence',source:' any ',minFailSweeps:'3',maxAgeMinutes:''}).params,{source:'any',minFailSweeps:3});
  assert.deepEqual(parse({name:'a',kind:'absence',source:'ACLED',minFailSweeps:'3',maxAgeMinutes:'90'}).params,{source:'ACLED',minFailSweeps:3,maxAgeMinutes:90});
  assert.deepEqual(parse({name:'v',kind:'convergence',cellDegrees:'2',windowHours:'24',minKinds:'3',minLevel:'watch',kinds:['conflict']}).params,{cellDegrees:2,windowHours:24,minKinds:3,minLevel:'watch',kinds:['conflict']});
  assert.deepEqual(parse({name:'v',kind:'convergence',cellDegrees:'2',windowHours:'24',minKinds:'3',minLevel:'watch',kinds:[]}).params,{cellDegrees:2,windowHours:24,minKinds:3,minLevel:'watch'});
  assert.deepEqual(parse({name:'d',kind:'delta',minSeverity:'critical'}).params,{minSeverity:'critical'});
  // Garbage never throws and is never trusted.
  for(const garbage of [null,undefined,'x',42,[],{},{kind:{}},{name:{},kind:'event',kinds:'x',keywords:{},enabled:{}},{__proto__:{kind:'delta'}}])assert.doesNotThrow(()=>R.parseDraft(garbage),String(garbage));
  assert.deepEqual(parse({}),{name:'',kind:'',enabled:false,severity:'',notify:false,params:{}},'an empty draft becomes empty fields the server rejects field by field');
  assert.equal(parse({__proto__:{kind:'delta',name:'inherited'}}).kind,'','only own properties are read'); assert.equal(parse({kind:'event'}).params.minLevel,'');
  assert.equal(parse({name:HOSTILE,kind:'event'}).name,HOSTILE,'text is data: escaping is the renderer\'s job');
});

test('draftOf and parseDraft round-trip every effective rule into what the server accepts',()=>{
  const R=load().CrucixAlertRules;
  for(const rule of RULES){
    const body=plain(R.parseDraft(R.draftOf(rule)));
    const {source,id,...expected}=rule;
    // The PUT body of a user rule, or the override of a built-in (complete params/scope, only the override fields).
    assert.deepEqual(body,expected,rule.id+' survives the form unchanged');

    const clean=validateRule(body,{id:rule.id}); assert(clean.ok,rule.id+' '+JSON.stringify(clean.error)); assert.deepEqual(clean.rule,{...expected,id:rule.id},rule.id);
  }
  // events-high keeps its upper bound (an override replaces params wholesale), the others keep theirs.
  assert.equal(plain(R.draftOf(byId('events-high'))).maxLevel,'high'); assert.equal(plain(R.parseDraft(R.draftOf(byId('events-high')))).params.maxLevel,'high');
  assert.equal(plain(R.draftOf(byId('hungary-region'))).lat,'47.5');
  // A fresh form, filled as the QA does: a threshold on the VIX.
  const fresh=plain(R.newDraft('threshold',METRIC_VIEW));
  const rule=validateRule(plain(R.parseDraft({...fresh,name:'VIX over 30',value:'30'})),{id:'vix-over-30'}); assert(rule.ok,JSON.stringify(rule.error));
  assert.deepEqual([rule.rule.params,rule.rule.forSweeps,rule.rule.severity,rule.rule.notify],[{metric:'vix',op:'>',value:30},2,'high',false]);
  for(const kind of ['event','change','absence','convergence','delta']){
    const filled={event:{minLevel:'high'},change:{pct:'5'},absence:{},convergence:{},delta:{}}[kind];
    const made=validateRule(plain(R.parseDraft({...R.newDraft(kind,METRIC_VIEW),name:'Made '+kind,...filled})),{id:'made-'+kind}); assert(made.ok,kind+' '+JSON.stringify(made.error));
  }
  // The server's own field paths for the common mistakes: empty name, missing value.
  assert.equal(validateRule(plain(R.parseDraft({...fresh,name:''})),{id:'x'}).error.field,'name'); assert.equal(validateRule(plain(R.parseDraft({...fresh,name:'n'})),{id:'x'}).error.field,'params.value');
  // draftOf is robust.
  for(const garbage of [null,undefined,'x',42,{},{kind:'threshold',params:null},{kind:'event',scope:{kinds:'x',radius:'y'},params:[]}])assert.doesNotThrow(()=>R.draftOf(garbage),String(garbage));
});

test('slug: a rule id from a name',()=>{
  const R=load().CrucixAlertRules;
  assert.equal(R.slug('VIX above 30'),'vix-above-30'); assert.equal(R.slug('  Árvíztűrő  tükörfúrógép! '),'arvizturo-tukorfurogep'); assert.equal(R.slug('---x---'),'x');
  assert.equal(R.slug('x'.repeat(60)).length,40); assert.equal(R.slug('a'.repeat(39)+'-b'),'a'.repeat(39),'no trailing dash after the cut');
  for(const nothing of ['','   ','!!!','日本語',null,undefined])assert.equal(R.slug(nothing),'',String(nothing)); assert.equal(R.slug(42),'42');

  for(const name of ['VIX above 30','Árvíz','x y z','UPPER_case-1'])assert.match(R.slug(name),/^[a-z0-9-]{1,40}$/);
});

test('robustness: garbage views, rules, metrics and translators never throw',()=>{
  const R=load().CrucixAlertRules;
  const views=[null,undefined,0,'x',[],{},{rules:'x',metrics:'y',editing:'z'},{rules:[null,1,'x',{},{id:7},{id:'a',kind:{}},{id:'a-b',kind:'threshold',params:'p',source:{}}],metrics:[null,1,{},{key:3}],editing:{id:{},draft:'x',error:'e'}},
    {rules:RULES,metrics:METRIC_VIEW,editing:{id:'missing-rule',draft:null,error:{field:7,message:{}}}},{rules:RULES,editing:{id:null,draft:{kind:'threshold',metric:{},kinds:'x',value:{}}}},{rules:RULES,confirm:{},busy:'yes',notice:{key:{},fallback:7,detail:[]},status:5}];
  for(const v of views)for(const tr of [t,null,()=>{throw new Error('boom');},()=>42,()=>({})])assert.equal(typeof R.renderRules(v,tr),'string',JSON.stringify(v)+String(tr));
  assert.equal(typeof R.renderRules(view(),t,NaN),'string');
  assert(R.renderRules(null,null).includes('Loading rules'),'a missing view is the loading state');
});

test('no regex lookbehind, no inline handler and no on* attribute in any output of the module',()=>{
  assert(!/\(\?<[=!]/.test(read('alert-rules.js')),'no regex lookbehind');
  const R=load().CrucixAlertRules,outputs=[R.renderRules(view(),t),R.renderRules(view({confirm:'vix-watch',busy:true}),t),...['event','threshold','change','absence','convergence','delta'].map(kind=>R.renderRules(view({editing:{id:null,draft:R.newDraft(kind,METRIC_VIEW),error:{field:'name',message:'m'}}}),t))];
  for(const html of outputs){assert(!/\son\w+=/i.test(html)); assert(!hasInlineHandler(html));}
});

test('every string the rule editor renders exists in en, hu and fr, in the same place',()=>{
  const R=load().CrucixAlertRules,used=new Set(),rec=(key,fallback)=>{used.add(key);return fallback;};
  const states=[view(),view({confirm:'vix-watch'}),view({busy:true}),view({notice:{key:'alerts.rules.errorSave',fallback:'x',detail:'d'},status:{key:'alerts.rules.saved',fallback:'x'}}),view({readOnly:true}),{rules:[],metrics:[],loaded:false},{rules:[],metrics:[],loaded:false,loadFailed:true},view({rules:[]}),
    ...['event','threshold','change','absence','convergence','delta'].flatMap(kind=>[view({editing:{id:null,draft:R.newDraft(kind,METRIC_VIEW),error:{field:'rule',message:'m'}}}),view({editing:{id:null,draft:{...R.newDraft(kind,METRIC_VIEW),metric:'vix'},error:null}})]),
    view({editing:{id:'events-high',draft:R.draftOf(byId('events-high')),error:null}}),view({editing:{id:'vix-watch',draft:R.draftOf(byId('vix-watch')),error:null}})];
  for(const v of states)R.renderRules(v,rec);
  // Strings only some states or the controller use.
  for(const key of ['errorLoad','deleted','saved','resetDone','errorDelete','errorIdTaken','source.override','summary.kinds','summary.sources','summary.keywords','summary.clears','summary.absenceAge'])used.add('alerts.rules.'+key);
  for(const token of ['news','osint','health','earthquake','weather','outage','conflict','signal','disaster','space-weather','economic','forecast','network','cyber','maritime','aviation','sanctions','market','energy'])used.add('intelligence.kind_'+token);
  for(const metric of METRICS)used.add('alerts.rules.metric.'+metric.key);
  for(const unit of new Set(METRICS.map(metric=>metric.unit)))if(/^[a-z]+(?:\/[a-z]+)?$/.test(unit))used.add('alerts.rules.unit.'+unit);
  const maps=['en','hu','fr'].map(lang=>new Map([...flatten(locale(lang).alerts,'alerts'),...flatten(locale(lang).intelligence,'intelligence'),...flatten(locale(lang).inspector,'inspector')]));
  // (alerts.ruleNames.* is looked up for every rule id, with the stored name as the fallback: locales.test pins the built-in ones.)
  const own=[...used].filter(key=>['alerts.','intelligence.kind_','inspector.level.'].some(prefix=>key.startsWith(prefix))&&!key.startsWith('alerts.ruleNames.'));
  assert(own.length>=110,'the rule editor uses its own group, the level names and the event kinds: '+own.length);
  for(const [index,strings] of maps.entries())for(const key of own)assert(strings.has(key),`${['en','hu','fr'][index]}: ${key}`);
  assert.equal(R.renderRules(view(),pageT(locale('en'))).includes('New rule'),true);
});

// ===== Controller: the rule editor in the tray, against the real alert engine and API over HTTP =====
// The page is the fake DOM of test/fixtures/alert-dom.mjs (the tray's innerHTML is the markup the person would see); events are
// delivered to the tray's listeners like the browser would. The server is the real one: its validation answers are the ones shown.
const quiet={warn(){},error(){},log(){},info(){}};
const NOW=Date.parse('2026-10-02T12:00:00Z');
const node=(attrs,extra={})=>{const n={...extra,getAttribute:key=>Object.hasOwn(attrs,key)?attrs[key]:null,hasAttribute:key=>Object.hasOwn(attrs,key),closest:()=>n,focus(){}};return n;};
async function harness(t,{seed=[],page={},snapshot={markets:{vix:{value:22.5}}}}={}){
  const dir=mkdtempSync(join(tmpdir(),'crucix-rules-ui-')),engine=new AlertEngine(dir,{logger:quiet});engine.load();
  for(const [id,rule] of seed)engine.putRule(id,rule);
  const app=express();installAlertRoutes(app,{engine,getSnapshot:()=>snapshot});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,requests=[],control={hold:null,fail:false};
  t.after(async()=>{control.hold=null;await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  const fetchFn=async(path,init)=>{
    requests.push({path,method:init.method,type:init.headers['Content-Type'],credentials:init.credentials,body:init.body===undefined?undefined:JSON.parse(init.body)});
    if(init.method!=='GET'&&control.fail)throw new TypeError('network down');
    if(init.method!=='GET'&&control.hold)await control.hold;
    return fetch(base+path,{method:init.method,headers:{...init.headers,Origin:control.origin??base},body:init.body});
  };
  const env=dom({fetch:fetchFn,files:['record-core.js','alerts-core.js','alerts.js','alert-rules.js'],...page});
  env.A.mount({getSummary:()=>engine.summary(),t,now:()=>NOW});
  const tray=env.byId('alertTray'),focused=[];
  // Every query finds a control that records the focus it is given (but never an open snooze menu: Esc would close that first).
  tray.querySelector=selector=>selector.includes('snooze-menu')?null:{focus(){focused.push(selector);}};
  const until=async(test,what='the page to change')=>{for(let i=0;i<300;i++){if(test())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('timed out waiting for '+what);};
  const event=(type,target,more={})=>{const e={type,target,key:'',defaultPrevented:false,preventDefault(){e.defaultPrevented=true;},...more};return e;};
  const h={...env,engine,tray,requests,control,focused,until,live:()=>env.byId('alertRulesLive'),
    html:()=>tray.innerHTML,
    press:attrs=>tray.handlers.click({currentTarget:tray,target:node(attrs),preventDefault(){}}),
    type:(name,value)=>tray.handlers.input(event('input',node({name},{value,type:'text'}))),
    choose:(name,value)=>tray.handlers.change(event('change',node({name},{value}))),
    check:(name,checked,more={})=>tray.handlers.change(event('change',node({name,...more},{checked,type:'checkbox'}))),
    flip:(flag,id,checked)=>tray.handlers.change(event('change',node({'data-rule-toggle':flag,'data-rule-id':id},{checked,type:'checkbox'}))),
    submit:()=>{const e=event('submit',node({}));tray.handlers.submit(e);return e;},
    esc:()=>{const e=event('keydown',node({}),{key:'Escape',currentTarget:tray});tray.handlers.keydown(e);return e;},
    puts:()=>requests.filter(request=>request.method==='PUT'),
    openRules:async()=>{env.A.open();h.press({'data-alert-tab':'rules'});await until(()=>tray.innerHTML.includes('data-rule-id="vix-spike"'),'the rule list');},
  };
  return h;
}
const FULL_VIX={enabled:true,notify:true,severity:'high',forSweeps:2,cooldownMinutes:30,params:{metric:'vix',op:'>',value:30}};

test('the Rules tab reads the rules and the metric values, every request is same-origin JSON',async t=>{
  const h=await harness(t);
  h.A.open(); assert(!h.html().includes('data-rule-id'),'nothing before the tab is shown');
  h.press({'data-alert-tab':'rules'});
  assert(h.html().includes('Loading rules…'),'loading first'); await h.until(()=>h.html().includes('data-rule-id="vix-spike"'));
  assert.deepEqual(plain(h.requests.map(({path,method,credentials})=>[path,method,credentials])),[['/api/alerts?state=all&limit=200','GET','same-origin'],['/api/alerts/rules','GET','same-origin']]);
  for(const rule of DEFAULT_RULES)assert(h.html().includes(`data-rule-id="${rule.id}"`)&&h.html().includes(rule.name),rule.id);
  assert.equal(count(h.html(),'ar-source-builtin'),9);
  assert(h.html().includes('<div class="at-rules"><section class="ar-panel"'),'inside the tray\'s rules placeholder');
  h.press({'data-rule-action':'new'}); h.choose('kind','threshold'); assert(h.html().includes('VIX — 22.5 index')&&h.html().includes('current: 22.5 index'),'the metric values come from the server');
  h.press({'data-rule-action':'cancel'}); h.press({'data-alert-tab':'active'}); h.press({'data-alert-tab':'rules'}); await h.until(()=>h.requests.filter(request=>request.path==='/api/alerts/rules').length===2,'a reload');
});

test('a toggle saves at once; a built-in is sent as a complete override, a user rule as the whole rule, neither with source or id',async t=>{
  const h=await harness(t,{seed:[['my-rule',{name:'My rule',kind:'threshold',severity:'watch',params:{metric:'gold',op:'<',value:1500}}]]});
  await h.openRules(); await h.until(()=>h.html().includes('data-rule-id="my-rule"'));
  h.flip('notify','vix-spike',false);
  assert(h.html().includes('aria-busy="true"'),'busy while the request runs'); await h.until(()=>h.puts().length===1&&h.html().includes('aria-busy="false"'));
  assert.deepEqual(plain(h.puts()[0]),{path:'/api/alerts/rules/vix-spike',method:'PUT',type:'application/json',credentials:'same-origin',body:{...FULL_VIX,notify:false}});
  assert(row(h.html(),'vix-spike').includes('>Modified<')&&!/<input[^>]*data-rule-toggle="notify" data-rule-id="vix-spike"[^>]* checked/.test(h.html()),'the answer replaced the row');
  assert.equal(h.engine.rules().find(rule=>rule.id==='vix-spike').source,'override'); assert.equal(h.engine.rules().find(rule=>rule.id==='vix-spike').notify,false);
  assert.equal(h.focused.at(-1),'[data-rule-toggle="notify"][data-rule-id="vix-spike"]','the focus stays on the toggle');
  // events-high: an override replaces params wholesale, so maxLevel has to travel with it (or it would overlap events-critical).
  h.flip('enabled','events-high',false); await h.until(()=>h.puts().length===2&&h.html().includes('aria-busy="false"'));
  assert.deepEqual(plain(h.puts()[1].body),{enabled:false,notify:true,severity:'auto',forSweeps:1,cooldownMinutes:30,params:{minLevel:'high',maxLevel:'high'},scope:{}});
  assert.deepEqual(plain(h.engine.rules().find(rule=>rule.id==='events-high').params),{minLevel:'high',maxLevel:'high'});
  h.flip('enabled','my-rule',false); await h.until(()=>h.puts().length===3&&h.html().includes('aria-busy="false"'));
  assert.deepEqual(plain(h.puts()[2].body),{name:'My rule',kind:'threshold',enabled:false,severity:'watch',notify:false,forSweeps:2,cooldownMinutes:30,params:{metric:'gold',op:'<',value:1500}});
  assert(!('id' in h.puts()[2].body)&&!('source' in h.puts()[2].body)); assert.equal(h.engine.rules().find(rule=>rule.id==='my-rule').enabled,false);
  assert(row(h.html(),'my-rule').includes('ar-rule-off'),'a disabled rule is dimmed');
});

test('a new threshold rule on the VIX is created from the form, listed, then deleted after a question',async t=>{
  const h=await harness(t);
  await h.openRules(); h.press({'data-rule-action':'new'});
  assert(h.html().includes('<form class="ar-form"')&&h.focused.at(-1)==='#ar-name','the form opens, the focus in the name');
  h.choose('kind','threshold'); assert(fieldPaths(h.html()).includes('params.metric')&&h.focused.at(-1)==='#ar-kind','the kind decides the fields, the focus stays on the select');
  h.type('name','VIX over 30'); h.choose('metric','vix'); h.type('value','30'); h.type('clearValue','28');
  const e=h.submit(); assert(e.defaultPrevented,'no native submit');
  assert(h.html().includes('aria-busy="true"')); await h.until(()=>h.puts().length===1&&h.html().includes('data-rule-id="vix-over-30"'));
  assert.deepEqual(plain(h.puts()[0]),{path:'/api/alerts/rules/vix-over-30',method:'PUT',type:'application/json',credentials:'same-origin',body:{name:'VIX over 30',kind:'threshold',enabled:true,severity:'high',notify:false,forSweeps:2,cooldownMinutes:30,params:{metric:'vix',op:'>',value:30,clearValue:28}}});
  assert(row(h.html(),'vix-over-30').includes('VIX &gt; 30 (clears at 28)')&&row(h.html(),'vix-over-30').includes('>Custom<')&&!h.html().includes('<form'),'the list is back with the new rule');
  assert.equal(h.focused.at(-1),'[data-rule-action="edit"][data-rule-id="vix-over-30"]','the focus goes to the new rule\'s Edit'); assert(h.html().includes('Rule saved'));
  await h.until(()=>h.live().textContent==='Rule saved');
  assert.deepEqual(plain(h.engine.rules().find(rule=>rule.id==='vix-over-30').params),{metric:'vix',op:'>',value:30,clearValue:28});
  // The delete question: no request until it is confirmed; Cancel and Esc drop it.
  h.press({'data-rule-action':'delete','data-rule-id':'vix-over-30'}); assert(h.html().includes('data-rule-action="delete-confirm"')&&h.focused.at(-1)==='[data-rule-action="delete-confirm"][data-rule-id="vix-over-30"]');
  h.press({'data-rule-action':'cancel-confirm','data-rule-id':'vix-over-30'}); assert(!h.html().includes('delete-confirm')); h.press({'data-rule-action':'delete','data-rule-id':'vix-over-30'});
  assert(h.esc().defaultPrevented,'Esc answers the question first'); assert(!h.html().includes('delete-confirm')&&h.tray.hidden===false&&h.focused.at(-1)==='[data-rule-action="delete"][data-rule-id="vix-over-30"]');
  assert.equal(h.requests.filter(request=>request.method==='DELETE').length,0);
  h.press({'data-rule-action':'delete','data-rule-id':'vix-over-30'}); h.press({'data-rule-action':'delete-confirm','data-rule-id':'vix-over-30'});
  await h.until(()=>!h.html().includes('data-rule-id="vix-over-30"'));
  const del=h.requests.find(request=>request.method==='DELETE'); assert.deepEqual(plain([del.path,del.type,del.credentials]),['/api/alerts/rules/vix-over-30','application/json','same-origin']); assert.equal(del.body,undefined,'no body');
  assert(h.html().includes('Rule deleted')&&h.focused.at(-1)==='[data-rule-action="new"]'); assert(!h.engine.rules().some(rule=>rule.id==='vix-over-30'));
  await h.until(()=>h.live().textContent==='Rule deleted');
});

test('the server\'s validation answer is shown at the field, the typed values stay, nothing is saved',async t=>{
  const h=await harness(t);
  await h.openRules(); h.press({'data-rule-action':'new'}); h.type('keywords','flood, fire');
  h.submit(); await h.until(()=>h.puts().length===1&&h.html().includes('class="ar-error"'));
  assert.equal(h.puts()[0].path,'/api/alerts/rules/rule','an empty name still gets a valid id'); assert.equal(h.puts()[0].body.name,'');
  const name=fieldBlocks(h.html()).get('name'); assert(name.includes('<p class="ar-error"')&&name.includes('must not be empty'),'the message is next to the name'); assert(h.html().includes('Could not save the rule'));
  assert(h.html().includes('value="flood, fire"'),'what was typed stays'); assert.equal(h.engine.rules().length,DEFAULT_RULES.length,'nothing was saved');
  assert.equal(h.focused.at(-1),'[data-rule-field="name"] :is(input,select)','the focus goes to the field'); assert(h.html().includes('aria-busy="false"')&&!/<(?:input|button)[^>]* disabled/.test(h.html()),'the controls are back');
  await h.until(()=>h.live().textContent.startsWith('Could not save the rule'));
  // A field in a list, an index in the path, a rule-level check: each lands where it belongs.
  h.type('name','Floods'); h.type('keywords',Array.from({length:11},(_,i)=>'k'+i).join(',')); h.submit();
  await h.until(()=>h.puts().length===2&&h.html().includes('at most 10 entries')); assert(fieldBlocks(h.html()).get('scope.keywords').includes('at most 10 entries'));
  h.type('keywords',''); h.type('lat','95'); h.type('lon','19'); h.type('km','500'); h.submit();
  await h.until(()=>h.puts().length===3&&fieldBlocks(h.html()).get('scope.radius.lat').includes('from -90 to 90'));
  h.type('lat','47.5'); h.type('km','5000'); h.submit(); await h.until(()=>h.puts().length===4&&fieldBlocks(h.html()).get('scope.radius.km').includes('1 to 3000'));
  h.type('km','500'); h.choose('maxLevel','info'); h.submit(); await h.until(()=>h.puts().length===5&&fieldBlocks(h.html()).get('params.maxLevel')?.includes('below'));
  h.choose('maxLevel',''); h.submit(); await h.until(()=>h.puts().length===6&&!h.html().includes('<form')); assert(h.engine.rules().some(rule=>rule.id==='floods'&&rule.scope.radius.km===500));
  // The comma decimal of a Hungarian keyboard reaches the server as a number.
  h.press({'data-rule-action':'new'}); h.type('name','Budapest'); h.type('lat','47,5'); h.type('lon','19,05'); h.type('km','50'); h.submit(); await h.until(()=>h.puts().length===7&&h.html().includes('data-rule-id="budapest"'));
  assert.deepEqual(plain(h.puts()[6].body.scope.radius),{lat:47.5,lon:19.05,km:50});
});

test('an id is made from the name and never overwrites a rule; "constructor" and "prototype" are ordinary ids',async t=>{
  const h=await harness(t);
  await h.openRules();
  h.press({'data-rule-action':'new'}); h.type('name','VIX spike'); h.submit(); await h.until(()=>h.html().includes('data-rule-id="vix-spike-2"'));
  assert.equal(h.puts()[0].path,'/api/alerts/rules/vix-spike-2','the slug is taken: the next free one'); assert.equal(h.engine.rules().find(rule=>rule.id==='vix-spike').source,'builtin','the built-in is untouched');
  h.press({'data-rule-action':'new'}); h.type('name','Mine'); h.type('id','vix-spike'); h.submit();
  assert(fieldBlocks(h.html()).get('id').includes('This ID is already used by another rule'),'a typed id that is taken is refused before any request'); assert.equal(h.puts().length,1);
  for(const [n,id] of [[2,'constructor'],[3,'prototype']]){
    h.type('id',id); h.type('name','Rule '+id); h.submit(); await h.until(()=>h.puts().length===n&&h.html().includes(`data-rule-id="${id}"`),id);
    h.press({'data-rule-action':'new'});
  }
  h.type('id','__proto__x'); h.type('name','Odd id'); h.submit(); await h.until(()=>h.puts().length===4&&h.html().includes('class="ar-error"'));
  assert.equal(h.puts()[3].path,'/api/alerts/rules/__proto__x','the server decides about an odd id'); assert(fieldBlocks(h.html()).get('id').includes('must be 1-40 characters'));
  h.press({'data-rule-action':'cancel'});
  for(const id of ['constructor','prototype']){
    assert(row(h.html(),id).includes('>Custom<'),id);
    h.flip('enabled',id,false); await h.until(()=>h.engine.rules().find(rule=>rule.id===id).enabled===false&&h.html().includes('aria-busy="false"'),id+' off');
    h.press({'data-rule-action':'delete','data-rule-id':id}); h.press({'data-rule-action':'delete-confirm','data-rule-id':id}); await h.until(()=>!h.html().includes(`data-rule-id="${id}"`),id+' deleted');
    assert(!h.engine.rules().some(rule=>rule.id===id));
  }
});

test('Reset to default removes an override and reads the rules again; editing a built-in sends a complete override',async t=>{
  const h=await harness(t);
  await h.openRules(); h.press({'data-rule-action':'edit','data-rule-id':'events-high'});
  assert(h.html().includes('<form class="ar-form"')&&!/name="name"/.test(h.html())&&h.html().includes('High-severity events')); assert.equal(h.focused.at(-1),'.ar-form [name]');
  h.choose('minLevel','watch'); h.type('keywords','storm'); h.submit(); await h.until(()=>h.puts().length===1&&!h.html().includes('<form'));
  assert.deepEqual(plain(h.puts()[0].body),{enabled:true,notify:true,severity:'auto',forSweeps:1,cooldownMinutes:30,params:{minLevel:'watch',maxLevel:'high'},scope:{keywords:['storm']}});
  assert(row(h.html(),'events-high').includes('>Modified<')&&row(h.html(),'events-high').includes('Watch–High · keywords: storm')); assert.equal(h.focused.at(-1),'[data-rule-action="edit"][data-rule-id="events-high"]');
  const before=h.requests.length; h.press({'data-rule-action':'reset','data-rule-id':'events-high'});
  await h.until(()=>row(h.html(),'events-high').includes('>Built-in<')&&h.html().includes('Rule reset to default'));
  // The tray may re-read the alert list in between (timing differs per platform); only the rule requests are pinned.
  assert.deepEqual(plain(h.requests.slice(before).filter(request=>request.path.startsWith('/api/alerts/rules')).map(request=>[request.method,request.path])),[['DELETE','/api/alerts/rules/events-high'],['GET','/api/alerts/rules']]);
  assert(row(h.html(),'events-high').includes('= High')&&!row(h.html(),'events-high').includes('storm'),'the default is back'); assert.equal(h.engine.rules().find(rule=>rule.id==='events-high').source,'builtin');
});

test('one request at a time: the controls are disabled and other clicks do nothing until it is answered',async t=>{
  const h=await harness(t); await h.openRules();
  let release;h.control.hold=new Promise(resolve=>{release=resolve;});
  h.flip('notify','vix-spike',false);
  const panel=()=>h.html().slice(h.html().indexOf('<section class="ar-panel"'));
  assert(h.html().includes('aria-busy="true"')); for(const tag of panel().match(/<(?:input|button|select)[^>]*>/g))assert(/ disabled/.test(tag),tag);
  h.press({'data-rule-action':'edit','data-rule-id':'events-high'}); h.flip('enabled','events-high',false); h.press({'data-rule-action':'new'});
  assert(!h.html().includes('<form')&&h.puts().length===1,'a second request or form is not started');
  release(); await h.until(()=>h.html().includes('aria-busy="false"')&&!/<(?:input|button)[^>]* disabled/.test(panel()));
  assert.equal(h.focused.at(-1),'[data-rule-toggle="notify"][data-rule-id="vix-spike"]');
});

test('Esc while a rule request runs is taken: the form, the tray and the request stay',async t=>{
  const h=await harness(t); await h.openRules();
  let release;h.control.hold=new Promise(resolve=>{release=resolve;});
  h.press({'data-rule-action':'new'}); h.type('name','Pending rule'); h.submit();
  assert(h.html().includes('aria-busy="true"'));
  const during=h.esc();
  assert(during.defaultPrevented,'Esc is taken'); assert.equal(h.tray.hidden,false,'the tray stays open'); assert(h.html().includes('<form')&&h.html().includes('value="Pending rule"'),'the form stays');
  release(); await h.until(()=>h.html().includes('data-rule-id="pending-rule"')&&h.html().includes('aria-busy="false"'),'the save');
  // A delete that runs: the question is answered, the request is in flight.
  h.control.hold=new Promise(resolve=>{release=resolve;});
  h.press({'data-rule-action':'delete','data-rule-id':'pending-rule'}); h.press({'data-rule-action':'delete-confirm','data-rule-id':'pending-rule'});
  assert(h.esc().defaultPrevented); assert.equal(h.tray.hidden,false);
  release(); await h.until(()=>!h.html().includes('data-rule-id="pending-rule"')&&h.html().includes('aria-busy="false"'),'the delete');
  const after=h.esc(); assert(after.defaultPrevented&&h.tray.hidden===true,'with nothing running and nothing open, Esc closes the tray (alerts.js)');
});

test('a change refused for its origin or host name names the fix instead of the server text',async t=>{
  const h=await harness(t); await h.openRules(); h.control.origin='http://evil.example';
  h.flip('notify','vix-spike',false); await h.until(()=>h.html().includes('Could not save the rule')&&h.html().includes('aria-busy="false"'));
  assert(h.html().includes('ALERT_PUBLIC_URL')&&!h.html().includes('Cross-origin request refused'),'the toggle failure');
  h.press({'data-rule-action':'new'}); h.type('name','Refused'); h.submit(); await h.until(()=>h.puts().length===2&&h.html().includes('<form')&&h.html().includes('aria-busy="false"'));
  assert(h.html().includes('Could not save the rule: Refused at this address')&&!h.html().includes('Cross-origin request refused'),'the form failure, at the top of the form');
  assert.equal(h.focused.at(-1),'.ar-notice');
  assert.equal(h.engine.rules().length,DEFAULT_RULES.length,'nothing was saved');
});

test('a form survives a live update of the tray, Esc closes the form before the tray, and a failure keeps what was typed',async t=>{
  const h=await harness(t); await h.openRules();
  h.press({'data-rule-action':'new'}); h.type('name','Half typed'); h.check('notify',true); h.check('kinds',true,{value:'conflict'}); h.check('kinds',true,{value:'weather'}); h.check('kinds',false,{value:'weather'});
  assert(h.A.update({...h.engine.summary(),generatedAt:Date.now()+60000}),'a newer summary'); // a live update redraws the tray
  assert(h.html().includes('value="Half typed"')&&/name="notify"[^>]* checked/.test(h.html())&&/name="kinds" value="conflict"[^>]*checked/.test(h.html())&&!/name="kinds" value="weather"[^>]*checked/.test(h.html()),'the draft is drawn again as it was');
  h.control.fail=true; h.submit(); await h.until(()=>h.html().includes('Could not save the rule')&&h.html().includes('aria-busy="false"'));
  assert(h.html().includes('<form')&&h.html().includes('value="Half typed"'),'a network failure keeps the form'); assert.equal(h.focused.at(-1),'.ar-notice');
  h.control.fail=false; h.submit(); await h.until(()=>!h.html().includes('<form')&&h.html().includes('data-rule-id="half-typed"'));
  assert.deepEqual(plain(h.puts().at(-1).body.scope),{kinds:['conflict']});
  h.press({'data-rule-action':'new'}); h.type('name','Abandoned'); const first=h.esc();
  assert(first.defaultPrevented&&!h.html().includes('<form')&&h.tray.hidden===false,'the first Esc closes the form only'); assert.equal(h.focused.at(-1),'[data-rule-action="new"]');
  const second=h.esc(); assert(second.defaultPrevented&&h.tray.hidden===true,'the next Esc closes the tray (alerts.js)');
  h.A.open(); assert(h.html().includes('data-rule-id="half-typed"'),'the Rules tab is still there when the tray opens again');
});

test('hostile rule names from the server are text; a refused change shows the error, a read-only page asks for nothing',async t=>{
  const HOST='"><img src=x onerror=window.__x=1>';
  const h=await harness(t,{seed:[['evil',{name:HOST,kind:'event',severity:'high',params:{minLevel:'high'},scope:{keywords:[HOST]}}]]});
  await h.openRules(); await h.until(()=>h.html().includes('data-rule-id="evil"'));
  assert(row(h.html(),'evil').includes('&lt;img src=x onerror=window.__x=1&gt;')&&!h.html().includes('<img')); assert(!hasInlineHandler(h.html()));
  h.press({'data-rule-action':'edit','data-rule-id':'evil'}); assert(h.html().includes('value="&quot;&gt;&lt;img src=x onerror=window.__x=1&gt;"')&&!h.html().includes('<img'),'the name in its input');
  // A change the server refuses outright (the 51st rule): the message is text at the top of the form.
  const full=await harness(t,{seed:Array.from({length:50},(_,i)=>['r'+i,{name:'Rule '+i,kind:'delta',params:{minSeverity:'high'}}])});
  await full.openRules(); full.press({'data-rule-action':'new'}); full.type('name','One too many'); full.submit();
  await full.until(()=>full.html().includes('At most 50 user rules')); assert(full.html().includes('Could not save the rule')); assert(fieldBlocks(full.html()).get('id').includes('At most 50 user rules'),'its field is the id');
  // File pages and the offline shell: nothing is requested.
  for(const page of [{protocol:'file:'},{offline:true}]){
    const ro=await harness(t,{page}); ro.A.open(); ro.press({'data-alert-tab':'rules'});
    assert(ro.html().includes('Rules are only available on the live dashboard')&&!ro.html().includes('data-rule-action')); assert.equal(ro.requests.length,0);
  }
});
