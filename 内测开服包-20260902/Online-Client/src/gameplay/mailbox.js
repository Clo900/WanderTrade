/* ================================================
 * 邮箱系统（v9.9）
 *
 * 存储：GS.mailbox = [mail...]，按 ts 升序（新邮件 push 到末尾）
 * 邮件结构：{ id, title, from, body, attachments:{gold,mats}, read, claimed, ts }
 *   - attachments 可为 null；mats 形如 { staralloy: 3 }
 *   - claimed 仅对有附件邮件有意义（true=已领取）
 *
 * 职责：
 *   - 顶栏红点/计数刷新（refreshDot，由 renderTopbar 调用）
 *   - 在线同步（sync：服务端权威覆盖本地缓存）
 *   - 面板渲染与操作：已读/一键已读/删除/删除已读/领取附件
 *   - 投递（localDeliver）：单机结算/GM 本地投递；在线投递在服务端完成
 *   - 满仓自动清理（makeRoom）：最旧"已读且已领取/无附件" → 最旧已读 → 最旧未读
 *
 * 权威约定：
 *   - 在线模式：所有操作 POST /api/mail/<op>，服务端返回权威 mailbox 覆盖本地；
 *     claim 额外返回 gold/materials/serverAt（权威覆盖，沿用 tradeBatch 模式）
 *   - 单机模式：直接改本地 GS.mailbox / GS.gold / GS.materials
 *   - 玩家档上传时 mailbox 被剔除（index.html 四处 delete up.mailbox），
 *     因此服务端投递邮件时不需要 bump __savedAt，不会触发多端冲突误报
 *
 * 耦合：不依赖 Starfall 模块（星陨城结算邮件经 localDeliver 投递）
 * ================================================ */
(function(global){
  'use strict';

  var CAP = 50;

  function box(){
    if(!Array.isArray(GS.mailbox)) GS.mailbox = [];
    return GS.mailbox;
  }

  function hasAtt(m){
    if(!m || !m.attachments) return false;
    var a = m.attachments;
    if((a.gold || 0) > 0) return true;
    if(a.mats){ for(var k in a.mats){ if((a.mats[k] || 0) > 0) return true; } }
    if(a.title) return true; // v9.10.3：称号附件
    return false;
  }
  // 未领取的附件（删除拦截用）
  function hasUnclaimedAtt(m){ return hasAtt(m) && !m.claimed; }

  function unreadCount(){
    var n = 0;
    var b = box();
    for(var i = 0; i < b.length; i++){ if(!b[i].read) n++; }
    return n;
  }

  /* 满仓自动清理：投递前腾出 1 个位置
   * 清理优先级：① 最旧「已读且（已领取或无附件）」 ② 最旧已读 ③ 最旧未读
   * 返回被清理的邮件（无邮件可清时返回 null——理论上不会发生，因为未读也能清） */
  function makeRoom(){
    var b = box();
    if(b.length < CAP) return null;
    var i, idx = -1;
    for(i = 0; i < b.length; i++){ if(b[i].read && !hasUnclaimedAtt(b[i])){ idx = i; break; } }
    if(idx < 0){ for(i = 0; i < b.length; i++){ if(b[i].read){ idx = i; break; } } }
    if(idx < 0) idx = 0; // 最旧未读
    var removed = b.splice(idx, 1)[0];
    return removed;
  }

  /* 本地投递（单机结算 / 单机 GM / 在线 sync 之外的兜底） */
  function localDeliver(mail){
    mail.id = mail.id || ('m' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
    mail.ts = mail.ts || Date.now();
    if(typeof mail.read !== 'boolean') mail.read = false;
    if(typeof mail.claimed !== 'boolean') mail.claimed = false;
    var removed = null;
    if(box().length >= CAP) removed = makeRoom();
    box().push(mail);
    refreshDot();
    if(removed) toast('📮 邮箱已满，已自动清理最旧邮件：《' + removed.title + '》', 'info');
    return mail;
  }

  /* 顶栏红点/计数（renderTopbar 每次重绘后调用） */
  function refreshDot(){
    var dot = document.getElementById('tb-mail-dot');
    var cnt = document.getElementById('tb-mail-count');
    var btn = document.getElementById('tb-mail-btn');
    if(!btn) return; // 顶栏尚未渲染
    var n = unreadCount();
    if(dot) dot.style.display = n > 0 ? '' : 'none';
    if(cnt) cnt.textContent = ' ' + box().length + '/' + CAP;
  }

  /* 在线同步：服务端权威覆盖本地邮箱 */
  function sync(){
    if(!ONLINE) return Promise.resolve();
    var user = localStorage.getItem(AUTH_KEY);
    if(!user) return Promise.resolve();
    return NET.get('/api/mail?user=' + encodeURIComponent(user)).then(function(r){
      if(r && r.ok && Array.isArray(r.mailbox)){
        GS.mailbox = r.mailbox;
        refreshDot();
        // v9.10.4：轮询同步后若邮箱面板已打开则重绘（修复 C6），并广播事件供外部联动
        if(document.getElementById('mailbox-overlay')) renderList();
        if(global.EventBus && global.EventBus.EVENTS && global.EventBus.EVENTS.MAIL_UPDATE) global.EventBus.emit(global.EventBus.EVENTS.MAIL_UPDATE, {});
      }
    });
  }

  /* ===== 面板 ===== */
  var _sel = null; // 当前选中邮件 id

  function close(){
    var ov = document.getElementById('mailbox-overlay');
    if(ov) ov.remove();
    _sel = null;
  }

  function open(){
    close();
    var ov = document.createElement('div');
    ov.id = 'mailbox-overlay';
    ov.className = 'mailbox-overlay';
    ov.innerHTML =
      '<div class="mailbox-panel">' +
        '<div class="mailbox-head">' +
          '<span class="mailbox-title">📮 邮箱</span>' +
          '<span class="mailbox-cap" id="mailbox-cap"></span>' +
          '<button class="mailbox-act" onclick="Mailbox.readAll()">全部已读</button>' +
          '<button class="mailbox-act" onclick="Mailbox.delRead()">删除已读</button>' +
          '<button class="mailbox-close" onclick="Mailbox.close()">✕</button>' +
        '</div>' +
        '<div class="mailbox-body">' +
          '<div class="mailbox-list" id="mailbox-list"></div>' +
          '<div class="mailbox-detail" id="mailbox-detail"></div>' +
        '</div>' +
      '</div>';
    ov.onclick = function(e){ if(e.target === ov) close(); };
    document.body.appendChild(ov);
    renderList();
    renderDetail();
  }

  function fmtTs(ts){
    var d = new Date(ts);
    function p(x){ return (x < 10 ? '0' : '') + x; }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function attText(m){
    if(!hasAtt(m)) return '';
    var a = m.attachments, parts = [];
    if((a.gold || 0) > 0) parts.push('💰' + fmt(a.gold));
    if(a.mats){
      for(var k in a.mats){
        if((a.mats[k] || 0) > 0){
          var mt = getMat(k);
          parts.push(mt.icon + mt.name + '×' + a.mats[k]);
        }
      }
    }
    if(a.title && global.Titles){ // v9.10.3：称号附件
      var tt = Titles.get(a.title);
      parts.push(tt ? ('🎖️' + tt.name) : ('🎖️' + a.title));
    }
    return parts.join(' ');
  }

  function renderList(){
    var el = document.getElementById('mailbox-list');
    if(!el) return;
    var capEl = document.getElementById('mailbox-cap');
    if(capEl) capEl.textContent = box().length + '/' + CAP;
    var b = box().slice().reverse(); // 最新在上
    if(!b.length){
      el.innerHTML = '<div class="mailbox-empty">暂无邮件</div>';
      return;
    }
    var html = '';
    for(var i = 0; i < b.length; i++){
      var m = b[i];
      var cls = 'mail-item' + (m.read ? '' : ' unread') + (_sel === m.id ? ' sel' : '');
      html += '<div class="' + cls + '" onclick="Mailbox.select(\'' + m.id + '\')">' +
        '<div class="mail-item-top"><span class="mail-item-title">' + esc(m.title) + '</span>' +
        '<span class="mail-item-ts">' + fmtTs(m.ts) + '</span></div>' +
        '<div class="mail-item-sub">' + esc(m.from) + (hasAtt(m) ? ' · 📎' : '') + '</div>' +
      '</div>';
    }
    el.innerHTML = html;
  }

  function esc(s){
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function find(id){
    var b = box();
    for(var i = 0; i < b.length; i++){ if(b[i].id === id) return b[i]; }
    return null;
  }

  function select(id){
    _sel = id;
    var m = find(id);
    if(m && !m.read) markRead(id); // 选中即已读
    renderList();
    renderDetail();
  }

  function renderDetail(){
    var el = document.getElementById('mailbox-detail');
    if(!el) return;
    var m = _sel ? find(_sel) : null;
    if(!m){
      el.innerHTML = '<div class="mailbox-empty">← 选择一封邮件查看</div>';
      return;
    }
    var att = attText(m);
    var html =
      '<div class="mail-detail-title">' + esc(m.title) + '</div>' +
      '<div class="mail-detail-meta">发件人：' + esc(m.from) + ' · ' + fmtTs(m.ts) + '</div>' +
      '<div class="mail-detail-body">' + esc(m.body).replace(/\n/g, '<br>') + '</div>';
    if(att){
      html += '<div class="mail-detail-att">📎 附件：' + esc(att) + '</div>';
      if(m.claimed){
        html += '<div class="mail-detail-claimed">✅ 附件已领取</div>';
      }else{
        html += '<button class="btn-ok mail-claim-btn" onclick="Mailbox.claim(\'' + m.id + '\')">领取附件</button>';
      }
    }
    if(!hasUnclaimedAtt(m)){
      html += '<button class="btn-cancel mail-del-btn" onclick="Mailbox.del(\'' + m.id + '\')">删除邮件</button>';
    }else{
      html += '<div class="mail-detail-tip">附件未领取，不可删除</div>';
    }
    el.innerHTML = html;
  }

  /* ===== 操作（在线走服务端权威，单机改本地） ===== */

  function afterOp(r){
    // 在线操作统一回包处理：服务端返回权威 mailbox
    if(r && r.ok && Array.isArray(r.mailbox)){
      GS.mailbox = r.mailbox;
      if(typeof r.gold === 'number') State.set('gold', r.gold);
      if(r.materials) State.set('materials', r.materials);
      refreshDot();
      renderList();
      renderDetail();
      return true;
    }
    return false;
  }

  function opOnline(op, body){
    var user = localStorage.getItem(AUTH_KEY);
    body = body || {};
    body.user = user;
    return NET.post('/api/mail/' + op, body).then(function(r){
      if(!afterOp(r)) toast('❌ ' + (r && r.err ? r.err : '操作失败'), 'err');
    });
  }

  function markRead(id){
    var m = find(id);
    if(!m || m.read) return;
    if(ONLINE){ opOnline('read', { id: id }); }
    else{ m.read = true; refreshDot(); renderList(); }
  }

  function readAll(){
    if(!box().length) return;
    if(ONLINE){ opOnline('readAll', {}); }
    else{
      var b = box();
      for(var i = 0; i < b.length; i++) b[i].read = true;
      refreshDot(); renderList(); renderDetail();
      toast('✅ 全部标记为已读', 'ok');
    }
  }

  function del(id){
    var m = find(id);
    if(!m) return;
    if(hasUnclaimedAtt(m)){ toast('附件未领取，不可删除', 'err'); return; }
    if(ONLINE){ opOnline('delete', { id: id }); }
    else{
      var b = box();
      var idx = b.indexOf(m);
      if(idx >= 0) b.splice(idx, 1);
      if(_sel === id) _sel = null;
      refreshDot(); renderList(); renderDetail();
    }
  }

  function delRead(){
    var b = box();
    var removable = false;
    for(var i = 0; i < b.length; i++){
      if(b[i].read && !hasUnclaimedAtt(b[i])){ removable = true; break; }
    }
    if(!removable){ toast('没有可删除的已读邮件', 'info'); return; }
    if(ONLINE){ opOnline('deleteRead', {}); }
    else{
      var kept = [];
      for(var j = 0; j < b.length; j++){
        var m = b[j];
        if(m.read && !hasUnclaimedAtt(m)){ if(_sel === m.id) _sel = null; continue; }
        kept.push(m);
      }
      GS.mailbox = kept;
      refreshDot(); renderList(); renderDetail();
      toast('🗑 已删除全部已读邮件', 'ok');
    }
  }

  function claim(id){
    var m = find(id);
    if(!m || !hasAtt(m) || m.claimed) return;
    if(ONLINE){
      var user = localStorage.getItem(AUTH_KEY);
      NET.post('/api/mail/claim', { user: user, id: id }).then(function(r){
        if(afterOp(r)){
          if(r.title && global.Titles) Titles.unlock(r.title); // v9.10.3：称号附件（服务端回包）
          toast('✅ 附件已领取：' + attText(m), 'ok');
          render();
        }else{
          toast('❌ ' + (r && r.err ? r.err : '领取失败'), 'err');
        }
      });
      return;
    }
    // 单机：本地领取
    var a = m.attachments;
    if((a.gold || 0) > 0) State.set('gold', GS.gold + a.gold);
    if(a.mats){
      var mats = Object.assign({}, GS.materials);
      for(var k in a.mats){ mats[k] = (mats[k] || 0) + (a.mats[k] || 0); }
      State.set('materials', mats);
    }
    if(a.title && global.Titles) Titles.unlock(a.title); // v9.10.3：称号附件（单机）
    m.claimed = true;
    toast('✅ 附件已领取：' + attText(m), 'ok');
    refreshDot(); renderDetail();
    render();
  }

  global.Mailbox = {
    CAP: CAP,
    box: box,
    hasAtt: hasAtt,
    hasUnclaimedAtt: hasUnclaimedAtt,
    unreadCount: unreadCount,
    makeRoom: makeRoom,
    localDeliver: localDeliver,
    refreshDot: refreshDot,
    sync: sync,
    open: open,
    close: close,
    select: select,
    readAll: readAll,
    del: del,
    delRead: delRead,
    claim: claim
  };

  // v9.11.x：定期同步服务端邮箱（GM 发邮件 / 星陨城结算后玩家无需刷新即可看到；
  //   单机模式 ONLINE=false 时 sync 内部直接返回，无副作用）
  // v9.10.4：改用裸 ONLINE（var 声明已挂 window；此前 window.ONLINE 恒 undefined 导致轮询永不触发——B1）
  setInterval(function(){
    if(ONLINE && localStorage.getItem(AUTH_KEY)) sync();
  }, 60000);

})(window);
