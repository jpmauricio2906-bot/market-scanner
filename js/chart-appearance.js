(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarketChartAppearance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const STORAGE_KEY = 'marketScanner.chartAppearance.v1';
  const WIDTHS = new Set([1, 1.5, 2, 3, 4]);
  const DASHES = Object.freeze({
    solid: { lineStyle: 0, borderDash: [] },
    dashed: { lineStyle: 2, borderDash: [6, 4] },
    dotted: { lineStyle: 1, borderDash: [2, 3] },
    'long-dashed': { lineStyle: 3, borderDash: [10, 5] },
    'sparse-dotted': { lineStyle: 4, borderDash: [2, 7] }
  });
  const DEFAULT_STYLE = Object.freeze({ color: '#3b82f6', width: 2, dash: 'solid' });
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const validKey = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
    && value !== 'prototype' && !own(Object.prototype, value);

  function validStyle(value) {
    const style = {};
    if (!record(value)) return style;
    if (own(value, 'color') && validColor(value.color)) style.color = value.color;
    if (own(value, 'width') && WIDTHS.has(value.width)) style.width = value.width;
    if (own(value, 'dash') && typeof value.dash === 'string' && own(DASHES, value.dash)) style.dash = value.dash;
    return style;
  }

  function createStore(storage) {
    let styles = Object.create(null), canPersist = false;
    if (arguments.length === 0) {
      try { storage = root.localStorage; } catch (_) { /* Keep preferences in memory. */ }
    }
    try {
      canPersist = !!storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
      if (canPersist) {
        const raw = storage.getItem(STORAGE_KEY);
        if (raw !== null && raw !== undefined) {
          let saved;
          try { saved = JSON.parse(raw); } catch (_) { /* Ignore malformed saved preferences. */ }
          if (record(saved) && saved.version === 1 && record(saved.styles)) {
            for (const key of Object.keys(saved.styles)) {
              if (!validKey(key)) continue;
              const style = validStyle(saved.styles[key]);
              if (Object.keys(style).length) styles[key] = style;
            }
          }
        }
      }
    } catch (_) { canPersist = false; }

    function persist() {
      try {
        if (!storage || typeof storage.setItem !== 'function') {
          canPersist = false;
          return;
        }
        storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, styles }));
        canPersist = true;
      } catch (_) { canPersist = false; }
    }

    return {
      get(key, defaults) {
        return Object.assign({}, validStyle(defaults), validKey(key) ? styles[key] : undefined);
      },
      set(key, patch) {
        if (!validKey(key)) return {};
        const valid = validStyle(patch);
        if (Object.keys(valid).length) {
          styles[key] = Object.assign({}, styles[key], valid);
          persist();
        }
        return Object.assign({}, styles[key]);
      },
      reset(keys) {
        if (arguments.length === 0) {
          styles = Object.create(null);
          persist();
          return;
        }
        const selected = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
        let changed = false;
        for (const key of selected) {
          if (validKey(key) && own(styles, key)) {
            delete styles[key];
            changed = true;
          }
        }
        if (changed) persist();
      },
      persistent() { return canPersist; }
    };
  }

  function lwOptions(style) {
    const value = Object.assign({}, DEFAULT_STYLE, validStyle(style));
    return { color: value.color, lineWidth: Math.max(1, Math.min(4, Math.round(value.width))), lineStyle: DASHES[value.dash].lineStyle };
  }

  function chartOptions(style) {
    const value = Object.assign({}, DEFAULT_STYLE, validStyle(style));
    return { borderColor: value.color, borderWidth: value.width, borderDash: DASHES[value.dash].borderDash.slice() };
  }

  function rgba(hex, alpha) {
    const color = validColor(hex) ? hex : DEFAULT_STYLE.color;
    const opacity = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    const components = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
    return 'rgba(' + components.join(', ') + ', ' + opacity + ')';
  }

  return { STORAGE_KEY, createStore, lwOptions, chartOptions, rgba };
});
