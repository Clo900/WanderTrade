/* ============================================================
 * 引导层（Guide）v9.13.4 — 目标高光框 + 跟随式提示气泡组件
 *
 * 职责（纯表现层，与业务解耦）：
 *   - 目标元素高光框（.tut-target，inset 描边 + 光晕，不暗化页面，玩家可自由操作）
 *   - 引导提示气泡跟随目标元素旁浮动（上/下/左/右自动避让 + 指向箭头）
 *   - 自动滚动定位 + 内容 DOM 变化实时重算（MutationObserver）
 *
 * 不引用 GS / tutorial / 教程步骤数据；调用方负责编排：
 *   Guide.show({
 *     target, title, desc, hintHtml, canSkip, onSkip,
 *     placement,                 // 'auto'(默认) / 'top' / 'bottom' / 'left' / 'right'
 *     actionText, onAction,      // 气泡「下一步」动作按钮
 *     mask: false,               // 无高光模式（仅气泡，如旅行等待提示）
 *     container, onChange        // 观察内容容器 DOM 变化→实时刷新 + 通知编排层
 *   })
 *   Guide.updateText({title,desc,hintHtml}) // 轻量更新文案不重建
 *   Guide.snapshot()            // 返回当前气泡文案快照（供编排层判断是否需要重建）
 *   Guide.hide();  Guide.refresh();  Guide.isActive()
 * ============================================================ */
(function (global) {
  'use strict';

  var Z = 95002; // 低于用户面板遮罩(150000)，高于主界面
  var root = null;
  var state = null; // { target, onSkip, mask, placement, targetEl }
  var _mo = null, _moTimer = null, _moCb = null;

  function onViewportChange() {
    if (state && root && root.style.display !== 'none') refresh();
  }

  function getTargetEl(src) {
    var t = (typeof src === 'function') ? src() : src;
    return (t && t.nodeType === 1) ? t : null;
  }

  function createRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'tut-guide';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:' + Z;
    root.innerHTML =
      '<div class="tut-bubble" id="tut-bubble">' +
        '<div class="tut-bubble-head" id="tut-bubble-head"></div>' +
        '<div class="tut-bubble-desc" id="tut-bubble-desc"></div>' +
        '<div class="tut-bubble-hint" id="tut-bubble-hint"></div>' +
        '<div class="tut-bubble-btns">' +
          '<button class="tut-bubble-action" id="tut-bubble-action" style="display:none"></button>' +
          '<button class="tut-bubble-skip" id="tut-bubble-skip">跳过引导</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    // 捕获阶段监听所有滚动 + 窗口缩放，实时重算高光框与气泡定位
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    return root;
  }

  /** 观察内容容器 DOM 变化（卡片展开/页签切换等会重建节点）→ 防抖后刷新 + 通知编排层 */
  function watchContainer(container, onChange) {
    if (_mo) { _mo.disconnect(); _mo = null; }
    _moCb = onChange;
    if (!container || typeof MutationObserver === 'undefined') return;
    _mo = new MutationObserver(function () {
      if (!state || !root || root.style.display === 'none') return;
      clearTimeout(_moTimer);
      _moTimer = setTimeout(function () {
        refresh();
        if (typeof _moCb === 'function') _moCb();
      }, 80);
    });
    _mo.observe(container, { childList: true, subtree: true });
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** 气泡跟随目标定位：无目标时顶部居中；有目标时按 placement（auto 自动避让）贴近目标旁 */
  function positionBubble() {
    if (!root || !state) return;
    var bubble = root.querySelector('#tut-bubble');
    if (!bubble) return;
    var target = (state.mask === false) ? null : (state.targetEl || getTargetEl(state.target));
    var margin = 14;
    var vw = document.documentElement.clientWidth || window.innerWidth;
    var vh = document.documentElement.clientHeight || window.innerHeight;

    if (!target) {
      bubble.className = 'tut-bubble';
      bubble.style.transform = 'translateX(-50%)';
      bubble.style.maxWidth = Math.min(320, vw - 2 * margin) + 'px';
      bubble.style.left = '50%';
      bubble.style.top = '16px';
      bubble.style.width = 'auto';
      return;
    }

    var r = target.getBoundingClientRect();
    var bw = bubble.offsetWidth || 300;
    var bh = bubble.offsetHeight || 120;
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    var p = state.placement || 'auto';

    if (p === 'auto') {
      var roomBottom = vh - r.bottom - margin;
      var roomTop = r.top - margin;
      var roomRight = vw - r.right - margin;
      var roomLeft = r.left - margin;
      if (roomBottom >= bh) p = 'bottom';
      else if (roomTop >= bh) p = 'top';
      else if (roomRight >= bw) p = 'right';
      else if (roomLeft >= bw) p = 'left';
      else p = 'bottom';
    }

    bubble.className = 'tut-bubble tut-arrow-' + p;
    bubble.style.transform = 'none';
    bubble.style.width = 'auto';
    bubble.style.maxWidth = Math.min(320, vw - 2 * margin) + 'px';

    var x, y;
    if (p === 'top' || p === 'bottom') {
      x = clamp(cx - bw / 2, margin, vw - bw - margin);
      y = (p === 'bottom') ? r.bottom + margin : r.top - bh - margin;
    } else {
      x = (p === 'right') ? r.right + margin : r.left - bw - margin;
      y = clamp(cy - bh / 2, margin, vh - bh - margin);
    }
    bubble.style.left = Math.round(x) + 'px';
    bubble.style.top = Math.round(y) + 'px';
  }

  /** 重算目标高光框（页面不暗化；mask:false 或目标缺失时无高光），并同步气泡定位 */
  function refresh() {
    if (!state || !root) return;
    var target = (state.mask === false) ? null : getTargetEl(state.target);
    // 高光唯一（目标元素在页面内而非 root 内，故从 document 查询）
    var prev = document.querySelector('.tut-target');
    if (prev && prev !== target) prev.classList.remove('tut-target');
    if (target) { target.classList.add('tut-target'); state.targetEl = target; }
    positionBubble();
  }

  function show(opts) {
    var o = opts || {};
    hide(); // 幂等：重复 show 先清理旧引导
    if (!o.desc && !o.target) return null;
    createRoot();
    state = {
      target: o.target,
      onSkip: o.onSkip || null,
      mask: o.mask !== false,
      placement: o.placement || 'auto'
    };
    root.style.display = '';
    root.querySelector('#tut-bubble-head').textContent = o.title || '🎓 新手引导';
    root.querySelector('#tut-bubble-desc').textContent = o.desc || '';
    root.querySelector('#tut-bubble-hint').innerHTML = o.hintHtml || '';
    // 可选动作按钮（如「下一步」）
    var actBtn = root.querySelector('#tut-bubble-action');
    if (o.actionText && typeof o.onAction === 'function') {
      actBtn.style.display = '';
      actBtn.textContent = o.actionText;
      actBtn.onclick = function () { o.onAction(); };
    } else {
      actBtn.style.display = 'none';
      actBtn.onclick = null;
    }
    var skipBtn = root.querySelector('#tut-bubble-skip');
    skipBtn.style.display = o.canSkip === false ? 'none' : '';
    skipBtn.onclick = function () {
      var cb = state ? state.onSkip : null;
      hide();
      if (typeof cb === 'function') cb();
    };
    // 观察内容容器 DOM 变化（实时刷新高光 + 通知编排层同步阶段）
    watchContainer(o.container || document.getElementById('content') || document.body, o.onChange);
    // 滚动定位目标（保证可见），滚动动画期间实时重算
    var target = getTargetEl(o.target);
    if (target && state.mask !== false) {
      try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      catch (e) { try { target.scrollIntoView(true); } catch (e2) {} }
      setTimeout(refresh, 500);
      setTimeout(refresh, 1000);
    }
    refresh();
    return state;
  }

  /** 轻量更新气泡文案（不重建、不重定位，避免等待提示闪烁） */
  function updateText(o) {
    if (!root || !state) return;
    var p = o || {};
    if (p.title != null) root.querySelector('#tut-bubble-head').textContent = p.title;
    if (p.desc != null) root.querySelector('#tut-bubble-desc').textContent = p.desc;
    if (p.hintHtml != null) root.querySelector('#tut-bubble-hint').innerHTML = p.hintHtml;
    positionBubble();
  }

  /** 返回当前气泡文案快照（供编排层判断阶段文案是否变化、是否需要重建） */
  function snapshot() {
    if (!root || !state) return null;
    return {
      title: root.querySelector('#tut-bubble-head').textContent,
      desc: root.querySelector('#tut-bubble-desc').textContent,
      hint: root.querySelector('#tut-bubble-hint').textContent
    };
  }

  function hide() {
    if (!root) return;
    root.style.display = 'none';
    var prev = document.querySelector('.tut-target'); // 目标在页面内，从 document 清理
    if (prev) prev.classList.remove('tut-target');
    if (_mo) { _mo.disconnect(); _mo = null; }
    clearTimeout(_moTimer);
    state = null;
  }

  global.Guide = {
    show: show,
    hide: hide,
    refresh: refresh,
    updateText: updateText,
    snapshot: snapshot,
    isActive: function () { return !!state; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
