/**
 * @plugin Gardena
 * @version 1.0.2
 * @author Christian Brauwers
 * @website https://www.kaenix.net
 * Functional adaptation of Gardena smart logic 12980 v1.9995 (gardena.py).
 * Original copyright: knx-user-forum e.V.
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Provided without warranty. https://www.gnu.org/licenses/gpl-3.0.html
 * API: https://developer.husqvarnagroup.cloud/apis/GARDENA+smart+system+API
 */
'use strict';
const https = require('https');
const crypto = require('crypto');
// Resolve from the server, including installations with an external plugin mount.
let WebSocket;
try { WebSocket = require('ws'); }
catch { WebSocket = require(require.resolve('ws', {paths:[process.cwd()]})); }
const nodes = new Map(), accounts = new Map();
const API = 'https://api.smart.gardena.dev/v2';
const AUTH = 'https://api.authentication.husqvarnagroup.dev/v1/oauth2/token';
const bit = v => [1,'1',true].includes(v) ? 1 : [0,'0',false].includes(v) ? 0 : undefined;
const attr = (r,k) => r?.attributes?.[k]?.value;
function emit(s,h,v) {
  if (!s.disposed && v !== undefined && v !== null && s.outputs[h] !== v) {
    s.outputs[h]=v; s.context.emitOutput(h,v);
  }
}
function fault(s,message) { emit(s,'debug',message); s.context.warn?.(`Gardena: ${message}`); }
function door(s,position) { if(bit(s.inputs.useGarage)===1 && Number.isFinite(position) && position>=0 && position<=100) emit(s,'garagedoor',position); }
function cancelStart(s) {s.pendingStart=false;s.pendingResume=false;clearTimeout(s.doorTimer);}
function awaitDoor(s,resume=false) {
  cancelStart(s);s.pendingStart=true;s.pendingResume=resume;openDoor(s);
  emit(s,'debug','Warte auf Tor-Rückmeldung 0 (offen)');
  s.doorTimer=setTimeout(()=>{cancelStart(s);fault(s,'Torfreigabe nach 120 Sekunden abgebrochen');},120000);
  s.doorTimer.unref?.();
}
function openDoor(s) { door(s, Number(s.inputs.doorPosition)>=0 ? Number(s.inputs.doorPosition) : 0); }
function offline(a) {
  a.online=false;
  for(const s of a.nodes) {
    s.context.setNodeStatus?.(false); cancelStart(s);
    if(bit(s.inputs.safety)!==0) openDoor(s);
  }
}
function requestPhase(url,auth) {
  if(auth)return 'Anmeldung';
  const pathname=new URL(url).pathname;
  if(pathname.endsWith('/websocket'))return 'WebSocket-Anmeldung';
  if(pathname.includes('/command/'))return 'Gerätebefehl';
  return pathname.endsWith('/locations') ? 'Standorte laden' : 'Geräte laden (Standort-ID prüfen)';
}
function responseError(a,url,auth,status,raw) {
  let json;
  try {json=JSON.parse(raw);}catch {json={};}
  const errors=Array.isArray(json?.errors)?json.errors.slice(0,3):[];
  const parts=[json?.error,json?.error_description,json?.message,...errors.flatMap(e=>[e?.code,e?.title,e?.detail])]
    .filter(v=>typeof v==='string' && v.trim());
  let detail=[...new Set(parts)].join(' – ');
  // Only selected error fields are logged; never dump bodies, credentials or URLs.
  const basic=Buffer.from(`${a.key}:${a.secret}`).toString('base64');
  const sensitive=[a.key,a.secret,a.token,basic].filter(Boolean).flatMap(v=>[v,encodeURIComponent(v),new URLSearchParams({v}).toString().slice(2)]);
  for(const value of sensitive.sort((x,y)=>y.length-x.length))detail=detail.split(value).join('[entfernt]');
  detail=detail.replace(/(?:https?|wss):\/\/[^\s]+/gi,'[URL entfernt]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi,'[Authentifizierung entfernt]')
    .replace(/[\r\n\t]+/g,' ').slice(0,500);
  const hint=auth && ['invalid_client','unauthorized_client'].includes(json?.error)
    ? ' – Application Key und Application Secret der Entwickler-Anwendung prüfen (kein Konto-Passwort)'
    : status===403 ? ' – API-Freigabe der Entwickler-Anwendung prüfen' : '';
  const error=new Error(`${requestPhase(url,auth)}: HTTP ${status}${detail ? ` – ${detail}` : ''}${hint}`);
  error.status=status;
  return error;
}
function request(a,url,method='GET',body,auth=false) {
  return new Promise((resolve,reject)=>{
    if(a.disposed) return reject(new Error('Verbindung beendet'));
    const payload=body===undefined ? undefined : auth ? body : JSON.stringify(body);
    const headers=auth ? {'Content-Type':'application/x-www-form-urlencoded'} : {
      Authorization:`Bearer ${a.token}`, 'Authorization-Provider':'husqvarna', 'X-Api-Key':a.key,
      'Content-Type':'application/vnd.api+json', Accept:'application/vnd.api+json',
    };
    if(payload) headers['Content-Length']=Buffer.byteLength(payload);
    const req=https.request(url,{method,headers,timeout:15000},res=>{
      let raw='';res.on('error',reject);res.on('aborted',()=>reject(new Error('Antwort abgebrochen')));
      res.on('data',chunk=>{raw+=chunk;if(raw.length>4*1024*1024)req.destroy(new Error('Antwort zu groß'));});
      res.on('end',()=>{
        if(res.statusCode<200 || res.statusCode>=300) {
          const e=responseError(a,url,auth,res.statusCode,raw);
          e.retryAfter=Math.max(0,Number(res.headers['retry-after'])||0);
          return reject(e);
        }
        try {resolve(raw ? JSON.parse(raw) : {});}catch {reject(new Error('Ungültige JSON-Antwort'));}
      });
    });
    a.requests.add(req);
    const timer=setTimeout(()=>req.destroy(new Error('Zeitüberschreitung')),20000);
    req.on('close',()=>{clearTimeout(timer);a.requests.delete(req);});
    req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Zeitüberschreitung')));req.end(payload);
  });
}
function deviceId(r) {return r.relationships?.device?.data?.id || String(r.id).split(':')[0];}
function services(s,type) {return [...s.account.resources.values()].filter(r=>deviceId(r)===s.cfg.deviceId && (!type || r.type===type));}
function report(s) {
  const all=services(s), common=all.find(r=>r.type==='COMMON');
  const found=all.some(r=>r.type==='DEVICE') || !!common;
  s.context.setNodeStatus?.(s.account.online && found && attr(common,'rfLinkState')!=='OFFLINE');
  if(!found) {
    const devices=[...s.account.resources.values()].filter(r=>r.type==='COMMON').map(r=>`${attr(r,'name') || 'Gerät'}: ${deviceId(r)}`);
    emit(s,'debug',`Geräte-ID fehlt oder nicht gefunden. ${devices.join('; ')}`);return;
  }
  emit(s,'battery',attr(common,'batteryLevel'));emit(s,'signal_quality',attr(common,'rfLinkLevel'));
  const errors=all.map(r=>attr(r,'lastErrorCode')).filter(v=>v!=null && !['NO_ERROR','NO_MESSAGE','OK','NONE',0,'0'].includes(v));
  const hasErrorState=all.some(r=>attr(r,'state')==='ERROR');
  emit(s,'error',errors.join(', ') || (hasErrorState ? 'ERROR' : ''));
  emit(s,'error_trigger',Number(errors.length>0 || hasErrorState));
  for(const r of all) {
    if(r.type==='MOWER') {
      const activity=attr(r,'activity');
      emit(s,'statustext',activity);
      if(activity) {
        emit(s,'status',Number(['OK_CUTTING','OK_SEARCHING','OK_LEAVING'].includes(activity)));
        emit(s,'charging',Number(activity==='OK_CHARGING'));
        // Only current telemetry may close the door. Never infer docking from a command.
        if(s.account.online && attr(common,'rfLinkState')==='ONLINE' && !s.pendingStart && s.lastActivity!==activity) {
          if(activity==='OK_SEARCHING' || activity==='OK_LEAVING') openDoor(s);
          else if(activity==='OK_CUTTING') door(s,Number(s.inputs.doorWhileMowing)||0);
          else if(activity==='OK_CHARGING' || activity.startsWith('PARKED_')) door(s,100);
        }
        if(s.account.online) s.lastActivity=activity;
      }
      emit(s,'running_time',attr(r,'operatingHours'));
    }
    if(r.type==='SENSOR') {
      emit(s,'temperature',attr(r,'ambientTemperature') ?? attr(r,'soilTemperature'));
      emit(s,'light',attr(r,'lightIntensity'));emit(s,'humidity',attr(r,'soilHumidity'));
    }
    if(r.type==='VALVE') {
      const activity=attr(r,'activity');
      const channel=String(r.id).match(/:([1-6])$/)?.[1];
      if(['OPEN','CLOSED'].includes(activity)) emit(s,channel ? `watering_timer_${channel}` : 'valve_open',Number(activity==='OPEN'));
    }
  }
}
function ingest(a,resources,replace=false) {
  if(replace) a.resources.clear();
  for(const r of resources) {
    if(!r?.id || !r.type) continue;
    const key=`${r.type}/${r.id}`,previous=a.resources.get(key);
    // WebSocket events contain partial services; retain untouched attributes.
    const attributes={...previous?.attributes};
    for(const [name,value] of Object.entries(r.attributes||{})) {
      const old=attributes[name];
      if(old?.timestamp && value?.timestamp && Date.parse(value.timestamp)<Date.parse(old.timestamp)) continue;
      attributes[name]=value;
    }
    a.resources.set(key,{...previous,...r,attributes});
  }
  for(const s of a.nodes) report(s);
}
async function snapshot(a) {
  if(a.snapshotPromise) return a.snapshotPromise;
  a.snapshotPromise=(async()=>{
    const data=await request(a,`${API}/locations/${encodeURIComponent(a.location)}`);
    if(a.disposed)return;
    if(!Array.isArray(data.included))throw new Error('Geräteliste fehlt');
    ingest(a,data.included,true);a.lastSnapshot=Date.now();
  })().finally(()=>{a.snapshotPromise=null;});
  return a.snapshotPromise;
}
function cleanupConnection(a) {
  clearTimeout(a.renewTimer);clearInterval(a.heartbeat);
  const ws=a.ws;a.ws=null;
  if(ws) {ws.removeAllListeners();ws.on('error',()=>{});ws.terminate();}
}
function retry(a,error) {
  if(a.disposed)return;
  cleanupConnection(a);offline(a);
  if(error)for(const s of a.nodes)fault(s,error.message);
  clearTimeout(a.retryTimer);
  const seconds=Math.max(Math.min(300,10*2**Math.min(a.failures++,5)),error?.retryAfter||0);
  a.retryTimer=setTimeout(()=>connect(a),Math.min(seconds,86400)*1000);a.retryTimer.unref?.();
}
function locationSetting(value) {
  // Unconnected text inputs can be restored as numeric/string zero by the editor.
  if(value==null || value===false)return '';
  const text=String(value).trim();
  return text==='0' ? '' : text;
}
function selectLocation(data,configured) {
  if(!Array.isArray(data))throw new Error('Ungültige Standortliste von Gardena');
  const locations=data.filter(item=>typeof item?.id==='string' && item.id.trim());
  if(!locations.length)throw new Error('Keine Gärten für diese Entwickler-Anwendung gefunden');
  const wanted=locationSetting(configured);
  const match=locations.find(item=>item.id===wanted);
  if(match)return match.id;
  if(!wanted && locations.length===1)return locations[0].id;
  const choices=locations.map(item=>`${typeof item.attributes?.name==='string' ? item.attributes.name : 'Garten'}: ${item.id}`).join('; ');
  throw new Error(`${wanted ? 'Konfigurierte Standort-ID gehört nicht zu diesem Konto' : 'Mehrere Gärten vorhanden – Standort-ID wählen'}. Verfügbare Standorte: ${choices}`);
}
async function connect(a) {
  if(a.disposed || a.connecting)return;
  a.connecting=true;clearTimeout(a.retryTimer);cleanupConnection(a);
  try {
    const token=await request(a,AUTH,'POST',new URLSearchParams({grant_type:'client_credentials',client_id:a.key,client_secret:a.secret}).toString(),true);
    if(a.disposed)return;
    if(!token.access_token || !(Number(token.expires_in)>0))throw new Error('Token-Antwort ungültig');
    a.token=token.access_token;
    const locations=await request(a,`${API}/locations`);
    if(a.disposed)return;
    a.location=selectLocation(locations.data,a.configuredLocation);
    await snapshot(a);
    const response=await request(a,`${API}/websocket`,'POST',{data:{id:crypto.randomUUID(),type:'WEBSOCKET',attributes:{locationId:a.location}}});
    if(a.disposed)return;
    const url=response.data?.attributes?.url;
    if(!url || new URL(url).protocol!=='wss:')throw new Error('Ungültige WebSocket-Adresse');
    const ws=new WebSocket(url,{handshakeTimeout:15000,maxPayload:4*1024*1024});a.ws=ws;
    ws.on('open',()=>{
      if(a.disposed || a.ws!==ws)return;
      a.online=true;a.failures=0;a.alive=true;
      for(const s of a.nodes) {emit(s,'debug','Verbunden (Gardena API v2)');report(s);}
      a.heartbeat=setInterval(()=>{
        if(!a.alive)return ws.terminate();
        a.alive=false;ws.ping();
      },30000);a.heartbeat.unref?.();
    });
    ws.on('pong',()=>{a.alive=true;});
    ws.on('message',raw=>{
      if(a.disposed || a.ws!==ws)return;
      try {const msg=JSON.parse(raw.toString());const data=msg.data||msg;ingest(a,Array.isArray(data)?data:[data]);}
      catch {for(const s of a.nodes)emit(s,'debug','Ungültiges WebSocket-Ereignis');}
    });
    ws.on('error',()=>{ /* close schedules a reconnect; never log signed WebSocket URLs */ });
    ws.on('close',()=>{if(a.ws===ws)retry(a,new Error('WebSocket getrennt'));});
    a.renewTimer=setTimeout(()=>{offline(a);connect(a);},Math.max(1,Number(token.expires_in)-60)*1000);
    a.renewTimer.unref?.();
  } catch(error) {retry(a,error);} finally {a.connecting=false;}
}
async function send(s,type,command,seconds,channel) {
  const a=s.account;
  if(s.disposed || !a.online)throw new Error('Nicht verbunden – Befehl nicht ausgeführt');
  const candidates=services(s,type);
  const service=channel ? candidates.find(r=>String(r.id).endsWith(`:${channel}`)) : candidates.length===1 ? candidates[0] : null;
  if(!service)throw new Error(`${type}${channel ? ` ${channel}` : ''}: Dienst fehlt oder ist nicht eindeutig`);
  const attributes={command};if(seconds!==undefined)attributes.seconds=seconds;
  await request(a,`${API}/command/${encodeURIComponent(service.id)}`,'PUT',{data:{id:crypto.randomUUID(),type:`${type}_CONTROL`,attributes}});
  emit(s,'debug','Befehl angenommen; warte auf Geräterückmeldung');
}
function duration(value,scale,max) {
  const n=Number(value);
  if(!Number.isFinite(n) || n<=0 || n*scale>max)throw new Error('Dauer außerhalb des zulässigen Bereichs');
  return Math.max(1,Math.round(n*scale));
}
async function action(s,handle,value) {
  if(handle==='triggerStatus') {
    if(bit(value)!==1)return;
    if(!s.account.online)throw new Error('Nicht verbunden');
    // Avoid flooding the cloud when several nodes receive the same trigger.
    if(Date.now()-s.account.lastSnapshot>=10000)await snapshot(s.account);else report(s);
    return;
  }
  if(handle==='refreshToken') {if(bit(value)===1){offline(s.account);await connect(s.account);}return;}
  if(handle==='doorState') {
    if(s.pendingStart && Number(value)===0) {
      const resume=s.pendingResume;cancelStart(s);
      if(bit(s.inputs.rain)===1)throw new Error('Mähstart durch Regen gesperrt');
      if(resume){await send(s,'MOWER','START_DONT_OVERRIDE');s.rainParked=false;}
      else await action(s,'mow',1);
    }return;
  }
  const on=bit(value);if(on===undefined)throw new Error('Befehl erwartet 0 oder 1');
  if(handle==='rain') {
    cancelStart(s);
    if(on) {openDoor(s);await send(s,'MOWER','PARK_UNTIL_FURTHER_NOTICE');s.rainParked=true;}
    else if(s.rainParked) {
      if(bit(s.inputs.useGarage)===1 && (s.inputs.doorState==null || Number(s.inputs.doorState)!==0)) {awaitDoor(s,true);return;}
      await send(s,'MOWER','START_DONT_OVERRIDE');s.rainParked=false;
    }
    return;
  }
  if(handle==='mow') {
    if(!on) {cancelStart(s);s.rainParked=false;openDoor(s);return send(s,'MOWER',bit(s.inputs.rain)===1?'PARK_UNTIL_FURTHER_NOTICE':'PARK_UNTIL_NEXT_TASK');}
    if(bit(s.inputs.rain)===1)throw new Error('Mähstart durch Regen gesperrt');
    const seconds=duration(s.inputs.mowHours,3600,86400);
    if(bit(s.inputs.useGarage)===1 && (s.inputs.doorState==null || Number(s.inputs.doorState)!==0)) {
      awaitDoor(s);return;
    }
    return send(s,'MOWER','START_SECONDS_TO_OVERRIDE',seconds);
  }
  const channel=handle.match(/^valve([1-6])$/)?.[1];
  if(handle==='valve' || channel)return send(s,'VALVE',on?'START_SECONDS_TO_OVERRIDE':'STOP_UNTIL_NEXT_TASK',on?duration(s.inputs.waterMinutes,60,3600):undefined,channel);
}
function enqueue(s,handle,value) {
  // Commands are accepted only during a live session; never replay after reconnect.
  const a=s.account;
  if(!a.online && handle!=='refreshToken') {fault(s,'Nicht verbunden – Befehl verworfen');return;}
  const connection=a.ws;
  a.queue=a.queue.then(async()=>{
    if(s.disposed || (handle!=='refreshToken' && connection!==a.ws))return;
    await action(s,handle,value);
  }).catch(error=>{
    if(!s.disposed)fault(s,error.message);
    if(error.status===401 || error.status===429)retry(a,error);
  });
}
function detach(s) {
  s.disposed=true;cancelStart(s);const a=s.account;if(!a)return;
  a.nodes.delete(s);
  if(!a.nodes.size) {
    a.disposed=true;clearTimeout(a.retryTimer);cleanupConnection(a);
    for(const req of a.requests)req.destroy();accounts.delete(a.id);
  }
}
const inputDefs=[
  ['clientId','Application Key'],['clientSecret','Application Secret'],['deviceId','Geräte-ID'],
  ['mow','Mähen / Parken (1/0)'],['triggerStatus','Status Trigger (1)'],['useGarage','Garagentor benutzen (0/1)'],
  ['doorState','Garagentor Zustand (0=offen, 100=zu)'],['safety','Tor bei Verbindungsverlust öffnen (0/1)'],
  ['doorPosition','Tor-Öffnungsposition (-1=0 %)'],['rain','Regen (0/1)'],['mowHours','Mähdauer (Stunden, 1–24)'],
  ['valve','Ventil öffnen/schließen (1/0)'],['waterMinutes','Wasser (Minuten, 1–60)'],
  ...[1,2,3,4,5,6].map(i=>[`valve${i}`,`SIC Ventil ${i} (0/1)`]),
  ['locationId','Standort-ID (optional bei einem Garten)'],['doorWhileMowing','Torposition beim Mähen (%)'],['refreshToken','Token erneuern (1)'],
];
const outputDefs=[
  ['statustext','Status Text'],['garagedoor','Garagentor (0=öffnen / 100=schließen)'],['status','Mäher aktiv (0/1)'],
  ['next_start_date','Nächster Start Datum (API nicht verfügbar)'],['next_start_time','Nächster Start Zeit (API nicht verfügbar)'],['next_start_rest','Nächster Start Rest (API nicht verfügbar)'],
  ['error','Gerätefehler'],['battery','Batterie (%)'],['charging','Batterie lädt (0/1)'],['signal_quality','Signalqualität (%)'],['debug','Diagnose / Geräte-IDs'],
  ['cutting_time','Mähzeit (API nicht verfügbar)'],['charging_cycles','Ladezyklen (API nicht verfügbar)'],['collisions','Kollisionen (API nicht verfügbar)'],
  ['running_time','Betriebsstunden (h)'],['error_trigger','Gerätefehler (0/1)'],['temperature','Temperatur (°C)'],['light','Helligkeit (lx)'],['humidity','Bodenfeuchte (%)'],
  ['valve_open','Ventil offen (0/1)'],['manual_override','Manuelle Steuerung (API nicht verfügbar)'],['button_manual_override_time','Manuelle Minuten (API nicht verfügbar)'],
  ...[1,2,3,4,5,6].map(i=>[`watering_timer_${i}`,`SIC Ventil ${i} (0/1)`]),
  ...[1,2,3,4,5,6].map(i=>[`watering_timer_${i}_duration`,`Restzeit Ventil ${i} (API nicht verfügbar)`]),
];
module.exports={
  type:'gardena',label:'Gardena',category:'Geräte',color:'#f97316',
  description:'Gardena smart system API v2 mit OAuth2 und WebSocket. Globale Application Key/Secret, pro Node eine Geräte-ID. Mähen, Regenpause, Torfreigabe, Sensoren und bis zu sechs Ventile. Nicht von der öffentlichen API angebotene Ausgänge bleiben unbelegt. Eingang 20 ist jetzt Standort-ID statt Webserver-Port.',
  inputs:inputDefs.map(([handle,label])=>({handle,label})),outputs:outputDefs.map(([handle,label])=>({handle,label})),
  globalSettings:[{key:'clientId',label:'Application Key',type:'text'},{key:'clientSecret',label:'Application Secret',type:'password'},{key:'locationId',label:'Standort-ID (optional bei einem Garten)',type:'text'}],
  config:[
    {key:'clientId',label:'Application Key (optional, überschreibt global)',type:'text'},
    {key:'clientSecret',label:'Application Secret (optional, überschreibt global)',type:'password'},
    {key:'deviceId',label:'Geräte-ID (leer: IDs in Diagnoseausgang)',type:'text'},
    {key:'locationId',label:'Standort-ID (optional)',type:'text'},
    {key:'mowHours',label:'Mähdauer in Stunden (Standard 24)',type:'number',placeholder:'24'},
    {key:'waterMinutes',label:'Bewässerungsdauer in Minuten (Standard 30)',type:'number',placeholder:'30'},
  ],
  execute(inputs,data,context) {
    const id=context.nodeId||'default';let s=nodes.get(id);
    const previous=s?.stored || context.initialInputs || {};
    const stored={...previous,...inputs};
    const pick=(key,fallback)=>[stored[key],data[key],context.globalSetting?.(key),fallback].find(v=>v!==undefined && v!==null && v!=='');
    const cfg=Object.fromEntries(['clientId','clientSecret','deviceId','locationId'].map(k=>[k,String(pick(k,'')).trim()]));
    cfg.locationId=[stored.locationId,data.locationId,context.globalSetting?.('locationId')].map(locationSetting).find(Boolean)||'';
    if(!s || JSON.stringify(cfg)!==JSON.stringify(s.cfg)) {
      if(s)detach(s);
      s={cfg,context,stored,inputs:{},outputs:{},disposed:false,pendingStart:false};nodes.set(id,s);
      if(cfg.clientId && cfg.clientSecret) {
        const accountId=crypto.createHash('sha256').update(JSON.stringify([cfg.clientId,cfg.clientSecret,cfg.locationId])).digest('hex');
        let a=accounts.get(accountId);
        if(!a) {
          a={id:accountId,key:cfg.clientId,secret:cfg.clientSecret,configuredLocation:cfg.locationId,location:cfg.locationId,nodes:new Set(),resources:new Map(),requests:new Set(),queue:Promise.resolve(),failures:0,online:false,disposed:false};
          accounts.set(accountId,a);
        }
        s.account=a;a.nodes.add(s);
      }
    }
    s.context=context;s.stored=stored;
    s.inputs={...stored,mowHours:pick('mowHours',24),waterMinutes:pick('waterMinutes',30),safety:pick('safety',1),doorPosition:pick('doorPosition',-1),doorWhileMowing:pick('doorWhileMowing',0)};
    if(!s.account) {context.setNodeStatus?.(false);emit(s,'debug','Application Key und Secret fehlen');return {};}
    const a=s.account;
    if(!a.online && !a.connecting && !a.retryTimer)void connect(a);
    else if(a.online)report(s);
    const actions=['mow','triggerStatus','doorState','rain','valve',...Array.from({length:6},(_,i)=>`valve${i+1}`),'refreshToken'];
    if(context.triggerHandle==='_config')return {};
    for(const h of actions) {
      if(inputs[h]===undefined)continue;
      if(context.triggerHandle!=null ? context.triggerHandle===h : inputs[h]!==previous[h])enqueue(s,h,inputs[h]);
    }
    return {};
  },
  dispose(nodeId) {
    if(nodeId!=null){const s=nodes.get(nodeId);if(s)detach(s);nodes.delete(nodeId);}
    else {for(const s of nodes.values())detach(s);nodes.clear();}
  },
};
