/* ============================================================
 * core/event-bus.js —— 极简发布订阅总线
 * ------------------------------------------------------------
 * 用于解耦：渲染层 / 交互层 / 模拟层 / HUD 之间只通过事件通信，
 * 互相不直接持有引用（对应项目 src/core/event-bus.js 的设计思路）。
 * 经典脚本 + IIFE，仅向全局暴露 HexLab 命名空间，无模块系统。
 * ============================================================ */
(function (HL) {
  'use strict';

  /** @type {Object<string, Function[]>} */
  const channels = Object.create(null);

  /**
   * 订阅
   * @param {string} type 事件名
   * @param {Function} fn 回调
   * @returns {Function} 取消订阅函数
   */
  function on(type, fn) {
    (channels[type] || (channels[type] = [])).push(fn);
    return function off() {
      HL.Bus.off(type, fn);
    };
  }

  /** 退订 */
  function off(type, fn) {
    const list = channels[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  /** 发布（回调异常不阻断其他订阅者） */
  function emit(type, payload) {
    const list = channels[type];
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (err) {
        // 单个订阅者出错不应影响其他订阅者
        console.error('[Bus] 订阅回调异常：' + type, err);
      }
    }
  }

  HL.Bus = { on, off, emit };
})(window.HexLab = window.HexLab || {});
