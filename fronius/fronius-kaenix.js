/**
 * @plugin Fronius
 * @version 1.0.0
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 * Based on Fronius logic 14166, version 0.481 (test.py).
 * Original copyright: knx-user-forum e.V.
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Distributed without warranty under the GNU General Public License v3 or later.
 * License: https://www.gnu.org/licenses/gpl-3.0.html
 */
'use strict';
const http = require('http');
const states = new Map();
const numeric = value => value == null || value === '' || typeof value === 'boolean'
  ? undefined : Number.isFinite(Number(value)) ? Number(value) : undefined;
function emit(s, handle, value) {
  if (!s.disposed && value !== undefined && s.outputs[handle] !== value) {
    s.outputs[handle] = value;
    s.context.emitOutput(handle, value);
  }
}
function measurement(s, handle, value, sign = 1, rounded = true) {
  const n = numeric(value);
  if (n !== undefined) emit(s, handle, (rounded ? Math.round(n) : n) * sign);
}
function apiData(json) {
  const status = json?.Head?.Status;
  if (status?.Code != null && Number(status.Code) !== 0) throw new Error(`API ${status.Code}: ${status.Reason || status.UserMessage || 'Abfrage fehlgeschlagen'}`);
  const data = json?.Body?.Data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Ungültige API-Antwort');
  return data;
}
function request(s, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: s.cfg.ip, port: s.cfg.port, path, method: 'GET', timeout: 5000 }, res => {
      let raw = '';
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Antwort abgebrochen')));
      res.on('data', chunk => { raw += chunk; if (raw.length > 4 * 1024 * 1024) req.destroy(new Error('Antwort zu groß')); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(apiData(JSON.parse(raw))); } catch (error) { reject(error); }
      });
    });
    // Bound the complete request as well as socket inactivity.
    const deadline = setTimeout(() => req.destroy(new Error('Zeitüberschreitung')), 5000);
    s.requests.add(req);
    req.on('close', () => { clearTimeout(deadline); s.requests.delete(req); });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.end();
  });
}
function resetSurplus(s) {
  s.low = [0, 0, 0];
  for (let i = 1; i <= 3; i++) emit(s, `surplus${i}`, 0);
}
function powerFlow(s, data) {
  const site = data.Site;
  if (!site || typeof site !== 'object') throw new Error('Keine Leistungsdaten');
  for (const [out, key, sign] of [['pv','P_PV',1], ['load','P_Load',-1], ['grid','P_Grid',-1], ['battery','P_Akku',-1]]) {
    measurement(s, out, site[key], sign);
  }
  measurement(s, 'soc', data.Inverters?.[s.cfg.deviceId]?.SOC);
  const grid = numeric(site.P_Grid);
  if (grid === undefined) { resetSurplus(s); return; }
  const exported = -Math.round(grid);
  emit(s, 'feeding', Number(exported > 0));
  for (let i = 1; i <= 3; i++) {
    const start = s.cfg[`start${i}`], end = s.cfg[`end${i}`];
    if (start <= 0) { s.low[i-1] = 0; emit(s, `surplus${i}`, 0); }
    else if (exported > start) { s.low[i-1] = 0; emit(s, `surplus${i}`, 1); }
    else if (exported < end) {
      if (++s.low[i-1] >= Math.max(1, s.cfg.wait)) emit(s, `surplus${i}`, 0);
    } else s.low[i-1] = 0;
  }
}
function warn(s, part, error) {
  const message = error?.message;
  if (message && s.errors[part] !== message) s.context.warn?.(`Fronius (${part}): ${message}`);
  s.errors[part] = message;
}
async function poll(s) {
  if (s.disposed || s.busy) return;
  s.busy = true;
  const id = encodeURIComponent(s.cfg.deviceId);
  const tasks = [
    ['Leistung', '/solar_api/v1/GetPowerFlowRealtimeData.fcgi', data => powerFlow(s, data)],
    ['Energie', '/solar_api/v1/GetInverterRealtimeData.cgi?Scope=System', data => {
      for (const [out, key] of [['dayEnergy','DAY_ENERGY'], ['yearEnergy','YEAR_ENERGY'], ['totalEnergy','TOTAL_ENERGY']]) {
        measurement(s, out, data[key]?.Values?.[s.cfg.deviceId]);
      }
    }],
    ['Phasen', `/solar_api/v1/GetInverterRealtimeData.cgi?Scope=Device&DeviceId=${id}&DataCollection=3PInverterData`, data => {
      for (let i = 1; i <= 3; i++) {
        measurement(s, `currentL${i}`, data[`IAC_L${i}`]?.Value, 1, false);
        measurement(s, `voltageL${i}`, data[`UAC_L${i}`]?.Value, 1, false);
      }
    }],
  ];
  await Promise.all(tasks.map(async ([part, path, apply]) => {
    try {
      const data = await request(s, path);
      if (s.disposed) return;
      apply(data); warn(s, part, null);
      if (part === 'Leistung') s.context.setNodeStatus?.(true);
    } catch (error) {
      if (s.disposed) return;
      warn(s, part, error);
      if (part === 'Leistung') { resetSurplus(s); s.context.setNodeStatus?.(false); }
    }
  }));
  s.busy = false;
  if (!s.disposed && s.cfg.interval > 0) {
    s.timer = setTimeout(() => poll(s), Math.max(1, s.cfg.interval) * 1000);
    s.timer.unref?.();
  }
}
function dispose(s) {
  s.disposed = true;
  clearTimeout(s.timer);
  for (const req of s.requests) req.destroy();
}
const fields = [
  ['ip','Fronius IP'], ['interval','Intervall (Sekunden, Standard 10, 0=aus)'],
  ['start1','Überschuss 1 Start (W)'], ['end1','Überschuss 1 Ende (W)'],
  ['start2','Überschuss 2 Start (W)'], ['end2','Überschuss 2 Ende (W)'],
  ['start3','Überschuss 3 Start (W)'], ['end3','Überschuss 3 Ende (W)'],
  ['wait','Auszeit (aufeinanderfolgende Abfragen, Standard 3)'],
];
module.exports = {
  type: 'fronius', category: 'Geräte', label: 'Fronius', color: '#f97316',
  description: 'Fronius Solar API V1. Netzleistung positiv bei Einspeisung, Batterieleistung positiv beim Laden. Energie in Wh. Drei Überschuss-Schaltungen mit Hysterese; Start 0 deaktiviert. Auszeit zählt aufeinanderfolgende Unterschreitungen. Bei fehlender Netzleistung werden Überschuss-Ausgänge ausgeschaltet. Polling startet automatisch.',
  inputs: fields.map(([handle,label]) => ({handle,label})),
  outputs: [
    ['pv','PV Last (W)'], ['load','Haus Last (W)'], ['grid','Netz Last (W)'],
    ['battery','Batterie Last (W)'], ['soc','Batterie Ladezustand (%)'],
    ['surplus1','Überschuss 1 (0/1)'], ['surplus2','Überschuss 2 (0/1)'], ['surplus3','Überschuss 3 (0/1)'],
    ['feeding','Einspeisen? (0/1)'], ['dayEnergy','Energie Tag (Wh)'], ['yearEnergy','Energie Jahr (Wh)'], ['totalEnergy','Energie Total (Wh)'],
    ...[1,2,3].map(i => [`currentL${i}`,`Strom L${i} (A)`]),
    ...[1,2,3].map(i => [`voltageL${i}`,`Spannung L${i} (V)`]),
  ].map(([handle,label]) => ({handle,label})),
  globalSettings: [{key:'ip',label:'Fronius IP-Adresse',type:'text'}, {key:'port',label:'HTTP-Port (Standard 80)',type:'number',placeholder:'80'}],
  config: [
    ...fields.map(([key,label]) => ({key,label,type:key === 'ip' ? 'text' : 'number',placeholder:key === 'interval' ? '10' : key === 'wait' ? '3' : key === 'ip' ? '' : '0'})),
    {key:'port',label:'HTTP-Port (optional, überschreibt global)',type:'number',placeholder:'80'},
    {key:'deviceId',label:'Wechselrichter-ID (Standard 1)',type:'number',placeholder:'1'},
  ],
  execute(inputs, data, context) {
    const id = context.nodeId || 'default';
    let s = states.get(id);
    const stored = {...(s?.inputs || context.initialInputs || {}), ...inputs};
    const pick = (key, fallback) => [stored[key], data[key], context.globalSetting?.(key), fallback].find(v => v != null && v !== '');
    const cfg = {ip:String(pick('ip','')).trim(), port:Number(pick('port',80)), deviceId:Number(pick('deviceId',1)), interval:Number(pick('interval',10)), wait:Number(pick('wait',3))};
    for (let i = 1; i <= 3; i++) for (const prefix of ['start','end']) cfg[`${prefix}${i}`] = Number(pick(`${prefix}${i}`,0));
    const changed = !s || JSON.stringify(s.cfg) !== JSON.stringify(cfg);
    if (changed) {
      if (s) dispose(s);
      s = {cfg, inputs:stored, context, outputs:{}, low:[0,0,0], errors:{}, requests:new Set(), disposed:false};
      states.set(id,s);
    }
    s.inputs = stored; s.context = context;
    if (!changed) return {};
    resetSurplus(s); context.setNodeStatus?.(false);
    const valid = cfg.ip && Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port <= 65535
      && Number.isInteger(cfg.deviceId) && cfg.deviceId >= 0 && cfg.deviceId <= 65535
      && Number.isFinite(cfg.interval) && cfg.interval >= 0 && cfg.interval <= 86400
      && Number.isInteger(cfg.wait) && cfg.wait >= 0 && cfg.wait <= 1000000
      && [1,2,3].every(i => Number.isFinite(cfg[`start${i}`]) && cfg[`start${i}`] >= 0
        && Number.isFinite(cfg[`end${i}`]) && (cfg[`start${i}`] === 0 || cfg[`end${i}`] < cfg[`start${i}`]));
    if (!valid) { if (cfg.ip) context.warn?.('Fronius: Ungültige Konfiguration. Ende muss unter Start liegen; Start 0 deaktiviert den Kanal.'); return {}; }
    void poll(s);
    return {};
  },
  dispose(nodeId) {
    if (nodeId != null) { const s = states.get(nodeId); if (s) dispose(s); states.delete(nodeId); }
    else { for (const s of states.values()) dispose(s); states.clear(); }
  },
};
