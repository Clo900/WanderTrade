/* ============================================================
 * world/terrain-overrides.js —— 稳定 tile-key 地形覆写
 * ------------------------------------------------------------
 * 覆写是确定性世界数据，不与编辑器运行时刷子混用。
 * 输入可使用新的嵌套策划格式，也兼容早期扁平字段。
 * ============================================================ */
(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const MODES = ['auto', 'mountainGorge', 'mountainPass', 'waterfall', 'blocked', 'dryValley'];
  const STYLES = ['auto', 'lonePeak', 'twinPeak', 'massif', 'ridge', 'valleyPeak', 'landmark'];

  function numberOr(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function keyOf(item) {
    if (!item) return null;
    if (typeof item === 'string') return item;
    if (item.key != null) return String(item.key);
    if (item.q != null && item.r != null) return Hex.key(item.q, item.r);
    return null;
  }
  function copy(obj) { return obj && typeof obj === 'object' ? Object.assign({}, obj) : {}; }
  function truthy(v) { return v !== false && v != null; }

  function hashText(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function canonicalValue(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalValue).join(',') + ']';
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + canonicalValue(value[key]);
    }).join(',') + '}';
  }

  function normalizeEntry(raw) {
    if (raw == null) return {};
    if (typeof raw === 'string') return { terrain: raw };
    if (typeof raw === 'boolean') return { blocked: raw };
    const src = copy(raw);
    const mountain = copy(src.mountain);
    const waterway = copy(src.waterway);
    const out = {};

    if (src.terrain != null) out.terrain = String(src.terrain);
    if (src.landform != null) out.landform = String(src.landform);
    if (src.locked != null) out.locked = !!src.locked;
    if (src.blocked != null) out.blocked = src.blocked;
    if (src.mountainGorge != null) out.mountainGorge = src.mountainGorge;
    if (src.mountainPass != null) out.mountainPass = src.mountainPass;
    if (src.dryValley != null) out.dryValley = src.dryValley;
    if (src.waterfall != null) out.waterfall = src.waterfall;

    const style = mountain.style != null ? mountain.style : src.mountainStyle;
    if (STYLES.indexOf(style) >= 0) out.mountain = Object.assign(out.mountain || {}, { style: style });
    const heightScale = mountain.heightScale != null ? mountain.heightScale : src.heightScale;
    if (heightScale != null) out.mountain = Object.assign(out.mountain || {}, {
      heightScale: clamp(numberOr(heightScale, 1), 0, 4)
    });
    ['landmark', 'valley'].forEach(function (field) {
      if (mountain[field] != null) out.mountain = Object.assign(out.mountain || {}, { [field]: mountain[field] });
    });

    let mode = waterway.mode;
    if (mode == null && typeof src.waterway === 'string') mode = src.waterway;
    if (mode == null) {
      if (truthy(src.mountainGorge)) mode = 'mountainGorge';
      else if (truthy(src.mountainPass)) mode = 'mountainPass';
      else if (truthy(src.dryValley)) mode = 'dryValley';
      else if (truthy(src.blocked)) mode = 'blocked';
    }
    if (MODES.indexOf(mode) >= 0) out.waterway = { mode: mode };
    if (waterway.radius != null || waterway.depth != null || waterway.width != null) {
      out.waterway = Object.assign(out.waterway || {}, {
        radius: numberOr(waterway.radius, undefined),
        depth: numberOr(waterway.depth, undefined),
        width: numberOr(waterway.width, undefined)
      });
    }
    return out;
  }

  function mergeEntry(target, raw) {
    const entry = normalizeEntry(raw);
    const out = Object.assign({}, target || {}, entry);
    if (target && target.mountain || entry.mountain) out.mountain = Object.assign({}, target && target.mountain, entry.mountain);
    if (target && target.waterway || entry.waterway) out.waterway = Object.assign({}, target && target.waterway, entry.waterway);
    return out;
  }

  function mergeMap(target, source) {
    if (!source || typeof source !== 'object') return;
    Object.keys(source).forEach(function (key) {
      target[String(key)] = mergeEntry(target[String(key)], source[key]);
    });
  }

  function normalize(source) {
    const src = source || {};
    const byKey = Object.create(null);
    mergeMap(byKey, src.byKey);
    mergeMap(byKey, src.tiles);
    mergeMap(byKey, src.overrides);

    ['mountainGorge', 'mountainPass', 'blocked', 'dryValley', 'waterfall', 'terrain', 'landform'].forEach(function (field) {
      const map = src[field];
      if (!map) return;
      if (Array.isArray(map)) {
        map.forEach(function (item) {
          const key = keyOf(item);
          if (!key) return;
          const value = item && typeof item === 'object' ? item[field] : true;
          byKey[key] = mergeEntry(byKey[key], { [field]: value == null ? true : value });
        });
      } else if (typeof map === 'object') {
        Object.keys(map).forEach(function (key) {
          byKey[key] = mergeEntry(byKey[key], { [field]: map[key] });
        });
      }
    });
    return byKey;
  }

  /**
   * 规则型覆写：按「已生成的地块属性」批量命中，而不是逐格列举 key。
   *
   * 为什么必须有它：山格是**生成结果**，策划说「所有山格设成隘口」时，
   * 显式列举 key 只能靠「先生成一遍拿到山格、再回头覆写」的两遍构建；
   * 而这一类的批量覆写（编辑器的「刷一类地形」）迟早都要，所以做成规则。
   *
   * 输入：`{ rules: [{ match: { terrain: 'ridge' }, set: { waterway: { mode: 'mountainPass' } } }] }`
   * `match` 目前支持 `terrain` / `landform`（字符串或字符串数组）。
   */
  function normalizeRules(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const raw = list[i];
      if (!raw || typeof raw !== 'object') continue;
      const match = copy(raw.match);
      const set = raw.set != null ? raw.set : raw.spec;
      if (set == null) continue;
      if (match.terrain == null && match.landform == null) continue;
      const listOf = function (v) {
        return v == null ? null : (Array.isArray(v) ? v.map(String) : [String(v)]);
      };
      out.push({
        match: { terrain: listOf(match.terrain), landform: listOf(match.landform) },
        entry: normalizeEntry(set)
      });
    }
    return out;
  }

  function build(world, options) {
    const opts = options || {};
    const source = opts.overrides || opts.terrainOverrides || opts;
    const byKey = normalize(source);
    const rules = normalizeRules(source.rules);
    const tiles = world && world.tileList ? world.tileList : [];
    const serial = {};
    Object.keys(byKey).sort().forEach(function (key) { serial[key] = byKey[key]; });
    // 规则也是覆写数据的一部分：不纳入 revision，改规则就不会让山体场 / 河流中心线
    // 的缓存失效（表现为「改了配置、地形没变」）。
    const revision = hashText(canonicalValue({ tiles: serial, rules: rules }));

    const tileByKey = Object.create(null);
    tiles.forEach(function (t) { tileByKey[String(t.key)] = t; });

    /** 命中该地块的所有规则，按声明顺序合并（后面的覆盖前面的） */
    function ruleEntry(tile) {
      let acc = null;
      for (let i = 0; i < rules.length; i++) {
        const m = rules[i].match;
        if (m.terrain && m.terrain.indexOf(String(tile.terrain)) < 0) continue;
        if (m.landform && m.landform.indexOf(String(tile.landform)) < 0) continue;
        acc = acc ? mergeEntry(acc, rules[i].entry) : Object.assign({}, rules[i].entry);
      }
      return acc;
    }

    /** 有效覆写 = 命中的规则合并后，再被显式 tile key 覆盖（显式优先） */
    function effective(tile) {
      const explicit = tile ? byKey[String(tile.key)] : null;
      const fromRule = tile ? ruleEntry(tile) : null;
      if (fromRule && explicit) return mergeEntry(fromRule, explicit);
      return explicit || fromRule || null;
    }

    function of(tileOrKey) {
      if (tileOrKey == null) return null;
      if (typeof tileOrKey === 'string') {
        const tile = tileByKey[tileOrKey];
        return tile ? effective(tile) : (byKey[tileOrKey] || null);
      }
      return effective(tileOrKey);
    }
    function mountain(tileOrKey) { const spec = of(tileOrKey); return spec && spec.mountain || null; }
    function waterway(tileOrKey) { const spec = of(tileOrKey); return spec && spec.waterway || null; }
    function mode(tileOrKey) { const w = waterway(tileOrKey); return w && w.mode || 'auto'; }
    function hasMode(tileOrKey, wanted) { return mode(tileOrKey) === wanted; }
    function isBlocked(tileOrKey) { return hasMode(tileOrKey, 'blocked') || !!(of(tileOrKey) || {}).blocked; }
    function isGorge(tileOrKey) { return hasMode(tileOrKey, 'mountainGorge') || !!(of(tileOrKey) || {}).mountainGorge; }
    function isPass(tileOrKey) { return hasMode(tileOrKey, 'mountainPass') || !!(of(tileOrKey) || {}).mountainPass; }
    function isDryValley(tileOrKey) { return hasMode(tileOrKey, 'dryValley') || !!(of(tileOrKey) || {}).dryValley; }
    function isWaterfall(tileOrKey) { return hasMode(tileOrKey, 'waterfall') || !!(of(tileOrKey) || {}).waterfall; }

    function apply() {
      let applied = 0;
      tiles.forEach(function (tile) {
        const spec = of(tile);
        if (!spec) return;
        if (spec.terrain) tile.terrain = spec.terrain;
        if (spec.landform) tile.landform = spec.landform;
        tile.locked = !!spec.locked;
        tile.blocked = isBlocked(tile);
        tile.mountainGorge = isGorge(tile);
        tile.mountainPass = isPass(tile);
        tile.dryValley = isDryValley(tile);
        tile.waterfall = isWaterfall(tile);
        tile.terrainOverride = spec;
        applied++;
      });
      return applied;
    }

    const api = {
      source: source, byKey: byKey, tiles: tiles, revision: revision, count: Object.keys(byKey).length,
      rules: rules, ruleCount: rules.length, effective: effective,
      modes: MODES.slice(), styles: STYLES.slice(), of: of, mountain: mountain, waterway: waterway, mode: mode,
      has: function (tileOrKey, name) { return !!(of(tileOrKey) || {})[name]; },
      isBlocked: isBlocked, isGorge: isGorge, isPass: isPass, isDryValley: isDryValley, isWaterfall: isWaterfall,
      apply: apply, key: function (q, r) { return Hex.key(q, r); },
      serialize: function () { return JSON.parse(JSON.stringify(serial)); },
      serializeRules: function () { return JSON.parse(JSON.stringify(rules)); }
    };
    if (world) world.terrainOverrides = api;
    return api;
  }

  HL.TerrainOverrides = {
    build: build, normalize: normalize, normalizeRules: normalizeRules,
    styles: STYLES, modes: MODES
  };
})(window.HexLab = window.HexLab || {});
