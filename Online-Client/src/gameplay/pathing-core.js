/* ================================================
 * 寻路核心
 * ================================================ */
function buildGraph(){const g={};for(let c of CITIES)g[c.id]={};for(let[a,b,d]of ROADS){g[a][b]=d;g[b][a]=d}return g}
function shortestPath(from,to){
  const graph=buildGraph(),dist={},prev={},visited=new Set();
  for(let c of CITIES)dist[c.id]=Infinity;dist[from]=0;
  while(visited.size<CITIES.length){let u=null;for(let c of CITIES){if(!visited.has(c.id)&&(u===null||dist[c.id]<dist[u]))u=c.id}if(u===null||dist[u]===Infinity)break;visited.add(u);for(let v in graph[u]){const alt=dist[u]+graph[u][v];if(alt<dist[v]){dist[v]=alt;prev[v]=u}}}
  if(dist[to]===Infinity)return null;const path=[to];let cur=to;while(cur!==from){cur=prev[cur];path.unshift(cur)}return{path,distance:dist[to]};
}

window.buildGraph = buildGraph;
window.shortestPath = shortestPath;
