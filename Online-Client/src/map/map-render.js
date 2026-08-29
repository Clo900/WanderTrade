/* ================================================
 * 地图渲染（v9.10.2 自 index.html 主内联脚本拆出）
 * 功能分区：视口状态与缩放平移 / 等高线地形（确定性一次生成）/ 流动云雾 / 拖拽缩放交互 / 地图与旅行进度渲染
 * 依赖全局（调用时求值，加载顺序见 index.html）：
 *   GS / CITIES / ROADS / getCity / getCityName / fmt（data.js）
 *   buildGraph / shortestPath（pathing-core.js）
 *   mulberry32 / mapSeed / roadCurve / pointOnCurves / ptOnRoad / MAP_CURVES（road-curves.js）
 *   Starfall（starfall.js，活动角标渲染）/ currentTab（主文件顶层 let，共享词法环境）
 * 本文件状态：MAP / MAP_DECO / MAP_CLOUDS
 * 地图工具按钮 onclick 依赖全局函数 mapZoom/mapCenter（经典脚本顶层声明自动挂 window）
 * ================================================ */
'use strict';

// ===== 交互式地图（v7.9：缩放/平移/当前城居中/等高线/曲线路网/云雾） =====
// 视口状态：g 元素 transform="translate(px,py) scale(s)"，世界坐标直接使用城市 x/y
let MAP={s:0.8,px:0,py:0,init:false,drag:null};
const MAP_VW=850,MAP_VH=520; // 视口像素（viewBox 尺寸）
function mapWorldRange(){
  const xs=CITIES.map(c=>c.x),ys=CITIES.map(c=>c.y);
  return{x1:Math.min(...xs)-70,y1:Math.min(...ys)-70,x2:Math.max(...xs)+70,y2:Math.max(...ys)+70};
}
function mapWrapSize(){const w=document.getElementById('map-wrap');return w?[w.clientWidth,w.clientHeight]:[MAP_VW,MAP_VH]}
// v8.13：地图坐标统一为 SVG viewBox 单位（850×520）。
// svg 为 width:100%/height:auto，容器宽高比恒为 850:520，像素→单位系数 k=容器宽/850。
function mapUnitK(){const rw=mapWrapSize()[0];return rw/MAP_VW||1}
function clampMap(){
  const R=mapWorldRange();
  // 以 SVG viewBox（850×520）为边界限制平移区间，保证地图完整可见；
  // 修复此前混用容器像素导致地图边缘被裁且拖不回来的问题。
  const minPx=Math.min(MAP_VW-R.x2*MAP.s,-R.x1*MAP.s),maxPx=Math.max(MAP_VW-R.x2*MAP.s,-R.x1*MAP.s);
  const minPy=Math.min(MAP_VH-R.y2*MAP.s,-R.y1*MAP.s),maxPy=Math.max(MAP_VH-R.y2*MAP.s,-R.y1*MAP.s);
  MAP.px=Math.max(minPx,Math.min(maxPx,MAP.px));
  MAP.py=Math.max(minPy,Math.min(maxPy,MAP.py));
}
function centerOn(cid){
  const c=getCity(cid);if(!c)return;
  MAP.px=MAP_VW/2-c.x*MAP.s;MAP.py=MAP_VH/2-c.y*MAP.s;clampMap();
}
function applyMapView(){
  const g=document.querySelector('.map-scene');
  if(g)g.setAttribute('transform',`translate(${MAP.px.toFixed(1)},${MAP.py.toFixed(1)}) scale(${MAP.s})`);
}
function initMapView(){
  const R=mapWorldRange();
  MAP.sMin=Math.min(MAP_VW/(R.x2-R.x1),MAP_VH/(R.y2-R.y1))*0.9; // 留 10% 观察边距，边缘城市也能在最小缩放下看全地图
  MAP.sMax=Math.min(4,MAP.sMin*4);
  MAP.s=Math.max(MAP.sMin,MAP.sMin*1.9);
  MAP.needCenter=true; // 挂载后按真实容器尺寸居中
}
function mapZoomAt(cx,cy,k){
  const wrap=document.getElementById('map-wrap');if(!wrap)return;
  const rect=wrap.getBoundingClientRect();
  const kk=mapUnitK(); // 像素 → SVG 单位（缩放锚点跟随鼠标）
  const ux=(cx-rect.left)/kk,uy=(cy-rect.top)/kk;
  const wx=(ux-MAP.px)/MAP.s,wy=(uy-MAP.py)/MAP.s;
  const ns=Math.max(MAP.sMin,Math.min(MAP.sMax,MAP.s*k));
  if(ns===MAP.s)return;
  MAP.px=ux-wx*ns;MAP.py=uy-wy*ns;MAP.s=ns;clampMap();applyMapView();
}
function mapZoom(k){ // 按钮：以地图中心缩放
  const wrap=document.getElementById('map-wrap');
  if(wrap){const r=wrap.getBoundingClientRect();mapZoomAt(r.left+r.width/2,r.top+r.height/2,k);}
}
function mapCenter(){ // 回到当前位置：重置为默认缩放并居中，避免缩得太小时无法居中
  if(!MAP.sMin)initMapView();
  MAP.s=Math.max(MAP.sMin,MAP.sMin*1.9);
  centerOn(GS.location);
  applyMapView();
}
// 等高线地形（确定性生成一次：基于全局高度场的统一等值线，适配城市分布，避免局部圆环互相覆盖）
let MAP_DECO=null;
function mapPolyArea(pts){
  let a=0;
  for(let i=0;i<pts.length;i++){
    const p=pts[i],q=pts[(i+1)%pts.length];
    a+=p.x*q.y-q.x*p.y;
  }
  return Math.abs(a/2);
}
function mapNearestCityDist(x,y){
  let d1=1e9,d2=1e9;
  for(const c of CITIES){
    const d=Math.hypot(x-c.x,y-c.y);
    if(d<d1){d2=d1;d1=d;}
    else if(d<d2)d2=d;
  }
  return[d1,d2];
}
function pointSegDist(px,py,x1,y1,x2,y2){
  const dx=x2-x1,dy=y2-y1;
  const len2=dx*dx+dy*dy||1;
  let t=((px-x1)*dx+(py-y1)*dy)/len2;
  t=Math.max(0,Math.min(1,t));
  const qx=x1+dx*t,qy=y1+dy*t;
  return Math.hypot(px-qx,py-qy);
}
function pickTerrainPeaks(R){
  const pts=[],stepX=88,stepY=72,edge=60;
  for(let y=R.y1+edge;y<=R.y2-edge;y+=stepY){
    for(let x=R.x1+edge;x<=R.x2-edge;x+=stepX){
      const[d1,d2]=mapNearestCityDist(x,y);
      if(d1<72)continue; // 避开城市本体，给聚落留平缓地
      const centerBias=1-Math.abs((x-(R.x1+R.x2)/2)/((R.x2-R.x1)/2))*0.35;
      const score=d1*1.15+d2*0.35+centerBias*18;
      pts.push({x,y,score});
    }
  }
  pts.sort((a,b)=>b.score-a.score);
  const peaks=[];
  for(const p of pts){
    if(peaks.every(q=>Math.hypot(q.x-p.x,q.y-p.y)>150)){
      peaks.push({
        x:p.x,y:p.y,
        amp:0.34-Math.min(peaks.length,4)*0.04,
        sx:90+peaks.length*10,
        sy:64+peaks.length*8
      });
    }
    if(peaks.length>=5)break;
  }
  if(!peaks.length){
    peaks.push({x:(R.x1+R.x2)/2,y:(R.y1+R.y2)/2,amp:0.28,sx:110,sy:80});
  }
  return peaks;
}
function terrainHeightAt(x,y,R,peaks){
  const nx=(x-R.x1)/(R.x2-R.x1),ny=(y-R.y1)/(R.y2-R.y1);
  let h=0.07
    +0.028*Math.sin(nx*Math.PI*1.45)
    +0.022*Math.cos((ny*1.25+nx*0.42)*Math.PI*2)
    +0.018*Math.sin((nx+ny)*Math.PI*2.2);
  for(const p of peaks){
    const dx=(x-p.x)/p.sx,dy=(y-p.y)/p.sy;
    h+=p.amp*Math.exp(-(dx*dx+dy*dy))*0.82;
  }
  // 王都周边：低丘陵，范围广、起伏缓
  const dc=getCity('dawncapital');
  const dh=Math.hypot((x-dc.x)/220,(y-dc.y)/155);
  h+=0.105*Math.exp(-(dh*dh))*(0.7+0.3*Math.sin(x*0.03+y*0.022));
  h+=0.05*Math.exp(-(Math.hypot((x-(dc.x-120))/170,(y-(dc.y+15))/120)**2));
  // 霜岭堡北侧：高山脊，线密且起伏强
  const ff=getCity('frostfort');
  const ridgeA=pointSegDist(x,y,ff.x-160,ff.y-120,ff.x+30,ff.y-205);
  const ridgeB=pointSegDist(x,y,ff.x-70,ff.y-55,ff.x+170,ff.y-145);
  const northBoost=1+Math.max(0,(ff.y-y))/150;
  h+=0.22*Math.exp(-(ridgeA*ridgeA)/(28*28))*northBoost;
  h+=0.18*Math.exp(-(ridgeB*ridgeB)/(24*24))*northBoost;
  h+=0.05*Math.exp(-(ridgeA*ridgeA)/(70*70))*Math.sin((x+y)*0.05+0.8);
  // 盐湾港附近：沿海缓坡，地势整体更柔和、更开阔
  const sb=getCity('saltbay');
  const coast=pointSegDist(x,y,sb.x-190,sb.y+82,sb.x+170,sb.y+128);
  const coastB=pointSegDist(x,y,sb.x-130,sb.y+36,sb.x+220,sb.y+72);
  h+=0.05*Math.exp(-(coast*coast)/(78*78));
  h+=0.03*Math.exp(-(coastB*coastB)/(96*96));
  h-=0.08*Math.exp(-((x-sb.x)*(x-sb.x))/(260*260)-((y-(sb.y+126))*(y-(sb.y+126)))/(170*170));
  // 星陨城周边：断裂地貌，沿裂谷产生折线状高差
  const sf=getCity('starfall');
  const faultA=pointSegDist(x,y,sf.x-150,sf.y-92,sf.x+145,sf.y+48);
  const faultB=pointSegDist(x,y,sf.x-92,sf.y+92,sf.x+90,sf.y-65);
  const along=((x-sf.x)*0.72+(y-sf.y)*0.48)/44;
  h+=0.15*Math.exp(-(faultA*faultA)/(22*22))*(0.68+0.32*Math.sin(along));
  h+=0.11*Math.exp(-(faultB*faultB)/(18*18))*(0.65+0.35*Math.cos(along*1.35));
  h+=0.05*Math.exp(-(Math.hypot((x-sf.x)/130,(y-sf.y)/96)**2));
  for(const c of CITIES){
    const dx=(x-c.x)/54,dy=(y-c.y)/40;
    h-=0.058*Math.exp(-(dx*dx+dy*dy)); // 城市周边压低，形成更真实的盆地/缓坡
  }
  return Math.max(0,Math.min(1,h));
}
function contourEdgePoint(edge,x,y,step,tl,tr,br,bl,level){
  const lerp=(a,b,va,vb)=>{
    const t=(level-va)/((vb-va)||1e-6);
    return a+(b-a)*Math.max(0,Math.min(1,t));
  };
  if(edge===0)return{x:lerp(x,x+step,tl,tr),y};
  if(edge===1)return{x:x+step,y:lerp(y,y+step,tr,br)};
  if(edge===2)return{x:lerp(x,x+step,bl,br),y:y+step};
  return{x,y:lerp(y,y+step,tl,bl)};
}
function stitchContourSegments(segs,step){
  const keyOf=p=>`${Math.round(p.x*2)}_${Math.round(p.y*2)}`;
  const adj=new Map(),used=new Array(segs.length).fill(false),paths=[];
  const add=(k,ref)=>{if(!adj.has(k))adj.set(k,[]);adj.get(k).push(ref);};
  segs.forEach((s,i)=>{add(keyOf(s[0]),{i});add(keyOf(s[1]),{i});});
  const extend=(path,atHead)=>{
    while(true){
      const cur=atHead?path[0]:path[path.length-1],key=keyOf(cur);
      const nexts=(adj.get(key)||[]).filter(r=>!used[r.i]);
      if(!nexts.length)break;
      const seg=segs[nexts[0].i];used[nexts[0].i]=true;
      const a=seg[0],b=seg[1];
      const next=keyOf(a)===key?b:a;
      if(atHead)path.unshift(next);else path.push(next);
    }
  };
  for(let i=0;i<segs.length;i++){
    if(used[i])continue;
    used[i]=true;
    const path=[segs[i][0],segs[i][1]];
    extend(path,false);extend(path,true);
    if(path.length>=4){
      const f=path[0],l=path[path.length-1];
      if(Math.hypot(f.x-l.x,f.y-l.y)<=step*0.7)path[path.length-1]={x:f.x,y:f.y};
      paths.push(path);
    }
  }
  return paths;
}
function genMapDeco(){
  if(MAP_DECO)return MAP_DECO;
  const rnd=mulberry32(20260812);
  const R=mapWorldRange();
  const cx0=(R.x1+R.x2)/2,cy0=(R.y1+R.y2)/2;
  const peaks=pickTerrainPeaks(R);
  const step=18,nx=Math.ceil((R.x2-R.x1)/step),ny=Math.ceil((R.y2-R.y1)/step);
  const ER={x1:R.x1-220,y1:R.y1-180,x2:R.x2+220,y2:R.y2+180};
  const enx=Math.ceil((ER.x2-ER.x1)/step),eny=Math.ceil((ER.y2-ER.y1)/step);
  const field=[];
  for(let gy=0;gy<=eny;gy++){
    field[gy]=[];
    for(let gx=0;gx<=enx;gx++){
      const x=ER.x1+gx*step,y=ER.y1+gy*step;
      field[gy][gx]=terrainHeightAt(x,y,ER,peaks);
    }
  }
  const levels=[0.10,0.16,0.22,0.28,0.34,0.42,0.52];
  const table={
    0:[],1:[[3,0]],2:[[0,1]],3:[[3,1]],4:[[1,2]],5:[[3,2],[0,1]],6:[[0,2]],7:[[3,2]],
    8:[[2,3]],9:[[0,2]],10:[[0,1],[2,3]],11:[[1,2]],12:[[1,3]],13:[[0,1]],14:[[3,0]],15:[]
  };
  let iso='',fills='';
  levels.forEach((lv,li)=>{
    const segs=[];
    for(let gy=0;gy<eny;gy++)for(let gx=0;gx<enx;gx++){
      const x=ER.x1+gx*step,y=ER.y1+gy*step;
      const tl=field[gy][gx],tr=field[gy][gx+1],br=field[gy+1][gx+1],bl=field[gy+1][gx];
      const idx=(tl>=lv?1:0)|(tr>=lv?2:0)|(br>=lv?4:0)|(bl>=lv?8:0);
      for(const pair of table[idx]){
        segs.push([
          contourEdgePoint(pair[0],x,y,step,tl,tr,br,bl,lv),
          contourEdgePoint(pair[1],x,y,step,tl,tr,br,bl,lv)
        ]);
      }
    }
    for(const path of stitchContourSegments(segs,step)){
      const d=path.map((p,i)=>`${i?'L':'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      const closed=Math.hypot(path[0].x-path[path.length-1].x,path[0].y-path[path.length-1].y)<=step*0.75;
      if(closed&&li>=1&&li<=5&&mapPolyArea(path)>1800){
        fills+=`<path d="${d} Z" class="iso-f iso-f${Math.min(4,li)}"/>`;
      }
      iso+=`<path d="${d}${closed?' Z':''}" class="iso"/>`;
    }
  });
  // 地形纹理：沿主峰外圈做少量切向短线，增强真实地貌感
  let tex='';
  for(const p of peaks){
    const count=6+Math.floor(rnd()*4);
    for(let i=0;i<count;i++){
      const ang=rnd()*Math.PI*2,rr=(p.sx*0.6)+rnd()*28;
      const x=p.x+Math.cos(ang)*rr,y=p.y+Math.sin(ang)*rr*(p.sy/p.sx);
      const tan=ang+Math.PI/2,L=10+rnd()*14;
      const x2=x+Math.cos(tan)*L,y2=y+Math.sin(tan)*L;
      tex+=`<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="iso-tex"/>`;
    }
  }
  const ox=ER.x1,oy=ER.y1,ow=ER.x2-ER.x1,oh=ER.y2-ER.y1;
  MAP_DECO=`<defs>
  <radialGradient id="mapCoreLight" cx="50%" cy="46%" r="62%"><stop offset="0%" stop-color="var(--map-core-light)" stop-opacity="0.15"/><stop offset="60%" stop-color="var(--map-bg-mid)" stop-opacity="0.05"/><stop offset="100%" stop-color="var(--map-bg-mid)" stop-opacity="0"/></radialGradient>
  <radialGradient id="cityShieldGrad" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="var(--map-shield-light)" stop-opacity="0.15"/><stop offset="60%" stop-color="var(--map-shield-light)" stop-opacity="0.06"/><stop offset="100%" stop-color="var(--map-shield-light)" stop-opacity="0"/></radialGradient>
  <radialGradient id="mistGrad" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="var(--map-mist-center)" stop-opacity="0.10"/><stop offset="60%" stop-color="var(--map-mist-edge)" stop-opacity="0.05"/><stop offset="100%" stop-color="var(--map-mist-edge)" stop-opacity="0"/></radialGradient>
  <filter id="cityShieldBlur" x="-120%" y="-120%" width="340%" height="340%"><feGaussianBlur stdDeviation="9"/></filter>
  <filter id="mistBlur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="26"/></filter>
  </defs>
  <rect x="${ox}" y="${oy}" width="${ow}" height="${oh}" fill="url(#mapCoreLight)"/>
  <ellipse cx="${ox+120}" cy="${cy0}" rx="230" ry="${oh*0.42}" fill="url(#mistGrad)" class="mist" filter="url(#mistBlur)"/>
  <ellipse cx="${ox+ow-120}" cy="${cy0}" rx="230" ry="${oh*0.42}" fill="url(#mistGrad)" class="mist" filter="url(#mistBlur)"/>
  <ellipse cx="${cx0}" cy="${oy+96}" rx="${ow*0.42}" ry="160" fill="url(#mistGrad)" class="mist" filter="url(#mistBlur)"/>
  <ellipse cx="${cx0}" cy="${oy+oh-96}" rx="${ow*0.42}" ry="160" fill="url(#mistGrad)" class="mist" filter="url(#mistBlur)"/>
  ${fills}${iso}${tex}`;
  return MAP_DECO;
}
// 流动云雾（确定性生成一次：高斯模糊云团 + 缓慢循环平移 + 呼吸透明度）
let MAP_CLOUDS=null;
function genMapClouds(){
  if(MAP_CLOUDS)return MAP_CLOUDS;
  const rnd=mulberry32(20260812);
  const R=mapWorldRange();
  const ER={x1:R.x1-220,y1:R.y1-180,x2:R.x2+220,y2:R.y2+180};
  const w=ER.x2-ER.x1,h=ER.y2-ER.y1;
  const cx=(R.x1+R.x2)/2,cy=(R.y1+R.y2)/2;
  let out='';
  for(let i=0;i<8;i++){
    let ex=0,ey=0;
    const side=i%4;
    if(side===0){ex=ER.x1+40+rnd()*110;ey=ER.y1+rnd()*h;}
    if(side===1){ex=ER.x2-40-rnd()*110;ey=ER.y1+rnd()*h;}
    if(side===2){ex=ER.x1+rnd()*w;ey=ER.y1+20+rnd()*90;}
    if(side===3){ex=ER.x1+rnd()*w;ey=ER.y2-20-rnd()*90;}
    ex=(ex+cx*0.18)/1.18;ey=(ey+cy*0.18)/1.18; // 保留外围感，但别离主图过远
    const rx=72+rnd()*128,ry=26+rnd()*42;
    const dur=45+rnd()*40;
    const dir=(rnd()<0.5?-1:1)*(90+rnd()*170);
    const baseOp=(side<2?0.03:0.022).toFixed(3);
    out+=`<ellipse cx="${ex.toFixed(0)}" cy="${ey.toFixed(0)}" rx="${rx.toFixed(0)}" ry="${ry.toFixed(0)}" fill="var(--map-cloud)" fill-opacity="${baseOp}" class="cloud"><animateTransform attributeName="transform" type="translate" values="0 0; ${dir.toFixed(0)} 0; 0 0" dur="${dur.toFixed(0)}s" repeatCount="indefinite"/></ellipse>`;
  }
  MAP_CLOUDS=`<g filter="url(#cloudBlur)">${out}</g><defs><filter id="cloudBlur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="16"/></filter></defs>`;
  return MAP_CLOUDS;
}
// 地图拖拽/缩放（pointer 事件：鼠标+触屏+触控笔；事件委托一次性绑定）
function initMapInteract(){
  if(window.__mapOn)return;window.__mapOn=true;
  document.addEventListener('pointerdown',e=>{
    const t=e.target;
    if(!t||!t.closest)return;
    if(!t.closest('#map-wrap'))return;
    if(t.closest('.city-node')||t.closest('.map-tools'))return;
    MAP.drag={sx:e.clientX,sy:e.clientY,px:MAP.px,py:MAP.py,moved:false};
    if(e.cancelable)e.preventDefault();
  });
  document.addEventListener('pointermove',e=>{
    if(!MAP.drag)return;
    const dx=e.clientX-MAP.drag.sx,dy=e.clientY-MAP.drag.sy;
    if(!MAP.drag.moved&&Math.hypot(dx,dy)>5)MAP.drag.moved=true;
    if(MAP.drag.moved){const kk=mapUnitK();MAP.px=MAP.drag.px+dx/kk;MAP.py=MAP.drag.py+dy/kk;clampMap();applyMapView();} // v8.13：拖动增量换算为 SVG 单位
  });
  document.addEventListener('pointerup',()=>{MAP.drag=null;});
  document.addEventListener('wheel',e=>{
    const wrap=document.getElementById('map-wrap');
    if(!wrap||!e.target.closest('#map-wrap'))return;
    e.preventDefault();
    mapZoomAt(e.clientX,e.clientY,e.deltaY>0?0.85:1.18);
  },{passive:false});
}
function renderMap(){
  const loc=GS.location;
  const sfPhase=(window.Starfall&&Starfall.phase)?Starfall.phase():null; // v9.10.1：星陨城活动状态角标（建设中/休整中）
  const cityPos={};for(let c of CITIES)cityPos[c.id]={x:c.x,y:c.y};
  if(!MAP.init){MAP.init=true;initMapView();}
  // 等高线背景 + 曲线路网
  const deco=genMapDeco();
  let roads='',rlabels='';
  for(let[a,b,d]of ROADS){
    const rc=roadCurve(a,b,cityPos[a].x,cityPos[a].y,cityPos[b].x,cityPos[b].y,d);
    roads+=`<path d="${rc.d}" class="road-line"/><path d="${rc.d}" class="road-flow"/>`;
    rlabels+=`<text x="${rc.cx.toFixed(1)}" y="${(rc.cy-6).toFixed(1)}" class="road-label">${d}里</text>`;
  }
  // 城市节点
  const R=mapWorldRange();
  let cityShields='',cities='',names='';
  for(let c of CITIES){
    const r=c.tier==='capital'?15:(c.tier==='village'?9:11);
    const cls=(c.id===loc?'city-node current':'city-node'); // v9.9：星陨城开放，移除 closed 置灰
    const edgeDist=Math.min(c.x-R.x1,R.x2-c.x,c.y-R.y1,R.y2-c.y);
    const shieldR=r+11+Math.max(0,104-edgeDist)*0.22;
    const shieldOp=edgeDist<104?0.16:0.05;
    cityShields+=`<circle cx="${c.x}" cy="${c.y}" r="${shieldR.toFixed(1)}" fill="url(#cityShieldGrad)" opacity="${shieldOp.toFixed(2)}" class="city-shield" filter="url(#cityShieldBlur)"/>`;
    cities+=`<circle cx="${c.x}" cy="${c.y}" r="${r}" class="${cls} tier-${c.tier}" data-city="${c.id}"/>`;
    if(c.id==='starfall'&&sfPhase){ // v9.10.1：星陨城活动角标——建设期呼吸光晕+状态徽标，休整期静态徽标
      const run=sfPhase==='running';
      cities+=`<circle cx="${c.x}" cy="${c.y}" r="${r+3}" class="sf-map-glow ${run?'sf-glow-run':'sf-glow-inter'}">`+
        (run?`<animate attributeName="r" values="${r+3};${r+8};${r+3}" dur="2.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.55;0.9;0.55" dur="2.6s" repeatCount="indefinite"/>`:'')+
        `</circle>`;
      const by=c.y-r-30;
      names+=`<g class="sf-map-badge ${run?'on':'off'}"><rect x="${c.x-32}" y="${by}" rx="8" width="64" height="16"/><text x="${c.x}" y="${by+12}">${run?'建设中':'休整中'}</text></g>`;
    }
    names+=`<text x="${c.x}" y="${c.y+r+14}" class="city-label">${c.name}</text>`;
  }
  // 旅行中：当前位置点（沿曲线路网插值，非直线）
  let travelDot='',sp=null;
  if(GS.traveling){
    sp=shortestPath(GS.location,GS.traveling.to);
    if(sp&&sp.path.length>1){
      const totalDist=sp.distance,elapsed=(Date.now()-GS.traveling.startedAt)/1000,totalTime=(GS.traveling.arrivalTime-GS.traveling.startedAt)/1000;
      const progress=Math.min(1,Math.max(0,elapsed/totalTime));
      let accDist=0,targetDist=progress*totalDist,px=0,py=0;
      for(let i=0;i<sp.path.length-1;i++){
        const a=sp.path[i],b=sp.path[i+1];
        const seg=buildGraph()[a][b];
        if(accDist+seg>=targetDist){
          const segFrac=(targetDist-accDist)/seg;
          const pt=ptOnRoad(a,b,segFrac,cityPos); // v8.23：方向对齐
          if(pt){px=pt[0];py=pt[1]}
          break;
        }
        accDist+=seg;
        if(i===sp.path.length-2){px=cityPos[sp.path[i+1]].x;py=cityPos[sp.path[i+1]].y}
      }
      if(px&&py)travelDot=`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="7" fill="var(--map-travel-dot)" stroke="var(--map-travel-dot-border)" stroke-width="2" data-travel-dot="1"><animate attributeName="r" values="7;10;7" dur="1.5s" repeatCount="indefinite"/></circle>`;
    }
  }
  // 流动云雾（放在路网与城市下层，避免和可交互元素混为一体）
  const clouds=genMapClouds();
  const view=`translate(${MAP.px.toFixed(1)},${MAP.py.toFixed(1)}) scale(${MAP.s})`;
  let info='',hint='';
  if(GS.traveling){
    const elapsed=Date.now()-GS.traveling.startedAt,total=GS.traveling.arrivalTime-GS.traveling.startedAt;
    const pct=Math.min(100,Math.max(0,Math.round(elapsed/total*100)));
    const curDist=Math.round(sp.distance*pct/100),totalDist=sp.distance;
    info=`<div class="map-info"><span class="city-name">→ ${getCityName(GS.traveling.to)}</span>
    <div class="travel-progress"><div class="fill" id="travel-fill" style="width:${pct}%"></div><div class="text" id="travel-text">${fmt(curDist)} 里 / ${fmt(totalDist)} 里</div></div>
    <span style="font-size:10px;color:var(--text3)">来自 ${getCityName(sp?.path?.[0]||GS.location)}</span></div>`;hint='<p class="map-hint">旅行中… 蓝色圆点为当前位置 · 拖动地图/滚轮缩放</p>';
  }else{
    const cc=getCity(loc);info=`<div class="map-info">📍 当前：<span class="city-name">${cc.name}</span><span style="margin-left:8px">${cc.tier==='village'?'新手村':(cc.tier==='capital'?'王都':(cc.tier==='frontier'?'边陲':'城镇'))}</span><span style="margin-left:auto;color:var(--text3)">拖动地图 · 滚轮缩放 · ⌖ 回到当前位置</span></div>`;hint='<p class="map-hint">点击城市节点发起旅行 · 相邻新手村约 24 秒抵达</p>';
  }
  return `<div class="map-wrap" id="map-wrap"><svg viewBox="0 0 ${MAP_VW} ${MAP_VH}"><g class="map-scene" transform="${view}">${deco}${clouds}${cityShields}${roads}${rlabels}${cities}${names}${travelDot}</g></svg>
  <div class="map-tools"><button title="放大" onclick="mapZoom(1.25)">＋</button><button title="缩小" onclick="mapZoom(0.8)">－</button><button title="回到当前位置" onclick="mapCenter()">⌖</button></div></div>${info}${hint}`;
}
// 旅行中仅增量更新位置点与进度（不重建整个地图，避免路网/云雾动画被重启而"一抽一抽"）
function updateTravelUI(){
  if(!GS.traveling||currentTab!=='map')return;
  const dot=document.querySelector('#map-wrap [data-travel-dot]');
  const sp=shortestPath(GS.location,GS.traveling.to);
  if(sp&&sp.path.length>1){
    const cityPos={};for(let c of CITIES)cityPos[c.id]={x:c.x,y:c.y};
    const totalDist=sp.distance,elapsed=(Date.now()-GS.traveling.startedAt)/1000,totalTime=(GS.traveling.arrivalTime-GS.traveling.startedAt)/1000;
    const progress=Math.min(1,Math.max(0,elapsed/totalTime));
    let accDist=0,targetDist=progress*totalDist,px=0,py=0;
    for(let i=0;i<sp.path.length-1;i++){
      const a=sp.path[i],b=sp.path[i+1];
      const seg=buildGraph()[a][b];
      if(accDist+seg>=targetDist){
        const segFrac=(targetDist-accDist)/seg;
        const pt=ptOnRoad(a,b,segFrac,cityPos); // v8.23：方向对齐
        if(pt){px=pt[0];py=pt[1]}
        break;
      }
      accDist+=seg;
      if(i===sp.path.length-2){px=cityPos[sp.path[i+1]].x;py=cityPos[sp.path[i+1]].y}
    }
    if(dot&&px&&py){dot.setAttribute('cx',px.toFixed(1));dot.setAttribute('cy',py.toFixed(1));}
    const fill=document.getElementById('travel-fill');
    const txt=document.getElementById('travel-text');
    if(fill)fill.style.width=Math.round(progress*100)+'%';
    if(txt)txt.textContent=fmt(Math.round(totalDist*progress))+' 里 / '+fmt(totalDist)+' 里';
  }
}
