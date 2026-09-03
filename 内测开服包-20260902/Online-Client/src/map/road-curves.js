/* ================================================
 * 路网曲线（v9.10.2 自 index.html 主内联脚本拆出）
 * 功能分区：确定性 PRNG（mulberry32/mapSeed）/ 曲线路网生成 / 贝塞尔求点 / 路上取点
 * 依赖全局（调用时求值，加载顺序见 index.html）：
 *   CITIES / buildGraph（pathing-core.js）
 * 本文件状态：MAP_CURVES——按端点归一化 key 缓存，地图绘制（ROADS 顺序）与
 *   旅行点（shortestPath 方向，可能相反）共用同一份曲线，保证两者形状一致。
 * ================================================ */
'use strict';

// 确定性伪随机：mulberry32（地图装饰、路网曲线共用；渲染一致性由固定种子保证）
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function mapSeed(key){let h=0;for(let i=0;i<key.length;i++){h=(h*31+key.charCodeAt(i))>>>0}return mulberry32(h+7)}

// 曲线路网：按里数分段三次贝塞尔（长路多弯、边缘路大弧度；确定性种子，结果缓存）
let MAP_CURVES={};
function roadCurve(a,b,x1,y1,x2,y2,d){
  // v8.22：key 按端点归一化——地图绘制用 ROADS 顺序、旅行点用 shortestPath 方向（可能相反），
  // 方向敏感 key 会让两者生成形状不同的曲线，导致旅行点"偏移出路网"
  const key=a<b?a+'|'+b:b+'|'+a;
  if(MAP_CURVES[key])return MAP_CURVES[key];
  const dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy)||1;
  const nx=-dy/len,ny=dx/len;
  const rnd=mapSeed(key);
  const distLi=d||10;
  // 里数越长弧度越大（短途近似直路，长途蜿蜒绕行）：振幅 0.10~0.34
  const amp=Math.min(0.34,0.10+distLi*0.006);
  const segs=distLi>22?3:(distLi>9?2:1); // 长路拆多段 → 多个弯道
  let pd='',cxs=0,cys=0;
  const curves=[];
  for(let s=0;s<segs;s++){
    const t0=s/segs,t1=(s+1)/segs;
    const p0x=x1+dx*t0,p0y=y1+dy*t0;
    const p1x=x1+dx*t1,p1y=y1+dy*t1;
    const off=(rnd()-0.5)*len*amp*2;
    const mx=(p0x+p1x)/2,my=(p0y+p1y)/2;
    const c1x=mx+nx*off,c1y=my+ny*off;
    const c2x=mx+nx*off*0.55,c2y=my+ny*off*0.55;
    pd+=(s===0?`M ${p0x.toFixed(1)} ${p0y.toFixed(1)}`:'')+` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p1x.toFixed(1)} ${p1y.toFixed(1)}`;
    curves.push({p0:[p0x,p0y],c1:[c1x,c1y],c2:[c2x,c2y],p1:[p1x,p1y]});
    cxs+=mx;cys+=my;
  }
  MAP_CURVES[key]={d:pd,curves,cx:cxs/segs,cy:cys/segs};
  return MAP_CURVES[key];
}
// 三次贝塞尔求点 / 沿曲线组按【弧长】取点（旅行位置跟随路网，匀速沿曲线行进）
function bezierPt(p0,c1,c2,p1,t){
  const u=1-t;
  return [u*u*u*p0[0]+3*u*u*t*c1[0]+3*u*t*t*c2[0]+t*t*t*p1[0],
          u*u*u*p0[1]+3*u*u*t*c1[1]+3*u*t*t*c2[1]+t*t*t*p1[1]];
}
function bezierLen(c){
  let L=0,px=c.p0[0],py=c.p0[1];
  for(let i=1;i<=24;i++){
    const p=bezierPt(c.p0,c.c1,c.c2,c.p1,i/24);
    L+=Math.hypot(p[0]-px,p[1]-py);px=p[0];py=p[1];
  }
  return L;
}
function pointOnCurves(curves,frac){
  if(!curves||!curves.length)return null;
  const n=curves.length;
  if(!curves._len){ // 缓存各段弧长与总长
    curves._seg=[];curves._len=0;
    for(let i=0;i<n;i++){curves._seg[i]=bezierLen(curves[i]);curves._len+=curves._seg[i];}
  }
  if(curves._len<=0)return bezierPt(curves[0].p0,curves[0].c1,curves[0].c2,curves[0].p1,0);
  let target=Math.max(0,Math.min(1,frac))*curves._len,acc=0;
  for(let i=0;i<n;i++){
    const L=curves._seg[i];
    if(acc+L>=target||i===n-1){
      const t=L>0?Math.max(0,Math.min(1,(target-acc)/L)):0;
      return bezierPt(curves[i].p0,curves[i].c1,curves[i].c2,curves[i].p1,t);
    }
    acc+=L;
  }
  return bezierPt(curves[n-1].p0,curves[n-1].c1,curves[n-1].c2,curves[n-1].p1,1);
}
// v8.23：路上取点——曲线方向由首次生成（ROADS 顺序）决定，若旅行方向与该段曲线反向则用 1-frac，
// 修复"旅行点从目的地反向行进、与路线完全不符"（v8.22 归一化 key 后引入）
function ptOnRoad(a,b,segFrac,cityPos){
  const seg=buildGraph()[a][b];
  const rc=roadCurve(a,b,cityPos[a].x,cityPos[a].y,cityPos[b].x,cityPos[b].y,seg);
  const p0=rc.curves[0].p0;
  const fwd=Math.abs(p0[0]-cityPos[a].x)<0.5&&Math.abs(p0[1]-cityPos[a].y)<0.5;
  return pointOnCurves(rc.curves,fwd?segFrac:1-segFrac);
}
