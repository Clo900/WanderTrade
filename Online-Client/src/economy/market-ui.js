/* ================================================
 * 交易市场 UI（v9.10.2 自 index.html 主内联脚本拆出）
 * 功能分区：市场卡片 / 中转面板 / 数量滑条 / 行情折线图 / 单笔与批量交易
 * 依赖全局（调用时求值，加载顺序见 index.html）：
 *   GS / State / ONLINE / AUTH_KEY / NET / localStorage / CENTRAL_PERIOD
 *   getCity / getItem / getBuyableGoods / getDayPrice / getSellPrice / getSellPriceBase
 *   getCurStock / getMaxStock / getUsedCargo / getTaskCargoUsed / getVehicleCapacity
 *   getCargoFree / getRepLevel / getPriceHistory / getTrend
 *   fmt / toast / showModal / render / advanceDay
 *   buyItem / sellItem / consumeLots / getSameVisitArbitrage
 *   DemandEngine / TradeDraft / TradePreview / TradeValidate / Tax
 * 本文件状态（与主文件 currentTab 并列）：marketTab / _chartDays / _chartItem / expandedCard / sliderVals
 * ================================================ */
'use strict';

// 市场视图状态（v9.10.2 迁移；内联脚本通过共享全局词法环境引用）
let marketTab='buy',_chartDays=60,_chartItem=null,expandedCard=null,sliderVals={};

function getChartableItems(){
  const loc=GS.location,city=getCity(loc);
  // vNext：列表随“购入/售出”切换
  if(marketTab==='buy'){
    return getBuyableGoods(loc);
  }
  // 售出：仅车厢持有（不含仓库）
  const s=new Set();
  for(let k of Object.keys(GS.cargo))if(GS.cargo[k]>0)s.add(k);
  return[...s];
}
function onChartSelect(){const sel=document.getElementById('chart-select');_chartItem=sel.value||null;if(_chartItem)drawChart()}
// DRY v9.10.2：市场 tab 刷新统一序列（卡片重绘 + 图表下拉同步）
function refreshMarketTab(){
  renderMarketCards();
  refreshChartSelectForMarketTab();
}
function switchMarket(tab){
  if(tab===marketTab)return;
  // vNext：中转面板有内容时，切换买卖也必须提示并清空（清空 buy/sell 两个 draft）
  if(window.TradeDraft&&TradeDraft.anyNonEmpty&&TradeDraft.anyNonEmpty()){
    showModal('⚠ 物价已更新',
      `中转面板中仍有未确认的交易单。\n为避免按旧价成交，切换面板将清空中转面板内容。`,
      '知道了',()=>{
        TradeDraft.clearAll('tab-switch');
        marketTab=tab;
        refreshMarketTab();
      });
    return;
  }
  marketTab=tab;
  refreshMarketTab();
}
function renderMarketCards(){
  const loc=GS.location,city=getCity(loc),cont=document.getElementById('market-cards');
  if(!cont)return;
  renderTradeDraftPanel();
  document.querySelector('.buy-tab')?.classList.toggle('active',marketTab==='buy');
  document.querySelector('.sell-tab')?.classList.toggle('active',marketTab==='sell');
  const items=[];
  if(marketTab==='buy'){
    for(let gid of getBuyableGoods(loc)){
      const it=getItem(gid),price=getDayPrice(loc,gid,GS.day),yest=getDayPrice(loc,gid,Math.max(1,GS.day-1));
      const ch=yest&&price?price-yest:0,stock=getCurStock(loc,gid),max=getMaxStock(loc,gid);
      items.push({gid,it,price,ch,stock,max,type:'buy'});
    }
  }else{
    // vNext：售出仅显示车厢持有（不含仓库）
    const hubNow=Math.floor(GS.day/CENTRAL_PERIOD);
    for(let gid of Object.keys(GS.cargo)){if(!GS.cargo[gid])continue;
      const it=getItem(gid);if(!it)continue;
      // v9.5：需求四档（hot/normal/cool/reject）
      const ds=(window.DemandEngine&&DemandEngine.getDemandState)?DemandEngine.getDemandState(loc,gid,hubNow):'normal';
      const sPrice=getSellPrice(loc,gid,GS.day);
      const sYest=getSellPrice(loc,gid,Math.max(1,GS.day-1));
      const ch=sYest&&sPrice?sPrice-sYest:0;
      const rejectReason=ds==='reject'?((window.DemandEngine&&DemandEngine.getRejectReason(loc,gid))||'本城无人收购'):'';
      items.push({gid,it,price:getDayPrice(loc,gid,GS.day),sPrice,ch,held:GS.cargo[gid],cost:GS.buyPrice[gid]||0,type:'sell',ds,rejectReason});
    }
  }
  let html='';
  for(let r of items){
    const isExp = expandedCard===r.gid;
    const chCls=r.ch>0?'up':(r.ch<0?'down':'flat'),chStr=r.ch>0?`+${r.ch}`:(r.ch<0?r.ch:0);
    html+=`<div class="item-card${isExp?' expanded':''}${r.ds==='reject'?' ic-reject':''}" data-gid="${r.gid}" onclick="toggleCard('${r.gid}')">`;
    html+=`<span class="ic-icon">${r.it.icon}</span><span class="ic-name">${r.it.name}</span>`;
    html+=`<span class="ic-cat">${r.it.cat==='basic'?'基础':'特产'}</span>`;
    if(r.type==='buy'){
      html+=`<div class="ic-price buy">${fmt(r.price)}</div>`;
      html+=`<div class="ic-change ${chCls}">${chStr}</div>`;
      html+=`<div class="ic-limit">库存 ${r.stock}/${r.max}</div>`;
      html+=`<div class="ic-cargo-info">🚛 ${getUsedCargo()+getTaskCargoUsed()}/${getVehicleCapacity()}</div>`;
      const afford=Math.max(0, Math.floor(GS.gold/Math.max(1,r.price||1)));
      const maxBuy=Math.min(r.stock, afford, getCargoFree());
      if(maxBuy<=0){
        const why=GS.gold<0?'欠债中，无法购入（先卖货或完成任务还债）':'资金/货舱/库存不足';
        html+=`<div class="ic-detail"><div class="row" style="color:${GS.gold<0?'var(--red)':'var(--text3)'}">${why}</div></div>`;
      }else{
        html+=`<div class="ic-detail">${qtySliderHTML(r.gid,maxBuy,Math.min(1,maxBuy))}<div class="row"><button class="btn-action btn-buy" onclick="event.stopPropagation();draftFromSlider('buy','${r.gid}')">加入中转面板</button></div></div>`;
      }
    }else{
      // v9.5：拒收标红 + 需求标签
      const dsTag = r.ds==='hot' ? `<span class="ic-ds ds-hot" title="本城正在高价收购">🔥 热门</span>`
                 : r.ds==='cool' ? `<span class="ic-ds ds-cool" title="本城市场需求冷淡，收购价压低">🧊 冷淡</span>`
                 : r.ds==='reject'? `<span class="ic-ds ds-reject" title="点击查看原因">🚫 无人收购</span>` : '';
      const priceCell = r.ds==='reject'
        ? `<div class="ic-price sell reject" onclick="event.stopPropagation();showModal('🚫 本城无人收购','<b>${r.it.name}</b>：${r.rejectReason||'本城不收购此物资'}', '知道了', ()=>{})">无人收购</div>`
        : `<div class="ic-price sell">${fmt(r.sPrice)}</div>`;
       html+=dsTag;
       html+=`${priceCell}`;
      html+=`<div class="ic-change ${chCls}">${chStr}</div>`;
      html+=`<div class="ic-limit">持有 ${r.held}件 · 成本 ${fmt(r.cost)}</div>`;
      html+=`<div class="ic-cargo-info">🚛 ${getUsedCargo()+getTaskCargoUsed()}/${getVehicleCapacity()}</div>`;
      const sellBtn = r.ds==='reject'
        ? `<button class="btn-action btn-sell disabled" onclick="event.stopPropagation();showModal('🚫 本城无人收购','<b>${r.it.name}</b>：${r.rejectReason||'本城不收购此物资'}', '知道了', ()=>{})">无法售出</button>`
        : `<button class="btn-action btn-sell" onclick="event.stopPropagation();draftFromSlider('sell','${r.gid}')">加入中转面板</button>`;
      html+=`<div class="ic-detail">${qtySliderHTML(r.gid,r.held,Math.min(1,r.held))}<div class="row">${sellBtn}</div></div>`;
    }
    html+=`</div>`;
  }
  if(items.length===0)html=`<div class="empty">${marketTab==='buy'?'本城无可购物资':'目前没有可出售的物资'}</div>`;
  cont.innerHTML=html;
  if(!_chartItem){
    const buyItems=items.filter(i=>i.type==='buy');
    const first=buyItems[0]||items[0];
    if(first){_chartItem=first.gid;const sel=document.getElementById('chart-select');if(sel)sel.value=_chartItem;drawChart();}
  }
}
function toggleCard(gid){
  expandedCard = (expandedCard===gid)?null:gid;
  renderMarketCards();
  if(_chartItem)drawChart();
}
function refreshChartSelectForMarketTab(){
  const sel=document.getElementById('chart-select');if(!sel)return;
  const items=getChartableItems();
  const old=_chartItem;
  let html=`<option value="">-- 选择物资 --</option>`;
  for(const gid of items){const it=getItem(gid);html+=`<option value="${gid}" ${gid===old?'selected':''}>${it.icon} ${it.name}</option>`}
  sel.innerHTML=html;
  if(old && items.includes(old)){ _chartItem=old; }
  else{ _chartItem=items[0]||null; if(_chartItem)sel.value=_chartItem; }
  if(_chartItem)drawChart(); else {document.getElementById('chart-stats').innerHTML='';}
}
function renderTradeDraftPanel(){
  const box=document.getElementById('trade-draft');if(!box)return;
  if(!window.TradeDraft)return;
  const td=TradeDraft.getDraftState();
  const mode=marketTab;
  const d=td[mode];
  const entries=[];
  if(d && d.items)for(const gid of Object.keys(d.items)){const q=parseInt(d.items[gid])||0;if(q>0)entries.push({gid,qty:q});}
  if(!entries.length){
    // 中转面板为空时也保留详情面板：具体数据按 0 / 空 显示
    const used0=getUsedCargo(),cap0=getVehicleCapacity();
    const pre0 = window.TradePreview ? (mode==='buy'?TradePreview.previewBuy(d):TradePreview.previewSell(d)) : null;
    const rate0 = pre0 ? pre0.taxRate : (window.Tax?Tax.getRate(getRepLevel(GS.location)):0);
    const cargoLine0 = `货舱 ${used0}/${cap0}${mode==='buy'?'（+0）':'（-0）'}`;
    const subLine0 = mode==='buy' ? '小计 0' : '收入 0';
    const taxLine0 = mode==='buy'
      ? `税率 ${Math.round(rate0*100)}% · 税额 0 · 应付 <b>0</b>`
      : `税率 ${Math.round(rate0*100)}% · 税额 0 · 到手 <b>0</b>`;
    box.innerHTML=`<div class="trade-side">
      <div class="trade-cart-panel empty">购物车为空：从左侧物资列表加入后，可一次性确认成交</div>
      <div class="trade-summary-panel">
        <div class="ts-row"><span class="ts-label">${cargoLine0}</span></div>
        <div class="ts-row"><span class="ts-label">${subLine0}</span></div>
        <div class="ts-row"><span class="ts-label">${taxLine0}</span></div>
        <button class="btn btn-primary td-confirm" onclick="confirmDraft('${mode}')" disabled>${mode==='buy'?'确认购入':'确认售出'}</button>
      </div>
    </div>`;
    return;
  }
  const pre = window.TradePreview ? (mode==='buy'?TradePreview.previewBuy(d):TradePreview.previewSell(d)) : null;
  const plannedQty = entries.reduce((s,e)=>s+e.qty,0);
  const used=getUsedCargo(),cap=getVehicleCapacity();
  const afterUsed = mode==='buy' ? (used+plannedQty) : Math.max(0, used-plannedQty);
  const cargoLine = `货舱 ${afterUsed}/${cap}${mode==='buy'?`（+${plannedQty}）`:`（-${plannedQty}）`}`;
  const totalLine = mode==='buy'
    ? `税率 ${Math.round(pre.taxRate*100)}% · 税额 ${fmt(pre.tax)} · 应付 <b>${fmt(pre.total)}</b>`
    : `税率 ${Math.round(pre.taxRate*100)}% · 税额 ${fmt(pre.tax)} · 到手 <b>${fmt(pre.net)}</b>`;
  let rows='';
  for(const e of entries){
    const it=getItem(e.gid);
    const max = mode==='buy'? Math.min(getCurStock(GS.location,e.gid), Math.max(0, Math.floor(GS.gold/Math.max(1,(getDayPrice(GS.location,e.gid,GS.day)||1)))), getCargoFree()+e.qty) : (GS.cargo[e.gid]||0);
    rows+=`<div class="td-row">
      <span class="td-name">${it.icon} ${it.name}</span>
      <input class="td-qty" type="number" min="0" max="${max}" value="${e.qty}" onchange="onDraftQtyChange('${mode}','${e.gid}',this.value)">
      <button class="td-del" onclick="onDraftRemove('${mode}','${e.gid}')">移除</button>
    </div>`;
  }
  box.innerHTML=`<div class="trade-side">
    <div class="trade-cart-panel">
      <div class="td-head">🧾 中转购物车（${mode==='buy'?'购入':'售出'} · ${entries.length}种）<button class="td-clear" onclick="clearDraftManual()">清空</button></div>
      <div class="td-list">${rows}</div>
    </div>
    <div class="trade-summary-panel">
      <div class="ts-row"><span class="ts-label">${cargoLine}</span></div>
      <div class="ts-row"><span class="ts-label">${mode==='buy'?`小计 ${fmt(pre.subtotal)}`:`收入 ${fmt(pre.revenue)}`}</span></div>
      <div class="ts-row"><span class="ts-label">${totalLine}</span></div>
      <button class="btn btn-primary td-confirm" onclick="confirmDraft('${mode}')">${mode==='buy'?'确认购入':'确认售出'}</button>
    </div>
  </div>`;
}
/* 中转面板 buy 容量校验（「加入」与「改数量」共用，DRY）：
   返回 {ok, used, cap, free, plannedOther, qty, planned}；
   used 含任务占用，plannedOther 为中转面板中除 gid 外的计划数量。 */
function draftCapacityCheck(gid,qty){
  const cap=getVehicleCapacity();
  const used=getUsedCargo()+getTaskCargoUsed();
  const dBuy = (window.TradeDraft && TradeDraft.getDraftState()) ? TradeDraft.getDraftState().buy : null;
  let plannedOther=0;
  if(dBuy && dBuy.items){
    for(const k of Object.keys(dBuy.items)){
      if(k===gid) continue;
      plannedOther += parseInt(dBuy.items[k])||0;
    }
  }
  const planned=plannedOther+qty;
  return {ok:(used+planned)<=cap, used, cap, free:Math.max(0,cap-used), plannedOther, qty, planned};
}
function onDraftQtyChange(mode,gid,val){
  const q=Math.max(0,parseInt(val)||0);
  // v9.10：购物车内直接改数量也套用容量校验（此前仅「加入」时校验，可在购物车改出超容量）
  if(mode==='buy'){
    const chk=draftCapacityCheck(gid,q);
    if(!chk.ok){
      toast(`货舱容量不足：当前剩余 ${chk.free} 格，该数量将使合计 ${chk.planned} 件，超出容量 ${chk.cap} 格`,'err');
      renderMarketCards(); // 不写入 draft，重绘还原输入框
      return;
    }
  }
  TradeDraft.add(mode,gid,q);
  renderMarketCards();
}
function onDraftRemove(mode,gid){
  TradeDraft.remove(mode,gid);
  renderMarketCards();
}
function clearDraftManual(){
  if(!TradeDraft.anyNonEmpty())return;
  showModal('清空中转面板','确认清空中转面板中的全部内容？','清空',()=>{TradeDraft.clearAll('manual');renderMarketCards();});
}
function draftFromSlider(mode,gid){
  if(!window.TradeDraft)return;
  // v9.5：拒收物资不可加入售出中转
  if(mode==='sell'&&window.DemandEngine){
    const hubNow=Math.floor(GS.day/CENTRAL_PERIOD);
    const ds=DemandEngine.getDemandState(GS.location,gid,hubNow);
    if(ds==='reject'){
      const reason=DemandEngine.getRejectReason(GS.location,gid)||'本城不收购此物资';
      showModal('🚫 本城无人收购',`<b>${getItem(gid).name}</b>：${reason}`,'知道了');
      return;
    }
  }
  // 若中转面板已有内容，但锚点变化（游戏日/中枢/城市）则按规则提示并清空后再加入
  if(TradeDraft.anyNonEmpty()){
    const td=TradeDraft.getDraftState();
    const d0=td.buy, d1=td.sell;
    const now=TradeDraft.anchorForNow();
    const bad = (d0 && d0.items && Object.keys(d0.items).length && (d0.cityId!==now.cityId || d0.hub!==now.hub || d0.day!==now.day))
      || (d1 && d1.items && Object.keys(d1.items).length && (d1.cityId!==now.cityId || d1.hub!==now.hub || d1.day!==now.day));
    if(bad){
      showModal('⚠ 物价已更新',`由于游戏日/中枢点/城市发生变化，为避免按旧价成交，已清空中转面板内容。`,'知道了',()=>{TradeDraft.clearAll('anchor');doDraftAdd();});
      return;
    }
  }
  doDraftAdd();
  function doDraftAdd(){
    const qty=getSliderVal(gid);
    // 购入时校验货舱容量（与购物车改数量共用 draftCapacityCheck）
    if(mode==='buy'){
      const chk=draftCapacityCheck(gid,qty);
      if(!chk.ok){
        showModal('⚠ 货舱容量不足',
          `当前货舱剩余 ${chk.free} 格，中转面板已有 ${chk.plannedOther} 件，本次计划加入 ${chk.qty} 件，合计 ${chk.planned} 件，已超出容量 ${chk.cap} 格。`,
          '知道了');
        return;
      }
    }
    TradeDraft.add(mode,gid,qty);
    toast('已加入中转面板','ok');
    renderMarketCards();
  }
}
async function confirmDraft(mode){
  if(GS.traveling)return toast('旅行中不可交易','info');
  // v9.13.6：确认成交时推进游戏日，但期间跳过"日/中枢变化清空中转面板"的拦截弹窗
  //（在线模式日由服务器时间驱动，确认时恰逢翻日会清空 draft 打断成交；成交本就是使用当前 draft 的意图）
  __confirmingDraft=true;
  try{ advanceDay(); }
  finally{ __confirmingDraft=false; }
  if(!window.TradeDraft||!window.TradeValidate||!window.TradePreview)return toast('模块未就绪','err');
  const td=TradeDraft.getDraftState();
  const draft=td[mode];
  if(mode==='buy'){
    const v=TradeValidate.validateBuyDraft(draft);
    if(!v.ok)return toast(v.msg,'err');
    const msg=`物品种类：${v.list.length}\n小计：${fmt(v.subtotal)}\n税率：${Math.round(v.taxRate*100)}%\n税额：${fmt(v.tax)}\n应付总额：${fmt(v.total)}`;
    showModal('🧾 确认购入（中转面板）',msg,'确认购入',async()=>{
      const ok = await execBuyDraft(v.list, v.total);
      if(ok){TradeDraft.clearAll('buy-confirm');render();refreshMarketTab();}
    });
    return;
  }
  // sell
  const vs=TradeValidate.validateSellDraft(draft);
  if(!vs.ok)return toast(vs.msg,'err');
  const warns=TradeValidate.sameVisitWarningsSell(vs.list);
  const proceed = async()=>{
    const pre=TradePreview.previewSell(draft);
    const msg=`物品种类：${pre.list.length}\n预计收入：${fmt(pre.revenue)}\n税率：${Math.round(pre.taxRate*100)}%\n税额：${fmt(pre.tax)}\n预计到手：${fmt(pre.net)}`;
    showModal('🧾 确认售出（中转面板）',msg,'确认售出',async()=>{
      const ok = await execSellDraft(pre.list, pre.net);
      // v9.13.6：成交后同步刷新市场区域（render 内 setTimeout(0) 异步刷新在教程完成等时序下可能被延迟/竞态，
      // 导致售出页短暂保持卖出前快照；此处同步 refreshMarketTab 保证"直接刷新"体验）
      if(ok){TradeDraft.clearAll('sell-confirm');render();refreshMarketTab();}
    });
  };
  if(warns.length){
    const rows=warns.map(w=>`- ${w.name}：同城同次 ${w.sameQty}件，将按买入价60%（${fmt(w.unit60)}/件）结算`).join('\n');
    showModal('⚠️ 同城倒卖警告',`以下物品命中“同城同次 + 顺价套利”惩罚：\n${rows}\n\n仍要继续吗？`,'继续售出',proceed);
    return;
  }
  proceed();
}

// DRY v9.10.2：在线批量结算统一入口（服务端资金/持仓/库存权威），失败时已 toast 并返回 null
async function onlineTradeBatch(dir,items,extra){
  const user=localStorage.getItem(AUTH_KEY)||'';
  const payload=Object.assign({user,city:GS.location,dir,items},extra||{});
  const r=await NET.post('/api/tradeBatch',payload);
  if(!r||!r.ok){toast('在线结算失败：'+(r&&r.err?r.err:'网络错误'),'err');return null;}
  if(r.serverAt)GS.__lastServerAt=r.serverAt; // 防止后续自动保存覆盖服务器变更
  if(typeof r.gold==='number')State.set('gold',r.gold);
  if(r.cargo)State.set('cargo',r.cargo);
  if(r.stocks){
    const cs=State.get('cityStocks')||{};
    cs[GS.location]=r.stocks;
    State.set('cityStocks',cs);
  }
  return r;
}

async function execBuyDraft(list,total){
  if(ONLINE){
    const r=await onlineTradeBatch('buy',list.map(x=>({item:x.gid,qty:x.qty})),{total:Math.round(total||0)});
    if(!r)return false;
    // 本地轻记账（lots/成本/声望/事件；资金与持仓以服务端为准）
    for(const it of list){
      buyItem(it.gid,it.qty,{skipAdvance:true,serverLedger:true});
    }
    toast('✅ 已完成购入（中转面板）','ok');
    return true;
  }
  // 本地落地（一次确认，多物品成交；单笔交易不再重复推进游戏日）
  for(const it of list){
    const rr=buyItem(it.gid,it.qty,{skipAdvance:true});
    if(!rr.ok){toast('购入失败：'+rr.msg,'err');return false;}
  }
  toast('✅ 已完成购入（中转面板）','ok');
  return true;
}

async function execSellDraft(list,net){
  if(ONLINE){
    const r=await onlineTradeBatch('sell',list.map(x=>({item:x.gid,qty:x.qty})),{net:Math.round(net||0)});
    if(!r)return false;
    // 本地轻记账：真实扣 lots（含惩罚）+ 成本/声望/事件
    for(const it of list){
      const lr=consumeLots(it.gid,it.qty);
      sellItem(it.gid,it.qty,{skipAdvance:true,serverLedger:true,lotsResult:lr});
    }
    toast('✅ 已完成售出（中转面板）','ok');
    return true;
  }
  for(const it of list){
    const rr=sellItem(it.gid,it.qty,{skipAdvance:true});
    if(!rr.ok){toast('售出失败：'+rr.msg,'err');return false;}
  }
  toast('✅ 已完成售出（中转面板）','ok');
  return true;
}
async function doAction(type,gid){
  const qty=getSliderVal(gid);
  if(type==='buy'){
    // C1：单笔买入在线也走服务端权威结算
    if(ONLINE){
      const city=GS.location;
      const price=getDayPrice(city,gid,GS.day)||0;
      const total=price*qty;
      const taxRate=(window.Tax&&Tax.getRate)?Tax.getRate(getRepLevel(city)):0;
      const tax=(window.Tax&&Tax.calc)?Tax.calc(total,taxRate):0;
      const pay=total+tax;
      const r=await onlineTradeBatch('buy',[{item:gid,qty}],{total:Math.round(pay)});
      if(!r)return;
      const rr=buyItem(gid,qty,{skipAdvance:true,serverLedger:true});
      toast(rr.msg,rr.ok?'ok':'err');
      if(rr.ok){delete sliderVals[gid];render();}
      return;
    }
    const r=buyItem(gid,qty);toast(r.msg,r.ok?'ok':'err');if(r.ok){delete sliderVals[gid];render();}return;
  }
  // 卖出前：同城同次 + 本城买入价<卖出价（顺价可套利）时弹窗确认 60% 惩罚
  const info=getSameVisitArbitrage(gid,qty);
  if(info){
    const unit60=Math.round(info.buy*0.6);
    showModal('⚠️ 同城倒卖警告',
      `本城该物资当前「买入价 ${fmt(info.buy)}」低于「卖出价 ${fmt(info.sPrice)}」\n本次出售中有 ${info.sameQty} 件为本城本次停留期间买入\n若确认出售，这 ${info.sameQty} 件将按当前买入价的 60%（${fmt(unit60)} 金/件）结算`,
      '确认出售',()=>{doSell(gid,qty);});
    return;
  }
  doSell(gid,qty);
}
async function doSell(gid,qty){
  // C1：单笔卖出在线也走服务端权威结算
  if(ONLINE){
    const lr=consumeLots(gid,qty); // 真实扣 lots（含惩罚），返回 revenue 供服务端记账
    const taxRate=(window.Tax&&Tax.getRate)?Tax.getRate(getRepLevel(GS.location)):0;
    const tax=(window.Tax&&Tax.calc)?Tax.calc(lr.revenue,taxRate):0;
    const net=lr.revenue-tax;
    const r=await onlineTradeBatch('sell',[{item:gid,qty}],{net:Math.round(net)});
    if(!r)return;
    const rr=sellItem(gid,qty,{skipAdvance:true,serverLedger:true,lotsResult:lr});
    toast(rr.msg,rr.ok?'ok':'err');
    if(rr.ok){delete sliderVals[gid];render();}
    return;
  }
  const r=sellItem(gid,qty);
  toast(r.msg,r.ok?'ok':'err');
  if(r.ok){delete sliderVals[gid];render();}
}
function getSliderVal(gid){const sl=document.getElementById('slider-'+gid);return sl?parseInt(sl.value)||1:1}
function qtySliderHTML(gid,maxVal,initVal){
  const base=sliderVals[gid]!==undefined?sliderVals[gid]:(initVal||1);
  const v=Math.max(1,Math.min(base,maxVal));
  return `<div class="qty-slider"><button class="qty-arrow" onclick="event.stopPropagation();setSliderDelta('${gid}',-1)">◀</button>
  <input type="range" id="slider-${gid}" min="1" max="${maxVal}" value="${v}" onclick="event.stopPropagation()" onpointerdown="window._draggingGid='${gid}'" oninput="document.getElementById('sv-${gid}').textContent=this.value;sliderVals['${gid}']=parseInt(this.value)||1" onpointerup="window._draggingGid=null;onSliderRelease()" onchange="event.stopPropagation()">
  <button class="qty-arrow" onclick="event.stopPropagation();setSliderDelta('${gid}',1)">▶</button>
  <span class="qty-val" id="sv-${gid}">${v}</span></div>`;
}
function setSliderDelta(gid,d){const sl=document.getElementById('slider-'+gid);if(sl){const v=Math.min(parseInt(sl.max),Math.max(1,(parseInt(sl.value)||1)+d));sl.value=v;document.getElementById('sv-'+gid).textContent=v;sliderVals[gid]=v;}}
function onSliderRelease(){window._draggingGid=null;if(window._pendingRefresh){window._pendingRefresh=false;render();}}

// ===== 折线图 =====
function drawChart(){
  if(!_chartItem)return;const canvas=document.getElementById('price-chart');if(!canvas)return;
  // 画布尺寸完全由 CSS 决定（固定高度 360px），避免因 bitmap 尺寸变化导致折线图变大变小
  const cssW=canvas.clientWidth||canvas.parentElement.clientWidth||320;
  const cssH=canvas.clientHeight||360;
  if(canvas.width!==cssW)canvas.width=cssW;
  if(canvas.height!==cssH)canvas.height=cssH;
  const loc=GS.location,hist=getPriceHistory(loc,_chartItem,_chartDays);
  const ctx=canvas.getContext('2d'),W=canvas.width,H=canvas.height,padL=55,padR=25,padT=20,padB=35;
  ctx.clearRect(0,0,W,H);ctx.fillStyle='#0d1b2a';ctx.fillRect(0,0,W,H);
  if(hist.length<2)return;
  const isBuyView = (marketTab==='buy');
  const buyPrices=hist.map(h=>h.price);
  const sellPrices=hist.map(h=>h.sell);
  const allP = isBuyView ? [...buyPrices, ...sellPrices] : [...sellPrices];
  const minP=Math.min(...allP),maxP=Math.max(...allP),range=maxP-minP||1;
  const pw=(W-padL-padR)/(hist.length-1),by=y=>padT+(H-padT-padB)*(1-(y-minP)/range),bx=i=>padL+i*pw;
  ctx.strokeStyle='#1a1a3a';ctx.lineWidth=0.5;for(let i=0;i<=4;i++){const y=padT+(H-padT-padB)*i/4;ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke()}
  // 售出线（一直画）
  ctx.beginPath();
  ctx.strokeStyle='#ff9f43';
  ctx.lineWidth=isBuyView?1.5:2;
  if(isBuyView)ctx.setLineDash([4,3]);
  for(let i=0;i<hist.length;i++){const x=bx(i),y=by(hist[i].sell);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y)}
  ctx.stroke();
  ctx.setLineDash([]);
  // 购入线（仅购入页面展示）
  if(isBuyView){
    ctx.beginPath();
    ctx.strokeStyle='#26d98b';
    ctx.lineWidth=2;
    for(let i=0;i<hist.length;i++){const x=bx(i),y=by(hist[i].price);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y)}
    ctx.stroke();
  }
  const last=hist[hist.length-1];
  if(isBuyView){
    ctx.beginPath();ctx.arc(bx(hist.length-1),by(last.price),5,0,Math.PI*2);ctx.fillStyle='#26d98b';ctx.fill();
    ctx.beginPath();ctx.arc(bx(hist.length-1),by(last.sell),4,0,Math.PI*2);ctx.fillStyle='#ff9f43';ctx.fill();
  }else{
    ctx.beginPath();ctx.arc(bx(hist.length-1),by(last.sell),5,0,Math.PI*2);ctx.fillStyle='#ff9f43';ctx.fill();
  }
  ctx.fillStyle='#8b95a5';ctx.font='10px sans-serif';for(let i=0;i<=4;i++){const y=padT+(H-padT-padB)*i/4;ctx.fillText(fmt(Math.round(maxP-(maxP-minP)*i/4)),2,y+4)}
  const steps=hist.length<=30?5:(hist.length<=60?8:12);for(let i=0;i<hist.length;i+=Math.ceil(hist.length/steps))ctx.fillText(hist[i].day,bx(i),H-padB+14);
  const trend=getTrend(GS.location,_chartItem, isBuyView ? 'buy' : 'sell');
  const cls=trend.cls==='up'?'color:var(--buy)':(trend.cls==='down'?'color:var(--red)':'color:var(--text2)');
  const tDay=Math.max(1,GS.day+1);
  const estBuy=getDayPrice(GS.location,_chartItem,tDay);
  const estSell=getSellPriceBase(GS.location,_chartItem,tDay);   // v9.6：预计明日卖出走纯物价（走势预测，不含需求档位）
  if(isBuyView){
    // 购入页：同时展示买入价与卖出价变化
    ctx.font='10px sans-serif';
    ctx.fillStyle='#26d98b';ctx.fillRect(W-160,padT,10,3);
    ctx.fillStyle='#ff9f43';ctx.fillRect(W-80,padT,10,3);
    ctx.fillStyle='#8b95a5';
    ctx.fillText('买入价',W-147,padT-2);
    ctx.fillText('卖出价',W-67,padT-2);
    const curBuy=last.price,curSell=last.sell;
    const spreadPct=curBuy?Math.round((1-curSell/curBuy)*100):0;
    const deltaBuy=(estBuy!=null?estBuy-curBuy:0);
    document.getElementById('chart-stats').innerHTML=
      `<span class="stat">买入 <b class="buy">${fmt(curBuy)}</b></span>`+
      `<span class="stat">卖出 <b class="sell">${fmt(curSell)}</b> (${spreadPct}%off)</span>`+
      `<span class="stat">${_chartDays}日买入最低 <b>${fmt(Math.min(...buyPrices))}</b></span>`+
      `<span class="stat">${_chartDays}日买入最高 <b>${fmt(Math.max(...buyPrices))}</b></span>`+
      `<span class="stat" style="${cls}">${trend.label}</span>`+
      `<span class="stat">预计明日买入 <b class="buy">${fmt(estBuy||0)}</b> (${deltaBuy>=0?'+':''}${fmt(deltaBuy)})</span>`;
  }else{
    // 售出页：只展示售价变化（折线/预计基于纯物价；需求档位以独立标签提示成交修正）
    const curSell=last.sell;
    const deltaSell=(estSell!=null?estSell-curSell:0);
    const _ds=(window.DemandEngine&&DemandEngine.getDemandState)?DemandEngine.getDemandState(GS.location,_chartItem,Math.floor(GS.day/CENTRAL_PERIOD)):'normal';
    const _hotPct=Math.round(((window.DemandEngine&&DemandEngine.getHotBonus)?DemandEngine.getHotBonus(GS.location,_chartItem):(DemandEngine.HOT_BONUS||0.15))*100);
    const dsNote=_ds==='hot'?`<span class="stat" style="color:#ff6b35">🔥 热门收购 +${_hotPct}%</span>`
              :_ds==='cool'?`<span class="stat" style="color:#5a8ec9">🧊 需求冷淡 ×${DemandEngine.COOL_MULT||0.6}</span>`
              :_ds==='reject'?`<span class="stat" style="color:var(--red)">🚫 本城拒收</span>`:'';
    document.getElementById('chart-stats').innerHTML=
      `<span class="stat">卖出 <b class="sell">${fmt(curSell)}</b></span>`+
      `<span class="stat">${_chartDays}日最低 <b>${fmt(Math.min(...sellPrices))}</b></span>`+
      `<span class="stat">${_chartDays}日最高 <b>${fmt(Math.max(...sellPrices))}</b></span>`+
      `<span class="stat" style="${cls}">${trend.label}</span>`+
      dsNote+
      `<span class="stat">预计明日卖出 <b class="sell">${fmt(estSell||0)}</b> (${deltaSell>=0?'+':''}${fmt(deltaSell)})</span>`;
  }
  syncMarketHeightToChart();
}

// 以左侧“物价表 + 下方小标签”为唯一高度基准，锁定 .market-body 高度。
// 右侧面板严格按该高度填充，超出部分由各自内部滚动承担（避免出现折线图下方冗余空白）。
let __mh_inited=false;
function syncMarketHeightToChart(){
  const body=document.querySelector('.market-body');
  const chart=document.querySelector('.market-chart .chart-panel');
  if(!body || !chart) return;

  // 使用 requestAnimationFrame，等 canvas 与 stats 更新后再取高度
  requestAnimationFrame(()=>{
    const cs=getComputedStyle(body);
    const pad=(parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0);
    const h=Math.ceil(chart.getBoundingClientRect().height + pad);
    if(h>0) body.style.height=h+'px';
  });

  if(__mh_inited) return;
  __mh_inited=true;
  window.addEventListener('resize', ()=>syncMarketHeightToChart());
}
