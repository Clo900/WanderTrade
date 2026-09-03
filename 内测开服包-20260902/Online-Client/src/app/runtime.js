/* ============================================================
 * 客户端运行模式（唯一模式判定入口）
 *
 * 判定规则：
 *   1. ?mode=standalone / ?mode=online 显式指定模式；
 *   2. file:// 自动使用单机模式；
 *   3. 其余 HTTP(S) 页面默认使用在线模式。
 *
 * 注意：在线连接失败不会在这里静默改成单机模式。切换模式必须由
 * 玩家显式确认并刷新页面，以免在线档和浏览器本地档混淆。
 * ============================================================ */
(function(global){
  'use strict';

  var params = new URLSearchParams(global.location.search);
  var requested = params.get('mode');

  function detectMode(){
    if(requested === 'standalone') return 'standalone';
    if(requested === 'online') return 'online';
    return global.location.protocol === 'file:' ? 'standalone' : 'online';
  }

  function switchTo(mode){
    if(mode !== 'standalone' && mode !== 'online') return;
    var next = new URL(global.location.href);
    next.searchParams.set('mode', mode);
    global.location.href = next.href;
  }

  var mode = detectMode();
  global.Runtime = Object.freeze({
    mode: mode,
    isStandalone: mode === 'standalone',
    isOnline: mode === 'online',
    switchTo: switchTo
  });

  // UI 只查询能力，不直接推断协议或服务器状态。
  global.Capabilities = Object.freeze({
    remotePersistence: mode === 'online',
    remoteChat: mode === 'online',
    globalRankings: mode === 'online',
    serverAdmin: mode === 'online'
  });
})(window);
