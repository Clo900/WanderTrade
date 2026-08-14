/* ================================================
 * 状态容器 (State Container)
 *
 * 响应式状态管理核心，特性：
 *   - 路径级订阅：subscribe('gold', cb) / subscribe('vehicle.durability', cb)
 *   - 批量更新：batch(fn) 内多次修改仅触发一次通知
 *   - 父路径冒泡：订阅 'vehicle' 会收到 'vehicle.durability' 变更
 *   - 通配符订阅：subscribe('*', cb) 监听全部变更
 *   - 完全兼容现有 GS.xxx 读写语法
 *
 * Phase 1 设计原则：
 *   - GS 保持为 Proxy 对象，顶层写入自动触发通知
 *   - 嵌套写入 (GS.vehicle.durability = x) 推荐使用 State.set()
 *   - 现有代码零修改即可运行
 *   - 新代码可立即使用订阅机制实现响应式 UI
 * ================================================ */
(function(global){
  'use strict';

  // ===== 内部存储 =====
  const _state = {};
  let _defaults = {};
  const _listeners = new Map();
  let _batchDepth = 0;
  const _batchDirtyPaths = new Set();
  let _silent = false;   // 初始化/重置期间静默，不触发订阅

  // ===== 路径工具 =====
  function getByPath(obj, path){
    return path.split('.').reduce(function(o,k){return o==null?o:o[k];},obj);
  }

  function setByPath(obj, path, value){
    var keys = path.split('.');
    var cur = obj;
    for(var i=0;i<keys.length-1;i++){
      if(cur[keys[i]]==null) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length-1]] = value;
  }

  function deleteByPath(obj, path){
    var keys = path.split('.');
    var cur = obj;
    for(var i=0;i<keys.length-1;i++){
      if(cur[keys[i]]==null) return;
      cur = cur[keys[i]];
    }
    delete cur[keys[keys.length-1]];
  }

  // ===== 通知派发 =====
  function _dispatch(path){
    var value = getByPath(_state, path);

    // 精确路径
    var exact = _listeners.get(path);
    if(exact) exact.forEach(function(cb){try{cb(value,path);}catch(e){console.error('[State] listener error:',e);}});

    // 父路径冒泡
    var parts = path.split('.');
    for(var i=parts.length-1;i>0;i--){
      var parent = parts.slice(0,i).join('.');
      var pSet = _listeners.get(parent);
      if(pSet){
        var pVal = getByPath(_state, parent);
        pSet.forEach(function(cb){try{cb(pVal,path);}catch(e){console.error('[State] listener error:',e);}});
      }
    }

    // 通配符
    var star = _listeners.get('*');
    if(star) star.forEach(function(cb){try{cb(value,path);}catch(e){console.error('[State] listener error:',e);}});
  }

  function _notify(path){
    if(_silent) return;
    if(_batchDepth>0){
      _batchDirtyPaths.add(path);
      return;
    }
    _dispatch(path);
  }

  function _flushBatch(){
    _batchDirtyPaths.forEach(function(p){_dispatch(p);});
    _batchDirtyPaths.clear();
  }

  // ===== 顶层 Proxy =====
  var gsHandler = {
    get: function(target, prop){
      return target[prop];
    },
    set: function(target, prop, value){
      target[prop] = value;
      _notify(String(prop));
      return true;
    },
    deleteProperty: function(target, prop){
      delete target[prop];
      _notify(String(prop));
      return true;
    }
  };

  var gsProxy = new Proxy(_state, gsHandler);

  // ===== 公共 API =====
  var State = {

    /**
     * 初始化状态（通常在游戏启动时调用一次）
     * @param {Object} defaults - 默认状态对象
     */
    init: function(defaults){
      _silent = true;
      try{
        if(defaults){
          _defaults = JSON.parse(JSON.stringify(defaults));
          Object.keys(defaults).forEach(function(k){
            _state[k] = defaults[k];
          });
        }
      }finally{
        _silent = false;
      }
    },

    /**
     * 获取当前状态的快照（深拷贝）
     */
    snapshot: function(){
      return JSON.parse(JSON.stringify(_state));
    },

    /**
     * 读取指定路径的值
     * @param {string} path - 点分路径，如 'gold' 或 'vehicle.durability'
     */
    get: function(path){
      if(!path) return _state;
      return getByPath(_state, path);
    },

    /**
     * 写入指定路径的值（触发通知）
     * @param {string} path - 点分路径
     * @param {*} value - 新值
     */
    set: function(path, value){
      if(!path){
        console.error('[State.set] path is required');
        return;
      }
      setByPath(_state, path, value);
      _notify(path);
    },

    /**
     * 删除指定路径（触发通知）
     */
    remove: function(path){
      if(!path) return;
      deleteByPath(_state, path);
      _notify(path);
    },

    /**
     * 批量更新：fn 内所有 State.set() 合并为一次通知
     * @param {Function} fn - 批量操作函数
     */
    batch: function(fn){
      _batchDepth++;
      try{ fn(); }
      finally{
        _batchDepth--;
        if(_batchDepth===0) _flushBatch();
      }
    },

    /**
     * 监听指定路径的变更
     * @param {string} path - 监听路径，'*' 表示全部
     * @param {Function} callback - (newValue, changedPath) => void
     * @returns {Function} 取消订阅函数
     */
    subscribe: function(path, callback){
      if(typeof callback!=='function'){
        console.error('[State.subscribe] callback must be a function');
        return function(){};
      }
      if(!_listeners.has(path)) _listeners.set(path, new Set());
      _listeners.get(path).add(callback);
      return function unsubscribe(){
        var set = _listeners.get(path);
        if(set) set.delete(callback);
      };
    },

    /**
     * 取消订阅
     */
    unsubscribe: function(path, callback){
      var set = _listeners.get(path);
      if(!set) return;
      if(!callback){
        _listeners.delete(path);
        return;
      }
      set.delete(callback);
      if(set.size===0) _listeners.delete(path);
    },

    /**
     * 手动触发路径通知（用于非 State.set 的直接赋值场景）
     * @param {string} path - 变更路径
     */
    notify: function(path){
      if(path) _notify(path);
    },

    /**
     * 重置到默认状态（静默，不触发订阅）
     */
    reset: function(){
      _silent = true;
      try{
        Object.keys(_state).forEach(function(k){delete _state[k];});
        if(_defaults){
          Object.keys(_defaults).forEach(function(k){
            _state[k] = JSON.parse(JSON.stringify(_defaults[k]));
          });
        }
      }finally{
        _silent = false;
      }
      _dispatch('*');
    },

    /**
     * 合并补丁到状态（批量）
     * @param {Object} patch - {path: value, ...}
     */
    patch: function(patch){
      State.batch(function(){
        Object.keys(patch).forEach(function(p){
          State.set(p, patch[p]);
        });
      });
    },

    /**
     * 在静默模式下执行代码（不触发任何订阅）
     * @param {Function} fn
     */
    silent: function(fn){
      _silent = true;
      try{ fn(); }
      finally{ _silent = false; }
    }
  };

  // ===== 暴露到全局 =====
  global.State = State;
  global.GS = gsProxy;

})(window);
