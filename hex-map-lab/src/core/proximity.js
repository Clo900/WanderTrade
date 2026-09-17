/* ============================================================
 * core/proximity.js —— 均匀网格空间索引（点到折线最近距离）
 * ------------------------------------------------------------
 * 用途：撒东西时避让。树木要避开道路，水洼要避开河流，装饰簇要避开城市……
 * 这些查询的形状完全一样：给一堆「已有物件的采样点」，问「(x,z) 到最近的
 * 那一个有多远」。这段实现原本私有在 road-builder 里，河流与装饰层也要用，
 * 因此抽到这里，并提供 merge() 把多份索引合成一份（例如「路 + 河」一起避让）。
 * ============================================================ */
(function (HL) {
  'use strict';

  /**
   * @param {Array<{x:number,z:number}>} samples 采样点
   * @param {number} cellSize 网格边长（必须大于查询阈值，否则 3×3 邻域不够）
   */
  function build(samples, cellSize) {
    const buckets = new Map();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const k = Math.floor(s.x / cellSize) + ':' + Math.floor(s.z / cellSize);
      let arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(s);
    }

    return {
      cellSize: cellSize,
      count: samples.length,
      /** (x,z) 到最近采样点的平面距离；没有采样点时返回 Infinity */
      nearestDistance: function (x, z) {
        const cx = Math.floor(x / cellSize);
        const cz = Math.floor(z / cellSize);
        let best = Infinity;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const arr = buckets.get((cx + dx) + ':' + (cz + dz));
            if (!arr) continue;
            for (let i = 0; i < arr.length; i++) {
              const ddx = arr[i].x - x;
              const ddz = arr[i].z - z;
              const d2 = ddx * ddx + ddz * ddz;
              if (d2 < best) best = d2;
            }
          }
        }
        return best === Infinity ? Infinity : Math.sqrt(best);
      }
    };
  }

  /**
   * 把多份索引合成一份：合并采样点后重建网格。
   * 之所以重建而不是逐个查询再取最小值：撒东西是逐点高频调用，
   * 一次遍历胜过 N 次查询，也让调用方只面对「一个避让距离」。
   * @param {Array<object>} indexes 各索引（取其 cellSize 的最小值为新网格边长）
   * @param {Array<Array>} sampleLists 与索引对应的采样点数组
   */
  function merge(indexes, sampleLists) {
    const all = [];
    let cell = Infinity;
    for (let i = 0; i < indexes.length; i++) {
      if (!indexes[i]) continue;
      cell = Math.min(cell, indexes[i].cellSize);
    }
    for (let i = 0; i < sampleLists.length; i++) {
      const list = sampleLists[i];
      if (!list) continue;
      for (let j = 0; j < list.length; j++) all.push(list[j]);
    }
    if (!isFinite(cell)) cell = 32;
    return build(all, cell);
  }

  HL.Proximity = { build: build, merge: merge };
})(window.HexLab = window.HexLab || {});
