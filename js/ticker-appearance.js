/* Presentation adapters: styling never changes market data, calculations or chart ranges. */
const TickerAppearance = (() => {
  const api = MarketChartAppearance;
  const store = api.createStore();
  const panels = new Map();
  const comparePalette = ['#e84393','#ff7675','#a29bfe','#00cec9','#fdcb6e','#b2bec3','#fd79a8'];
  const dashNames = ['solid','dashed','dotted','long-dashed','sparse-dotted'];
  const dashLabels = ['Solid','Dashed','Dotted','Long dashes','Spaced dots'];
  const t = (key, params) => MarketI18n.t(key, params);
  const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  function colorParts(value) {
    if (/^#[0-9a-f]{6}$/i.test(value)) return {color:value, alpha:1};
    const match = String(value).match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?\s*\)$/);
    return match ? {color:'#'+match.slice(1,4).map(n=>Number(n).toString(16).padStart(2,'0')).join(''),alpha:match[4]===undefined?1:Number(match[4])} : {color:'#00d4ff',alpha:1};
  }
  function styledColor(style, alpha=1) { return alpha===1 ? style.color : api.rgba(style.color, alpha); }
  function compareColor(symbol, index) { return store.get('compare:'+symbol,{color:comparePalette[index%comparePalette.length],width:2,dash:'solid'}).color; }
  function lineEntry(key, label, series, area=false) {
    const options=series.options(), color=colorParts(area?options.lineColor:options.color);
    const defaults={color:color.color,width:Math.round(options.lineWidth),dash:({0:'solid',1:'dotted',2:'dashed',3:'long-dashed',4:'sparse-dotted'})[options.lineStyle]||'solid'};
    return {key,label,defaults,apply(style) {
      const next=api.lwOptions(style);
      next.color=styledColor(style,color.alpha);
      if(area) {
        next.lineColor=next.color; delete next.color;
        next.topColor=api.rgba(style.color,.25); next.bottomColor=api.rgba(style.color,.02);
      }
      series.applyOptions(next);
    }};
  }
  function syncMain(state, symbol, onChanged) {
    const entries=[];
    if(state.mainSeries) {
      if(state.compareTickers.length||['line','area'].includes(state.chartType)) {
        entries.push(lineEntry('price','Price line',state.mainSeries,!state.compareTickers.length&&state.chartType==='area'));
      } else {
        const options=state.mainSeries.options();
        for(const [direction,label] of [['up','Rising candles'],['down','Falling candles']]) {
          const color=colorParts(options[direction+'Color']);
          entries.push({key:'candles.'+direction,label,colorOnly:true,defaults:{color:color.color,width:1,dash:'solid'},apply(style) {
            const opts={[direction+'Color']:style.color};
            if(state.chartType!=='ohlc') {
              const cap=direction[0].toUpperCase()+direction.slice(1);
              opts['border'+cap+'Color']=style.color; opts['wick'+cap+'Color']=api.rgba(style.color,.6);
            }
            state.mainSeries.applyOptions(opts);
          }});
        }
      }
    }
    const labels={sma20:'SMA 20',sma50:'SMA 50',sma200:'SMA 200',ema12:'EMA 12',ema26:'EMA 26',vwap:'Approx VWAP'};
    Object.entries(state.overlaySeries).forEach(([key,series])=>{
      if(key==='bb') series.forEach((line,index)=>entries.push(lineEntry(['bb.upper','bb.middle','bb.lower'][index],['Bollinger upper','Bollinger middle','Bollinger lower'][index],line)));
      else entries.push(lineEntry(key,labels[key]||key,series));
    });
    Object.entries(state.compareSeries).forEach(([key,series])=>entries.push({...lineEntry('compare:'+key,key,series),literalLabel:true}));
    if(state.baselineSeries)entries.push(lineEntry('compare.zero','Zero baseline',state.baselineSeries));
    setPanel('main',document.getElementById('mainAppearance'),entries,onChanged);
  }

  const chartLines={
    rsiChart:[[0,'rsi','RSI',0]],
    macdChart:[[1,'macd','MACD',0],[2,'macd.signal','Signal',1]],
    stochChart:[[0,'stoch','StochRSI',0]],
    willChart:[[0,'williams','Williams %R',0]],
    volChart:[[1,'volume.average','Avg20']],
    obvChart:[[0,'obv','OBV']],
    atrChart:[[0,'atr','ATR']]
  };
  function registerChart(id, chart) {
    const entries=[];
    const card=document.getElementById(id).closest('.subchart-card');
    if(!card)return;
    (chartLines[id]||[]).forEach(([index,key,label,legendIndex])=>{
      const dataset=chart.data.datasets[index], color=colorParts(dataset.borderColor);
      const fillColor=typeof dataset.backgroundColor==='string'?colorParts(dataset.backgroundColor):null;
      entries.push({key,label,legendIndex,defaults:{color:color.color,width:dataset.borderWidth||1.5,dash:'solid'},apply(style) {
        Object.assign(dataset,api.chartOptions(style));
        dataset.borderColor=styledColor(style,color.alpha);
        if(dataset.fill===true&&fillColor)dataset.backgroundColor=api.rgba(style.color,fillColor.alpha);
      }});
    });
    // Bar panels offer color controls without pretending that bars have line dashes.
    if(['macdChart','volChart','rocChart'].includes(id)) {
      const dataset=chart.data.datasets[0], colors=dataset.backgroundColor.slice();
      const prefix={macdChart:'macd.histogram',volChart:'volume',rocChart:'roc'}[id];
      const up=colorParts('rgba(0,230,118,.65)'),down=colorParts('rgba(255,61,87,.65)');
      const isUp=colors.map(color=>colorParts(color).color===up.color);
      for(const [positive,label,base] of [[true,'Positive bars',up],[false,'Negative bars',down]]) {
        const first=colors.find((_,i)=>isUp[i]===positive);
        const defaults={...base,...(first?colorParts(first):{}),width:1,dash:'solid'};
        entries.push({key:prefix+(positive?'.up':'.down'),label,colorOnly:true,defaults,apply(style) {
          dataset.backgroundColor=dataset.backgroundColor.map((color,i)=>isUp[i]===positive?styledColor(style,defaults.alpha):color);
        }});
      }
    }
    let host=card.querySelector('.chart-appearance-host');
    if(!host){host=document.createElement('div');host.className='chart-appearance-host';card.insertBefore(host,card.querySelector('.subchart-inner'));}
    const changed=()=>{
      entries.forEach(entry=>{
        if(entry.legendIndex===undefined)return;
        const swatch=card.querySelectorAll('.leg-dot')[entry.legendIndex];
        if(!swatch)return;
        const style=store.get(entry.key,entry.defaults);
        swatch.style.background='transparent';
        swatch.style.height='0';
        swatch.style.borderTop=style.width+'px '+(style.dash==='solid'?'solid':style.dash.includes('dot')?'dotted':'dashed')+' '+style.color;
      });
      if(entries[0])card.querySelector('.chart-title .dot').style.background=store.get(entries[0].key,entries[0].defaults).color;
      chart.update('none');
    };
    setPanel(id,host,entries,changed);
  }

  function setPanel(id,host,entries,changed) {
    if(!host||!entries.length)return;
    const old=panels.get(id);
    const panel={id,host,entries,changed,selected:old?.selected,open:old?.host.querySelector('details')?.open||false};
    panels.set(id,panel);
    entries.forEach(entry=>entry.apply(store.get(entry.key,entry.defaults)));
    changed();
    renderPanel(panel);
  }
  function renderPanel(panel) {
    const {id,host,entries}=panel;
    const wasOpen=host.querySelector('details')?.open??panel.open;
    if(!entries.some(entry=>entry.key===panel.selected))panel.selected=entries[0].key;
    const label=entry=>entry.literalLabel?entry.label:t(entry.label);
    host.innerHTML=`<details class="chart-appearance"${wasOpen?' open':''}><summary>${esc(t('Customize chart'))}</summary>
      <div class="appearance-controls">
        <label class="appearance-series">${esc(t('Series'))}<select data-appearance="series">${entries.map(entry=>`<option value="${esc(entry.key)}"${entry.key===panel.selected?' selected':''}>${esc(label(entry))}</option>`).join('')}</select></label>
        <label>${esc(t('Color'))}<input type="color" data-appearance="color"></label>
        <label>${esc(t('Width'))}<select data-appearance="width">${(id==='main'?[1,2,3,4]:[1,1.5,2,3,4]).map(width=>`<option value="${width}">${MarketI18n.number(width,width%1?1:0)} px</option>`).join('')}</select></label>
        <label>${esc(t('Stroke'))}<select data-appearance="dash">${dashNames.map((dash,i)=>`<option value="${dash}">${esc(t(dashLabels[i]))}</option>`).join('')}</select></label>
        <span class="appearance-preview" aria-hidden="true"></span>
      </div>
      <div class="appearance-actions"><button type="button" data-reset="series">${esc(t('Reset series'))}</button><button type="button" data-reset="panel">${esc(t('Reset this chart'))}</button></div>
      <p class="appearance-note"></p><p class="appearance-status" role="status"></p>
    </details>`;
    const change=event=>{
      const field=event.target.dataset.appearance;
      if(!field)return;
      if(field==='series'){panel.selected=event.target.value;updateControls(panel);return;}
      const entry=entries.find(entry=>entry.key===panel.selected);
      store.set(entry.key,{[field]:field==='width'?Number(event.target.value):event.target.value});
      entry.apply(store.get(entry.key,entry.defaults));
      panel.changed(); updateControls(panel,true);
    };
    host.onchange=change;
    host.oninput=event=>{if(event.target.dataset.appearance==='color')change(event);};
    host.onclick=event=>{
      const reset=event.target.dataset.reset;
      if(!reset)return;
      const targets=reset==='panel'?entries:entries.filter(entry=>entry.key===panel.selected);
      store.reset(targets.map(entry=>entry.key));
      targets.forEach(entry=>entry.apply(store.get(entry.key,entry.defaults)));
      panel.changed(); updateControls(panel,true);
    };
    updateControls(panel);
  }
  function updateControls(panel,changed=false) {
    const entry=panel.entries.find(entry=>entry.key===panel.selected);
    const style=store.get(entry.key,entry.defaults);
    if(panel.id==='main')style.width=Math.round(style.width);
    for(const key of ['color','width','dash']) {
      const input=panel.host.querySelector('[data-appearance="'+key+'"]');
      input.value=style[key];input.disabled=Boolean(entry.colorOnly&&key!=='color');
    }
    const preview=panel.host.querySelector('.appearance-preview');
    preview.style.borderTop=style.width+'px '+(style.dash==='solid'?'solid':style.dash.includes('dot')?'dotted':'dashed')+' '+style.color;
    preview.style.height=entry.colorOnly?'12px':'0';preview.style.background=entry.colorOnly?style.color:'transparent';
    panel.host.querySelector('.appearance-note').textContent=t(entry.colorOnly?'Candles and bars use color only.':'Changes apply immediately.');
    panel.host.querySelector('.appearance-status').textContent=t(store.persistent()?'Saved in this browser for all tickers.':'Changes apply for this visit; browser storage is unavailable.');
  }
  function refreshLanguage(){panels.forEach(renderPanel);}
  return {syncMain,registerChart,compareColor,refreshLanguage};
})();
