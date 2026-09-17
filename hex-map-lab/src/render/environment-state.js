(function (HL) {
  'use strict';

  const Config = HL.Config;

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function create(opts) {
    const C = Config.value;
    const conf = opts || {};
    const dayNight = C.dayNight || {};
    const season = C.season || {};
    const weather = C.weather || {};
    const defaults = C.environment && C.environment.default || {};

    const state = {
      timeOfDay: clamp01(conf.timeOfDay == null ? (defaults.timeOfDay == null ? 0.5 : defaults.timeOfDay) : conf.timeOfDay),
      season: conf.season || defaults.season || season.current || 'summer',
      weather: conf.weather || defaults.weather || weather.current || 'clear',
      autoCycle: conf.autoCycle == null
        ? (defaults.autoCycle == null ? !!dayNight.enabled : !!defaults.autoCycle)
        : !!conf.autoCycle
    };

    let dirty = true;

    function markDirty() { dirty = true; }

    return {
      current: function () {
        return {
          timeOfDay: state.timeOfDay,
          season: state.season,
          weather: state.weather,
          autoCycle: state.autoCycle
        };
      },
      setTimeOfDay: function (t) {
        const next = clamp01(t);
        if (Math.abs(next - state.timeOfDay) > 1e-6) {
          state.timeOfDay = next;
          markDirty();
        }
      },
      setSeason: function (name) {
        if (name && name !== state.season) {
          state.season = name;
          markDirty();
        }
      },
      setWeather: function (name) {
        if (name && name !== state.weather) {
          state.weather = name;
          markDirty();
        }
      },
      setAutoCycle: function (on) {
        const next = !!on;
        if (next !== state.autoCycle) {
          state.autoCycle = next;
          markDirty();
        }
      },
      tick: function (dt) {
        if (!state.autoCycle || !dayNight.enabled) return false;
        const cycle = Math.max(1, dayNight.cycleSeconds || 300);
        const prev = state.timeOfDay;
        state.timeOfDay = (state.timeOfDay + dt / cycle) % 1;
        dirty = dirty || Math.abs(state.timeOfDay - prev) > 1e-6;
        return dirty;
      },
      consumeDirty: function () {
        const out = dirty;
        dirty = false;
        return out;
      }
    };
  }

  HL.EnvironmentState = {
    create: create
  };
})(window.HexLab = window.HexLab || {});
