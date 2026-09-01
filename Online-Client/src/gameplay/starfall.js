/* ================================================
 * 星陨城活动（v9.9）
 *
 * 玩法：星陨城是"只进不出"的建设城市。72h 周期 = 建设期 running 24h + 间隙期 intermission 48h，
 *   阶段切换对齐自然日 08:00（以本地 2026-01-01 08:00 为周期基准 EPOCH）。
 *   建设期玩家提交本期所需物资（1 特产 + 3 普通，确定性抽选），特产 100 贡献/件、普通 20 贡献/件，
 *   无金币回报；结束时按排行榜 7 档发放金币+星陨合金（经邮箱投递），进度未满按 进度/目标 折算向下取整。
 *
 * 权威约定：
 *   - 在线：活动状态存服务端 starfall_activity.json；本模块 _net 为缓存（sync 拉取）。
 *     提交走 POST /api/starfall/contribute（服务端校验持有、扣货、记账，返回权威 cargo/serverAt）。
 *     结算与轮转在服务端惰性执行（MaybeStarfallRotate）。
 *   - 单机：活动状态存 GS.sfActivity（随本地档保存）；本模块本地结算，奖励经 Mailbox.localDeliver 投递。
 *
 * 状态结构（与 starfall_activity.json 同构）：
 *   { period, phase, phaseStartedAt, phaseEndsAt, target, required:{special,normal:[3]},
 *     totalProgress, scores:{user:score}, firstOrder:{user:ts}, settled, history:[{period,first,...}] }
 *   firstOrder：该玩家最后一次贡献的时间戳（=达到当前分的时间），同分时先达到者优先。
 *
 * 耦合：依赖全局 GS/State/NET/ONLINE/nowMs/toast/fmt/render/getItem/Mailbox；不修改市场/任务代码，
 *   仅经 renderCity 顶部分支接管星陨城面板。
 * ================================================ */
(function(global){
  'use strict';

  // v9.11.x：确定性逻辑统一走共享核心 StarfallCore（starfall-core.js，浏览器/Node 共用），
  // 消灭"客户端 JS vs 服务端 PS 逐位复刻"的双份实现。本文件只保留 UI/状态/副作用层。
  var Core = global.StarfallCore;

  var GOAL = 200000;
  var CONTRIB = { special: 100, normal: 20, other: 1 }; // v9.9.3：非当期物资 1 贡献/件
  // v9.10.2：周期参数化——默认建设期 24h / 间隙期 48h；在线由服务端 sfConfig 覆盖，单机由 GM cycle 或存档 sfConfig 覆盖
  var RUN_MS = 24 * 3600 * 1000, INTER_MS = 48 * 3600 * 1000, CYCLE_MS = RUN_MS + INTER_MS;
  function applyCycle(runMs, interMs){
    if(runMs > 0 && interMs > 0){
      RUN_MS = Math.floor(runMs);
      INTER_MS = Math.floor(interMs);
      CYCLE_MS = RUN_MS + INTER_MS;
    }
  }
  var HISTORY_KEEP = 7;
  // 奖励梯度（7 档）：maxRank → {gold, alloy}
  // v9.11.14：参与奖（100 名外）合金 0→1——星陨合金为活动独家产出，保证"想升级必须持续玩活动"的稳定供给
  var TIERS = [
    { max: 1, gold: 100000, alloy: 10 },
    { max: 2, gold: 60000, alloy: 7 },
    { max: 3, gold: 40000, alloy: 5 },
    { max: 15, gold: 20000, alloy: 3 },
    { max: 50, gold: 10000, alloy: 2 },
    { max: 100, gold: 5000, alloy: 1 },
    { max: Infinity, gold: 1000, alloy: 1 }
  ];
  // "城市状况"采访文案池（设计文档 5.1；v9.9.3 扩至 12 条，v9.10.1 按建设期/间隙期分池并联动城市背景设定）
  // 建设期：缺粮/铁料/修路/守备/伤兵/木匠/孩童/粮官/盐贩/篝火/星陨矿脉/兽潮/裂谷/号角等边境建设场景
  var LINES_RUNNING = [
    '城墙缺口又让狼群钻进来三回，仓库的粮堆见底了。',
    '铁匠铺还缺三百斤好铁，打出来的都是软刀。',
    '等这条路修通，商队就能直抵王都，再也不必绕行。',
    '昨夜又听见号角，守军轮值加了一班，人心不散。',
    '听说城北要起一座望塔，地基就等这批石料。',
    '外乡人肯送来这些东西，城里老小都记着这份情。',
    '伤兵营的布条快用完了，郎中搓着手直叹气。',
    '木匠连夜赶制攻城车的轮轴，桐油却见底了。',
    '街角的孩子们把木刀挥得虎虎生风，说要学守军打仗。',
    '老粮官说，只要撑过这个月，城外的麦子就熟了。',
    '盐贩子绕道走了，说是北边路上不太平，大家省着点用。',
    '今晚的篝火烧得很旺，守军说这是近来最安稳的一夜。',
    '矿脉里的星陨铁越来越亮，老矿工说陨星怕是要来了。',
    '兽潮退去后满地狼藉，墙角的裂缝又深了几分。',
    '裂谷深处传来闷响，守军说那是地下的石头在翻身。',
    '号角响过三遍，最近的一支商队总算平安进了城。',
    '全城都在传：这期要是建成，大伙就能过个安稳冬。',
    '城头的星陨铁敲得叮当响，工匠说那是给新箭楼做脊梁。'
  ];
  // 间隙期：休整/筹备/等待下一期
  var LINES_INTER = [
    '城里难得安静，粮官终于能睡个整觉了。',
    '工匠们把工具擦得锃亮，就等下一批石料进城。',
    '孩子在废墟边捡到一块星陨铁，说是要当护身符。',
    '守军清点了存粮，说够撑到下一期建设开始。',
    '裂谷边的风停了，大家说这是暴风雨前的宁静。',
    '巡夜的更夫换上了新鞋，说这觉睡得格外踏实。'
  ];
  function linesFor(phase){ return phase === 'running' ? LINES_RUNNING : LINES_INTER; }

  function tierOf(rank){ return Core.tierFor(rank, TIERS); }

  function esc(s){
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ===== 周期状态机（确定性逻辑均在 StarfallCore，此处仅做参数接线） ===== */
  function epoch(){ return Core.epoch(); }

  /* 确定性抽选：每期 1 特产 + 3 普通（池与 data.js ITEMS 同步：cat==='special'/'basic'） */
  function pickGoods(period){ return Core.pickGoods(period, Core.categoriesFromItems(ITEMS)); }

  /* 贡献率：当期特产 100/件、当期普通 20/件、其他物资 1/件（v9.9.3 放开提交范围） */
  function contribRate(itemId, req){ return Core.contribRate(itemId, req, CONTRIB); }

  /* ===== 单机活动状态（存 GS.sfActivity，随本地档保存） ===== */
  function localAct(){
    if(GS.sfActivity && typeof GS.sfActivity !== 'object') GS.sfActivity = null;
    if(GS.sfActivity && GS.sfActivity.sfConfig){ applyCycle(GS.sfActivity.sfConfig.runMs, GS.sfActivity.sfConfig.interMs); } // v9.10.2：单机恢复周期配置
    if(!GS.sfActivity){
      GS.sfActivity = Core.newActivity(nowMs(), {
        runMs: RUN_MS, interMs: INTER_MS, goal: GOAL, ep: Core.epoch(),
        cats: Core.categoriesFromItems(ITEMS)
      });
    }
    return GS.sfActivity;
  }

  /* 单机惰性轮转（阶段推进逻辑在 StarfallCore；running 结束先本地结算投递奖励） */
  function rotateLocal(){
    return Core.rotate(localAct(), nowMs(), {
      runMs: RUN_MS, interMs: INTER_MS, ep: Core.epoch(),
      cats: Core.categoriesFromItems(ITEMS)
    }, settleLocal);
  }

  /* 单机结算：排名（贡献降序，同分先达到者优先）→ 进度折算 → 邮箱投递奖励 → 归档冠军 */
  function settleLocal(act){
    if(act.settled) return;
    act.settled = true;
    var arr = [];
    for(var u in act.scores){ arr.push({ user: u, score: act.scores[u], ts: act.firstOrder[u] || 0 }); }
    arr.sort(function(a, b){ return b.score - a.score || a.ts - b.ts; });
    var ratio = Math.min(1, act.totalProgress / GOAL);
    // v9.13.6：目标未达成（建设度 < 目标）时不发素材与称号（仅金币按比例折算；与在线结算一致）
    // v9.10.4：单机模式放宽为"有贡献即发"——全服目标(20~50人量级)对单机不可达，
    //   改为按进度折算发放合金/称号，避免载具/核心升级被星陨合金锁死（C2）
    var single = !ONLINE;
    var goalMet = single ? ratio > 0 : ratio >= 1;
    for(var i = 0; i < arr.length; i++){
      var t = tierOf(i + 1);
      var gold = Math.floor(t.gold * ratio), alloy = Math.floor(t.alloy * ratio);
      var mats = goalMet && alloy > 0 ? { staralloy: alloy } : {};
      var titleId = null;
      if(goalMet){
        if(i === 0) titleId = 'sf_champion';
        else if(i < 3) titleId = 'sf_top3';
        else if(i < 10) titleId = 'sf_top10';
        else titleId = 'sf_participant';
      }
      var attachments = { gold: gold };
      if(mats && Object.keys(mats).length) attachments.mats = mats;
      if(titleId) attachments.title = titleId;
      Mailbox.localDeliver({
        title: '星陨城第 ' + act.period + ' 期建设奖励',
        from: '边境城建指挥部',
        body: '本期建设圆满结束，感谢你对星陨城的贡献。\n你的排名：第 ' + (i + 1) + ' 名 · 累计贡献 ' + fmt(arr[i].score) +
          ' · 全服建设度 ' + Math.floor(ratio * 100) + '%' + (ratio < 1 ? '（目标未达成，本次仅发放金币奖励）' : ''),
        attachments: attachments
      });
    }
    act.history = act.history || [];
    act.history.unshift({ period: act.period, first: arr.length ? arr[0].user : null, progress: act.totalProgress, target: GOAL });
    if(act.history.length > HISTORY_KEEP) act.history = act.history.slice(0, HISTORY_KEEP);
  }

  /* ===== 在线活动状态（服务端权威，_net 为缓存） ===== */
  var _net = null;
  // v9.10.5：账号切换时清模块态（_net 在线缓存 / _sel 提交草稿 / 周期参数），
  //   防止上一账号的 GM cycle 周期设置、活动缓存、提交草稿泄漏给下一账号（M3）
  function reset(){
    _net = null;
    _sel = {};
    applyCycle(24 * 3600 * 1000, 48 * 3600 * 1000); // 恢复默认：建设期 24h / 间隙期 48h
  }
  function sync(){
    if(!ONLINE) return Promise.resolve();
    var user = localStorage.getItem(AUTH_KEY) || '';
    return NET.get('/api/starfall/activity?user=' + encodeURIComponent(user)).then(function(r){
      if(r && r.ok && r.activity){
        _net = r.activity;
        if(r.activity.sfConfig) applyCycle(r.activity.sfConfig.runMs, r.activity.sfConfig.interMs); // v9.10.2：周期对齐服务端
      }
    });
  }

  function act(){
    if(ONLINE) return _net;
    rotateLocal();
    return localAct();
  }

  // v9.10.1：供地图角标取当前阶段（在线未同步前返回 null，地图不显示角标）
  function phase(){
    if(ONLINE && !_net) return null;
    var a = act();
    return a ? a.phase : null;
  }

  /* ===== 面板渲染 ===== */
  var _lineIdx = 0, _histIdx = 0;

  // v9.10.4：改名 fmtCountdownMs——与 events.js 全局 fmtCountdown(秒) 区分（B5 同名异义）
  function fmtCountdownMs(ms){
    ms = Math.max(0, ms);
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    function p(x){ return (x < 10 ? '0' : '') + x; }
    return p(h) + ':' + p(m) + ':' + p(ss);
  }

  function itemChip(id, qty){
    var it = getItem(id) || { name: id, icon: '📦' };
    return '<span class="sf-item-chip">' + it.icon + ' ' + it.name + (qty != null ? ' ×' + qty : '') + '</span>';
  }

  /* 排行榜 HTML：rows=[{user,score}]，myRank（0=未上榜），myScore */
  function rankHtml(rows, myRank, myScore){
    var html = '<div class="sf-rank">';
    if(!rows.length){
      html += '<div class="sf-rank-empty">暂无贡献记录，第一位建设者虚位以待</div>';
    }else{
      for(var i = 0; i < rows.length; i++){
        var cls = 'sf-rank-row' + (i < 3 ? ' top' + (i + 1) : '');
        html += '<div class="' + cls + '"><span class="sf-rank-no">' + (i + 1) + '</span>' +
          '<span class="sf-rank-user">' + esc(rows[i].user) + '</span>' +
          '<span class="sf-rank-score">' + fmt(rows[i].score) + '</span></div>';
      }
    }
    var me = localStorage.getItem(AUTH_KEY) || '';
    if(myRank > 0){
      html += '<div class="sf-rank-row sf-rank-me"><span class="sf-rank-no">' + myRank + '</span>' +
        '<span class="sf-rank-user">' + esc(me) + '（我）</span>' +
        '<span class="sf-rank-score">' + fmt(myScore) + '</span></div>';
    }else if(myScore > 0){
      html += '<div class="sf-rank-row sf-rank-me"><span class="sf-rank-no">-</span>' +
        '<span class="sf-rank-user">' + esc(me) + '（我）</span>' +
        '<span class="sf-rank-score">' + fmt(myScore) + '</span></div>';
    }
    html += '</div>';
    return html;
  }

  function myRankOf(a){
    var me = localStorage.getItem(AUTH_KEY) || '';
    var arr = [];
    for(var u in a.scores){ arr.push({ user: u, score: a.scores[u], ts: (a.firstOrder || {})[u] || 0 }); }
    arr.sort(function(x, y){ return y.score - x.score || x.ts - y.ts; });
    for(var i = 0; i < arr.length; i++){ if(arr[i].user === me) return { rank: i + 1, score: arr[i].score, rows: arr.slice(0, 10) }; }
    return { rank: 0, score: 0, rows: arr.slice(0, 10) };
  }

  /* ===== 城市状况动态图景（v9.9.4 #3） =====
   * 轻量 SVG + CSS 动画：夜空繁星/月牙/远山为底；
   * 屋舍 4 栋、城墙 5 段、中央城门随建设度逐段成型；
   * 常驻动画：星星闪烁、窗户灯光、吊车摆动、炊烟、施工火星。
   * rest=true：呈现"已建成"的休整夜景（吊车停摆、无施工火星）。 */
  function wallCrenell(x, w){
    var tooth = 13, n = Math.round(w / tooth), s = '';
    for(var i = 0; i < n; i++){
      var tw = Math.min(8, w - i * tooth);
      if(tw <= 0) break;
      s += '<rect x="' + (x + i * tooth) + '" y="157" width="' + tw + '" height="8" fill="#3d4766" stroke="#55618a" stroke-width="1"/>';
    }
    return s;
  }
  function citySceneHtml(pct, rest){
    pct = Math.max(0, Math.min(100, pct));
    var s = '<div class="sf-scene">';
    s += '<svg class="sf-scene-svg" viewBox="0 0 640 230" preserveAspectRatio="xMidYMid meet">';
    s += '<defs><linearGradient id="sfSky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#18213c"/><stop offset="1" stop-color="#2e3b63"/></linearGradient></defs>';
    s += '<rect width="640" height="230" fill="url(#sfSky)"/>';
    // 繁星（闪烁）
    var stars = [[56,42],[132,24],[238,48],[318,28],[402,44],[492,26],[566,52],[96,74],[352,66],[184,58],[448,70],[40,88]];
    for(var i = 0; i < stars.length; i++){
      s += '<circle class="sf-star" cx="' + stars[i][0] + '" cy="' + stars[i][1] + '" r="1.5" style="animation-delay:' + ((i * 0.55) % 3).toFixed(2) + 's"/>';
    }
    // 月牙
    s += '<circle cx="566" cy="46" r="17" fill="#f2e6bd" opacity=".95"/><circle cx="559" cy="41" r="15" fill="#18213c"/>';
    // 远山两层
    s += '<path d="M0 172 L88 118 L158 162 L232 104 L318 166 L392 128 L470 168 L552 116 L640 158 L640 230 L0 230 Z" fill="#243153"/>';
    s += '<path d="M0 186 L118 148 L216 180 L326 138 L448 184 L558 148 L640 184 L640 230 L0 230 Z" fill="#1c2544"/>';
    // 地面
    s += '<rect y="200" width="640" height="30" fill="#171d2e"/>';
    // 屋舍（先画，立于城墙之后；随建设度逐栋落成）
    var houses = [
      { x: 96,  w: 54, h: 50, y: 150, th: 28, on: 0.30 },
      { x: 168, w: 66, h: 60, y: 140, th: 34, on: 0.48 },
      { x: 268, w: 48, h: 44, y: 156, th: 24, on: 0.65 },
      { x: 348, w: 60, h: 54, y: 146, th: 30, on: 0.80 }
    ];
    for(var hh = 0; hh < houses.length; hh++){
      var ho = houses[hh];
      if(!rest && pct < ho.on * 100) continue;
      s += '<g class="sf-house">' +
        '<path d="M' + (ho.x - 5) + ' ' + ho.y + ' L' + (ho.x + ho.w / 2) + ' ' + (ho.y - ho.th) + ' L' + (ho.x + ho.w + 5) + ' ' + ho.y + ' Z" fill="#5b3d2e" stroke="#7a5638" stroke-width="1"/>' +
        '<rect x="' + ho.x + '" y="' + ho.y + '" width="' + ho.w + '" height="' + ho.h + '" fill="#4a3628" stroke="#6b5238" stroke-width="1"/>' +
        '<rect class="sf-win" x="' + (ho.x + ho.w * 0.18) + '" y="' + (ho.y + 6) + '" width="7" height="8" fill="#ffd98a"/>' +
        '<rect class="sf-win" x="' + (ho.x + ho.w * 0.68) + '" y="' + (ho.y + 6) + '" width="7" height="8" fill="#ffd98a" style="animation-delay:' + (hh * 1.1) + 's"/>' +
        '</g>';
    }
    // 城墙 5 段（自左向右逐段合拢）
    var segs = [
      { x: 55,  w: 108, on: 0.12 },
      { x: 175, w: 108, on: 0.28 },
      { x: 295, w: 100, on: 0.45 },
      { x: 470, w: 100, on: 0.62 },
      { x: 580, w: 60,  on: 0.80 }
    ];
    for(var wd = 0; wd < segs.length; wd++){
      var sg = segs[wd];
      if(!rest && pct < sg.on * 100) continue;
      s += '<g class="sf-wallseg"><rect x="' + sg.x + '" y="165" width="' + sg.w + '" height="35" fill="#3d4766" stroke="#55618a" stroke-width="1.5"/>' + wallCrenell(sg.x, sg.w) + '</g>';
    }
    // 中央城门（石拱 + 木门，位于第 3/4 段之间）
    if(rest || pct >= 0.35 * 100){
      s += '<g class="sf-gate">' +
        '<path d="M400 200 L400 152 Q400 138 418 138 L442 138 Q460 138 460 152 L460 200 Z" fill="#31395a" stroke="#55618a" stroke-width="2"/>' +
        '<rect x="420" y="166" width="20" height="34" rx="10" fill="#8a5a33" stroke="#6b4423" stroke-width="1.5"/>' +
        '<circle cx="436" cy="184" r="1.6" fill="#ffd98a"/></g>';
    }
    // 吊车（右侧，建城时摆动；休整时停摆）
    s += '<g class="' + (rest ? 'sf-crane rest' : 'sf-crane') + '">' +
      '<rect x="588" y="82" width="11" height="118" fill="#6a7288"/>' +
      '<rect x="581" y="76" width="25" height="15" rx="3" fill="#3d4766" stroke="#55618a" stroke-width="1.2"/>' +
      '<g class="sf-crane-boom">' +
      '<rect x="430" y="80" width="172" height="7" rx="3" fill="#8a90a5"/>' +
      '<rect x="596" y="75" width="24" height="15" rx="3" fill="#4a5678"/>' +
      '<line x1="470" y1="86" x2="470" y2="132" stroke="#aab3c8" stroke-width="1.5"/>' +
      '<rect x="462" y="132" width="16" height="12" rx="2" fill="#c2a15f"/>' +
      '</g></g>';
    // 施工火星（吊车吊索下方）
    if(!rest){
      for(var pk = 0; pk < 4; pk++){
        s += '<circle class="sf-spark" cx="' + (470 + pk * 26) + '" cy="' + (150 - pk * 8) + '" r="2" style="animation-delay:' + (pk * 0.8) + 's"/>';
      }
    }
    // 屋舍烟囱炊烟（第二栋屋顶）
    if(rest || pct >= 0.48 * 100){
      s += '<rect x="194" y="94" width="8" height="22" fill="#4a3628" stroke="#6b5238" stroke-width="1"/>';
      for(var sm = 0; sm < 3; sm++){
        s += '<circle class="sf-smoke" cx="198" cy="90" r="5" style="animation-delay:' + (sm * 1.2) + 's"/>';
      }
    }
    s += '</svg>';
    // 状态字幕（与建设度联动的旁白）
    var cap = '';
    if(rest) cap = '🌙 城市休整中 · 街灯昏黄，守军轮值如常';
    else if(pct < 20) cap = '⛏ 地基开挖 · 木料石料陆续进城';
    else if(pct < 40) cap = '🧱 城墙筑起 · 工匠昼夜轮班';
    else if(pct < 60) cap = '🏗 箭楼合拢 · 吊车往来不休';
    else if(pct < 80) cap = '🏠 屋舍成排 · 炊烟渐起';
    else if(pct < 100) cap = '🏰 城墙合龙 · 全城灯火通明';
    else cap = '✨ 星陨城雄姿初现 · 外乡人都看在眼里';
    s += '<div class="sf-scene-cap">' + cap + '</div></div>';
    return s;
  }

  /* 建设期面板：左 65% 信息区 + 右 35% 提交区 */
  function renderRunning(a){
    var prog = Math.min(a.totalProgress, GOAL);
    var pct = Math.min(100, a.totalProgress / GOAL * 100);
    var req = a.required || { special: null, normal: [] };
    var mine = myRankOf(a);
    var top10 = ONLINE && Array.isArray(a.top10) ? a.top10 : mine.rows;
    if(ONLINE){ mine.rank = a.myRank || mine.rank; mine.score = a.myScore || 0; }

    var html = '<div class="sf-layout">';
    // 左侧：采访气泡 + 进度条 + 本期物资 + 排行榜
    html += '<div class="sf-left">';
    html += '<div class="sf-head"><span class="sf-title">☄️ 星陨城 · 第 ' + a.period + ' 期建设</span>' +
      '<span class="sf-phase running">建设期 · 剩余 <b id="sf-countdown">' + fmtCountdownMs(a.phaseEndsAt - nowMs()) + '</b></span></div>';
    html += '<div class="sf-bubble-wrap"><span class="sf-bubble-tag">边境居民</span><span class="sf-bubble" id="sf-bubble">' + esc(linesFor('running')[_lineIdx % linesFor('running').length]) + '</span></div>';
    html += '<div class="sf-progress-wrap"><div class="sf-progress-label">建设度 ' + fmt(prog) + ' / ' + fmt(GOAL) +
      (a.totalProgress > GOAL ? '（已超额 ' + fmt(a.totalProgress) + '）' : '') + '</div>' +
      '<div class="sf-progress"><div class="sf-progress-bar" style="width:' + pct.toFixed(1) + '%"></div></div></div>';
    html += '<div class="sf-req"><div class="sf-req-group"><span class="sf-req-tag special">本期特产</span>' +
      (req.special ? itemChip(req.special) : '<span class="sf-req-none">未知</span>') +
      '<span class="sf-req-rate">' + CONTRIB.special + ' 贡献/件</span></div>' +
      '<div class="sf-req-group"><span class="sf-req-tag">本期普通物资</span>';
    for(var i = 0; i < req.normal.length; i++) html += itemChip(req.normal[i]);
    html += '<span class="sf-req-rate">' + CONTRIB.normal + ' 贡献/件</span></div></div>';
    html += '<div class="sf-rank-title">🏆 本期贡献排行榜</div>' + rankHtml(top10, mine.rank, mine.score);
    html += '</div>';

    // 右侧：提交区（物资栏 + 提交面板 + 提交按钮，参照售出面板布局，无金币/税栏）
    html += '<div class="sf-right">';
    html += '<div class="sf-submit-layout">';
    // 物资栏：所有持有物资（v9.9.3 放开范围，非当期物资 1 贡献/件）
    html += '<div class="sf-goods-pane"><div class="sf-pane-title">📦 物资栏 <em>点击选择</em></div><div class="sf-goods-list">';
    var held = Object.keys(GS.cargo || {}).filter(function(g){ return (GS.cargo[g] || 0) > 0; }).sort();
    if(!held.length){
      html += '<div class="sf-pane-empty">暂无持有物资<br>可从其他城市购入后运来</div>';
    }else{
      for(var h = 0; h < held.length; h++){
        var gid = held[h];
        var git = getItem(gid) || { name: gid, icon: '📦' };
        var grate = contribRate(gid, req);
        var gCur = grate > 1;
        html += '<div class="sf-goods-item' + (_sel[gid] ? ' sel' : '') + '" onclick="Starfall.toggleItem(\'' + gid + '\')">' +
          '<span class="sf-g-icon">' + git.icon + '</span>' +
          '<span class="sf-g-name">' + git.name + '</span>' +
          '<span class="sf-g-held">×' + (GS.cargo[gid] || 0) + '</span>' +
          '<span class="sf-g-rate' + (gCur ? ' cur' : '') + '">' + grate + '</span>' +
          '</div>';
      }
    }
    html += '</div></div>';
    // 提交面板：已选物资（数量输入 + 贡献/件 + 移除），底部合计 + 提交按钮
    html += '<div class="sf-draft-pane"><div class="sf-pane-title">🧺 提交面板';
    var selIds = Object.keys(_sel);
    if(selIds.length) html += '<button class="sf-draft-clear" onclick="Starfall.clearDraft()">清空</button>';
    html += '</div><div class="sf-draft-list">';
    if(!selIds.length){
      html += '<div class="sf-pane-empty">← 从左侧选择物资</div>';
    }else{
      for(var s = 0; s < selIds.length; s++){
        var sid = selIds[s];
        var sit = getItem(sid) || { name: sid, icon: '📦' };
        var srate = contribRate(sid, req);
        var shave = (GS.cargo || {})[sid] || 0;
        html += '<div class="sf-draft-row">' +
          '<span class="sf-d-name">' + sit.icon + ' ' + sit.name + '</span>' +
          '<input type="number" class="sf-qty" data-item="' + sid + '" min="0" max="' + shave + '" value="0" oninput="Starfall.updateSum()">' +
          '<span class="sf-d-rate">×' + srate + '</span>' +
          '<button class="sf-d-del" onclick="Starfall.toggleItem(\'' + sid + '\')">✕</button>' +
          '</div>';
      }
    }
    html += '</div>';
    html += '<div class="sf-draft-sum">合计贡献 <b id="sf-sum">0</b></div>';
    html += '<div class="sf-submit-tip">提交只消耗货物，不产生金币。<br>当期物资高贡献，其他物资 1 贡献/件。</div>';
    html += '<button class="sf-submit-btn" onclick="Starfall.submit()">确认提交物资</button>';
    html += '</div></div>';
    // 历史冠军：随时可查看，置于提交面板下方
    html += historyWidget(a);
    html += '</div></div>';
    // 动态图景置于整个面板下方通栏显示，填满提交面板以下的空白
    html += citySceneHtml(pct, false);
    return html;
  }

  /* 历史冠军回顾：随时可查看（建设期/间隙期均置于右侧提交面板下方），下拉 + 左右箭头 */
  function historyWidget(a){
    var hist = a.history || [];
    if(_histIdx >= hist.length) _histIdx = 0;
    var h = hist[_histIdx] || null;
    var s = '<div class="sf-hist-wrap">';
    s += '<div class="sf-rank-title">📜 历史冠军（最近 ' + HISTORY_KEEP + ' 期）</div>';
    if(!h){
      s += '<div class="sf-rank-empty">暂无历史记录，首期冠军等你来拿</div>';
    }else{
      s += '<div class="sf-hist">' +
        '<select class="sf-hist-sel" onchange="Starfall.histSelect(this.value)">';
      for(var hi = 0; hi < hist.length; hi++){
        s += '<option value="' + hi + '"' + (hi === _histIdx ? ' selected' : '') + '>第 ' + hist[hi].period + ' 期</option>';
      }
      s += '</select>' +
        '<button class="sf-hist-nav" onclick="Starfall.histShift(1)">◀</button>' +
        '<span class="sf-hist-cur">第 ' + h.period + ' 期 · 冠军：' + (h.first ? esc(h.first) : '（无人上榜）') + '</span>' +
        '<button class="sf-hist-nav" onclick="Starfall.histShift(-1)">▶</button></div>' +
        '<div class="sf-hist-idx">建设度 ' + fmt(h.progress || 0) + '/' + fmt(h.target || GOAL) + ' · ' + (_histIdx + 1) + ' / ' + hist.length + '</div>';
    }
    s += '</div>';
    return s;
  }

  /* 间隙期面板：倒计时 + 物资未知（历史冠军在右侧提交区下方，随时可查看） */
  function renderIntermission(a){
    var html = '<div class="sf-layout"><div class="sf-left">';
    html += '<div class="sf-head"><span class="sf-title">☄️ 星陨城 · 间隙期</span>' +
      '<span class="sf-phase inter">下一轮开始 <b id="sf-countdown">' + fmtCountdownMs(a.phaseEndsAt - nowMs()) + '</b></span></div>';
    html += '<div class="sf-bubble-wrap"><span class="sf-bubble-tag">边境居民</span><span class="sf-bubble" id="sf-bubble">' + esc(linesFor('intermission')[_lineIdx % linesFor('intermission').length]) + '</span></div>';
    html += '<div class="sf-req"><div class="sf-req-group"><span class="sf-req-tag special">下期特产</span><span class="sf-req-none">未知（开始时公布）</span></div>' +
      '<div class="sf-req-group"><span class="sf-req-tag">下期普通物资</span><span class="sf-req-none">未知（开始时公布）</span></div></div>';
    html += '</div>';
    html += '<div class="sf-right"><div class="sf-submit-title">📦 提交物资</div>' +
      '<div class="sf-submit-none">间隙期不可提交。<br>下一轮开始时公布所需物资。</div>';
    html += historyWidget(a);
    html += '</div></div>';
    // 动态图景置于整个面板下方通栏显示
    html += citySceneHtml(100, true);
    return html;
  }

  function renderPanel(){
    var a = act();
    // v9.9：外层包裹 .station-panel，与任务板/车站/情报所等城市板块结构一致
    if(!a) return '<div class="station-panel"><div class="sf-loading">☄️ 星陨城活动数据加载中…</div></div>';
    return '<div class="station-panel">' + (a.phase === 'running' ? renderRunning(a) : renderIntermission(a)) + '</div>';
  }

  function histShift(d){
    var a = act();
    var n = (a && a.history) ? a.history.length : 0;
    if(!n) return;
    _histIdx = (_histIdx + d + n) % n;
    render();
  }
  /* v9.9.4 #5：历史回顾下拉选择 */
  function histSelect(v){
    var a = act();
    var n = (a && a.history) ? a.history.length : 0;
    if(!n) return;
    v = parseInt(v, 10);
    if(isNaN(v) || v < 0 || v >= n) return;
    _histIdx = v;
    render();
  }

  /* ===== 提交 ===== */
  var _sel = {}; // v9.9.3：提交面板已选物资（gid -> true）
  function toggleItem(gid){
    if(_sel[gid]){ delete _sel[gid]; } else { _sel[gid] = true; }
    render();
  }
  function clearDraft(){ _sel = {}; render(); }
  function updateSum(){
    var a = act();
    var req = (a && a.required) || {};
    var total = 0;
    var rows = document.querySelectorAll('.sf-draft-row');
    for(var i = 0; i < rows.length; i++){
      var inp = rows[i].querySelector('.sf-qty');
      var q = Math.floor(parseFloat(inp.value) || 0);
      if(q > 0) total += q * contribRate(inp.dataset.item, req);
    }
    var el = document.getElementById('sf-sum');
    if(el) el.textContent = fmt(total);
  }

  function submit(){
    var a = act();
    if(!a || a.phase !== 'running') return toast('当前不在建设期，无法提交', 'info');
    var items = [];
    var inputs = document.querySelectorAll('.sf-draft-row .sf-qty');
    for(var i = 0; i < inputs.length; i++){
      var q = Math.floor(parseFloat(inputs[i].value) || 0);
      if(q > 0) items.push({ item: inputs[i].dataset.item, qty: q });
    }
    if(!items.length) return toast('请输入要提交的数量', 'info');
    for(var j = 0; j < items.length; j++){
      var it = getItem(items[j].item);
      if(((GS.cargo || {})[items[j].item] || 0) < items[j].qty)
        return toast('持有不足：' + (it ? it.name : items[j].item), 'err');
    }
    if(ONLINE){
      var user = localStorage.getItem(AUTH_KEY) || '';
      NET.post('/api/starfall/contribute', { user: user, items: items }).then(function(r){
        if(r && r.ok){
          State.set('cargo', r.cargo);
          if(typeof r.serverAt === 'number') GS.__lastServerAt = r.serverAt;
          if(_net){
            _net.totalProgress = r.totalProgress;
            _net.myScore = r.myScore;
            _net.myRank = r.myRank;
            if(Array.isArray(r.top10)) _net.top10 = r.top10;
          }
          _sel = {};
          toast('✅ 物资已提交，贡献 +' + fmt(r.gained || 0), 'ok');
          render();
        }else{
          toast('❌ ' + (r && r.err ? r.err : '提交失败'), 'err');
        }
      });
      return;
    }
    // 单机：本地扣货记账
    var gained = 0, cargo = Object.assign({}, GS.cargo);
    var req = a.required || { special: null, normal: [] };
    for(var k = 0; k < items.length; k++){
      gained += items[k].qty * contribRate(items[k].item, req);
      cargo[items[k].item] -= items[k].qty;
      if(cargo[items[k].item] <= 0) delete cargo[items[k].item];
    }
    State.set('cargo', cargo);
    a.totalProgress += gained;
    var me = localStorage.getItem(AUTH_KEY) || '';
    a.scores[me] = (a.scores[me] || 0) + gained;
    a.firstOrder[me] = nowMs();
    _sel = {};
    toast('✅ 物资已提交，贡献 +' + fmt(gained), 'ok');
    render();
  }

  /* ===== 每秒 tick：倒计时/采访轮播局部刷新 + 惰性轮转 ===== */
  var _lastLineSwap = 0, _lastSync = 0;
  function tick(){
    var now = nowMs();
    if(!ONLINE){
      if(rotateLocal() && GS.location === 'starfall' && currentTab === 'city'){ render(); return; }
    }else if(now - _lastSync > 30000){
      _lastSync = now;
      sync().then(function(){
        if(GS.location === 'starfall' && currentTab === 'city') render();
      });
    }
    if(GS.location !== 'starfall' || currentTab !== 'city') return;
    var a = act();
    if(!a) return;
    var cd = document.getElementById('sf-countdown');
    if(cd) cd.textContent = fmtCountdownMs(a.phaseEndsAt - now);
    if(now - _lastLineSwap > 8000){
      _lastLineSwap = now;
      var ls = linesFor(a.phase); // v9.10.1：文案池按当前阶段取用（建设期/间隙期）
      _lineIdx = (_lineIdx + 1) % ls.length;
      var b = document.getElementById('sf-bubble');
      if(b) b.textContent = ls[_lineIdx];
    }
  }

  /* ===== 内测指令（单机免密，由 runCmd /gm starfall 分支调用） ===== */
  function adminCmd(action, out, opts){
    out = out || function(m){};
    if(ONLINE) return out('❌ 在线模式请走服务端 /api/admin');
    var a = localAct(), now = nowMs();
    function startNext(){
      a.period++;
      a.required = pickGoods(a.period);
      a.totalProgress = 0; a.scores = {}; a.firstOrder = {};
      a.settled = false;
      a.phase = 'running'; a.phaseStartedAt = now; a.phaseEndsAt = now + RUN_MS;
    }
    if(action === 'status'){
      // v9.10：单机查看活动状态快照
      var arr = [];
      for(var u2 in a.scores){ arr.push({ user: u2, score: a.scores[u2] }); }
      arr.sort(function(x, y){ return y.score - x.score; });
      var first = arr.length ? arr[0].user : (a.history && a.history.length ? a.history[0].first : null);
      out('☄️ 星陨城第 ' + a.period + ' 期 · ' + (a.phase === 'running' ? '建设期' : '间隙期') +
        '\n  剩余 ' + fmtCountdownMs(a.phaseEndsAt - now) +
        '\n  建设度 ' + fmt(a.totalProgress) + ' / ' + fmt(GOAL) +
        '\n  本期特产 ' + (a.required ? a.required.special : '?') + ' · 普通 ' + (a.required ? a.required.normal.join('、') : '?') +
        '\n  参与 ' + arr.length + ' 人 · 当前第一 ' + (first || '（暂无）'));
      return;
    }
    if(action === 'start'){
      if(a.phase === 'running') return out('ℹ 已在建设期（第 ' + a.period + ' 期，剩余 ' + fmtCountdownMs(a.phaseEndsAt - now) + '）');
      startNext();
      out('✅ 星陨城第 ' + a.period + ' 期建设已开始（' + Math.round(RUN_MS / 3600000) + 'h），所需物资已重新抽选');
    }else if(action === 'end'){
      if(a.phase !== 'running') return out('ℹ 当前不在建设期');
      settleLocal(a);
      a.phase = 'intermission'; a.phaseStartedAt = now; a.phaseEndsAt = now + INTER_MS;
      out('✅ 本期建设已结束并结算（奖励已投递邮箱），进入 ' + Math.round(INTER_MS / 3600000) + 'h 间隙期');
    }else if(action === 'next'){
      if(a.phase === 'running'){
        settleLocal(a);
        a.phase = 'intermission'; a.phaseStartedAt = now; a.phaseEndsAt = now + INTER_MS;
        out('✅ 已结束本期并结算，进入间隙期（再执行一次 start 可立即开下期）');
      }else{
        startNext();
        out('✅ 已进入第 ' + a.period + ' 期建设（' + Math.round(RUN_MS / 3600000) + 'h）');
      }
    }else if(action === 'cycle'){
      // v9.10.2：单机周期参数化——/gm starfall cycle <建设期小时> <间隙期小时>
      var runH = parseFloat(opts && opts.runH), interH = parseFloat(opts && opts.interH);
      if(!(runH >= 1 && runH <= 168 && interH >= 1 && interH <= 168)){
        return out('❌ 指令有误：cycle 用法 /gm starfall cycle <建设期小时> <间隙期小时>（1~168）');
      }
      applyCycle(runH * 3600 * 1000, interH * 3600 * 1000);
      if(!GS.sfActivity) localAct();
      GS.sfActivity.sfConfig = { runMs: RUN_MS, interMs: INTER_MS };
      out('✅ 活动周期已更新：建设期 ' + runH + 'h / 间隙期 ' + interH + 'h（已开始的周期不回溯，下一阶段切换生效）');
    }else{
      return out('用法：/gm <密码> starfall start|end|next|status|cycle <建设期小时> <间隙期小时>');
    }
    render();
  }

  global.Starfall = {
    GOAL: GOAL,
    CONTRIB: CONTRIB,
    TIERS: TIERS,
    pickGoods: pickGoods,
    contribRate: contribRate,
    renderPanel: renderPanel,
    submit: submit,
    toggleItem: toggleItem,
    clearDraft: clearDraft,
    updateSum: updateSum,
    tick: tick,
    sync: sync,
    reset: reset, // v9.10.5：账号切换时清模块态
    phase: phase, // v9.10.1：地图活动标识取阶段
    histShift: histShift,
    histSelect: histSelect,
    adminCmd: adminCmd,
    _settleLocal: settleLocal // 测试钩子
  };

})(window);
