/* ================================================
 * 交易单校验（DRY）
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
  function validateBuyDraft(draft){
    const city = GS.location;
    const list = itemsOf(draft);
    if(!list.length) return {ok:false, msg:'中转面板为空'};
    let needGold = 0;
    let needCargo = 0;
    for(const it of list){
      const price = getDayPrice(city, it.gid, GS.day);
      if(!price) return {ok:false, msg:'价格数据异常'};
      const stock = getCurStock(city, it.gid);
      if(it.qty > stock) return {ok:false, msg:`${getItem(it.gid).name} 库存不足（${stock}）`};
      needGold += price * it.qty;
      needCargo += it.qty;
    }
    const rate = (window.Tax && Tax.getRate) ? Tax.getRate(getRepLevel(city)) : 0;
    const tax = (window.Tax && Tax.calc) ? Tax.calc(needGold, rate) : 0;
    const total = needGold + tax;
    if(GS.gold < total) return {ok:false, msg:`资金不足（需 ${fmt(total)}）`};
    if(getCargoFree() < needCargo) return {ok:false, msg:`载具容量不足（需 ${needCargo} 格）`};
    return {ok:true, list, subtotal:needGold, taxRate:rate, tax, total};
  }
  function validateSellDraft(draft){
    const city = GS.location;
    const list = itemsOf(draft);
    if(!list.length) return {ok:false, msg:'中转面板为空'};
    for(const it of list){
      const held = GS.cargo[it.gid]||0;
      if(it.qty > held) return {ok:false, msg:`${getItem(it.gid).name} 持有不足（${held}）`};
    }
    return {ok:true, list};
  }
  function sameVisitWarningsSell(list){
    // 汇总同城同次顺价套利警告（60%）
    const warns = [];
    for(const it of list){
      const info = getSameVisitArbitrage(it.gid, it.qty);
      if(info){
        warns.push({
          gid: it.gid,
          name: getItem(it.gid).name,
          sameQty: info.sameQty,
          buy: info.buy,
          sell: info.sPrice,
          unit60: Math.round(info.buy*0.6)
        });
      }
    }
    return warns;
  }

  window.TradeValidate = {
    validateBuyDraft,
    validateSellDraft,
    sameVisitWarningsSell
  };
})();

