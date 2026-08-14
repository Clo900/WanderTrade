/* ================================================
 * 事件总线 (EventBus)
 *
 * 轻量级发布/订阅系统，用于连接状态变更与 UI 动画、音效、
 * 通知等副作用模块，实现业务逻辑与表现层解耦。
 *
 * 使用场景：
 *   - State.subscribe('gold', ...) → EventBus.emit('gold-changed', delta)
 *   - UI 模块订阅 'gold-changed' 播放金币动画
 *   - 音效模块订阅 'travel-start' 播放出发音效
 *
 * API:
 *   EventBus.on(event, callback)  订阅事件
 *   EventBus.off(event, callback) 取消订阅
 *   EventBus.emit(event, data)    发布事件
 *   EventBus.once(event, callback) 一次性订阅
 * ================================================ */
(function(global){
  'use strict';

  const _events = new Map();

  function on(event, callback){
    if(typeof callback!=='function')return;
    if(!_events.has(event))_events.set(event, new Set());
    _events.get(event).add(callback);
    return function unsubscribe(){ off(event, callback); };
  }

  function off(event, callback){
    if(!_events.has(event))return;
    if(!callback){_events.delete(event);return;}
    const set = _events.get(event);
    set.delete(callback);
    if(set.size===0)_events.delete(event);
  }

  function emit(event, data){
    if(!_events.has(event))return;
    _events.get(event).forEach(function(cb){
      try{ cb(data); }catch(e){ console.error('[EventBus] error in', event, ':', e); }
    });
  }

  function once(event, callback){
    function wrapper(data){
      off(event, wrapper);
      callback(data);
    }
    on(event, wrapper);
  }

  // ===== 预定义事件常量 =====
  const EVENTS = {
    GOLD_CHANGED:     'gold-changed',
    LOCATION_CHANGED: 'location-changed',
    DAY_CHANGED:      'day-changed',
    TRAVEL_START:     'travel-start',
    TRAVEL_ARRIVE:    'travel-arrive',
    CARGO_CHANGED:    'cargo-changed',
    VEHICLE_REPAIR:   'vehicle-repair',
    ITEM_BOUGHT:      'item-bought',
    ITEM_SOLD:        'item-sold',
    REPUTATION_GAIN:  'reputation-gain',
    ACHIEVEMENT:      'achievement-unlocked',
    TASK_COMPLETE:    'task-complete',
    DAMAGE_TAKEN:     'damage-taken',
    NOTIFICATION:     'notification'
  };

  const EventBus = { on, off, emit, once, EVENTS };
  global.EventBus = EventBus;

})(window);
