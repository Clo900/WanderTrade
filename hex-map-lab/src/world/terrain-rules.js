(function (HL) {
  'use strict';

  const Hex = HL.Hex;
  const Config = HL.Config;

  const DEFAULTS = {
    autoLinkRadius: 2,
    lockedTerrainWins: true,
    riverWetRadius: 0.42,
    riverFloodRadius: 0.92,
    foothillRadius: 1,
    transitionEdgeMin: 1
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function settings() {
    const C = Config.value;
    return Object.assign({}, DEFAULTS, (C.terrain && C.terrain.transitionRules) || {});
  }

  function transitionKey(a, b) {
    return a < b ? (a + '|' + b) : (b + '|' + a);
  }

  function ensureEditor(tile, ruleCfg) {
    if (!tile.editorRule) {
      tile.editorRule = {
        locked: false,
        forcedTerrain: null,
        autoLink: true,
        autoRadius: ruleCfg.autoLinkRadius,
        source: 'worldgen'
      };
    }
    return tile.editorRule;
  }

  function applyForcedTerrain(tile) {
    if (tile && tile.editorRule && tile.editorRule.locked && tile.editorRule.forcedTerrain) {
      tile.terrain = tile.editorRule.forcedTerrain;
    }
  }

  /**
   * 编辑器侧可复用的刷子接口：
   * - 默认会联动邻近 1~2 圈，但不会回写 locked 格
   * - `lock: true` 表示当前格是手动强制覆盖，邻域只能围着它过渡
   * 本实验页暂不真正驱动编辑 UI，但规则先稳定下来，后续编辑器可直接复用。
   */
  function applyEditorBrush(world, edit) {
    const ruleCfg = settings();
    const tile = world.tileAt(edit.q, edit.r);
    if (!tile) return null;

    const centerRule = ensureEditor(tile, ruleCfg);
    if (edit.lock != null) centerRule.locked = !!edit.lock;
    if (edit.terrain) centerRule.forcedTerrain = edit.terrain;
    if (edit.autoLink != null) centerRule.autoLink = !!edit.autoLink;
    if (edit.autoRadius != null) centerRule.autoRadius = Math.max(0, edit.autoRadius | 0);
    centerRule.source = edit.source || 'editor';
    applyForcedTerrain(tile);

    const touched = [tile];
    const radius = centerRule.autoLink ? Math.max(0, centerRule.autoRadius | 0) : 0;
    for (let i = 0; i < world.tileList.length; i++) {
      const other = world.tileList[i];
      if (other === tile) continue;
      const d = Hex.distance(tile, other);
      if (d <= 0 || d > radius) continue;
      const otherRule = ensureEditor(other, ruleCfg);
      if (ruleCfg.lockedTerrainWins && otherRule.locked) continue;
      otherRule.suggestedBy = tile.key;
      otherRule.linkWeight = 1 - (d / (radius + 1));
      touched.push(other);
    }
    return { center: tile, touched: touched };
  }

  function analyze(world, opt) {
    const ruleCfg = settings();
    const rivers = opt && opt.rivers ? opt.rivers : world.rivers;
    const mountainClusters = opt && opt.mountainClusters ? opt.mountainClusters : world.mountainClusters;
    const out = {
      autoLinkRadius: ruleCfg.autoLinkRadius,
      lockedTerrainWins: !!ruleCfg.lockedTerrainWins,
      byTile: Object.create(null),
      applyEditorBrush: function (edit) { return applyEditorBrush(world, edit); }
    };

    for (let i = 0; i < world.tileList.length; i++) {
      const tile = world.tileList[i];
      const editor = ensureEditor(tile, ruleCfg);
      applyForcedTerrain(tile);

      let boundaryEdges = 0;
      let reliefNeighbors = 0;
      let waterNeighbors = 0;
      let transitionMask = 0;
      const neighbors = [];
      const counts = Object.create(null);

      for (let d = 0; d < 6; d++) {
        const n = Hex.neighbor(tile, d);
        const nb = world.tileAt(n.q, n.r);
        if (!nb) continue;
        neighbors.push(nb);
        counts[nb.terrain] = (counts[nb.terrain] || 0) + 1;
        if (nb.terrain !== tile.terrain) {
          boundaryEdges++;
          transitionMask |= (1 << d);
        }
        if (nb.terrain === 'ridge') reliefNeighbors++;
        if (nb.terrain === 'water') waterNeighbors++;
      }

      const riverWetness = rivers ? rivers.wetness(tile.x, tile.z) : 0;
      const riverFlood = rivers ? rivers.floodplain(tile.x, tile.z) : 0;
      const mountainMeta = mountainClusters && mountainClusters.of ? mountainClusters.of(tile) : null;
      const foothill = clamp(
        Math.max(
          mountainMeta ? mountainMeta.foothill : 0,
          reliefNeighbors / 4
        ), 0, 1);

      let dominantTransition = null;
      let dominantCount = 0;
      for (const k in counts) {
        if (k === tile.terrain) continue;
        if (counts[k] > dominantCount) {
          dominantCount = counts[k];
          dominantTransition = transitionKey(tile.terrain, k);
        }
      }

      const semantics = {
        editor: editor,
        boundaryEdges: boundaryEdges,
        transitionMask: transitionMask,
        transitionStrength: boundaryEdges / 6,
        dominantTransition: dominantTransition,
        riverWetness: riverWetness,
        riverFlood: riverFlood,
        foothill: foothill,
        waterAdjacency: waterNeighbors / 6,
        reliefAdjacency: reliefNeighbors / 6,
        autoLinkRadius: editor.autoRadius,
        isTransitionTile: boundaryEdges >= ruleCfg.transitionEdgeMin
      };

      tile.terrainRule = semantics;
      out.byTile[tile.key] = semantics;
    }

    // 内海 / 内湖向外派生支流的候选语义：当前先给规则口，后续编辑器直接复用。
    out.branchCandidates = rivers && rivers.branchCandidates ? rivers.branchCandidates.slice() :
      world.tileList.filter(function (tile) {
        if (tile.terrain !== 'water' || tile.rimWater) return false;
        const sem = tile.terrainRule;
        return sem && sem.waterAdjacency < 0.45 && sem.riverFlood < 0.15;
      }).map(function (tile) {
        return {
          q: tile.q,
          r: tile.r,
          key: tile.key,
          strength: 1 - tile.terrainRule.waterAdjacency
        };
      });

    world.terrainRules = out;
    return out;
  }

  HL.TerrainRules = {
    settings: settings,
    transitionKey: transitionKey,
    analyze: analyze,
    applyEditorBrush: applyEditorBrush
  };
})(window.HexLab = window.HexLab || {});
