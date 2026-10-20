// Same palettes and storage key as the scanner. Loaded in the head so a saved
// light theme applies before the backtesting interface is painted.
(function(root){
  'use strict';
  const THEMES = {
  midnight:{name:"🌙 Midnight",color:"#4f8ef7",vars:{"--bg":"#0d1117","--surface":"#13181f","--surface2":"#1a1f2e","--border":"#1e2838","--text":"#e8eaf0","--muted":"#7a8298","--accent":"#4f8ef7","--buy":"#2ecc71","--sell":"#e74c3c","--hold":"#f7c44f","--buy-bg":"rgba(46,204,113,0.18)","--sell-bg":"rgba(231,76,60,0.16)","--hold-bg":"rgba(247,196,79,0.08)","--row-buy-sticky":"rgba(46,204,113,0.13)","--row-sell-sticky":"rgba(231,76,60,0.13)"}},
  arctic:{name:"❄️ Arctic",color:"#2563eb",vars:{"--bg":"#f0f4f8","--surface":"#ffffff","--surface2":"#f7f9fc","--border":"#dde3ec","--text":"#1a2332","--muted":"#64748b","--accent":"#2563eb","--buy":"#16a34a","--sell":"#dc2626","--hold":"#d97706","--buy-bg":"rgba(22,163,74,0.18)","--sell-bg":"rgba(220,38,38,0.15)","--hold-bg":"rgba(217,119,6,0.1)","--row-buy-sticky":"rgba(22,163,74,0.13)","--row-sell-sticky":"rgba(220,38,38,0.11)"}},
  tableau:{name:"📊 Tableau",color:"#4e79a7",vars:{"--bg":"#f5f5f0","--surface":"#ffffff","--surface2":"#f9f8f5","--border":"#e0ddd8","--text":"#1a1a2e","--muted":"#666660","--accent":"#4e79a7","--buy":"#59a14f","--sell":"#e15759","--hold":"#f28e2b","--buy-bg":"rgba(89,161,79,0.2)","--sell-bg":"rgba(225,87,89,0.18)","--hold-bg":"rgba(242,142,43,0.1)","--row-buy-sticky":"rgba(89,161,79,0.15)","--row-sell-sticky":"rgba(225,87,89,0.13)"}},
  forest:{name:"🌿 Forest",color:"#4caf50",vars:{"--bg":"#0f1a0f","--surface":"#142014","--surface2":"#1a2e1a","--border":"#1e3a1e","--text":"#d4e8d4","--muted":"#7a9e7a","--accent":"#4caf50","--buy":"#81c784","--sell":"#ef5350","--hold":"#ffcc02","--buy-bg":"rgba(118,196,66,0.2)","--sell-bg":"rgba(239,83,80,0.18)","--hold-bg":"rgba(255,204,2,0.08)","--row-buy-sticky":"rgba(118,196,66,0.15)","--row-sell-sticky":"rgba(239,83,80,0.13)"}},
  sunset:{name:"🌅 Sunset",color:"#ff6b35",vars:{"--bg":"#1a0e0a","--surface":"#231510","--surface2":"#2e1a12","--border":"#3a2218","--text":"#f0e6e0","--muted":"#9e7060","--accent":"#ff6b35","--buy":"#4caf50","--sell":"#ef5350","--hold":"#ffc947","--buy-bg":"rgba(76,175,80,0.2)","--sell-bg":"rgba(239,83,80,0.18)","--hold-bg":"rgba(255,201,71,0.08)","--row-buy-sticky":"rgba(76,175,80,0.15)","--row-sell-sticky":"rgba(239,83,80,0.13)"}},
  slate:{name:"🪨 Slate",color:"#58a6ff",vars:{"--bg":"#0d1117","--surface":"#161b22","--surface2":"#21262d","--border":"#30363d","--text":"#c9d1d9","--muted":"#8b949e","--accent":"#58a6ff","--buy":"#3fb950","--sell":"#f85149","--hold":"#e3b341","--buy-bg":"rgba(63,185,80,0.18)","--sell-bg":"rgba(248,81,73,0.16)","--hold-bg":"rgba(227,179,65,0.08)","--row-buy-sticky":"rgba(63,185,80,0.13)","--row-sell-sticky":"rgba(248,81,73,0.12)"}},
  lavender:{name:"💜 Lavender",color:"#7c3aed",vars:{"--bg":"#f7f6ff","--surface":"#ffffff","--surface2":"#faf9ff","--border":"#e0deff","--text":"#1e1b4b","--muted":"#6d6a9a","--accent":"#7c3aed","--buy":"#059669","--sell":"#dc2626","--hold":"#db7706","--buy-bg":"rgba(5,150,105,0.18)","--sell-bg":"rgba(220,38,38,0.15)","--hold-bg":"rgba(219,119,6,0.1)","--row-buy-sticky":"rgba(5,150,105,0.13)","--row-sell-sticky":"rgba(220,38,38,0.11)"}},
  solarized:{name:"☀️ Solarized",color:"#268bd2",vars:{"--bg":"#002b36","--surface":"#073642","--surface2":"#001f27","--border":"#0d4a5a","--text":"#839496","--muted":"#586e75","--accent":"#268bd2","--buy":"#859900","--sell":"#dc322f","--hold":"#b58900","--buy-bg":"rgba(133,153,0,0.2)","--sell-bg":"rgba(220,50,47,0.18)","--hold-bg":"rgba(181,137,0,0.1)","--row-buy-sticky":"rgba(133,153,0,0.15)","--row-sell-sticky":"rgba(220,50,47,0.13)"}}
};
  const STORAGE_KEY = 'ms-theme';
  const legacy = new Set(['dark','powerbi','bloomberg','ocean','stata']);
  const listeners = new Set();
  let active = 'midnight';
  function resolve(value) { return legacy.has(value) || !Object.hasOwn(THEMES,value) ? 'midnight' : value; }
  function setTheme(id, persist = true) {
    if (!Object.hasOwn(THEMES,id)) return;
    active = id;
    const element = root.document?.documentElement;
    if (element) {
      Object.entries(THEMES[id].vars).forEach(([key,value])=>element.style.setProperty(key,value));
      element.style.colorScheme = ['arctic','tableau','lavender'].includes(id) ? 'light' : 'dark';
      element.dataset.theme = id;
    }
    if (persist) { try { root.localStorage.setItem(STORAGE_KEY,id); } catch (_) {} }
    listeners.forEach(listener=>listener(id));
  }
  let saved;
  try { saved = root.localStorage.getItem(STORAGE_KEY); } catch (_) {}
  setTheme(resolve(saved),false);
  root.addEventListener?.('storage',event=>{
    if (event.key === STORAGE_KEY) setTheme(resolve(event.newValue),false);
  });
  root.MarketBacktestTheme = Object.freeze({THEMES,STORAGE_KEY,resolve,getTheme:()=>active,setTheme,
    onChange:listener=>{ listeners.add(listener); return ()=>listeners.delete(listener); }});
})(globalThis);
