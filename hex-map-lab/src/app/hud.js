/* ============================================================
 * app/hud.js —— HTML 叠加面板
 * ------------------------------------------------------------
 * 3D 只负责地图，信息、开关、图例仍是普通 DOM（对应方案「保留 HTML/CSS，
 * 与 3D 画布叠加」）。图例、地形名称与配色全部从 config 读取，
 * 改配色或加地形时这里不需要改代码。
 *
 * 解耦约定：HUD 只通过 HexLab.Bus 发出用户意图
 *   'ui:toggle' { name, value }   图层 / 视角开关
 *   'ui:action' { name }          一次性命令
 *   'ui:env'    { kind, value }   环境切换（日夜 / 季节 / 天气 / 自动轮播）
 * 自身内容由 main.js 单向推送 setXxx()。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Bus = HL.Bus;
  const Data = HL.Data;
  const Config = HL.Config;
  const RoadStyle = HL.RoadStyle;

  /**
   * 地貌中文名（landform 只有 水 / 平原 / 丘陵；山脉见 terrain）。
   * ⚠ 键必须与世界上产出的值一致：产出是 'plain'（v2.8 起与 config 的
   *   `landformRatios` 键名统一，旧版是产出 plain、表里写 lowland，查不到中文名）。
   */
  const LANDFORM_NAME = { water: '水域', plain: '平原', hill: '丘陵' };

  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function colorCss(hex) {
    return '#' + new THREE.Color(hex).getHexString();
  }

  function swatch(color) {
    return '<span class="swatch" style="background:' + colorCss(color) + '"></span>';
  }

  function pct(v) {
    return (v * 100).toFixed(1) + '%';
  }

  function normTime(t) {
    const v = t == null ? 0.5 : t;
    return ((v % 1) + 1) % 1;
  }

  function timeLabel(t) {
    const v = normTime(t);
    if (v < 0.125 || v >= 0.875) return '夜晚';
    if (v < 0.35) return '清晨';
    if (v < 0.65) return '正午';
    return '黄昏';
  }

  /**
   * @param {{container:HTMLElement, world?:object}} opts
   *        world 用于「道路一览」预览：预览与实际地图共用同一份配方与同一个种子
   */
  function create(opts) {
    const root = opts.container;
    const world = opts.world || null;
    const C = Config.value;
    const P = C.palette;
    root.innerHTML = '';

    // ---------- 头部 ----------
    const header = el('div', 'hud-header');
    header.appendChild(el('div', 'hud-title', '六边形 2.5D 跑商地图 · 实验页'));
    header.appendChild(el('div', 'hud-sub',
      '手绘蜡笔沙盘风：逐地块档位 + 丘陵连绵波 + 独立山体（雪线）+ 沿格边河流（沿程下降）+ 五档道路（铁轨 / 栈桥 / 隧道）+ 生态植被与过渡装饰 + 云影飞鸟'));
    root.appendChild(header);

    // ---------- 世界 ----------
    const worldCard = el('section', 'card');
    worldCard.appendChild(el('h4', null, '世界'));
    const worldBody = el('div', 'kv');
    worldCard.appendChild(worldBody);
    root.appendChild(worldCard);

    // ---------- 视角与图层 ----------
    const viewCard = el('section', 'card');
    viewCard.appendChild(el('h4', null, '视角与图层'));

    const modeRow = el('div', 'btn-row');
    // 默认「低透视」（与 scene.js 的 DEFAULT_MODE 一致）：正交视角靠按钮切换
    const btnPersp = el('button', 'btn is-active', '低透视（主）');
    const btnOrtho = el('button', 'btn', '正射');
    btnOrtho.addEventListener('click', function () {
      btnOrtho.classList.add('is-active');
      btnPersp.classList.remove('is-active');
      Bus.emit('ui:toggle', { name: 'cameraMode', value: 'ortho' });
    });
    btnPersp.addEventListener('click', function () {
      btnPersp.classList.add('is-active');
      btnOrtho.classList.remove('is-active');
      Bus.emit('ui:toggle', { name: 'cameraMode', value: 'perspective' });
    });
    modeRow.appendChild(btnPersp);
    modeRow.appendChild(btnOrtho);
    const btnReset = el('button', 'btn', '重置视角');
    btnReset.addEventListener('click', function () { Bus.emit('ui:action', { name: 'resetView' }); });
    const btnFocus = el('button', 'btn', '定位主城');
    btnFocus.addEventListener('click', function () { Bus.emit('ui:action', { name: 'focusPrimary' }); });
    modeRow.appendChild(btnReset);
    modeRow.appendChild(btnFocus);
    viewCard.appendChild(modeRow);

    const layers = [
      { name: 'showInk', label: '墨线描边', on: true },
      { name: 'showMountains', label: '山体（峰+雪）', on: true },
      // 水面（v2.8）：海 / 河 / 泉已合并成一份几何，只能整片开关；
      // 「河口三角洲」是逐顶点的表现开关（几何仍属于同一份水面）。
      { name: 'showWater', label: '水面（海 / 河 / 湖）', on: true },
      { name: 'showDeltas', label: '河口三角洲', on: true },
      { name: 'showRoads', label: '道路（五档）', on: true },
      { name: 'showRoadLabels', label: '里程标签', on: false },
      { name: 'showProps', label: '植被道具', on: true },
      { name: 'showVillage', label: '村落小屋', on: true },
      { name: 'showCities', label: '城市地标', on: true },
      { name: 'showPlayers', label: '玩家', on: true },
      // 两个氛围层默认都关：整片压在画面上会让画面发雾（v1.6 起云影也默认关）
      { name: 'showCloudShadow', label: '云影（贴地）', on: false },
      { name: 'showClouds', label: '云雾（高空）', on: false },
      { name: 'showBirds', label: '飞鸟', on: true },
      { name: 'showGrid', label: '网格线（调试）', on: false }
    ];
    const layerBox = el('div', 'toggles');
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      const wrap = el('label', 'toggle');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'tg-' + L.name;
      input.checked = L.on;
      input.addEventListener('change', function () {
        Bus.emit('ui:toggle', { name: L.name, value: input.checked });
      });
      wrap.appendChild(input);
      wrap.appendChild(el('span', null, L.label));
      layerBox.appendChild(wrap);
    }
    viewCard.appendChild(layerBox);
    root.appendChild(viewCard);

    // ---------- 山脉重掷（策划用：换一片山看效果）----------
    const reliefCard = el('section', 'card');
    reliefCard.appendChild(el('h4', null, '山脉重掷'));
    const reliefStatus = el('div', 'note', '山脉种子：--');
    reliefCard.appendChild(reliefStatus);
    const reliefRow = el('div', 'btn-row');
    const btnReroll = el('button', 'btn', '重掷山脉');
    btnReroll.type = 'button';
    btnReroll.addEventListener('click', function () { Bus.emit('ui:action', { name: 'rerollMountains' }); });
    const btnReliefReset = el('button', 'btn', '还原默认');
    btnReliefReset.type = 'button';
    btnReliefReset.addEventListener('click', function () { Bus.emit('ui:action', { name: 'resetMountains' }); });
    reliefRow.appendChild(btnReroll);
    reliefRow.appendChild(btnReliefReset);
    reliefCard.appendChild(reliefRow);
    reliefCard.appendChild(el('div', 'hint',
      '只换山脉通道种子：水 / 草 / 田 / 林 / 花的占比不变，山格分布与山体形态改变（河流与道路随之重算）。'));
    root.appendChild(reliefCard);

    // ---------- 环境 ----------
    const envCard = el('section', 'card');
    envCard.appendChild(el('h4', null, '环境'));
    const envStatus = el('div', 'note', '当前：正午 / 夏季 / 晴天');
    envCard.appendChild(envStatus);

    const timePresets = [
      { label: '清晨', value: 0.18 },
      { label: '正午', value: 0.50 },
      { label: '黄昏', value: 0.78 },
      { label: '夜晚', value: 0.96 }
    ];
    const seasonPresets = [
      { label: '春', value: 'spring' },
      { label: '夏', value: 'summer' },
      { label: '秋', value: 'autumn' },
      { label: '冬', value: 'winter' }
    ];
    const weatherPresets = [
      { label: '晴天', value: 'clear' },
      { label: '多云', value: 'cloudy' },
      { label: '雨天', value: 'rain' },
      { label: '雾天', value: 'foggy' }
    ];
    const timeBtns = [];
    const seasonBtns = [];
    const weatherBtns = [];

    function makeEnvRow(title, list, bucket, kind) {
      envCard.appendChild(el('div', 'state-title', title));
      const row = el('div', 'btn-row');
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const btn = el('button', 'btn', item.label);
        btn.type = 'button';
        btn.dataset.value = String(item.value);
        btn.addEventListener('click', function () {
          Bus.emit('ui:env', { kind: kind, value: item.value });
        });
        row.appendChild(btn);
        bucket.push(btn);
      }
      envCard.appendChild(row);
    }

    makeEnvRow('时段', timePresets, timeBtns, 'timeOfDay');
    makeEnvRow('季节', seasonPresets, seasonBtns, 'season');
    makeEnvRow('天气', weatherPresets, weatherBtns, 'weather');

    const autoWrap = el('label', 'toggle');
    const autoInput = document.createElement('input');
    autoInput.type = 'checkbox';
    autoInput.id = 'tg-env-autoCycle';
    autoInput.addEventListener('change', function () {
      Bus.emit('ui:env', { kind: 'autoCycle', value: autoInput.checked });
    });
    autoWrap.appendChild(autoInput);
    autoWrap.appendChild(el('span', null, '自动轮播日夜'));
    envCard.appendChild(autoWrap);
    root.appendChild(envCard);

    // ---------- 选中 ----------
    const selCard = el('section', 'card');
    selCard.appendChild(el('h4', null, '选中'));
    const selBody = el('div', 'kv');
    selBody.innerHTML = '<div class="muted">点击地块或城市查看详情</div>';
    selCard.appendChild(selBody);
    root.appendChild(selCard);

    // ---------- 地图状态（生成比例 / 道路分级 / 生态基底）----------
    const stateCard = el('section', 'card');
    stateCard.appendChild(el('h4', null, '地图状态与生成比例'));
    const stateBody = el('div', 'state');
    stateCard.appendChild(stateBody);
    stateCard.appendChild(el('div', 'note',
      '生成比例来自 <b>config.terrain</b>，改参数即可调整各地形占比；' +
      '磨损与生长的速率在 config 中默认为 0（本期不做演示），改成非 0 即自动开始推演。'));
    root.appendChild(stateCard);

    // ---------- 道路一览（五档对比） ----------
    // 五档的差别不能只靠宽度：默认视角下最宽与最窄只差两三个像素。
    // 这里把「路面材质 + 构件」放大成一张张预览图，且预览与地图共用
    // render/road-style.js 的同一份配方——看到的就是画出来的。
    const roadCard = el('section', 'card');
    roadCard.appendChild(el('h4', null, '道路一览（五档对比）'));
    const roadList = el('div', 'road-list');
    const roadCountEls = Object.create(null);
    const roadPreviewEls = Object.create(null);
    let lastPreviewKey = '';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const PW = 132, PH = 40;
    for (let i = 0; i < C.road.grades.length; i++) {
      const g = C.road.grades[i];
      const item = el('div', 'road-item');
      if (world && HL.RoadStyle) {
        const canvas = RoadStyle.previewCanvas(g, {
          width: Math.round(PW * dpr), height: Math.round(PH * dpr),
          hexSize: world.hexSize, seed: world.seed
        });
        canvas.className = 'road-preview';
        canvas.style.width = PW + 'px';
        canvas.style.height = PH + 'px';
        item.appendChild(canvas);
        roadPreviewEls[g.key] = canvas;
      }
      const meta = el('div', 'road-meta');
      meta.appendChild(el('div', 'road-name',
        swatch(P.road[g.key].color) + g.name +
        ' <span class="muted">' + RoadStyle.distanceLabel(g) + '</span>'));
      meta.appendChild(el('div', 'road-desc muted',
        RoadStyle.describe(g, world ? world.hexSize : 22)));
      item.appendChild(meta);
      const cnt = el('div', 'road-count muted', '—');
      roadCountEls[g.key] = cnt;
      item.appendChild(cnt);
      roadList.appendChild(item);
    }
    roadCard.appendChild(roadList);
    roadCard.appendChild(el('div', 'note',
      '预览与地图同源（render/road-style.js）：御道＝道砟床 + 枕木 + 双钢轨（铁轨），' +
      '官道＝石板 + 路缘石，商道＝夯土 + 车辙，乡道＝碎石 + 散石，小径＝毛边泥路。'));
    root.appendChild(roadCard);

    // ---------- 玩家 ----------
    const playerCard = el('section', 'card');
    playerCard.appendChild(el('h4', null, '玩家（服务器权威状态 + 客户端插值）'));
    const playerBody = el('div', 'players');
    playerCard.appendChild(playerBody);
    root.appendChild(playerCard);

    // ---------- 日志 ----------
    const logCard = el('section', 'card');
    logCard.appendChild(el('h4', null, '广播日志（S_TravelStart / S_TravelArrive）'));
    const logBody = el('div', 'log');
    logCard.appendChild(logBody);
    root.appendChild(logCard);

    // ---------- 图例 ----------
    // 道路分级不在这里重复：上面的「道路一览」已经给出颜色、阈值与构件，
    // 同一份信息只在 HUD 里出现一次。
    const legendCard = el('section', 'card');
    legendCard.appendChild(el('h4', null, '图例'));
    const legendBody = el('div', 'legend');
    let terrainHtml = '';
    for (const key in P.terrain) {
      terrainHtml += '<div class="legend-item">' + swatch(P.terrain[key].color) + P.terrain[key].name + '</div>';
    }
    let tierHtml = '';
    for (const key in P.tier) {
      tierHtml += '<div class="legend-item">' + swatch(P.tier[key].color) + P.tier[key].label + '</div>';
    }
    legendBody.innerHTML =
      '<div class="legend-group">地形</div>' + terrainHtml +
      '<div class="legend-group">城市梯度</div>' + tierHtml;
    legendCard.appendChild(legendBody);
    root.appendChild(legendCard);

    // ---------- 操作 ----------
    const helpCard = el('section', 'card help');
    helpCard.appendChild(el('h4', null, '操作'));
    helpCard.innerHTML +=
      '<ul>' +
      '<li>左键拖拽：旋转视角</li>' +
      '<li>右键 / 中键 / Shift+左键：平移</li>' +
      '<li>滚轮：缩放</li>' +
      '<li>点击地块 / 城市：查看详情并高亮</li>' +
      '</ul>';
    root.appendChild(helpCard);

    // ---------- 页脚（FPS + 网格统计）----------
    // ⚠ 挂到**独立的浮动层**（opts.overlay）而不是 HUD 面板里：
    //   HUD 面板有 backdrop-filter，会给 fixed 后代建立包含块，浮条会被定位到
    //   面板内部（实测 left/top 失效、宽度被挤成一条）。没有宿主时退回面板内。
    const footer = el('div', 'hud-footer');
    const fpsEl = el('span', 'fps', '-- FPS');
    const countEl = el('span', 'count', '');
    footer.appendChild(fpsEl);
    footer.appendChild(countEl);
    (opts.overlay || root).appendChild(footer);

    function redrawRoadPreviews(state) {
      if (!world || !HL.RoadStyle) return;
      const cur = state || { timeOfDay: 0.5, season: 'summer', weather: 'clear' };
      const previewKey = [timeLabel(cur.timeOfDay), cur.season, cur.weather].join('|');
      if (previewKey === lastPreviewKey) return;
      lastPreviewKey = previewKey;
      for (let i = 0; i < C.road.grades.length; i++) {
        const g = C.road.grades[i];
        const prev = roadPreviewEls[g.key];
        if (!prev || !prev.parentNode) continue;
        const canvas = RoadStyle.previewCanvas(g, {
          width: Math.round(PW * dpr), height: Math.round(PH * dpr),
          hexSize: world.hexSize, seed: world.seed
        });
        canvas.className = 'road-preview';
        canvas.style.width = PW + 'px';
        canvas.style.height = PH + 'px';
        prev.parentNode.replaceChild(canvas, prev);
        roadPreviewEls[g.key] = canvas;
      }
    }

    function setActive(btns, predicate) {
      for (let i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('is-active', !!predicate(btns[i]));
      }
    }

    function syncEnvironmentControls(state) {
      const cur = state || { timeOfDay: 0.5, season: 'summer', weather: 'clear', autoCycle: false };
      const tt = normTime(cur.timeOfDay);
      setActive(timeBtns, function (btn) {
        return Math.abs(parseFloat(btn.dataset.value) - tt) < 0.08;
      });
      setActive(seasonBtns, function (btn) { return btn.dataset.value === cur.season; });
      setActive(weatherBtns, function (btn) { return btn.dataset.value === cur.weather; });
      autoInput.checked = !!cur.autoCycle;
      const seasonMap = { spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季' };
      const weatherMap = { clear: '晴天', cloudy: '多云', rain: '雨天', foggy: '雾天' };
      envStatus.textContent = '当前：' + timeLabel(tt) + ' / ' +
        (seasonMap[cur.season] || cur.season) + ' / ' +
        (weatherMap[cur.weather] || cur.weather) +
        (cur.autoCycle ? ' · 自动轮播中' : '');
      redrawRoadPreviews(cur);
    }

    return {
      setWorldInfo: function (info) {
        worldBody.innerHTML =
          '<div><span>地图源</span><b>' + info.source + '</b></div>' +
          '<div><span>worldSchema</span><b>' + info.worldSchema + '</b></div>' +
          '<div><span>地形种子</span><b>' + info.seed + '</b></div>' +
          '<div><span>六边形</span><b>' + info.hexCount + ' 格</b></div>' +
          '<div><span>城市 / 道路</span><b>' + info.cityCount + ' / ' + info.roadCount + '</b></div>' +
          '<div><span>最大高差</span><b>' + info.maxRise + ' 单位</b></div>' +
          '<div><span>描边 / 河口分流</span><b>' + info.inkEdges + ' / ' + info.deltaBands + '</b></div>' +
          '<div><span>蜡笔笔触 / 断笔</span><b>' + info.inkStrokes + ' / ' + info.inkBreaks + '</b></div>' +
          '<div><span>快照版本</span><b>' + info.revision + '</b></div>' +
          '<div><span>配置版本</span><b>' + info.configRevision + '</b></div>';
      },

      setFps: function (fps) { fpsEl.textContent = fps.toFixed(0) + ' FPS'; },
      setCount: function (text) { countEl.textContent = text; },
      setEnvironment: function (state) { syncEnvironmentControls(state); },

      /**
       * 山脉重掷面板。种子号必须显示出来：它是确定性序列（不是 Math.random），
       * 策划看到喜欢的分布时，把这个号记下来就能复现同一个世界。
       */
      setRelief: function (info) {
        if (!info) return;
        const parts = [];
        parts.push('山脉种子：' + info.seed + (info.isDefault ? '（默认）' : ''));
        parts.push('山格 ' + info.ridgeTiles + ' 格 / 山簇 ' + info.clusters + ' 组');
        if (info.roll) parts.push('第 ' + info.roll + ' 次重掷');
        reliefStatus.textContent = parts.join(' · ');
        btnReliefReset.disabled = !!info.isDefault;
      },

      setTile: function (tile, world, state) {
        if (!tile) {
          selBody.innerHTML = '<div class="muted">点击地块或城市查看详情</div>';
          return;
        }
        const style = P.terrain[tile.terrain] || P.terrain.grass;
        const city = tile.cityId ? Data.cityById(tile.cityId) : null;
        let html = '';
        html += '<div><span>轴向坐标</span><b>q=' + tile.q + ', r=' + tile.r + '</b></div>';
        html += '<div><span>地貌</span><b>' + (LANDFORM_NAME[tile.landform] || tile.landform) + '</b></div>';
        html += '<div><span>地形</span><b>' + swatch(style.color) + style.name + '</b></div>';
        // 高度语义（v2.8 阶段二）：**基座**（离散，`surfaceY`，山格恒为 0）
        // 与**逐点实际地表**（连续，`world.heightAt`）是两件事 —— 后者还含丘陵波、
        // 河道走廊与泉湖碗。旧版只有一个 `tile.height`（0/1/2 的标志位）却叫 height。
        html += '<div><span>高度基座</span><b>' + (LANDFORM_NAME[tile.landform] || tile.landform) +
          '（基座 ' + tile.surfaceY.toFixed(1) + ' · 地表 ' +
          world.heightAt(tile.x, tile.z).toFixed(1) + ' 单位）</b></div>';
        if (tile.resource) {
          html += '<div><span>资源</span><b>' + tile.resource.name + ' ×' + tile.resource.amount + '</b></div>';
        }
        if (state) {
          html += '<div><span>植被生长度</span><b>' + (state.growthOf(tile.q, tile.r) * 100).toFixed(0) + '%</b></div>';
        }
        if (city) {
          html += '<div><span>城市</span><b>' + city.name + '（' + (P.tier[city.tier] || {}).label + '）</b></div>';
        }
        if (tile.roadIds.length) {
          const names = tile.roadIds.map(function (id) {
            const rd = HL.Data.SNAPSHOT.roads.filter(function (r) { return r.id === id; })[0];
            return rd ? Config.roadGrade(rd.travelDistance,
              (Data.cityById(rd.from) || {}).tier || 'village',
              (Data.cityById(rd.to) || {}).tier || 'village').name : id;
          });
          html += '<div><span>经过道路</span><b>' + names.join('、') + '</b></div>';
        }
        if (tile.bridgeVia) html += '<div><span>桥</span><b>' + tile.bridgeVia + '</b></div>';
        if (tile.trestleVia) html += '<div><span>栈桥（跨水）</span><b>' + tile.trestleVia + '</b></div>';
        if (tile.tunnelVia) html += '<div><span>隧道（穿山脊）</span><b>' + tile.tunnelVia + '</b></div>';
        if (tile.terrain === 'ridge') {
          html += '<div><span>山脊位置</span><b>' + ((tile.reliefFrac || 0) * 100).toFixed(0) + '%（100 = 峰顶）</b></div>';
        }
        selBody.innerHTML = html;
      },

      setCity: function (cityId) {
        const city = Data.cityById(cityId);
        if (!city) return;
        const tier = P.tier[city.tier] || { label: city.tier, color: 0x999999 };
        const roads = Data.roadsOfCity(cityId);
        let roadHtml = '';
        for (let i = 0; i < roads.length; i++) {
          const rd = roads[i];
          const other = rd.from === cityId ? rd.to : rd.from;
          const otherCity = Data.cityById(other);
          const grade = Config.roadGrade(rd.travelDistance,
            (Data.cityById(rd.from) || {}).tier || 'village',
            (Data.cityById(rd.to) || {}).tier || 'village');
          roadHtml += '<div class="mini">' + grade.name + ' → ' + (otherCity ? otherCity.name : other) +
            '<span class="muted">' + rd.travelDistance + ' 里</span></div>';
        }
        let html = '';
        html += '<div><span>城市</span><b>' + city.name + '</b></div>';
        html += '<div><span>梯度</span><b>' + swatch(tier.color) + tier.label + '</b></div>';
        html += '<div><span>坐标</span><b>' + city.x + ', ' + city.y + '（viewBox）</b></div>';
        html += '<div><span>可售物资</span><b>' + (city.goods.length ? city.goods.length + ' 种' : '无（活动城市）') + '</b></div>';
        html += '<div><span>连接道路</span><b>' + roads.length + ' 条</b></div>';
        html += roadHtml;
        selBody.innerHTML = html;
      },

      /**
       * 地图状态与生成比例
       * @param {{byTerrain:object, targetByTerrain:object, hexCount:number,
       *          gradeCounts:object, gradeMeta:Array, avgRoadCondition:number,
       *          avgGrowth:number, roadCount:number, wearEnabled:boolean,
       *          treeCount:number, tileStats:object}} s
       */
      setMapState: function (s) {
        let html = '<div class="state-block"><div class="state-title">地形占比（目标 / 实际·剔边界）</div>';
        for (const key in P.terrain) {
          const actual = (s.byTerrainInner[key] || 0) / Math.max(1, s.innerCount);
          const target = s.targetByTerrain[key] == null ? 0 : s.targetByTerrain[key];
          html += '<div class="ratio-row"><span>' + swatch(P.terrain[key].color) + P.terrain[key].name +
            '</span><span class="muted">' + pct(target) + ' → ' + pct(actual) +
            '（' + (s.byTerrainInner[key] || 0) + ' 格）</span></div>';
        }
        html += '<div class="ratio-row"><span class="muted">边界格（强制海岸线，另计）</span>' +
          '<span class="muted">' + s.borderCount + ' 格</span></div>';
        html += '</div>';

        html += '<div class="state-block"><div class="state-title">道路分级（' + s.roadCount + ' 条）</div>';
        for (let i = 0; i < s.gradeMeta.length; i++) {
          const g = s.gradeMeta[i];
          html += '<div class="ratio-row"><span>' + swatch(P.road[g.key].color) + g.name +
            '</span><span class="muted">' + (s.gradeCounts[g.key] || 0) + ' 条</span></div>';
        }
        html += '</div>';

        if (s.tileStats) {
          html += '<div class="state-block"><div class="state-title">立体结构（跨水 / 穿山）</div>' +
            '<div class="ratio-row"><span>桥（跨水）</span><span class="muted">' + s.tileStats.bridge + ' 格</span></div>' +
            '<div class="ratio-row"><span>栈桥（跨水）</span><span class="muted">' + s.tileStats.trestle + ' 格</span></div>' +
            '<div class="ratio-row"><span>隧道（穿山脊）</span><span class="muted">' + s.tileStats.tunnel + ' 格</span></div>' +
            '<div class="ratio-row"><span>桥墩 / 栈桥墩</span><span class="muted">' +
            s.structureCounts.bridgePiers + ' / ' + s.structureCounts.trestlePiers + ' 根</span></div>' +
            '<div class="ratio-row"><span>枕木 / 散石</span><span class="muted">' +
            s.structureCounts.ties + ' / ' + s.structureCounts.scatter + ' 个</span></div>' +
            '</div>';
        }

        html += '<div class="state-block"><div class="state-title">生态基底</div>' +
          '<div class="ratio-row"><span>平均植被生长度</span><span class="muted">' + pct(s.avgGrowth) + '</span></div>' +
          '<div class="ratio-row"><span>平均道路状况</span><span class="muted">' + pct(s.avgRoadCondition) + '</span></div>' +
          '<div class="ratio-row"><span>植被道具总数</span><span class="muted">' + s.treeCount + ' 个</span></div>' +
          '<div class="ratio-row"><span>磨损 / 生长推演</span><span class="muted">' +
          (s.wearEnabled ? '已启用' : '未启用（速率 0）') + '</span></div>' +
          '</div>';
        stateBody.innerHTML = html;

        // 道路一览面板里的条数（信息只在 HUD 出现一次，这里只更新数字）
        for (const key in roadCountEls) {
          roadCountEls[key].textContent = (s.gradeCounts[key] || 0) + ' 条';
        }
      },

      setPlayers: function (list) {
        let html = '';
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          html += '<div class="player">' +
            '<div class="player-top">' + swatch(p.color) + '<b>' + p.name + '</b>' +
            '<span class="muted">' + p.location + '</span></div>' +
            '<div class="bar"><i style="width:' + (p.progress * 100).toFixed(0) + '%;background:' + colorCss(p.color) + '"></i></div>' +
            '<div class="player-bottom">' + p.statusText + '<span class="muted">行程 ' + p.tripCount + '</span></div>' +
            '</div>';
        }
        playerBody.innerHTML = html || '<div class="muted">无玩家</div>';
      },

      pushLog: function (text, kind) {
        const line = el('div', 'log-line ' + (kind || ''));
        line.textContent = text;
        logBody.appendChild(line);
        while (logBody.childNodes.length > 40) logBody.removeChild(logBody.firstChild);
        logBody.scrollTop = logBody.scrollHeight;
      }
    };
  }

  HL.Hud = { create: create };
})(window.HexLab = window.HexLab || {});
