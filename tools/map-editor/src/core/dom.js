/* ============================================================
 * core/dom.js —— DOM 基础工具（无业务、无状态）
 * ============================================================ */
(function (E) {
  'use strict';

  E.NS = 'http://www.w3.org/2000/svg';

  /** 按 id 取元素 */
  E.$ = function (id) { return document.getElementById(id); };

  /** 创建 SVG 元素并批量设置属性 */
  E.el = function (tag, attrs) {
    const node = document.createElementNS(E.NS, tag);
    if (attrs) {
      for (const key in attrs) node.setAttribute(key, attrs[key]);
    }
    return node;
  };
})(window.MapEditor = window.MapEditor || {});
