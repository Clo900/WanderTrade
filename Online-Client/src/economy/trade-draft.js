/* ================================================
 * 交易单（中转面板 draft）
 * - buy/sell 分离
 * - 任一 draft 非空时，若发生：
 *   - 游戏日变化 / 中枢点变化 / 切城 / 买卖Tab切换
 *   则弹窗提示并清空两个 draft
 * ================================================ */
(function(){
  function emptyDraft(){
    return {cityId:null, day:null, hub:null, items:{}};
  }
  function sanitizeDraft(d){
    if(!d) return false;
    if(!d.items) d.items = {};
    let changed=false;
    const clean={};
    for(const gid of Object.keys(d.items)){
      const q=Math.max(0, parseInt(d.items[gid])||0);
      if(q>0) clean[gid]=q;
      else changed=true;
    }
    if(changed || Object.keys(clean).length!==Object.keys(d.items).length){
      d.items=clean;
      changed=true;
    }
    // 若没有有效条目，把锚点也清空，避免 anyNonEmpty 误判
    if(Object.keys(d.items).length===0 && (d.cityId!=null || d.day!=null || d.hub!=null)){
      d.cityId=null; d.day=null; d.hub=null;
      changed=true;
    }
    return changed;
  }
  function getDraftState(){
    const td = State.get('tradeDraft');
    if(td && td.buy && td.sell){
      const ch1=sanitizeDraft(td.buy);
      const ch2=sanitizeDraft(td.sell);
      if(ch1||ch2) State.set('tradeDraft', td);
      return td;
    }
    const init = {buy: emptyDraft(), sell: emptyDraft()};
    State.set('tradeDraft', init);
    return init;
  }
  function isEmpty(mode){
    const d = getDraftState()[mode];
    if(!d) return true;
    return !d.items || Object.keys(d.items).length===0;
  }
  function anyNonEmpty(){
    return !isEmpty('buy') || !isEmpty('sell');
  }
  function anchorForNow(){
    const cityId = (window.GS && GS.location) ? GS.location : State.get('location');
    const day = (window.GS && GS.day) ? GS.day : State.get('day');
    const hub = (window.TradeGraph && TradeGraph.hub) ? TradeGraph.hub(day) : Math.floor((Math.max(1,day)-1)/12);
    return {cityId, day, hub};
  }
  function ensureAnchor(mode){
    const td = getDraftState();
    const d = td[mode];
    if(!d) return;
    if(!d.items) d.items = {};
    if(Object.keys(d.items).length===0){
      const a = anchorForNow();
      d.cityId = a.cityId; d.day = a.day; d.hub = a.hub;
      State.set('tradeDraft', td);
    }
  }
  function add(mode, gid, qty){
    if(!gid) return;
    const td = getDraftState();
    const d = td[mode];
    if(!d.items) d.items = {};
    if(Object.keys(d.items).length===0) ensureAnchor(mode);
    const q = Math.max(0, parseInt(qty)||0);
    if(q<=0){ delete d.items[gid]; }
    else{ d.items[gid]=q; }
    // 保证不会残留 0/NaN 项导致 anyNonEmpty 误判
    sanitizeDraft(d);
    State.set('tradeDraft', td);
  }
  function remove(mode, gid){
    const td = getDraftState();
    const d = td[mode];
    if(d && d.items){ delete d.items[gid]; }
    sanitizeDraft(d);
    State.set('tradeDraft', td);
  }
  function clearAll(reason){
    State.set('tradeDraft', {buy: emptyDraft(), sell: emptyDraft(), _lastClearReason: reason||''});
  }

  window.TradeDraft = {
    emptyDraft,
    getDraftState,
    anyNonEmpty,
    ensureAnchor,
    add,
    remove,
    clearAll,
    anchorForNow
  };
})();
