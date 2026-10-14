// The air layer of the map (dashboard/inject.mjs airGrid, airNotable, airFlows; GET /api/air for every aircraft):
//   - clusters: the 2° density cells merged into coarser groups, each with its aircraft count, busiest registration countries and the
//     notable aircraft inside it; a click opens a mini map of the group with every aircraft in it (heading, callsign, route);
//   - describe: the text of one aircraft for a popup or the mini map's info line;
//   - canvas: every aircraft as a dot on a canvas over either map (the "all aircraft" switch), with picking by screen position.
// No DOM work happens at load; every function takes what it needs, so the page (jarvis.html) owns the maps and the popups.
(function(){
  'use strict';
  // GET /api/air row fields (apis/sources/opensky.mjs AIRCRAFT_FIELDS).
  const F={icao24:0,callsign:1,country:2,lat:3,lon:4,altitude:5,speed:6,track:7,vrate:8,squawk:9,kind:10,from:11,to:12};
  const KIND_COLOR=Object.freeze({squawk:'#ff4848',military:'#ffb84c',high:'#e0b0ff',nocallsign:'#ffe082'});
  // Altitude bands: low (climb, descent, regional), cruise, high cruise.
  const altColor=alt=>!Number.isFinite(alt)?'#8fb8ae':alt<3000?'#ff9f5a':alt<9000?'#64f0c8':'#44ccff';
  const fin=Number.isFinite;
  const short=n=>n>=10000?Math.round(n/1000)+'k':n>=1000?(n/1000).toFixed(1).replace(/\.0$/,'')+'k':String(n);

  // The grid cells (2°, centre lat/lon) merged into deg × deg groups; the notable aircraft are counted into the group they are in.
  function clusters(grid,notable,deg){
    const bins=new Map(),half=1;
    const bin=(lat,lon)=>{
      const y=Math.floor(lat/deg),x=Math.floor(lon/deg),key=y+'|'+x;
      let b=bins.get(key);
      if(!b){b={key,count:0,sumLat:0,sumLon:0,countries:{},kinds:{},notable:0,s:90,n:-90,w:180,e:-180};bins.set(key,b)}
      return b;
    };
    for(const c of Array.isArray(grid)?grid:[]){
      if(!c||!fin(c.lat)||!fin(c.lon)||!fin(c.count)||c.count<=0)continue;
      const b=bin(c.lat,c.lon);
      b.count+=c.count;b.sumLat+=c.lat*c.count;b.sumLon+=c.lon*c.count;
      b.s=Math.min(b.s,c.lat-half);b.n=Math.max(b.n,c.lat+half);b.w=Math.min(b.w,c.lon-half);b.e=Math.max(b.e,c.lon+half);
      for(const [name,n] of Array.isArray(c.top)?c.top:[])if(typeof name==='string'&&fin(n))b.countries[name]=(b.countries[name]||0)+n;
    }
    for(const a of Array.isArray(notable)?notable:[]){
      if(!a||!fin(a.lat)||!fin(a.lon))continue;
      const b=bin(a.lat,a.lon);
      b.notable++;b.kinds[a.kind]=(b.kinds[a.kind]||0)+1;
      b.s=Math.min(b.s,a.lat-0.5);b.n=Math.max(b.n,a.lat+0.5);b.w=Math.min(b.w,a.lon-0.5);b.e=Math.max(b.e,a.lon+0.5);
    }
    return [...bins.values()].filter(b=>b.count>0).map(b=>({
      key:b.key,lat:b.sumLat/b.count,lon:b.sumLon/b.count,count:b.count,notable:b.notable,kinds:b.kinds,
      top:Object.entries(b.countries).sort((x,y)=>y[1]-x[1]).slice(0,3),bounds:[b.w,b.s,b.e,b.n],
    })).sort((x,y)=>y.count-x.count);
  }

  // A row of /api/air as an object.
  function rowObject(r){
    return {icao24:r[F.icao24],callsign:r[F.callsign],country:r[F.country],lat:r[F.lat],lon:r[F.lon],altitude:r[F.altitude],speed:r[F.speed],
      track:r[F.track],vrate:r[F.vrate],squawk:r[F.squawk],kind:r[F.kind]||null,from:Array.isArray(r[F.from])?r[F.from]:null,to:Array.isArray(r[F.to])?r[F.to]:null};
  }
  const validRow=r=>Array.isArray(r)&&fin(r[F.lat])&&fin(r[F.lon]);

  // The aircraft list, fetched once per OpenSky observation (observedAt) and shared by the mini map and the canvas.
  let list=null,listKey=null,pending=null;
  async function aircraft(fetchJson,key){
    if(list&&listKey===key)return list;
    if(pending&&pending.key===key)return pending.promise;
    const promise=(async()=>{
      const data=await fetchJson('/api/air');
      const rows=Array.isArray(data?.rows)?data.rows.filter(validRow):[];
      list={observedAt:typeof data?.observedAt==='string'?data.observedAt:null,rows};listKey=key;
      return list;
    })().finally(()=>{if(pending?.promise===promise)pending=null});
    pending={key,promise};
    return promise;
  }
  const rowsIn=(rows,[w,s,e,n])=>rows.filter(r=>r[F.lat]>=s&&r[F.lat]<=n&&r[F.lon]>=w&&r[F.lon]<=e).map(rowObject);

  // One aircraft in words: a head and the lines of the popup (the page renders them as text).
  function describe(a,t){
    const say=(key,fallback,values)=>{let out=t(key,fallback);for(const [k,v] of Object.entries(values||{}))out=out.split('{'+k+'}').join(String(v));return out};
    const lines=[];
    if(a.kind)lines.push(say('air.kind_'+a.kind,a.kind));
    if(a.from&&a.to)lines.push(say('air.route','Route: {from} → {to}',{from:a.from[0]+(a.from[3]?' ('+a.from[3]+')':''),to:a.to[0]+(a.to[3]?' ('+a.to[3]+')':'')}));
    if(a.country)lines.push(say('air.registered','Registered in: {country}',{country:a.country}));
    if(fin(a.altitude))lines.push(say('air.altitudeFt','Altitude: {m} m ({ft} ft)',{m:Math.round(a.altitude).toLocaleString(),ft:Math.round(a.altitude*3.28084).toLocaleString()}));
    if(fin(a.speed))lines.push(say('air.speed','Speed: {kmh} km/h',{kmh:Math.round(a.speed*3.6).toLocaleString()}));
    if(fin(a.track))lines.push(say('air.heading','Heading: {deg}°',{deg:Math.round(a.track)}));
    if(a.squawk)lines.push('Squawk '+a.squawk+(a.kind==='squawk'?' · '+say('air.squawk_'+({7500:'hijack',7600:'radio',7700:'emergency'}[a.squawk]||'emergency'),''):''));
    lines.push('ICAO24: '+(a.icao24||'?'));
    if(a.kind==='military')lines.push(say('air.militaryNote','Military-pattern callsign: a heuristic, not a confirmed military flight.'));
    if(a.kind==='squawk')lines.push(say('air.squawkNote','A transponder code, not a confirmed event: test codes and mistyped squawks happen.'));
    return {head:a.callsign||a.icao24||say('map.aircraft','Aircraft'),lines};
  }

  // The plane glyph, nose up (north); rotated by the track.
  const PLANE='M0,-7 L1.2,-2.5 L6,1 L6,2.4 L1.2,0.8 L0.9,4.6 L2.6,6 L2.6,7 L0,6.2 L-2.6,7 L-2.6,6 L-0.9,4.6 L-1.2,0.8 L-6,2.4 L-6,1 L-1.2,-2.5 Z';

  // ---- Mini map of a group ------------------------------------------------------------------------------------------------------
  let mini=null;
  function closeMiniMap(){if(mini){mini.remove();mini=null;document.removeEventListener('keydown',onMiniKey,true)}}
  function onMiniKey(ev){if(ev.key==='Escape'&&mini){ev.stopPropagation();closeMiniMap()}}
  /**
   * opts: { container, x, y, title, subtitle, bounds:[w,s,e,n], rows (objects, or null while loading), world (topology or null), t, message }
   * Returns the panel; call again with rows to fill it.
   */
  function openMiniMap(opts){
    const {container,t}=opts,d3=window.d3,topojson=window.topojson;
    closeMiniMap();
    const W=Math.min(400,Math.max(260,container.clientWidth-24)),H=230;
    const panel=document.createElement('div');panel.className='air-mini';panel.setAttribute('role','dialog');panel.setAttribute('aria-label',opts.title);
    const left=Math.max(8,Math.min(container.clientWidth-W-8,opts.x+12)),top=Math.max(8,Math.min(container.clientHeight-H-120,opts.y-40));
    panel.style.left=left+'px';panel.style.top=top+'px';panel.style.width=W+'px';
    const head=document.createElement('div');head.className='air-mini-head';
    const title=document.createElement('b');title.textContent=opts.title;
    const sub=document.createElement('span');sub.textContent=opts.subtitle||'';
    const close=document.createElement('button');close.type='button';close.className='air-mini-close';close.textContent='×';close.setAttribute('aria-label',t('air.close','Close'));close.onclick=closeMiniMap;
    head.append(title,sub,close);
    const info=document.createElement('div');info.className='air-mini-info';info.textContent=opts.message||t('air.miniHint','Click an aircraft for its details and route.');
    panel.append(head);
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('width',W);svg.setAttribute('height',H);svg.setAttribute('class','air-mini-svg');
    panel.append(svg,info);
    container.append(panel);mini=panel;
    document.addEventListener('keydown',onMiniKey,true);
    panel.addEventListener('click',ev=>ev.stopPropagation());
    if(!d3)return panel;
    const [w,s,e,n]=opts.bounds;
    const projection=d3.geoMercator().fitExtent([[10,10],[W-10,H-10]],{type:'MultiPoint',coordinates:[[w,s],[e,n],[w,n],[e,s]]});
    const path=d3.geoPath(projection);
    const root=d3.select(svg),g=root.append('g');
    if(opts.world&&topojson){
      try{g.append('path').datum(topojson.feature(opts.world,opts.world.objects.countries)).attr('class','air-mini-land').attr('d',path)}catch{/* no land: aircraft still drawn */}
    }
    g.append('path').datum(d3.geoGraticule().step([2,2])()).attr('class','air-mini-grid').attr('d',path);
    const routeLayer=g.append('g'),planes=g.append('g');
    let k=1;
    root.call(d3.zoom().scaleExtent([1,10]).on('zoom',ev=>{k=ev.transform.k;g.attr('transform',ev.transform);planes.selectAll('g.air-plane').attr('transform',function(){return this.dataset.base+' scale('+(1/Math.sqrt(k)).toFixed(3)+')'});planes.selectAll('text').style('display',k>=1.5||(opts.rows||[]).length<=60?'block':'none')}));
    panel.fill=rows=>{
      opts.rows=rows;planes.selectAll('*').remove();
      if(!rows){info.textContent=t('air.loading','Loading aircraft…');return}
      if(!rows.length){info.textContent=t('air.noneHere','No aircraft with a position in this group right now.');return}
      sub.textContent=t('air.miniCount','{count} aircraft').replace('{count}',rows.length.toLocaleString());
      info.textContent=t('air.miniHint','Click an aircraft for its details and route.');
      const labels=rows.length<=60;
      for(const a of rows){
        const p=projection([a.lon,a.lat]);if(!p||!p.every(fin))continue;
        const base=`translate(${p[0].toFixed(1)},${p[1].toFixed(1)})`;
        const node=planes.append('g').attr('class','air-plane').attr('data-base',base).attr('transform',base).style('cursor','pointer');
        node.append('path').attr('d',PLANE).attr('transform',`rotate(${fin(a.track)?Math.round(a.track):0}) scale(${a.kind?0.95:0.75})`)
          .attr('fill',a.kind?KIND_COLOR[a.kind]:altColor(a.altitude)).attr('stroke','rgba(0,0,0,.6)').attr('stroke-width',0.6);
        if(a.callsign)node.append('text').attr('x',7).attr('y',3).attr('class','air-mini-label').style('display',labels?'block':'none').text(a.callsign);
        node.on('click',ev=>{
          ev.stopPropagation();
          planes.selectAll('g.air-plane').classed('air-picked',false);node.classed('air-picked',true).raise();
          const d=describe(a,t);info.textContent='';
          const strong=document.createElement('b');strong.textContent=d.head;info.append(strong);
          for(const line of d.lines){info.append(document.createElement('br'),document.createTextNode(line))}
          routeLayer.selectAll('*').remove();
          if(a.from&&a.to){
            const feature={type:'LineString',coordinates:[[a.from[2],a.from[1]],[a.lon,a.lat],[a.to[2],a.to[1]]]};
            routeLayer.append('path').datum(feature).attr('class','air-mini-route').attr('d',path);
          }
        });
      }
    };
    panel.fill(opts.rows);
    return panel;
  }

  // ---- Every aircraft on a canvas over the map ----------------------------------------------------------------------------------
  // project(lat, lon) -> [x, y] in container pixels, or null when hidden (the far side of the globe). draw() repaints; pick(x, y) finds
  // the nearest dot within 7 px.
  function canvas(container,project){
    const el=document.createElement('canvas');el.className='air-canvas';container.append(el);
    let rows=[],drawn=[];
    const ctx=el.getContext('2d');
    function draw(){
      const w=container.clientWidth,h=container.clientHeight,dpr=Math.min(2,window.devicePixelRatio||1);
      if(el.width!==Math.round(w*dpr)||el.height!==Math.round(h*dpr)){el.width=Math.round(w*dpr);el.height=Math.round(h*dpr);el.style.width=w+'px';el.style.height=h+'px'}
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      drawn=[];
      const bands=new Map();
      for(const r of rows){
        const p=project(r[F.lat],r[F.lon]);if(!p||p[0]<-4||p[1]<-4||p[0]>w+4||p[1]>h+4)continue;
        const color=r[F.kind]?KIND_COLOR[r[F.kind]]:altColor(r[F.altitude]);
        let list=bands.get(color);if(!list){list=[];bands.set(color,list)}list.push(p);drawn.push([p[0],p[1],r]);
      }
      for(const [color,points] of bands){
        ctx.fillStyle=color;ctx.globalAlpha=.85;ctx.beginPath();
        for(const [x,y] of points){ctx.moveTo(x+1.4,y);ctx.arc(x,y,1.4,0,Math.PI*2)}
        ctx.fill();
      }
      ctx.globalAlpha=1;
    }
    function pick(x,y){
      let best=null,bestD=49;
      for(const [px,py,r] of drawn){const d=(px-x)**2+(py-y)**2;if(d<bestD){bestD=d;best=r}}
      return best?rowObject(best):null;
    }
    return {el,draw,pick,setRows(next){rows=Array.isArray(next)?next:[];draw()},count:()=>drawn.length,destroy(){el.remove()}};
  }

  window.CrucixAir=Object.freeze({FIELDS:F,KIND_COLOR,altColor,short,clusters,aircraft,rowsIn,rowObject,describe,openMiniMap,closeMiniMap,canvas,PLANE});
})();
