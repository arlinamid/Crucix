import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { DEFAULT_RULES } from '../lib/alerts/rules.mjs';
import { dom } from './fixtures/alert-dom.mjs';
const read=file=>readFileSync(new URL('../dashboard/public/'+file,import.meta.url),'utf8');
// record-core.js, alerts-core.js and alerts.js share one realm, as in the page; a fresh realm per test, so nothing leaks.
// Results cross the realm boundary: compare plain data through JSON (prototypes differ).
const load=()=>{const window={},context=vm.createContext({window,Date,URL});for(const file of ['record-core.js','alerts-core.js','alerts.js'])vm.runInContext(read(file),context);return window;};
const plain=value=>JSON.parse(JSON.stringify(value));
const t=(_,fallback)=>fallback;
// The dashboard's t() (jarvis.html): walks the key with `in`, so prototype members are reachable; non-strings give the fallback.
const pageT=locale=>(keyPath,fallback)=>{let value=locale;for(const key of keyPath.split('.')){if(value&&typeof value==='object'&&key in value)value=value[key];else return fallback||keyPath;}return typeof value==='string'?value:(fallback||keyPath);};
const now=Date.parse('2026-10-02T12:00:00Z'),MIN=60000,HOUR=3600000;
const EVENT='event-'+'a'.repeat(32),HOSTILE='"><img onerror=x>';
const count=(html,needle)=>html.split(needle).length-1;
const hhmm=ms=>{const d=new Date(ms);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');};
// A tag with an on*= attribute name. Escaped text ("&lt;img onerror=x&gt;") is not a tag, and inside a tag the quoted attribute
// values are dropped first: an escaped value cannot contain a raw quote, so " onerror=" there is inert text.
// An attribute name may also follow a closing quote or a slash directly (<img src="x"onerror=y>, <img/onerror=y>).
const hasInlineHandler=html=>(html.match(/<[a-z][^>]*>/gi)||[]).some(tag=>/[\s"'/]on\w+\s*=/i.test(tag.replace(/"[^"]*"/g,'""')));
let serial=0;
const alert=(more={})=>{serial+=1;return {id:'alert-'+String(serial).padStart(32,'0'),ruleId:'events-critical',ruleName:'Critical events',dedupKey:'events-critical|'+EVENT,kind:'event',severity:'critical',state:'firing',
  title:'Alert '+serial,summary:'Summary '+serial,evidence:[{type:'event',id:EVENT,title:'Quake near Szeged',source:'USGS',level:'critical'}],firstSeenAt:now-2*HOUR,lastSeenAt:now-10*MIN,count:3,notify:true,silent:false,log:[],...more};};
const compact=a=>({id:a.id,ruleId:a.ruleId,ruleName:a.ruleName,severity:a.severity,state:a.state,title:a.title,firstSeenAt:a.firstSeenAt,lastSeenAt:a.lastSeenAt,count:a.count,silent:a.silent});
const summaryOf=(alerts,more={})=>{
  const counts={critical:0,high:0,watch:0,info:0,total:0,acked:0,snoozed:0},firing=alerts.filter(a=>a.state==='firing');
  for(const a of alerts){if(a.state==='resolved')continue;counts.total++;if(a.state==='firing')counts[a.severity]++;else counts[a.state]++;}
  const level={critical:5,high:4,watch:3,info:2}[firing[0]?.severity]||1;
  return {generatedAt:now,lastEvaluatedAt:now-5*MIN,counts,threat:{level,drivers:firing.slice(0,5).map(a=>({alertId:a.id,ruleId:a.ruleId,severity:a.severity,title:a.title}))},
    top:firing.slice(0,5).map(compact),overflow:[],rules:{enabled:8,total:8},status:{alerts:{source:'main'}},...more};
};
const view=(alerts,more={})=>({tab:'active',alerts,summary:summaryOf(alerts),expandedGroups:[],threatOpen:false,...more});

test('core constants and helpers are those of record-core',()=>{
  const window=load(),C=window.CrucixAlertsCore,R=window.CrucixRecords;
  assert.deepEqual(plain(C.LEVELS),['critical','high','watch','info']);
  for(const level of C.LEVELS)assert.equal(C.GLYPH[level],R.GLYPH[level],level);
  assert.equal(C.esc(`<a href="x">'&`),'&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(C.safeUrl('javascript:alert(1)'),null); assert.equal(C.safeUrl('https://user:pw@example.org/'),null); assert.equal(C.safeUrl('https://example.org/a'),'https://example.org/a');
  assert.equal(C.ageLabel(now-12*MIN,now),'12m'); assert.equal(C.ageLabel(now-3*HOUR,now),'3h'); assert.equal(C.ageLabel(now-2*24*HOUR,now),'2d'); assert.equal(C.ageLabel(NaN,now),'—');
});

test('sortAlerts: firing first, then severity, then newest lastSeenAt; stable; input untouched',()=>{
  const C=load().CrucixAlertsCore;
  const a=alert({state:'acked',severity:'critical',lastSeenAt:now}),b=alert({severity:'watch',lastSeenAt:now-MIN}),c=alert({severity:'critical',lastSeenAt:now-5*MIN}),d=alert({severity:'critical',lastSeenAt:now-MIN});
  const e=alert({state:'snoozed',severity:'high',lastSeenAt:now}),f=alert({state:'resolved',severity:'critical',lastSeenAt:now}),g=alert({severity:'critical',lastSeenAt:now-5*MIN});
  const input=[a,b,c,d,e,f,g],before=input.map(x=>x.id);
  assert.deepEqual(C.sortAlerts(input).map(x=>x.id),[d.id,c.id,g.id,b.id,a.id,e.id,f.id]);
  assert.deepEqual(input.map(x=>x.id),before,'the input array keeps its order');
  for(const garbage of [null,undefined,'x',42,{},[null,1,'x']])assert.deepEqual(plain(C.sortAlerts(garbage)),[]);
});

test('groupByRule: more than five alerts of a rule form a group, in sorted order',()=>{
  const C=load().CrucixAlertsCore;
  const six=Array.from({length:6},(_,i)=>alert({ruleId:'events-high',ruleName:'High-severity events',severity:'high',lastSeenAt:now-i*MIN}));
  const five=Array.from({length:5},(_,i)=>alert({ruleId:'vix-spike',ruleName:'VIX spike',severity:'watch',lastSeenAt:now-i*MIN}));
  const top=alert();
  const groups=C.groupByRule(C.sortAlerts([...five,...six,top]));
  assert.deepEqual(plain(groups.map(g=>[g.ruleId,g.ruleName,g.alerts.length,g.grouped])),[['events-critical','Critical events',1,false],['events-high','High-severity events',6,true],['vix-spike','VIX spike',5,false]]);
  assert.deepEqual(plain(groups[1].alerts.map(a=>a.id)),six.map(a=>a.id));
  assert.equal(C.groupByRule(six,6)[0].grouped,false,'the threshold is configurable');
  assert.deepEqual(plain(C.groupByRule('nope')),[]);
});

test('titleBadge counts firing critical and high alerts',()=>{
  const C=load().CrucixAlertsCore;
  assert.equal(C.titleBadge({counts:{critical:1,high:2,watch:7,info:1}}),'(3) ');
  assert.equal(C.titleBadge({counts:{critical:0,high:0,watch:4}}),'');
  for(const garbage of [null,undefined,'x',{counts:null},{counts:{critical:-1,high:'2'}},{counts:{critical:NaN,high:Infinity}}])assert.equal(C.titleBadge(garbage),'');
});

test('newAlertToasts: new firing critical or high alerts only, never silent ones',()=>{
  const C=load().CrucixAlertsCore;
  const critical=alert(),high=alert({severity:'high'}),watch=alert({severity:'watch'}),seen=alert(),silent=alert({silent:true}),acked=alert({state:'acked'});
  const summary={top:[critical,high,watch,seen,silent,acked].map(compact)};
  assert.deepEqual(C.newAlertToasts(summary,new Set([seen.id])).map(a=>a.id),[critical.id,high.id]);
  assert.deepEqual(plain(C.newAlertToasts(summary,new Set([critical.id,high.id,seen.id]))),[]);
  for(const garbage of [null,'x',{top:'x'},{top:[null,1]}])assert.deepEqual(plain(C.newAlertToasts(garbage,new Set())),[]);
  assert.deepEqual(plain(C.newAlertToasts(summary,null).map(a=>a.id)),[critical.id,high.id,seen.id],'a missing seen set counts as empty');
  assert.deepEqual(plain(C.newAlertToasts({top:[compact(critical),compact(critical)]},new Set()).map(a=>a.id)),[critical.id],'one toast per id');
});

test('renderStrip: calm state',()=>{
  const A=load().CrucixAlerts,summary=summaryOf([]);
  const html=A.renderStrip(summary,t,now);
  assert(html.includes('No active alerts')); assert(html.includes('Last evaluation')); assert(html.includes(hhmm(now-5*MIN)));
  assert(html.includes('data-alert-action="threat"')); assert(html.includes('1/5'));
  for(const action of ['ack','snooze','open'])assert(!html.includes(`data-alert-action="${action}"`),action);
  assert(A.renderStrip({...summary,lastEvaluatedAt:null},t,now).includes('—'),'never evaluated');
});

test('renderStrip: active state',()=>{
  const A=load().CrucixAlerts,top=alert({title:'Earthquake M7.1'}),alerts=[top,alert({severity:'high'}),alert({severity:'high'})];
  const html=A.renderStrip(summaryOf(alerts),t,now);
  assert.match(html,/<button type="button" class="as-threat as-threat-5" data-alert-action="threat" aria-expanded="false"[^>]*>/);
  assert(html.includes('Threat 5/5'));
  assert(html.includes('<span class="ri-sr"> Critical</span>')&&html.includes('<span class="ri-sr"> High</span>'),'level names are spoken');
  assert(html.includes('sev-critical')&&html.includes('sev-high'));
  assert(!html.includes('as-count sev-watch')&&!html.includes('as-count sev-info'),'no counter for zero levels');
  assert.match(html,/as-count sev-critical"><i aria-hidden="true">◆<\/i>1</); assert.match(html,/as-count sev-high"><i aria-hidden="true">▲<\/i>2</);
  assert(html.includes('Earthquake M7.1')); assert(!html.includes('No active alerts'));
  for(const action of ['ack','snooze-menu','open'])assert(html.includes(`data-alert-action="${action}" data-alert-id="${top.id}"`),action);
  for(const minutes of [60,480,1440])assert(html.includes(`data-alert-action="snooze" data-alert-id="${top.id}" data-minutes="${minutes}"`),String(minutes));
  assert.match(html,/<span class="al-snooze-menu" id="as-snooze" role="group" aria-label="Snooze" hidden>/,'the snooze lengths start hidden');
  assert(html.includes('+2 more alerts'),'the other firing alerts are counted');
  assert(A.renderStrip(summaryOf(alerts),t,now,true).includes('aria-expanded="true"'),'an open threat panel is announced');
});

test('renderTray: tabs, empty state and the rules placeholder',()=>{
  const A=load().CrucixAlerts;
  const html=A.renderTray(view([]),t,now);
  assert.equal(count(html,'role="tab"'),4);
  for(const [tab,label] of [['active','Active'],['handled','Handled'],['resolved','Resolved'],['rules','Rules']])assert(html.includes(`data-alert-tab="${tab}"`)&&html.includes(label),tab);
  assert.match(html,/data-alert-tab="active"[^>]*aria-selected="true"/); assert.match(html,/data-alert-tab="rules"[^>]*aria-selected="false"/);
  // Roving tabindex: only the selected tab is in the tab order.
  assert.match(html,/data-alert-tab="active"[^>]*tabindex="0"/);
  for(const tab of ['handled','resolved','rules'])assert.match(html,new RegExp(`data-alert-tab="${tab}"[^>]*tabindex="-1"`),tab);
  assert.match(A.renderTray(view([],{tab:'resolved'}),t,now),/data-alert-tab="resolved"[^>]*tabindex="0"/);
  assert(html.includes('role="tabpanel"')); assert(html.includes('Nothing here'));
  assert(html.includes('data-alert-action="close"'));
  const rules=A.renderTray(view([alert()],{tab:'rules'}),t,now);
  assert(rules.includes('<div class="at-rules"></div>')); assert(!rules.includes('data-alert-id='),'the rules tab lists no alerts');
  assert.match(A.renderTray(view([],{tab:'bogus'}),t,now),/data-alert-tab="active"[^>]*aria-selected="true"/,'an unknown tab falls back to active');
});

test('renderTray: rows, actions and per-tab filtering',()=>{
  const A=load().CrucixAlerts;
  const firing=alert({title:'Firing one',count:4}),acked=alert({state:'acked',ack:{at:now-HOUR},title:'Acked one'});
  const snoozed=alert({state:'snoozed',snooze:{at:now-HOUR,until:now+3*HOUR},title:'Snoozed one'}),resolved=alert({state:'resolved',resolvedAt:now-30*MIN,title:'Resolved one'});
  const all=[firing,acked,snoozed,resolved];
  const active=A.renderTray(view(all),t,now);
  assert.equal(count(active,'data-alert-id="'+firing.id+'"')>0,true); assert(!active.includes(acked.id)&&!active.includes(resolved.id),'active shows firing alerts only');
  assert.match(active,new RegExp(`<li class="at-alert[^"]*" data-alert-id="${firing.id}"`));
  for(const action of ['ack','snooze-menu','resolve'])assert(active.includes(`data-alert-action="${action}" data-alert-id="${firing.id}"`),action);
  for(const minutes of [60,480,1440])assert(active.includes(`data-alert-action="snooze" data-alert-id="${firing.id}" data-minutes="${minutes}"`),String(minutes));
  // The snooze lengths start closed: the toggle says so and the group is hidden.
  assert.match(active,/data-alert-action="snooze-menu" data-alert-id="[^"]+" aria-expanded="false" aria-controls="at-snooze-0">/);
  assert.match(active,/<span class="al-snooze-menu" id="at-snooze-0" role="group" aria-label="Snooze" hidden>/);
  for(const text of ['Firing one','Critical events','<span class="at-age">2h</span>','seen 4×','Summary'])assert(active.includes(text),text);
  assert(active.includes(`data-alert-action="evidence" data-event-id="${EVENT}"`)&&active.includes('Quake near Szeged'),'evidence opens the event');
  assert(active.includes('<span class="ri-sr">Critical</span>'));
  assert(active.includes('data-alert-action="ack-all"')&&active.includes('Acknowledge all'));
  assert(active.includes('data-alert-action="ack-all" data-severity="critical"'),'ack all by level');
  const handled=A.renderTray(view(all,{tab:'handled'}),t,now);
  assert(handled.includes('Acked one')&&handled.includes('Snoozed one')&&!handled.includes('Firing one')&&!handled.includes('Resolved one'));
  assert(handled.includes('Snoozed until')&&handled.includes(hhmm(now+3*HOUR)),'the snooze deadline is shown');
  assert(handled.includes('Acknowledged'));
  assert(!handled.includes(`data-alert-action="ack" data-alert-id="${acked.id}"`),'an acknowledged alert has no ack button');
  assert(handled.includes(`data-alert-action="resolve" data-alert-id="${acked.id}"`));
  assert(!handled.includes('data-alert-action="ack-all"'),'ack all lives on the active tab');
  const done=A.renderTray(view(all,{tab:'resolved'}),t,now);
  assert(done.includes('Resolved one')&&!done.includes('Firing one')); assert(done.includes(hhmm(now-30*MIN)),'the resolve time is shown');
  for(const action of ['ack','snooze-menu','snooze','resolve'])assert(!done.includes(`data-alert-action="${action}"`),'a resolved alert has no '+action+' action');
  assert(A.renderTray(view([alert({silent:true})]),t,now).includes('Initial baseline'),'a bootstrap alert is labelled');
});

test('renderTray: grouping, expansion and overflow',()=>{
  const A=load().CrucixAlerts;
  const six=Array.from({length:6},(_,i)=>alert({ruleId:'events-high',ruleName:'High-severity events',severity:'high',lastSeenAt:now-i*MIN}));
  const lone=alert();
  const collapsed=A.renderTray(view([...six,lone],{summary:{...summaryOf([...six,lone]),overflow:[{ruleId:'events-high',count:12}]}}),t,now);
  assert.match(collapsed,/data-alert-action="group" data-rule-id="events-high" aria-expanded="false"/);
  assert(collapsed.includes('High-severity events')); assert(collapsed.includes('+12 more alerts'),'overflow in the group header');
  assert.equal(count(collapsed,'<li class="at-alert'),1,'a collapsed group hides its rows');
  const open=A.renderTray(view([...six,lone],{expandedGroups:['events-high']}),t,now);
  assert.match(open,/data-alert-action="group" data-rule-id="events-high" aria-expanded="true"/);
  assert.equal(count(open,'<li class="at-alert'),7);
  // The caret is decoration: aria-expanded carries the state, the arrow is never read aloud.
  assert(collapsed.includes('<span class="at-caret" aria-hidden="true">▸</span></button>'),'collapsed caret');
  assert(open.includes('<span class="at-caret" aria-hidden="true">▾</span></button>'),'expanded caret');
  const five=A.renderTray(view(six.slice(0,5)),t,now);
  assert(!five.includes('data-alert-action="group"'),'five alerts are not grouped'); assert.equal(count(five,'<li class="at-alert'),5);
  const loneOverflow=A.renderTray(view([lone],{summary:{...summaryOf([lone]),overflow:[{ruleId:'events-critical',count:3}]}}),t,now);
  assert(loneOverflow.includes('+3 more alerts'),'overflow of an ungrouped rule is shown too');
});

test('renderTray: threat drivers block',()=>{
  const A=load().CrucixAlerts,a=alert({title:'Driver title'}),alerts=[a,alert({severity:'high'})];
  assert(!A.renderTray(view(alerts),t,now).includes('Driving this level'),'closed by default');
  const html=A.renderTray(view(alerts,{threatOpen:true}),t,now);
  assert(html.includes('Driving this level')&&html.includes('Threat 5/5')&&html.includes('Driver title'));
  assert.match(html,new RegExp(`<li data-driver-id="${a.id}">`),'a driver names its alert');
  assert.equal(count(html,`data-alert-id="${a.id}"`),count(A.renderTray(view(alerts),t,now),`data-alert-id="${a.id}"`),'a driver never carries data-alert-id');
  assert(A.renderTray(view([],{threatOpen:true}),t,now).includes('No active alerts'),'no drivers at level 1');
  // The rule name of a driver: from the alert list, else from summary.top, before the bare rule id.
  const own=alert({ruleId:'my-rule',ruleName:'My watch rule'});
  const fromTop=A.renderTray(view([],{summary:summaryOf([own]),threatOpen:true}),t,now);
  assert(fromTop.includes('My watch rule')&&!fromTop.includes('>my-rule<'),'summary.top supplies the name');
  const bare=A.renderTray(view([],{summary:{...summaryOf([own]),top:[]},threatOpen:true}),t,now);
  assert(bare.includes('>my-rule<'),'without a name the rule id is shown');
});

test('rule names are localised by id, rules without a locale name keep the stored one',()=>{
  const A=load().CrucixAlerts,tr=pageT({alerts:{ruleNames:{'events-critical':'Kritikus események'}}});
  const html=A.renderTray(view([alert(),alert({ruleId:'constructor',ruleName:'Prototype-named rule'}),alert({ruleId:'my-rule',ruleName:'My rule'}),alert({ruleId:'Bad Id!',ruleName:'Odd rule'})]),tr,now);
  for(const name of ['Kritikus események','Prototype-named rule','My rule','Odd rule'])assert(html.includes(name),name);
  assert(!html.includes('function'),'a prototype member is never shown');
  assert(A.renderToast(alert(),tr).includes('Kritikus események'));
  // Every built-in rule is looked up under its own key (the locale test pins that each key exists).
  const keyT=key=>'L:'+key;
  assert.equal(DEFAULT_RULES.length,9);
  for(const {id,name} of DEFAULT_RULES)assert(A.renderToast(alert({ruleId:id,ruleName:name}),keyT).includes('L:alerts.ruleNames.'+id),id);
  assert(!A.renderToast(alert({ruleId:'Bad Id!',ruleName:'Odd rule'}),keyT).includes('L:alerts.ruleNames'),'malformed ids are not looked up');
});

test('hostile feed text stays inert',()=>{
  for(const tag of ['<img src="x" onerror=y>','<b\nonclick="y">','<img src="x"onerror=y>','<img/onerror=y>'])assert(hasInlineHandler(tag),'the matcher finds '+tag);
  assert(!hasInlineHandler('<b title=" onerror=x">&lt;img onerror=x&gt;</b>'),'quoted values and escaped text are inert');
  const A=load().CrucixAlerts,E='&quot;&gt;&lt;img onerror=x&gt;',SAFE='https://example.org/a?x=1&y=2';
  // The leader has a valid severity, so it is the strip's top alert; its rule has more than five alerts, so a group renders.
  const leader=alert({id:HOSTILE,ruleId:HOSTILE,ruleName:HOSTILE,title:HOSTILE,summary:HOSTILE,severity:'critical',lastSeenAt:now,
    evidence:[{type:'event',id:HOSTILE,title:HOSTILE,source:HOSTILE},{type:'link',title:HOSTILE,url:SAFE,source:HOSTILE},{type:'link',title:HOSTILE,url:'javascript:alert(1)'},{type:'link',title:'Safe',url:'https://example.org/?token=s'}]});
  const crowd=Array.from({length:6},()=>alert({ruleId:HOSTILE,ruleName:HOSTILE,title:HOSTILE,severity:'high'}));
  // An unknown severity and unreadable times take the fallback paths.
  const evil=alert({id:HOSTILE,ruleId:HOSTILE,ruleName:HOSTILE,title:HOSTILE,summary:HOSTILE,severity:HOSTILE,state:'firing',evidence:[{type:'event',id:HOSTILE,title:HOSTILE,source:HOSTILE}]});
  const good=alert({title:HOSTILE,summary:HOSTILE,ruleName:HOSTILE,evidence:[{type:'event',id:EVENT,title:HOSTILE,url:'javascript:alert(1)'}]});
  const snoozed={...leader,state:'snoozed',snooze:{at:now,until:now+HOUR,reason:HOSTILE}};
  const summary={...summaryOf([leader,good]),top:[compact(leader),compact(good),compact(evil)],threat:{level:5,drivers:[{alertId:HOSTILE,ruleId:HOSTILE,severity:HOSTILE,title:HOSTILE}]},overflow:[{ruleId:HOSTILE,count:HOSTILE},{ruleId:HOSTILE+'x',count:2}]};
  const alerts=[leader,...crowd,good,evil,snoozed,{...evil,state:'snoozed',snooze:{until:HOSTILE}},{...evil,state:'resolved',resolvedAt:HOSTILE}];
  const strip=A.renderStrip(summary,t,now,true);
  const [active,handled,resolved]=['active','handled','resolved'].map(tab=>A.renderTray({tab,alerts,summary,expandedGroups:[HOSTILE],threatOpen:true},t,now));
  const outputs=[strip,A.renderToast(leader,t),A.renderToast(good,t),A.renderToast(evil,t),active,handled,resolved];
  for(const html of outputs){
    assert(!html.includes('<img'),'no raw markup'); assert(!html.includes('"&gt;<')&&!html.includes('">&lt;img'),'no attribute breakout');
    for(const href of html.match(/href="[^"]*"/g)||[])assert.equal(href,'href="https://example.org/a?x=1&amp;y=2"','only the safe evidence link, escaped');
    assert(!hasInlineHandler(html),'no inline handler');
  }
  // Every escape site with hostile input, text and attribute context alike.
  for(const action of ['ack','snooze-menu','open'])assert(strip.includes(`data-alert-action="${action}" data-alert-id="${E}"`),'strip '+action);
  assert(strip.includes(`data-alert-action="snooze" data-alert-id="${E}" data-minutes="60"`)&&strip.includes(`<span class="as-title">${E}</span>`));
  assert(active.includes(`data-alert-action="group" data-rule-id="${E}" aria-expanded="true"`),'the group toggle');
  assert(active.includes(`<li class="at-alert at-critical" data-alert-id="${E}">`)&&active.includes(`data-alert-action="resolve" data-alert-id="${E}"`),'row and actions');
  assert(active.includes(`data-event-id="${E}"`),'evidence event id');
  assert(active.includes(`<a href="https://example.org/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">${E} ↗</a><span class="at-source">${E}</span>`),'a safe evidence link with a hostile title');
  assert(active.includes(`<li data-driver-id="${E}">`)&&active.includes(`<span class="at-driver-title">${E}</span>`),'drivers');
  assert(active.includes(`<span class="at-rule">${E}x</span>`),'an overflow-only rule');
  assert(handled.includes(`· ${E}</span>`),'the snooze reason');
  assert(resolved.includes(`data-alert-id="${E}"`)&&resolved.includes('Resolved —'),'an unreadable resolve time');
  assert(outputs[1].includes(`data-alert-action="dismiss" data-alert-id="${E}"`),'toast');
  const safe=A.renderTray({tab:'active',alerts:[alert({evidence:[{type:'link',title:'Report',url:'https://example.org/report'}]})],summary:summaryOf([])},t,now);
  assert(safe.includes('href="https://example.org/report"')&&safe.includes('rel="noopener noreferrer"'),'a safe evidence link is kept');
});

test('renderToast: roles and actions',()=>{
  const A=load().CrucixAlerts,critical=alert({title:'Big one'}),high=alert({severity:'high'});
  const html=A.renderToast(critical,t);
  assert.match(html,/role="alert"/); assert(!html.includes('role="status"'));
  assert(html.includes('New alert')&&html.includes('Big one')&&html.includes('<span class="ri-sr">Critical</span>'));
  for(const action of ['ack','open','dismiss'])assert(html.includes(`data-alert-action="${action}" data-alert-id="${critical.id}"`),action);
  assert(html.includes('aria-label="Close"'));
  assert.match(A.renderToast(high,t),/role="status"/);
  for(const garbage of [null,undefined,'x',42,[],{}])assert.equal(A.renderToast(garbage,t),'',String(garbage));
});

test('no inline handlers in any output',()=>{
  const A=load().CrucixAlerts,alerts=[alert(),alert({severity:'high',state:'snoozed',snooze:{at:now,until:now+HOUR}}),alert({state:'resolved',resolvedAt:now})];
  const outputs=[A.renderStrip(summaryOf(alerts),t,now),A.renderStrip(summaryOf([]),t,now),A.renderToast(alerts[0],t),
    ...['active','handled','resolved','rules'].map(tab=>A.renderTray(view(alerts,{tab,threatOpen:true}),t,now))];
  for(const html of outputs){assert(!/\son\w+=/i.test(html),'no on*= attribute'); assert(!/javascript:/i.test(html));}
});

test('robustness: garbage summaries, views and translators never throw',()=>{
  const A=load().CrucixAlerts,C=load().CrucixAlertsCore;
  const garbage=[null,undefined,0,'x',[],{},{counts:'x',top:'y',threat:'z',overflow:'w'},{counts:{critical:'1',high:-2,watch:NaN},top:[null,1,'x',{}],threat:{level:'9',drivers:[null,{}]},overflow:[null,{ruleId:3}],lastEvaluatedAt:'soon'}];
  const badT=[t,null,()=>{throw new Error('boom');},()=>42,()=>({})];
  for(const summary of garbage)for(const tr of badT){
    assert.equal(typeof A.renderStrip(summary,tr,now),'string');
    assert.equal(typeof A.renderStrip(summary,tr,NaN),'string');
    assert.equal(typeof A.renderTray(summary,tr,now),'string');
    assert.equal(typeof A.renderTray({tab:'active',alerts:[null,1,'x',{},{id:7,state:{},severity:[],evidence:'x',lastSeenAt:'y'}],summary,expandedGroups:'x',threatOpen:'yes'},tr,now),'string');
    assert.equal(typeof A.renderToast({id:'a',severity:'critical',evidence:null},tr),'string');
    assert.equal(typeof C.titleBadge(summary),'string'); assert(Array.isArray(plain(C.newAlertToasts(summary,new Set()))));
  }
  assert(A.renderStrip(null,null,now).includes('Alerts unavailable'),'a missing translator falls back to English');
  assert(A.renderStrip(summaryOf([]),null,now).includes('No active alerts'),'a missing translator falls back to English');
});

// ===== Controller =====
// The fake DOM is test/fixtures/alert-dom.mjs.
const button=attrs=>{const node={getAttribute:k=>Object.hasOwn(attrs,k)?attrs[k]:null,hasAttribute:k=>Object.hasOwn(attrs,k),closest:()=>node,focus(){},setAttribute(k,v){attrs[k]=String(v);}};return node;};
const click=(root,attrs)=>root.handlers.click({currentTarget:root,target:button(attrs),preventDefault(){}});
const ticks=()=>new Promise(resolve=>setTimeout(resolve,20));
const firing=()=>[alert({title:'Quake <img src=x onerror=boom>'}),alert({severity:'high'}),alert({severity:'watch'})];

test('controller: mount, update and the bell never throw, whatever the page gives them',()=>{
  const bare=dom({topbar:false});
  assert.doesNotThrow(()=>bare.A.mount({getSummary:()=>summaryOf(firing()),t,now:()=>now}));
  assert.equal(bare.A.bell(),'','no top bar: nothing is mounted, the bell is empty');
  assert.doesNotThrow(()=>{bare.A.update(summaryOf(firing()));bare.A.open();});
  const {A,byId,document}=dom();
  assert.equal(A.bell(),'','the bell is empty before mount');
  assert.doesNotThrow(()=>A.mount({getSummary:()=>{throw new Error('boom');},t:()=>{throw new Error('boom');},now:()=>NaN}));
  const strip=byId('alertStrip');
  assert(strip&&byId('alertTray')&&byId('alertToasts'),'strip, tray and toast stack exist');
  assert.equal(strip.getAttribute('role'),'region'); assert(strip.getAttribute('aria-label'));
  assert(strip.innerHTML.includes('Alerts unavailable')&&!strip.innerHTML.includes('No active alerts'),'without a summary the strip says alerts are unavailable');
  const tray=byId('alertTray');
  assert.deepEqual([tray.hidden,tray.getAttribute('aria-hidden'),tray.getAttribute('role'),tray.getAttribute('aria-labelledby')],[true,'true','region','at-heading']);
  assert.equal(byId('alertToasts').innerHTML,'','the toast stack has no text nodes, so :empty hides it');
  A.mount({});assert.equal(byId('alertStrip'),strip,'mount is idempotent');
  for(const garbage of [null,5,'x',[],{counts:'x',top:'y',threat:null,generatedAt:'soon'}])assert.doesNotThrow(()=>A.update(garbage));
  assert.equal(document.title,'Crucix');
});

test('controller: tab title, bell count and threat follow the summary; an older summary is ignored',()=>{
  const {A,byId,document}=dom(),alerts=firing();
  A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});
  assert.equal(document.title,'(2) Crucix'); assert.match(A.bell(),/id="alertBell"/); assert.match(A.bell(),/al-bell-count">3</);
  assert.match(byId('alertStrip').innerHTML,/Threat 5\/5/);
  assert(!byId('alertStrip').innerHTML.includes('<img'),'hostile titles are escaped');
  assert.equal(A.update(summaryOf([],{generatedAt:now-1})),false,'an older summary is ignored');
  assert.equal(document.title,'(2) Crucix');
  assert.equal(A.update(summaryOf([],{generatedAt:now+1})),true);
  assert.equal(document.title,'Crucix','zero firing critical/high restores the title'); assert.match(byId('alertStrip').innerHTML,/No active alerts/);
});

test('controller: a file: page and the offline shell read the snapshot summary and never fetch',async()=>{
  for(const options of [{protocol:'file:'},{offline:true}]){
    const {A,byId,calls}=dom(options),alerts=firing();
    A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});
    A.open();await ticks();
    const tray=byId('alertTray');
    assert.equal(tray.hidden,false); assert.equal(tray.getAttribute('aria-hidden'),'false');
    assert(tray.innerHTML.includes(alerts[1].id),'the tray lists the summary alerts');
    for(const id of ['alertStrip','alertTray','alertToasts'])assert(byId(id).classList.contains('al-readonly'),id+' is read-only');
    click(byId('alertStrip'),{'data-alert-action':'ack','data-alert-id':alerts[0].id});await ticks();
    assert.equal(calls.length,0,'no request at all');
  }
});

test('controller: actions post same-origin JSON, invalid ids and event ids go nowhere',async()=>{
  const {A,byId,calls,opened}=dom(),alerts=firing(),strip=()=>byId('alertStrip');
  A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});
  click(strip(),{'data-alert-action':'ack','data-alert-id':alerts[0].id});await ticks();
  const [url,init]=calls[0];
  assert.equal(url,'/api/alerts/'+alerts[0].id+'/ack');
  assert.deepEqual(plain({method:init.method,credentials:init.credentials,type:init.headers['Content-Type'],body:init.body}),{method:'POST',credentials:'same-origin',type:'application/json',body:'{}'});
  calls.length=0;
  click(strip(),{'data-alert-action':'snooze','data-alert-id':alerts[1].id,'data-minutes':'480'});await ticks();
  assert.deepEqual(plain([calls[0][0],JSON.parse(calls[0][1].body)]),['/api/alerts/'+alerts[1].id+'/snooze',{minutes:480}]);
  calls.length=0;
  click(strip(),{'data-alert-action':'ack-all','data-severity':'high'});await ticks();
  assert.deepEqual(plain([calls[0][0],JSON.parse(calls[0][1].body)]),['/api/alerts/ack-all',{severity:'high'}]);
  calls.length=0;
  for(const id of ['alert-x','../ack','alert-'+'0'.repeat(31)+'"'])click(strip(),{'data-alert-action':'resolve','data-alert-id':id});
  await ticks(); assert.equal(calls.length,0,'a malformed alert id is never sent');
  A.open();await ticks();
  assert(calls.some(([url,init])=>url==='/api/alerts?state=all&limit=200'&&init.credentials==='same-origin'),'opening the tray loads the list');
  const tray=byId('alertTray');
  for(const id of ['event-x','javascript:alert(1)','event-'+'A'.repeat(32)])click(tray,{'data-alert-action':'evidence','data-event-id':id});
  click(tray,{'data-alert-action':'evidence','data-event-id':EVENT});
  assert.deepEqual(plain(opened),[EVENT],'only a well-formed event id opens the event detail');
});

const forbidden=async url=>url.includes('/ack')?{ok:false,status:403,json:async()=>({error:'Forbidden'})}:{ok:true,status:200,json:async()=>({alerts:[]})};
const speech=()=>new Promise(resolve=>setTimeout(resolve,80));
test('controller: a failed action is shown without a role and spoken once; redraws never repeat it',async()=>{
  const {A,byId,errors}=dom({fetch:forbidden}),alerts=firing(),tray=byId.bind(null,'alertTray');
  A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});
  const live=byId('alertError');
  assert.deepEqual([live.getAttribute('role'),live.textContent],['alert',''],'one persistent, empty alert region');
  A.open();await ticks();
  click(tray(),{'data-alert-action':'ack','data-alert-id':alerts[0].id});await speech();
  assert.match(tray().innerHTML,/class="al-notice">Action failed</); assert(!tray().innerHTML.includes('role="alert"'),'the drawn notice has no role');
  assert.equal(live.textContent,'Action failed','spoken once through the live region');
  live.textContent='spoken';
  A.update(summaryOf(alerts,{generatedAt:now+1}));A.update(summaryOf(alerts,{generatedAt:now+2}));await speech();
  assert.equal(live.textContent,'spoken','redraws do not speak it again'); assert(!tray().innerHTML.includes('role="alert"'));
  click(tray(),{'data-alert-tab':'handled'});assert(!tray().innerHTML.includes('Action failed'),'the next click clears it');
  // The same failure from the strip (tray closed): shown at the end of the strip, cleared by the next summary.
  A.close();click(byId('alertStrip'),{'data-alert-action':'ack','data-alert-id':alerts[0].id});await speech();
  assert.match(byId('alertStrip').innerHTML,/Action failed/); assert.equal(live.textContent,'Action failed','a repeated action failure is spoken again');
  A.update(summaryOf(alerts,{generatedAt:now+3}));
  assert(!byId('alertStrip').innerHTML.includes('Action failed'),'a new summary clears the strip notice');
  assert.equal(errors.length,0);
});

test('controller: a change refused for its origin or host name says how to reach the dashboard',async()=>{
  for(const code of ['CROSS_ORIGIN','HOST_NOT_ALLOWED']){
    const refusing=async url=>url.includes('/ack')?{ok:false,status:403,json:async()=>({error:'Cross-origin request refused',code,field:null})}:{ok:true,status:200,json:async()=>({alerts:[]})};
    const {A,byId}=dom({fetch:refusing}),alerts=firing();
    A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});A.open();await ticks();
    click(byId('alertTray'),{'data-alert-action':'ack','data-alert-id':alerts[0].id});await speech();
    assert.match(byId('alertTray').innerHTML,/class="al-notice">Refused at this address: open the dashboard at its ALERT_PUBLIC_URL address/,code);
    assert.match(byId('alertError').textContent,/ALERT_ALLOWED_HOSTS/,code);
    assert(!byId('alertTray').innerHTML.includes('Action failed'),code);
  }
});

test('renderStrip and the drivers block: no summary at all is "unavailable", never a calm threat level 1',()=>{
  const A=load().CrucixAlerts;
  for(const missing of [null,undefined,{},{generatedAt:now},{counts:{critical:0},threat:null},{threat:{level:1}}]){
    const html=A.renderStrip(missing,t,now);
    assert(html.includes('Alerts unavailable'),JSON.stringify(missing)); assert(!html.includes('No active alerts')&&!html.includes('1/5'),JSON.stringify(missing));
    assert.match(html,/<button type="button" class="as-threat as-threat-0" data-alert-action="threat"[^>]*>Threat –\/5<\/button>/,'a neutral threat badge');
    const drivers=A.renderTray({tab:'active',alerts:[],summary:missing,threatOpen:true},t,now);
    assert(drivers.includes('Threat –/5')&&drivers.includes('Alerts unavailable')&&!drivers.includes('No active alerts'),JSON.stringify(missing));
  }
  assert(A.renderStrip(summaryOf([]),t,now).includes('No active alerts'),'a real calm summary is still calm');
  assert(A.renderStrip({},(key,fallback)=>key==='alerts.unavailable'?'A riasztások nem érhetők el':fallback,now).includes('A riasztások nem érhetők el'),'localised');
});

test('controller: a page without a summary (offline shell, old snapshot) shows "unavailable" and a neutral bell',()=>{
  for(const options of [{offline:true},{protocol:'file:'},{}]){
    const {A,byId}=dom(options);
    A.mount({getSummary:()=>undefined,t,now:()=>now});
    assert(byId('alertStrip').innerHTML.includes('Alerts unavailable'),JSON.stringify(options)); assert(!byId('alertStrip').innerHTML.includes('1/5'));
    assert.match(A.bell(),/al-bell-count">–</,'no count without a summary');
    A.update(summaryOf(firing(),{generatedAt:now+1}));
    assert.match(byId('alertStrip').innerHTML,/Threat 5\/5/,'the first summary replaces it'); assert.match(A.bell(),/al-bell-count">3</);
  }
});

test('controller: a server clock that went back more than 5 minutes is a reset, not an old summary',()=>{
  const {A,byId}=dom(),alerts=firing();
  A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});
  assert.equal(A.update(summaryOf([],{generatedAt:now-MIN})),false,'a little older: ignored');
  assert.equal(A.update(summaryOf([],{generatedAt:now-5*MIN})),false,'up to 5 minutes older: ignored');
  const back=now-HOUR,old=alert({title:'Already firing',firstSeenAt:back-MIN});
  assert.equal(A.update(summaryOf([old],{generatedAt:back})),true,'more than 5 minutes older: applied');
  assert.match(byId('alertStrip').innerHTML,/Already firing/); assert.equal(byId('alertToasts').innerHTML,'','what fires at the reset is the new baseline, it does not toast');
  // The next summaries are measured from the reset one, not from the old (now future) time.
  const fresh=alert({title:'After the reset',firstSeenAt:back+MIN});
  assert.equal(A.update(summaryOf([fresh,old],{generatedAt:back+15*MIN})),true);
  assert(byId('alertToasts').innerHTML.includes('After the reset'),'a new alert after the reset toasts');
  assert.equal(A.update(summaryOf([],{generatedAt:back+10*MIN})),false,'and an older one than that is ignored again');
});

test('controller: a non-object or list-less answer is a failure, a summary without counts and threat is ignored',async()=>{
  for(const body of ['<html>login</html>',null,[],{alerts:'x'}]){
    const {A,byId}=dom({fetch:async()=>({ok:true,status:200,json:async()=>body})});
    A.mount({getSummary:()=>summaryOf(firing()),t,now:()=>now});A.open();await ticks();
    assert.match(byId('alertTray').innerHTML,/Could not load alerts/,JSON.stringify(body));
  }
  const {A,byId}=dom(),alerts=firing();
  A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});
  for(const garbage of [{},{counts:{}},{threat:{level:5}},{counts:[],threat:{}}])assert.equal(A.update({...garbage,generatedAt:now+1}),false);
  assert.match(byId('alertStrip').innerHTML,/Threat 5\/5/,'the real summary stays');
});

test('controller: request() sends JSON for every change, DELETE included, and nothing on read-only pages',async()=>{
  const {A,calls}=dom();
  A.mount({getSummary:()=>summaryOf([]),t,now:()=>now});
  await A.request('/api/alerts/rules/my-rule',{enabled:false},'PUT');await A.request('/api/alerts/rules/my-rule',undefined,'DELETE');
  assert.deepEqual(plain(calls.map(([url,init])=>[url,init.method,init.credentials,init.headers['Content-Type'],init.body??null])),
    [['/api/alerts/rules/my-rule','PUT','same-origin','application/json','{"enabled":false}'],['/api/alerts/rules/my-rule','DELETE','same-origin','application/json',null]]);
  await assert.rejects(A.request('/api/alerts','x','PATCH'));
  const file=dom({protocol:'file:'});file.A.mount({});
  await assert.rejects(file.A.request('/api/alerts/ack-all',{},'POST')); assert.equal(file.calls.length,0);
});

test('controller: an old alert moving up into summary.top is not new',()=>{
  const {A,byId}=dom(),alerts=Array.from({length:6},(_,i)=>alert({title:'Old critical '+i}));
  A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});
  const acked=[{...alerts[0],state:'acked',ack:{at:now}},...alerts.slice(1)];
  A.update(summaryOf(acked,{generatedAt:now+1}));
  assert.equal(byId('alertToasts').innerHTML,'','the sixth alert, first seen two hours ago, does not toast');
});

test('controller: at most three toasts, the oldest leaves first and hands its focus to the bell',()=>{
  const {A,byId,document}=dom();
  A.mount({getSummary:()=>summaryOf([]),t,now:()=>now});
  const stack=byId('alertToasts'),fresh=n=>alert({title:'Fresh '+n,firstSeenAt:now+n,lastSeenAt:now+n});
  A.update(summaryOf([fresh(1)],{generatedAt:now+1}));
  document.activeElement=stack.kids[0].inner;
  A.update(summaryOf([fresh(2),fresh(3),fresh(4)],{generatedAt:now+5}));
  assert.equal(stack.kids.length,3); assert(!stack.innerHTML.includes('Fresh 1')&&stack.innerHTML.includes('Fresh 4'),'the oldest toast left');
  assert.equal(byId('alertBell').focused,1,'its focus went to the bell');
});

test('controller: toasts only for new critical/high alerts after the first summary, once each',()=>{
  const {A,byId}=dom(),alerts=firing();
  A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});
  assert.equal(byId('alertToasts').innerHTML,'','alerts already firing at load do not toast');
  const fresh=[alert({title:'New one'}),alert({severity:'high',title:'New two'}),alert({severity:'watch',title:'Watch only'}),alert({title:'Silent',silent:true})].map(a=>({...a,firstSeenAt:now+1}));
  A.update(summaryOf([...fresh,...alerts],{generatedAt:now+1}));
  const html=byId('alertToasts').innerHTML;
  assert(html.includes('New one')&&html.includes('New two'),'new critical and high alerts toast');
  assert(!html.includes('Watch only')&&!html.includes('Silent'),'watch and silent alerts never toast');
  assert.match(html,/role="alert"/); assert(!/>\s+</.test(html)&&!/^\s|\s$/.test(html),'no whitespace text nodes in the stack');
  A.update(summaryOf([...fresh,...alerts],{generatedAt:now+2}));
  assert.equal(byId('alertToasts').innerHTML,html,'an alert toasts once per session');
});

// ===== Task 9 controller fixes =====
// A toggle as the redraw leaves it: closest('.al-snooze') is its own group with one menu.
const toggleNode=(id,menu)=>{const n=button({'data-alert-action':'snooze-menu','data-alert-id':id,'aria-expanded':'false'});n.closest=selector=>selector==='.al-snooze'?{querySelector:()=>menu,contains:()=>true}:n;return n;};
test('controller: the first click on a Snooze toggle after a failed action opens the menu (the click redraws the tray)',async()=>{
  const {A,byId}=dom({fetch:forbidden}),alerts=firing(),id=alerts[0].id;
  A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});const tray=byId('alertTray');A.open();await ticks();
  click(tray,{'data-alert-action':'ack','data-alert-id':id});await ticks();
  assert.match(tray.innerHTML,/Action failed/,'a failure notice is drawn');
  // Clearing the notice redraws the tray: the node that was clicked is detached, the toggle that replaced it is the live one.
  const clicked=toggleNode(id,{hidden:true}),menuAfter={hidden:true},live=toggleNode(id,menuAfter);
  tray.querySelector=selector=>selector.startsWith('[data-alert-action="snooze-menu"][data-alert-id=')?live:null;
  tray.handlers.click({currentTarget:tray,target:clicked,preventDefault(){}});
  assert.equal(live.getAttribute('aria-expanded'),'true','the toggle on the page is expanded');
  assert.equal(menuAfter.hidden,false,'and its menu is shown');
  assert(!tray.innerHTML.includes('Action failed'),'the notice is gone');
});

test('controller: #alertError is emptied wherever the notice goes away, and a pending announcement is cancelled',async()=>{
  const {A,byId}=dom({fetch:forbidden}),alerts=firing(),ack={'data-alert-action':'ack','data-alert-id':alerts[0].id};
  A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});const tray=byId('alertTray'),strip=byId('alertStrip'),live=byId('alertError');A.open();await ticks();
  // The next click clears the notice, before and after it was spoken.
  click(tray,ack);await speech(); assert.equal(live.textContent,'Action failed');
  click(tray,{'data-alert-tab':'handled'}); assert.equal(live.textContent,'','a spoken notice leaves no text behind');
  click(tray,ack);await ticks(); // failed, the announcement (50 ms) is still pending
  click(tray,{'data-alert-tab':'active'});await speech(); assert.equal(live.textContent,'','a pending announcement of a cleared notice is never made');
  // A notice that goes with the closing tray.
  click(tray,ack);await speech(); assert.equal(live.textContent,'Action failed'); A.close(); assert.equal(live.textContent,'','closing the tray clears it');
  // A notice in the strip goes with the next summary.
  click(strip,ack);await speech(); assert.equal(live.textContent,'Action failed'); A.update(summaryOf(alerts,{generatedAt:now+5})); assert.equal(live.textContent,'','a new summary clears it');
  // A load failure goes when a load succeeds.
  let loads=0;const flaky=dom({fetch:async()=>{loads++;return loads===1?{ok:false,status:503,json:async()=>({})}:{ok:true,status:200,json:async()=>({alerts:[]})};}});
  flaky.A.mount({getSummary:()=>summaryOf(alerts),t,now:()=>now});flaky.A.open();await speech(); assert.equal(flaky.byId('alertError').textContent,'Could not load alerts');
  flaky.A.update(summaryOf(alerts,{generatedAt:now+5}));await new Promise(resolve=>setTimeout(resolve,260)); // the reload is debounced (150 ms)
  assert.equal(flaky.byId('alertError').textContent,'','a successful load clears the load failure');
});

// The record inspector and the alert tray in one page: the inspector places the focus itself once the tray steps aside.
const inspectorOptions={getSources:()=>[{source:'GDACS',status:'ok',observedAt:new Date(now-600000).toISOString(),observations:[]}],getEvents:()=>[],t,now:()=>now};
const both=hash=>{
  const env=dom({files:['record-core.js','live-sources.js','record-inspector.js','alerts-core.js','alerts.js'],hash});
  env.A.mount({getSummary:()=>summaryOf(firing()),t,now:()=>now});env.window.CrucixRecordInspector.mount(inspectorOptions);
  const tray=env.byId('alertTray'),aside=env.byId('record-inspector'),card=source=>({closest:selector=>selector==='[data-open-records]'?{dataset:{openRecords:source}}:null});
  const probe={n:0,focus(){probe.n++;}};aside.querySelector=selector=>selector.includes('ri-row')||selector.includes('data-ri-action="close"')?probe:null;
  return {...env,tray,aside,probe,openCard:source=>{for(const fn of env.listeners.document.click)fn({target:card(source)});}};
};
test('inspector: a records card opens the inspector and closes an alert tray opened over it, without moving the focus away',()=>{
  const env=both(''),{A,tray,aside,probe,openCard,byId}=env;
  openCard('GDACS'); assert.equal(aside.hidden,false,'the inspector is open'); assert.equal(probe.n,1,'the card puts the focus into the inspector');
  A.open(); assert.equal(tray.hidden,false,'a tray opened over the inspector stays (as asked)');
  openCard('GDACS'); assert.equal(aside.hidden,false); assert.equal(tray.hidden,true,'activating a records card while the inspector is open closes the tray');
  assert.equal(byId('alertBell').focused,0,'the tray did not take the focus back to the bell'); assert.equal(probe.n,2,'the inspector holds the focus');
  A.open(); openCard('NASA-EONET'); assert.equal(tray.hidden,true,'a card of another source does too');
});
test('inspector: a hash that opens the inspector keeps the focus that was in the tray, and never takes one that was not',()=>{
  for(const held of [true,false]){
    const {A,tray,aside,probe,location,listeners,document}=both('');
    A.open(); const inside={};if(held){document.activeElement=inside;tray.contains=node=>node===inside;}
    location.hash='#src=GDACS';for(const fn of listeners.window.hashchange)fn();
    assert.equal(aside.hidden,false,'the hash opened the inspector'); assert.equal(tray.hidden,true,'and the tray stepped aside');
    assert.equal(probe.n,held?1:0,held?'the focus went into the inspector instead of dropping to the page':'a focus elsewhere is left alone');
  }
});

test('controller: a failed request keeps the status and the server error for the caller',async()=>{
  const bad=status=>dom({fetch:async()=>({ok:false,status,json:async()=>status===400?{error:'must be an integer from 1 to 10',code:'INVALID_RULE',field:'forSweeps'}:status===500?'<html>':null})});
  for(const [status,expected] of [[400,{status:400,code:'INVALID_RULE',field:'forSweeps',detail:'must be an integer from 1 to 10'}],[500,{status:500,code:'',field:'',detail:''}],[403,{status:403,code:'',field:'',detail:''}]]){
    const {A}=bad(status);A.mount({getSummary:()=>summaryOf([]),t,now:()=>now});
    const error=await A.request('/api/alerts/rules/x',{},'PUT').then(()=>null,failure=>failure);
    assert(error&&typeof error.message==='string','an Error',String(status)); assert.match(error.message,new RegExp('HTTP '+status));
    assert.deepEqual(plain({status:error.status,code:error.code,field:error.field,detail:error.detail}),expected,String(status));
  }
});

test('renderTray: the Rules tab shows the rule editor when it is loaded and a view is given, else the empty placeholder',()=>{
  const load4=()=>{const window={},context=vm.createContext({window,Date,URL});for(const file of ['record-core.js','alerts-core.js','alerts.js','alert-rules.js'])vm.runInContext(read(file),context);return window;};
  const A=load4().CrucixAlerts,rules={rules:[{id:'vix-spike',name:'VIX spike',kind:'threshold',severity:'high',enabled:true,notify:true,source:'builtin',params:{metric:'vix',op:'>',value:30}}],metrics:[],editing:null};
  const html=A.renderTray(view([],{tab:'rules',rules}),t,now);
  assert(html.includes('<div class="at-rules"><section class="ar-panel"')&&html.includes('data-rule-id="vix-spike"'),'the editor fills the placeholder');
  assert(A.renderTray(view([],{tab:'rules'}),t,now).includes('<div class="at-rules"></div>'),'no view of its own: empty');
  assert(!A.renderTray(view([],{tab:'active',rules}),t,now).includes('ar-panel'),'only on the Rules tab');
  // An editor that throws, or answers with something else, never breaks the tray.
  const broken=load4();broken.CrucixAlertRules.renderRules=()=>{throw new Error('boom');};
  assert(broken.CrucixAlerts.renderTray(view([],{tab:'rules',rules}),t,now).includes('<div class="at-rules"></div>'));
});

test('controller: a redraw puts the focus and the caret back into the text field that had them',()=>{
  const {A,byId,document}=dom();A.mount({getSummary:()=>summaryOf(firing()),t,now:()=>now});A.open();
  const tray=byId('alertTray'),typed={id:'ar-name',selectionStart:3,selectionEnd:5,hasAttribute:()=>false,getAttribute:()=>null};
  const fresh={focused:0,selection:null,focus(){this.focused++;},setSelectionRange(start,end){this.selection=[start,end];}};
  tray.contains=node=>node===typed;document.activeElement=typed;tray.querySelector=selector=>selector==='#ar-name'?fresh:null;
  assert(A.update(summaryOf(firing(),{generatedAt:Date.now()+60000})),'a newer summary redraws the tray');
  assert.equal(fresh.focused,1,'the focus came back'); assert.deepEqual(plain(fresh.selection),[3,5],'with its caret and selection');
  // A checkbox has no caret (selectionStart is null) and nothing to restore.
  const box={id:'ar-notify',selectionStart:null,selectionEnd:null,hasAttribute:()=>false,getAttribute:()=>null},again={focused:0,focus(){this.focused++;}};
  tray.contains=node=>node===box;document.activeElement=box;tray.querySelector=selector=>selector==='#ar-notify'?again:null;
  assert.doesNotThrow(()=>A.update(summaryOf(firing(),{generatedAt:Date.now()+120000}))); assert.equal(again.focused,1);
});
