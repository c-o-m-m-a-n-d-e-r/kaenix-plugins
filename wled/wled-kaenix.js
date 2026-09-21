/**
 * @plugin    WLED
 * @version   1.0.0
 * @author    Christian Brauwers
 * @website   https://www.kaenix.net
 * API: https://kno.wled.ge/interfaces/json-api/
 */
'use strict';
const http = require('http');
const states = new Map();
const bit = v => [0, '0', false].includes(v) ? false : [1, '1', true].includes(v) ? true : undefined;
function number(v, min, max, integer = false) {
  if (v == null || v === '' || typeof v === 'boolean') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n)) ? n : undefined;
}
function required(v, min, max, integer = false) {
  const n = number(v, min, max, integer);
  if (n === undefined) throw new Error(`Wert muss zwischen ${min} und ${max} liegen${integer ? ' (Ganzzahl)' : ''}`);
  return n;
}
const byte = v => Math.round(required(v, 0, 100) * 255 / 100);
function emit(s, handle, value) {
  if (!s.disposed && value !== undefined && s.outputs[handle] !== value) {
    s.outputs[handle] = value; s.context.emitOutput(handle, value);
  }
}
function connected(s, value) {
  if (s.disposed) return;
  emit(s, 'connected', value); s.context.setNodeStatus?.(!!value);
}
function request(s, method, path, body) {
  return new Promise((resolve, reject) => {
    if (s.disposed) return reject(new Error('Node gestoppt'));
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: s.cfg.ip, port: s.cfg.port, path, method, timeout: 10000,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      let raw = '';
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('WLED-Antwort abgebrochen')));
      res.on('data', chunk => { raw += chunk; if (raw.length > 4 * 1024 * 1024) req.destroy(new Error('Antwort zu groß')); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`WLED HTTP ${res.statusCode}${[204, 423].includes(res.statusCode) ? ' – Hub in Wartung' : ''}`);
          error.status = res.statusCode; return reject(error);
        }
        try { resolve(raw ? JSON.parse(raw) : null); }
        catch { const error = new Error('Ungültige WLED-JSON-Antwort'); error.invalidJSON = true; reject(error); }
      });
    });
    s.requests.add(req); req.on('close', () => s.requests.delete(req));
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('WLED Zeitüberschreitung')));
    req.end(payload);
  });
}
function segment(s) {
  const seg = s.state?.seg?.find((seg, i) => (seg.id ?? i) === s.cfg.segment);
  if (!seg) throw new Error(`Segment ${s.cfg.segment} nicht vorhanden`);
  return seg;
}
function report(s, state) {
  if (!state || typeof state.on !== 'boolean' || !Array.isArray(state.seg)) throw new Error('Ungültiger WLED-Status');
  if (s.disposed) return;
  s.state = state; connected(s, 1);
  emit(s, 'onOff', Number(state.on));
  if (number(state.bri, 0, 255) !== undefined) emit(s, 'brightness', state.on ? Math.round(state.bri / 255 * 100) : 0);
  if (number(state.ps, -1, 250, true) !== undefined) emit(s, 'preset', state.ps);
  const seg = segment(s);
  if (typeof seg.on === 'boolean') emit(s, 'segmentOn', Number(seg.on));
  for (const [out, key] of [['speed','sx'], ['intensity','ix'], ['cct','cct']]) {
    if (number(seg[key], 0, 255) !== undefined) emit(s, out, Math.round(seg[key] / 255 * 100));
  }
  for (const [out, key] of [['effect','fx'], ['palette','pal']]) {
    if (number(seg[key], 0, 65535, true) !== undefined) emit(s, out, seg[key]);
  }
  const col = seg.col?.[0];
  if (Array.isArray(col)) {
    ['red','green','blue','white'].forEach((handle,i) => {
      if (number(col[i], 0, 255) !== undefined) emit(s, handle, Math.round(col[i] / 255 * 100));
    });
    if (col.length >= 3 && col.slice(0,3).every(v => number(v,0,255,true) !== undefined)) {
      emit(s, 'rgb', col[0] * 65536 + col[1] * 256 + col[2]);
    }
  }
}
async function refresh(s) { report(s, await request(s, 'GET', '/json/state')); }
async function selectId(s, value, kind) {
  const id = number(value, kind === 'preset' ? 1 : 0, kind === 'preset' ? 250 : 255, true);
  if (id !== undefined) return id;
  const label = String(value ?? '').trim();
  if (!label) throw new Error('ID oder Name fehlt');
  const raw = await request(s, 'GET', kind === 'preset' ? '/presets.json' : kind === 'effect' ? '/json/eff' : '/json/pal');
  const matches = kind === 'preset'
    ? Object.entries(raw || {}).filter(([key, entry]) => number(key, 1, 250, true) !== undefined && entry?.n === label).map(([key]) => Number(key))
    : Array.isArray(raw) ? raw.map((entry, i) => entry === label && !['RSVD','-'].includes(entry) ? i : -1).filter(i => i >= 0) : [];
  if (matches.length !== 1) throw new Error(matches.length ? 'Name nicht eindeutig – ID verwenden' : `${kind}: Name nicht gefunden`);
  return matches[0];
}
async function command(s, handle, value) {
  const body = { v: true };
  if (handle === 'onOff' || handle === 'toggle') {
    if (bit(value) === undefined) throw new Error('Schalten/Toggle erwartet 0 oder 1');
    body.on = handle === 'toggle' ? 't' : bit(value);
  } else if (handle === 'brightness') {
    const bri = byte(value); body.on = bri > 0; if (bri > 0) body.bri = bri;
  } else if (handle === 'preset') body.ps = await selectId(s, value, 'preset');
  else {
    // Read the current primary color before individual channel updates. This
    // preserves channels changed by another client, even with polling disabled.
    await refresh(s);
    const current = segment(s), seg = { id: s.cfg.segment };
    if (handle === 'segmentOn') {
      const on = bit(value); if (on === undefined) throw new Error('Segment Ein/Aus erwartet 0 oder 1'); seg.on = on;
    } else if (['red','green','blue','white','rgb'].includes(handle)) {
      const col = current.col?.[0];
      if (!Array.isArray(col) || col.length < 3 || col.some(v => number(v,0,255,true) === undefined)) throw new Error('Keine gültige RGB-Farbrückmeldung');
      const color = col.slice(0,4);
      if (handle === 'rgb') {
        let rgb;
        if (typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value.trim())) rgb = parseInt(value.trim().slice(1),16);
        else rgb = required(value,0,0xffffff,true);
        color[0] = (rgb >> 16) & 255; color[1] = (rgb >> 8) & 255; color[2] = rgb & 255;
      } else color[['red','green','blue','white'].indexOf(handle)] = byte(value);
      seg.col = [color];
    } else if (handle === 'effect') seg.fx = await selectId(s, value, 'effect');
    else if (handle === 'palette') seg.pal = await selectId(s, value, 'palette');
    else {
      const key = { speed:'sx', intensity:'ix', cct:'cct' }[handle];
      if (!key) throw new Error('Unbekannter Befehl'); seg[key] = byte(value);
    }
    body.seg = [seg];
  }
  const response = await request(s, 'POST', '/json/state', body);
  if (response?.error) throw new Error(`WLED meldet Fehler ${response.error}`);
  if (typeof response?.on === 'boolean') report(s, response);
  else if (typeof response?.state?.on === 'boolean') report(s, response.state);
  else await refresh(s);
}
function enqueue(s, task) {
  s.queue = s.queue.then(() => s.disposed ? undefined : task()).catch(error => {
    if (s.disposed) return;
    if (error.status || error.code || /Zeitüberschreitung|Antwort|WLED-Status/.test(error.message)) connected(s, 0);
    s.context.warn?.(`WLED: ${error.message}`);
  });
  return s.queue;
}
function dispose(s) {
  s.disposed = true; clearInterval(s.timer);
  for (const req of s.requests) req.destroy();
}
const controls = [
  ['onOff','Schalten (0/1)'], ['toggle','Toggle (0/1)'], ['brightness','Helligkeit (0–100 %)'],
  ['segmentOn','Segment Ein/Aus (0/1)'], ['rgb','RGB (DPT232.600 / #RRGGBB)'],
  ['red','Rot (0–100 %)'], ['green','Grün (0–100 %)'], ['blue','Blau (0–100 %)'], ['white','Weiß (0–100 %)'],
  ['cct','Farbtemperatur (0–100 %)'], ['effect','Effekt (ID oder Name)'], ['speed','Effektgeschwindigkeit (0–100 %)'],
  ['intensity','Effektintensität (0–100 %)'], ['palette','Farbpalette (ID oder Name)'], ['preset','Preset (ID oder Name)'],
];
module.exports = {
  type: 'wled', category: 'Geräte', label: 'WLED', color: '#f4b400',
  description: 'Lokale WLED-JSON-API. Schalten/Helligkeit gelten für das Gerät, Farben und Effekte für die gewählte Segment-ID (Standard 0). Toggle bei jedem 0/1-Telegramm. Status-Trigger nur bei 1. IP/Port können global gespeichert werden.',
  inputs: [
    {handle:'ip',label:'IP Adresse'}, {handle:'port',label:'Port (Standard 80)'}, {handle:'segment',label:'Segment-ID (Standard 0)'},
    ...controls.map(([handle,label]) => ({handle,label})),
    {handle:'triggerStatus',label:'Status Trigger (1)'}, {handle:'interval',label:'Status Intervall (Sekunden)'},
  ],
  outputs: [
    {handle:'connected',label:'Verbindungsstatus (0/1)'},
    ...controls.filter(([h])=>h!=='toggle').map(([handle,label])=>({handle,label:label.replace('Schalten','Status').replace('ID oder Name','ID')})),
  ],
  globalSettings: [
    {key:'ip',label:'WLED IP-Adresse',type:'text'}, {key:'port',label:'Port (Standard 80)',type:'number',placeholder:'80'},
  ],
  config: [
    {key:'ip',label:'IP-Adresse (optional, überschreibt global)',type:'text'},
    {key:'port',label:'Port (optional, überschreibt global)',type:'number',placeholder:'80'},
    {key:'segment',label:'Segment-ID',type:'number',placeholder:'0'},
    {key:'interval',label:'Statusintervall in Sekunden (Standard 10, 0=aus)',type:'number',placeholder:'10'},
  ],
  execute(inputs, data, context) {
    const id = context.nodeId || 'default'; let s = states.get(id);
    const previous = s?.inputs || context.initialInputs || {};
    const stored = {...previous,...inputs};
    const pick = key => stored[key] != null && stored[key] !== '' ? stored[key]
      : data[key] != null && data[key] !== '' ? data[key] : (context.globalSetting?.(key) || undefined);
    const cfg = {ip:String(pick('ip') || '').trim(),port:Number(pick('port') ?? 80),
      segment:Number(pick('segment') ?? 0),interval:Number(pick('interval') ?? 10)};
    const changed = !s || JSON.stringify(s.cfg) !== JSON.stringify(cfg);
    if (changed) {
      if (s) dispose(s);
      s = {cfg,inputs:stored,context,requests:new Set(),outputs:{},queue:Promise.resolve(),disposed:false};
      states.set(id,s);
    }
    s.context=context; s.inputs=stored;
    if (!cfg.ip || number(cfg.port,1,65535,true) === undefined || number(cfg.segment,0,255,true) === undefined
      || number(cfg.interval,0,86400) === undefined) {
      connected(s,0); if (changed && cfg.ip) context.warn?.('WLED: Port, Segment-ID oder Statusintervall ungültig'); return {};
    }
    if (changed) {
      connected(s,0); enqueue(s,()=>refresh(s));
      if (cfg.interval) {
        s.timer=setInterval(()=>{
          if (s.pollPending) return; s.pollPending=true;
          enqueue(s,()=>refresh(s)).finally(()=>{s.pollPending=false;});
        },Math.max(1,cfg.interval)*1000);
        s.timer.unref?.();
      }
    }
    const actions=[...controls.map(([h])=>h),'triggerStatus'];
    const handles=context.triggerHandle != null ? actions.filter(h=>h===context.triggerHandle && inputs[h]!==undefined)
      : actions.filter(h=>inputs[h]!==undefined && inputs[h]!==previous[h]);
    for (const handle of handles) {
      const value=inputs[handle];
      if (handle==='triggerStatus' && bit(value)!==true) continue;
      enqueue(s,()=>handle==='triggerStatus' ? refresh(s) : command(s,handle,value));
    }
    return {};
  },
  dispose(nodeId) {
    if (nodeId != null) {const s=states.get(nodeId); if(s)dispose(s); states.delete(nodeId);}
    else {for(const s of states.values())dispose(s); states.clear();}
  },
};
