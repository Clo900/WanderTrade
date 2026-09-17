(function (HL) {
  'use strict';

  const Config = HL.Config;
  let currentProfile = null;

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function smooth(v) { v = clamp01(v); return v * v * (3 - 2 * v); }

  function mix(a, b, t) { return new THREE.Color(a).lerp(new THREE.Color(b), clamp01(t)).getHex(); }
  function mul(a, s) { return new THREE.Color(a).multiplyScalar(s).getHex(); }
  function lerp(a, b, t) { return a + (b - a) * clamp01(t); }

  function styleColor(style, key) {
    return style && style[key] != null ? style[key] : 0xffffff;
  }

  function keyframeAt(frames, t) {
    const list = frames && frames.length ? frames : [{ t: 0, sun: 0xffffff, intensity: 1, sky: [0xdde8f0, 0xf6eddc] }];
    const tt = ((t % 1) + 1) % 1;
    let a = list[0], b = list[list.length - 1];
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      const next = list[(i + 1) % list.length];
      const t0 = cur.t;
      const t1 = i === list.length - 1 ? next.t + 1 : next.t;
      const sample = i === list.length - 1 && tt < cur.t ? tt + 1 : tt;
      if (sample >= t0 && sample <= t1) {
        a = cur; b = next;
        const span = Math.max(1e-6, t1 - t0);
        return { a: a, b: b, k: (sample - t0) / span };
      }
    }
    return { a: a, b: b, k: 0 };
  }

  function weatherPreset(name) {
    const weather = Config.value.weather || {};
    const presets = weather.presets || {};
    return presets[name] || presets.clear || {
      skyTint: 0xffffff,
      fogTint: 0xffffff,
      sunIntensity: 1,
      ambientBoost: 0,
      cloudColor: 0xffffff,
      shadowOpacity: 0.28,
      wetness: 0,
      desaturate: 0
    };
  }

  function seasonPreset(name) {
    const season = Config.value.season || {};
    return (season.presets && season.presets[name]) || season.presets && season.presets.summer || {
      grassTint: 0xffffff,
      treeTint: 0xffffff,
      fieldTint: 0xffffff,
      rockTint: 0xffffff,
      waterTint: 0xffffff,
      flowerTint: 0xffffff
    };
  }

  function resolve(state) {
    const C = Config.value;
    const P = C.palette;
    const DN = C.dayNight || {};
    const s = state || { timeOfDay: 0.5, season: 'summer', weather: 'clear' };
    const frames = keyframeAt(DN.keyframes, s.timeOfDay == null ? 0.5 : s.timeOfDay);
    const sunColor = mix(frames.a.sun, frames.b.sun, frames.k);
    const skyTop = mix(frames.a.sky[0], frames.b.sky[0], frames.k);
    const skyBottom = mix(frames.a.sky[1], frames.b.sky[1], frames.k);
    const weather = weatherPreset(s.weather);
    const season = seasonPreset(s.season);
    const day = smooth(Math.max(0, Math.sin(((s.timeOfDay == null ? 0.5 : s.timeOfDay) % 1) * Math.PI)));
    const night = 1 - day;
    const dusk = Math.max(
      Math.exp(-Math.pow(((s.timeOfDay == null ? 0.5 : s.timeOfDay) - 0.24) / 0.11, 2)),
      Math.exp(-Math.pow(((s.timeOfDay == null ? 0.5 : s.timeOfDay) - 0.76) / 0.11, 2))
    );
    const wetness = clamp01(weather.wetness == null ? 0 : weather.wetness);
    const desat = clamp01(weather.desaturate == null ? 0 : weather.desaturate);
    const globalDim = lerp(0.58, 1.0, day) * (weather.sunIntensity == null ? 1 : weather.sunIntensity);
    const fogColor = mix(mix(P.fog.color, weather.fogTint || P.fog.color, 0.55), skyBottom, 0.24);

    function role(base, opt) {
      const o = opt || {};
      let col = base;
      if (o.season === 'grass') col = mix(col, season.grassTint, 0.28);
      else if (o.season === 'field') col = mix(col, season.fieldTint, 0.34);
      else if (o.season === 'tree') col = mix(col, season.treeTint, 0.32);
      else if (o.season === 'rock') col = mix(col, season.rockTint, 0.25);
      else if (o.season === 'water') col = mix(col, season.waterTint, 0.24);
      else if (o.season === 'flower') col = mix(col, season.flowerTint, 0.26);
      if (o.weatherTint != null) col = mix(col, o.weatherTint, o.weatherMix == null ? 0.2 : o.weatherMix);
      if (dusk > 0.01 && o.warm !== false) col = mix(col, sunColor, 0.08 * dusk);
      if (night > 0.01 && o.nightCool !== false) col = mix(col, 0x6f88b0, 0.22 * night);
      if (desat > 0 && o.allowDesaturate !== false) col = mix(col, 0x8a9096, desat * 0.18);
      col = mul(col, (o.brightness == null ? 1 : o.brightness) * globalDim + (o.nightLift || 0) * night);
      if (wetness > 0 && o.wetDarken) col = mul(col, 1 - wetness * o.wetDarken);
      return col;
    }

    const scene = {
      sunColor: sunColor,
      sunIntensity: lerp(frames.a.intensity, frames.b.intensity, frames.k) * (weather.sunIntensity == null ? 1 : weather.sunIntensity),
      hemiIntensity: C.lighting.hemi.intensity * lerp(0.72, 1.06, day),
      hemiSky: mix(C.lighting.hemi.sky, skyTop, 0.62),
      hemiGround: role(C.lighting.hemi.ground, { warm: false, nightCool: false, brightness: 0.98, weatherTint: fogColor, weatherMix: 0.12 }),
      ambientColor: mix(C.lighting.ambient.color, fogColor, 0.15),
      ambientIntensity: C.lighting.ambient.intensity + (weather.ambientBoost || 0) + night * 0.08,
      fillColor: mix(C.lighting.fill.color, skyTop, 0.34),
      fillIntensity: C.lighting.fill.intensity + night * 0.12,
      sky: {
        top: mix(skyTop, weather.skyTint || skyTop, 0.4),
        mid: mix(mix(skyTop, skyBottom, 0.5), weather.skyTint || skyTop, 0.25),
        bottom: mix(skyBottom, weather.skyTint || skyBottom, 0.18)
      },
      fogColor: fogColor
    };

    const profile = {
      key: [s.season, s.weather, (s.timeOfDay == null ? 0.5 : s.timeOfDay).toFixed(3)].join('|'),
      state: { timeOfDay: s.timeOfDay, season: s.season, weather: s.weather },
      wetness: wetness,
      dayFactor: day,
      duskFactor: dusk,
      nightFactor: night,
      scene: scene,
      terrain: {
        land: role(P.terrain.grass.color, { season: 'grass', brightness: 1.06 }),
        forest: role(P.terrain.forest.color, { season: 'tree', brightness: 1.02 }),
        field: role(P.terrain.field.color, { season: 'field', brightness: 1.05 }),
        flower: role(P.terrain.flower.color, { season: 'flower', brightness: 1.04 }),
        rock: role(P.terrain.ridge.color, { season: 'rock', brightness: 0.98, wetDarken: 0.08 }),
        water: role(P.terrain.water.color, { season: 'water', brightness: 1.03, warm: false, wetDarken: -0.08 }),
        skirt: role(P.water.deep, { season: 'water', brightness: 0.92, warm: false }),
        board: role(P.board.color, { warm: true, nightCool: false, brightness: 1.0 }),
        boardEdge: role(P.board.edge, { warm: false, brightness: 0.9 })
      },
      mountain: {
        body: role(P.mountain.rockMid, { season: 'rock', brightness: 1.0, wetDarken: 0.08 })
      },
      river: {
        surface: role(P.river.surface, { season: 'water', brightness: 1.06, warm: false, wetDarken: -0.06 }),
        channel: role(P.river.surfaceDeep, { season: 'water', brightness: 0.95, warm: false })
      },
      road: {
        surface: role(P.road.trade.color, { warm: true, brightness: 1.0, wetDarken: 0.16 }),
        detail: role(P.rock.light, { season: 'rock', brightness: 1.03, wetDarken: 0.06 }),
        rail: role(P.house.door, { warm: false, brightness: 1.05 }),
        steel: role(0xd9d3c4, { warm: false, brightness: 1.02 }),
        label: role(P.road.royal.color, { warm: true, brightness: 1.06 })
      },
      city: {
        plinth: role(P.city.stone, { warm: true, brightness: 1.04 }),
        tower: role(P.house.wall, { warm: true, brightness: 1.02 }),
        roof: role(P.city.roof, { warm: true, brightness: 1.0 }),
        glow: role(P.tier.capital.color, { warm: false, brightness: lerp(0.68, 1.0, day), nightLift: 0.35 }),
        glowOpacityMul: lerp(0.86, 1.55, night)
      },
      village: {
        wall: role(P.house.wall, { warm: true, brightness: 1.02 }),
        roof: role(P.house.roofs[0], { warm: true, brightness: 0.98 })
      },
      props: {
        round: role(P.tree.round.mid, { season: 'tree', brightness: 1.02 }),
        autumn: role(P.tree.autumn.mid, { season: 'tree', brightness: 1.0 }),
        pine: role(P.tree.pine.mid, { season: 'tree', brightness: 0.98 }),
        bush: role(P.tree.bush.mid, { season: 'tree', brightness: 1.04 }),
        flower: role(P.flower.petals[0], { season: 'flower', brightness: 1.06 }),
        crop: role(P.crop.line[0], { season: 'field', brightness: 1.03 }),
        rock: role(P.rock.mid, { season: 'rock', brightness: 0.98 }),
        puddle: role(P.river.surface, { season: 'water', brightness: 1.08, warm: false })
      },
      ambience: {
        cloud: role(P.cloud.color, { warm: false, brightness: lerp(0.85, 1.0, day) }),
        shadow: role(C.ambience.cloudShadow.color, { warm: false, brightness: 0.92 }),
        bird: role(P.bird.color, { warm: false, brightness: 0.96 })
      },
      accent: {
        highlightLine: mix(0xfff0c0, sunColor, 0.15 * dusk),
        highlightFill: mix(0xffd166, sunColor, 0.22 * dusk)
      }
    };
    currentProfile = profile;
    return profile;
  }

  function current() { return currentProfile; }

  HL.EnvironmentPalette = {
    resolve: resolve,
    current: current
  };
})(window.HexLab = window.HexLab || {});
