/* ================================================
 * 交易单汇总预览（中转面板只展示总额）
 * - 注意：这里只用于“预览/确认页展示”，不写入 State
 * ================================================ */
(function(){
  function itemsOf(draft){
    const items = [];
    if(!draft || !draft.items) return items;
    for(const gid of Object.keys(draft.items)){
      const q = parseInt(draft.items[gid])||0;
      if(q>0) items.push({gid, qty:q});
    }
    return items;
  }

  function previewBuy(draft){
    const city = GS.location;
    const list = itemsOf(draft);
    let subtotal = 0;
    for(const it of list){
      const price = getDayPrice(city, it.gid, GS.day) || 0;
      subtotal += price * it.qty;
    }
    const rate = (window.Tax && Tax.getRate) ? Tax.getRate(getRepLevel(city)) : 0;
    const tax = (window.Tax && Tax.calc) ? Tax.calc(subtotal, rate) : 0;
    return {list, subtotal, taxRate:rate, tax, total: subtotal+tax};
  }

  function previewSell(draft){
    const city = GS.location;
    const list = itemsOf(draft);
    // lotsSnapshot: 深拷贝到可变结构（仅 gid 数组）
    const lots0 = JSON.parse(JSON.stringify(GS.lots||{}));
    let revenue = 0;
    for(const it of list){
      const r = simulateConsumeLots(lots0, city, GS.day, GS.visitStamp||{}, it.gid, it.qty);
      revenue += r.revenue;
    }
    const rate = (window.Tax && Tax.getRate) ? Tax.getRate(getRepLevel(city)) : 0;
    const tax = (window.Tax && Tax.calc) ? Tax.calc(revenue, rate) : 0;
    return {list, revenue, taxRate:rate, tax, net: revenue-tax};
  }

  function simulateConsumeLots(lots, cityId, day, visitStamp, gid, qty){
    const sPrice = getSellPrice(cityId, gid, day) || 0;
    const buy = getDayPrice(cityId, gid, day) || 0;
    // v9.10.5：顺价判定用纯中枢价（与结算侧 consumeLots 同口径，保证预览=结算）；buy 为实际结算价（60% 惩罚基准）
    const pBuy = getBaseBuyPrice(cityId, gid, day);
    const pSell = getBaseSellPrice(cityId, gid, day);
    const arbitrage = pBuy != null && pSell != null && pBuy < pSell;
    const curStamp = visitStamp[cityId];
    let remaining = qty, revenue = 0, sameQty = 0;
    const arr = (lots[gid] || []).map(b=>({city:b.city, qty:b.qty, cost:b.cost, stamp:b.stamp}));
    for(const b of arr){
      if(remaining<=0) break;
      if(b.city===cityId && b.stamp===curStamp){
        const take=Math.min(b.qty,remaining);
        const rate=arbitrage?Math.round(buy*0.6):Math.round(b.cost*0.8);
        revenue+=take*rate; sameQty+=take; b.qty-=take; remaining-=take;
      }
    }
    for(const b of arr){
      if(remaining<=0) break;
      if(b.qty<=0) continue;
      const take=Math.min(b.qty,remaining);
      revenue+=take*sPrice; b.qty-=take; remaining-=take;
    }
    lots[gid] = arr.filter(b=>b.qty>0);
    if(!lots[gid].length) delete lots[gid];
    return {revenue, sameQty, arbitrage};
  }

  window.TradePreview = {
    previewBuy,
    previewSell
  };
})();

