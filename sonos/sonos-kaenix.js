/**
 * @plugin    Sonos Player
 * @version   1.0.10
 * @author    Christian Brauwers
 * @website   https://www.kaenix.net
 */

'use strict';

const http = require('http');

// ── Modulweiter Zustand pro Node-Instanz ──────────────────────────────────────

const _states = new Map();

function getState(nodeId) {
  if (!_states.has(nodeId)) {
    _states.set(nodeId, {
      emit:          null,
      warn:          null,
      log:           null,
      nodeLog:       null,
      setStatus:     null,
      prevInputs:    {},
      prevEmitted:   {},     // send-by-change
      timer:         null,
      ip:            null,
      port:          1400,
      state:         'stop', // 'play' | 'pause' | 'stop' | 'transitioning'
      isPlaying:     0,
      volume:        0,
      mute:          0,
      title:         '',
      artist:        '',
      album:         '',
      streamContent: '',
      imageUrl:      '',
      trackText:     '',
      duration:      '',
      position:      '',
      shuffle:       0,
      repeat:        0,
      uri:           '',
      isFetching:    false,
      cfg:           null,
      favorites:     [],
      favoritesReadAt: 0,
    });
  }
  return _states.get(nodeId);
}

// ── XML & SOAP Hilfsfunktionen ─────────────────────────────────────────────────

function unescapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

// Nur die äußere DIDL-Hülle dekodieren. resMD enthält wiederum XML als Text;
// zu frühes Entpacken verschachtelt dessen item-Tags mit dem Favoriten-item.
function decodeDidl(value) {
  let xml = (value || '').trim();
  for (let i = 0; i < 3 && xml.startsWith('&'); i++) xml = unescapeXml(xml);
  return xml;
}

function metadataImage(xml) {
  return getXmlTag(xml, 'albumArtURI') || getXmlTag(xml, 'logo') || '';
}

function isRadioSource(uri, metadata = '') {
  return /^(?:x-rincon-mp3radio|x-sonosapi-stream|x-sonosapi-radio|x-sonosapi-hls):/i.test(uri) ||
    /audioBroadcast/i.test(getXmlTag(metadata, 'class') || '');
}

async function readFavorites(cfg, state, force = false) {
  if (!force && Date.now() - state.favoritesReadAt < 60000) return state.favorites;
  state.favoritesReadAt = Date.now();
  const items = [];
  for (let start = 0; ; ) {
    const res = await soapRequest(cfg.ip, cfg.port,
      'urn:schemas-upnp-org:service:ContentDirectory:1', '/MediaServer/ContentDirectory/Control', 'Browse',
      `<ObjectID>FV:2</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>${start}</StartingIndex><RequestedCount>100</RequestedCount><SortCriteria></SortCriteria>`, 3500);
    if (res.status !== 200) throw new Error(`Favoriten HTTP ${res.status}`);
    const page = getAllXmlTags(decodeDidl(getXmlTag(res.body, 'Result')), 'item');
    items.push(...page);
    const count = Number(getXmlTag(res.body, 'NumberReturned')) || page.length;
    start += count;
    if (!page.length || !count || start >= (Number(getXmlTag(res.body, 'TotalMatches')) || start)) break;
  }
  state.favorites = items;
  return items;
}

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getXmlTag(xml, tag) {
  if (!xml || typeof xml !== 'string') return null;
  // Unterstützt Tags mit oder ohne XML-Namespaces (z.B. dc:title, upnp:artist, CurrentVolume)
  const escapedTag = tag.replace(':', '\\:');
  const m = xml.match(new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${escapedTag}>`, 'i'));
  return m ? unescapeXml(m[1].trim()) : null;
}

function getAllXmlTags(xml, tag) {
  if (!xml || typeof xml !== 'string') return [];
  const escapedTag = tag.replace(':', '\\:');
  const regex = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${escapedTag}>`, 'gi');
  const results = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

// Radio liefert den laufenden Titel häufig als „Interpret - Titel“ in
// r:streamContent; dc:title enthält dann nur den Sendernamen.
function normalizeTrackInfo(title, artist, streamContent) {
  const content = (streamContent || '').trim();
  const hasRadioContent = content && !/^ZPSTR_/i.test(content) && content !== 'NOT_IMPLEMENTED';
  if (hasRadioContent) {
    // Nur am ersten Trennzeichen teilen: Bindestriche im Titel bleiben erhalten.
    const parts = content.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (parts) {
      artist = parts[1].trim();
      title = parts[2].trim();
    } else {
      // Freitext (z.B. Sendungsname) nicht als erfundenen Interpreten ausgeben.
      title = content;
      artist = '';
    }
  }
  return {
    title,
    artist,
    trackText: artist && title ? `${artist} - ${title}` : title || artist || '',
  };
}

// ── UPnP / SOAP HTTP-Request ──────────────────────────────────────────────────

function soapRequest(ip, port, serviceType, controlPath, action, argsXml = '', timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const soapBody =
      '<?xml version="1.0" encoding="utf-8"?>\r\n' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
        '<s:Body>' +
          `<u:${action} xmlns:u="${serviceType}">` +
            argsXml +
          `</u:${action}>` +
        '</s:Body>' +
      '</s:Envelope>';

    const req = http.request(
      {
        hostname: ip,
        port: port || 1400,
        path: controlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'SOAPAction': `"${serviceType}#${action}"`,
          'Content-Length': Buffer.byteLength(soapBody),
          'Connection': 'close',
          'User-Agent': 'kaenix-sonos-plugin/1.0',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP Timeout'));
    });

    req.write(soapBody);
    req.end();
  });
}

// ── Status abrufen und Outputs emittieren ──────────────────────────────────────

// Polling darf identische Statusmeldungen nicht wiederholt ins Debug-Log schreiben.
function logStatusChange(state, message) {
  if (state.prevEmitted._debugStatus === message) return;
  state.prevEmitted._debugStatus = message;
  state.nodeLog?.(message);
}

function emitStatus(data, state, cfg) {
  if (!state.emit || !data) return;

  delete state.prevEmitted._connectionError;
  state.setStatus?.(true);
  state.state         = data.state;
  state.isPlaying     = data.isPlaying;
  state.volume        = data.volume;
  state.mute          = data.mute;
  state.title         = data.title;
  state.artist        = data.artist;
  state.album         = data.album;
  state.streamContent = data.streamContent;
  state.imageUrl      = data.imageUrl;
  state.trackText     = data.trackText;
  state.duration      = data.duration;
  state.position      = data.position;
  state.shuffle       = data.shuffle;
  state.repeat        = data.repeat;
  state.uri           = data.uri;

  // Send-by-change Helfer
  const changed = (handle, value) => {
    if (value === undefined) return false;
    const cur = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
    if (state.prevEmitted[handle] === cur) return false;
    state.prevEmitted[handle] = cur;
    return true;
  };

  if (changed('connected', 1))              state.emit('connected', 1);
  if (changed('isPlaying', data.isPlaying)) state.emit('isPlaying', data.isPlaying);
  if (changed('state', data.state))         state.emit('state', data.state);
  if (changed('volume', data.volume))       state.emit('volume', data.volume);
  if (changed('mute', data.mute))           state.emit('mute', data.mute);
  if (changed('title', data.title))         state.emit('title', data.title);
  if (changed('artist', data.artist))       state.emit('artist', data.artist);
  if (changed('album', data.album))         state.emit('album', data.album);
  if (changed('streamContent', data.streamContent)) state.emit('streamContent', data.streamContent);
  if (changed('imageUrl', data.imageUrl))   state.emit('imageUrl', data.imageUrl);
  if (changed('trackText', data.trackText)) state.emit('trackText', data.trackText);
  if (changed('duration', data.duration))   state.emit('duration', data.duration);
  if (changed('position', data.position))   state.emit('position', data.position);
  if (changed('shuffle', data.shuffle))     state.emit('shuffle', data.shuffle);
  if (changed('repeat', data.repeat))       state.emit('repeat', data.repeat);
  if (changed('uri', data.uri))             state.emit('uri', data.uri);

  // Status nur bei Änderung in der zentralen Debug-Ansicht ausgeben
  const stateIcon = data.isPlaying ? '▶' : (data.state === 'pause' ? '⏸' : '⏹');
  const shortInfo = data.trackText
    ? data.trackText
    : data.state;
  logStatusChange(state, `${stateIcon} ${shortInfo} (${data.volume}%)`);
}

async function fetchStatus(cfg, state) {
  if (!cfg.ip || state.isFetching || state.disposed) return;
  state.isFetching = true;

  try {
    const avTransportService = 'urn:schemas-upnp-org:service:AVTransport:1';
    const avTransportPath    = '/MediaRenderer/AVTransport/Control';
    const renderingService   = 'urn:schemas-upnp-org:service:RenderingControl:1';
    const renderingPath      = '/MediaRenderer/RenderingControl/Control';

    const [resTransport, resPosition, resVolume, resMute, resSettings, resMedia] = await Promise.allSettled([
      soapRequest(cfg.ip, cfg.port, avTransportService, avTransportPath, 'GetTransportInfo', '<InstanceID>0</InstanceID>', 3500),
      soapRequest(cfg.ip, cfg.port, avTransportService, avTransportPath, 'GetPositionInfo', '<InstanceID>0</InstanceID>', 3500),
      soapRequest(cfg.ip, cfg.port, renderingService, renderingPath, 'GetVolume', '<InstanceID>0</InstanceID><Channel>Master</Channel>', 3500),
      soapRequest(cfg.ip, cfg.port, renderingService, renderingPath, 'GetMute', '<InstanceID>0</InstanceID><Channel>Master</Channel>', 3500),
      soapRequest(cfg.ip, cfg.port, avTransportService, avTransportPath, 'GetTransportSettings', '<InstanceID>0</InstanceID>', 3500),
      soapRequest(cfg.ip, cfg.port, avTransportService, avTransportPath, 'GetMediaInfo', '<InstanceID>0</InstanceID>', 3500),
    ]);

    const hasAnySuccess = (resTransport.status === 'fulfilled' && resTransport.value.status === 200) ||
                          (resPosition.status === 'fulfilled' && resPosition.value.status === 200) ||
                          (resVolume.status === 'fulfilled' && resVolume.value.status === 200);

    if (!hasAnySuccess) {
      const errReason = resTransport.reason || resPosition.reason || resVolume.reason || new Error('Keine Antwort');
      handleConnectionError(state, errReason);
      state.isFetching = false;
      return;
    }

    // 1. Transport State (PLAYING, PAUSED_PLAYBACK, STOPPED, TRANSITIONING)
    let rawState = 'stop';
    if (resTransport.status === 'fulfilled' && resTransport.value.status === 200) {
      const tState = (getXmlTag(resTransport.value.body, 'CurrentTransportState') || '').toUpperCase();
      if (tState === 'PLAYING') {
        rawState = 'play';
      } else if (tState === 'PAUSED_PLAYBACK' || tState === 'PAUSED') {
        rawState = 'pause';
      } else if (tState === 'TRANSITIONING') {
        rawState = 'transitioning';
      } else {
        rawState = 'stop';
      }
    }
    const isPlaying = (rawState === 'play' || rawState === 'transitioning') ? 1 : 0;

    // 2. Position & Metadata (DIDL-Lite)
    let title         = '';
    let artist        = '';
    let album         = '';
    let streamContent = '';
    let image         = '';
    let duration      = '';
    let position      = '';
    let uri           = '';
    let trackClass    = '';

    if (resPosition.status === 'fulfilled' && resPosition.value.status === 200) {
      const pBody = resPosition.value.body;
      duration = getXmlTag(pBody, 'TrackDuration') || '';
      position = getXmlTag(pBody, 'RelTime') || '';
      uri      = getXmlTag(pBody, 'TrackURI') || '';

      const trackMetaRaw = getXmlTag(pBody, 'TrackMetaData');
      if (trackMetaRaw) {
        // DIDL-Lite entpacken (ist oft doppelt escaped im SOAP-Body)
        const didl = decodeDidl(trackMetaRaw);
        title         = getXmlTag(didl, 'title') || '';
        artist        = getXmlTag(didl, 'creator') || getXmlTag(didl, 'artist') || '';
        album         = getXmlTag(didl, 'album') || '';
        streamContent = getXmlTag(didl, 'streamContent') || '';
        image         = metadataImage(didl);
        trackClass    = getXmlTag(didl, 'class') || '';
      }
    }

    // Sendername und Senderlogo stehen bei Radio häufig in den Transport-
    // Metadaten statt in den Metadaten des gerade laufenden Titels.
    let mediaUri = '';
    let mediaMeta = '';
    if (resMedia.status === 'fulfilled' && resMedia.value.status === 200) {
      mediaUri = getXmlTag(resMedia.value.body, 'CurrentURI') || '';
      mediaMeta = decodeDidl(getXmlTag(resMedia.value.body, 'CurrentURIMetaData'));
    }
    let isRadio = isRadioSource(mediaUri, mediaMeta) || isRadioSource(uri) || /audioBroadcast/i.test(trackClass);
    let stationTitle = getXmlTag(mediaMeta, 'title') || '';
    const stationImage = metadataImage(mediaMeta);
    // Das Logo ist oft nur am äußeren Favoriten gespeichert, nicht in resMD.
    // Auch bei Start über die Sonos-App anhand der aktuellen URI zuordnen.
    if ((isRadio && (!stationTitle || !stationImage)) ||
        (!isRadio && /^https?:/i.test(mediaUri || uri) && !stationTitle)) {
      let favorites = state.favorites;
      try { favorites = await readFavorites(cfg, state); } catch (_) { /* Zusatzdaten optional */ }
      const currentUri = mediaUri || uri;
      const favorite = currentUri && favorites.find(item => getXmlTag(item, 'res') === currentUri);
      if (favorite) {
        const favoriteMeta = decodeDidl(getXmlTag(favorite, 'resMD'));
        isRadio = isRadio || isRadioSource(currentUri, favoriteMeta);
        if (isRadio) {
          stationTitle = stationTitle || getXmlTag(favorite, 'title') || getXmlTag(favoriteMeta, 'title') || '';
          image = stationImage || metadataImage(favorite) || metadataImage(favoriteMeta) || image;
        }
      }
    }
    if (isRadio) image = stationImage || image;
    // Track-Titel nur bei expliziten Sender-Metadaten als Sendername verwenden.
    // Sonst wäre der gerade laufende Song fälschlich wieder der Stationsname.
    if (!stationTitle && /audioBroadcast/i.test(trackClass)) stationTitle = title;

    // 3. Volume
    let volume = state.volume || 0;
    if (resVolume.status === 'fulfilled' && resVolume.value.status === 200) {
      const rawVol = getXmlTag(resVolume.value.body, 'CurrentVolume');
      if (rawVol != null && rawVol !== '') {
        volume = Math.max(0, Math.min(100, parseInt(rawVol, 10) || 0));
      }
    }

    // 4. Mute
    let mute = state.mute || 0;
    if (resMute.status === 'fulfilled' && resMute.value.status === 200) {
      const rawMute = getXmlTag(resMute.value.body, 'CurrentMute');
      if (rawMute != null) {
        mute = (rawMute === '1' || rawMute === 'true') ? 1 : 0;
      }
    }

    // 5. PlayMode (Shuffle / Repeat)
    let shuffle = 0;
    let repeat  = 0;
    if (resSettings.status === 'fulfilled' && resSettings.value.status === 200) {
      const playMode = (getXmlTag(resSettings.value.body, 'PlayMode') || '').toUpperCase();
      if (playMode.includes('SHUFFLE')) {
        shuffle = 1;
      }
      if (playMode === 'REPEAT_ALL' || playMode === 'SHUFFLE') {
        repeat = 1;
      } else if (playMode === 'REPEAT_ONE' || playMode === 'SHUFFLE_REPEAT_ONE') {
        repeat = 2;
      } else {
        repeat = 0;
      }
    }

    // Titel und Interpret bleiben bei Radio stabil; die Titelanzeige zeigt
    // dagegen den laufenden Song aus den Stream-Metadaten.
    const trackInfo = isRadio
      ? normalizeTrackInfo(stationTitle, '', streamContent)
      : normalizeTrackInfo(title, artist, '');
    title = isRadio ? stationTitle : trackInfo.title;
    artist = isRadio ? '' : trackInfo.artist;
    const trackText = trackInfo.trackText || title;

    // Vollständige Cover-Image-URL zusammensetzen
    let fullImageUrl = image;
    if (fullImageUrl && fullImageUrl.startsWith('/')) {
      fullImageUrl = `http://${cfg.ip}:${cfg.port || 1400}${fullImageUrl}`;
    }

    emitStatus({
      state: rawState,
      isPlaying,
      volume,
      mute,
      title,
      artist,
      album,
      streamContent,
      imageUrl: fullImageUrl,
      trackText,
      duration,
      position,
      shuffle,
      repeat,
      uri,
    }, state, cfg);

  } catch (e) {
    handleConnectionError(state, e);
  } finally {
    state.isFetching = false;
  }
}

function handleConnectionError(state, err) {
  if (state.prevEmitted['connected'] !== '0') {
    state.prevEmitted['connected'] = '0';
    state.emit?.('connected', 0);
  }
  state.setStatus?.(false);
  logStatusChange(state, '✗ getrennt');
  if (state.prevEmitted._connectionError !== err.message) {
    state.prevEmitted._connectionError = err.message;
    state.warn?.(`Sonos Verbindungsfehler: ${err.message}`);
  }
}

// ── Steuerbefehle (Sonos UPnP Actions) ─────────────────────────────────────────

async function sendSonosAction(cfg, state, serviceType, controlPath, action, argsXml = '') {
  if (!cfg.ip) {
    state.warn?.('Sonos IP-Adresse nicht konfiguriert');
    return;
  }
  try {
    await soapRequest(cfg.ip, cfg.port, serviceType, controlPath, action, argsXml, 4000);
    setTimeout(() => {
      fetchStatus(cfg, state);
    }, 250);
  } catch (e) {
    state.warn?.(`Sonos Befehl (${action}) fehlgeschlagen: ${e.message}`);
  }
}

// ── Transport Controls ──

async function cmdPlay(cfg, state) {
  await sendSonosAction(
    cfg,
    state,
    'urn:schemas-upnp-org:service:AVTransport:1',
    '/MediaRenderer/AVTransport/Control',
    'Play',
    '<InstanceID>0</InstanceID><Speed>1</Speed>'
  );
}

async function cmdPause(cfg, state) {
  await sendSonosAction(
    cfg,
    state,
    'urn:schemas-upnp-org:service:AVTransport:1',
    '/MediaRenderer/AVTransport/Control',
    'Pause',
    '<InstanceID>0</InstanceID>'
  );
}

async function cmdStop(cfg, state) {
  await sendSonosAction(
    cfg,
    state,
    'urn:schemas-upnp-org:service:AVTransport:1',
    '/MediaRenderer/AVTransport/Control',
    'Stop',
    '<InstanceID>0</InstanceID>'
  );
}

async function cmdPlayPause(cfg, state) {
  if (state.isPlaying) {
    await cmdPause(cfg, state);
  } else {
    await cmdPlay(cfg, state);
  }
}

async function cmdNext(cfg, state) {
  await sendSonosAction(
    cfg,
    state,
    'urn:schemas-upnp-org:service:AVTransport:1',
    '/MediaRenderer/AVTransport/Control',
    'Next',
    '<InstanceID>0</InstanceID>'
  );
}

async function cmdPrev(cfg, state) {
  await sendSonosAction(
    cfg,
    state,
    'urn:schemas-upnp-org:service:AVTransport:1',
    '/MediaRenderer/AVTransport/Control',
    'Previous',
    '<InstanceID>0</InstanceID>'
  );
}

// ── Volume & Mute ──

async function cmdVolume(cfg, state, volume) {
  const level = Math.max(0, Math.min(100, parseInt(volume, 10) || 0));
  await sendSonosAction(
    cfg,
    state,
    'urn:schemas-upnp-org:service:RenderingControl:1',
    '/MediaRenderer/RenderingControl/Control',
    'SetVolume',
    `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${level}</DesiredVolume>`
  );
}

async function cmdVolumeInc(cfg, state, step = 2) {
  const s = Math.max(1, parseInt(step, 10) || 2);
  const newVol = Math.min(100, (state.volume || 0) + s);
  await cmdVolume(cfg, state, newVol);
}

async function cmdVolumeDec(cfg, state, step = 2) {
  const s = Math.max(1, parseInt(step, 10) || 2);
  const newVol = Math.max(0, (state.volume || 0) - s);
  await cmdVolume(cfg, state, newVol);
}

// KNX 4-Bit Relativdimmer (DPT 3.007):
// Bit 3 = Richtung (1=lauter, 0=leiser), Bits 0–2 = Schrittweite (1–7)
// Byte 0x00 = Stopp-Telegramm
async function cmdDim(cfg, state, val) {
  const byte = typeof val === 'number' ? val & 0xFF : parseInt(val, 10) & 0xFF;
  const step = byte & 0x07;
  if (step === 0) return; // Stopp-Telegramm

  const direction = (byte & 0x08) ? 1 : -1;
  const factor = cfg.volumeStep || 2;
  const change = step * factor;

  if (direction > 0) {
    await cmdVolumeInc(cfg, state, change);
  } else {
    await cmdVolumeDec(cfg, state, change);
  }
}

async function cmdMute(cfg, state, val) {
  const muteVal = (val === 1 || val === '1' || val === true) ? 1 : 0;
  await sendSonosAction(
    cfg,
    state,
    'urn:schemas-upnp-org:service:RenderingControl:1',
    '/MediaRenderer/RenderingControl/Control',
    'SetMute',
    `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>${muteVal}</DesiredMute>`
  );
}

async function cmdMuteToggle(cfg, state) {
  const newMute = state.mute ? 0 : 1;
  await cmdMute(cfg, state, newMute);
}

// ── Shuffle & Repeat ──

async function updatePlayMode(cfg, state, targetShuffle, targetRepeat) {
  let mode = 'NORMAL';
  if (targetShuffle) {
    if (targetRepeat === 2) mode = 'SHUFFLE_REPEAT_ONE';
    else if (targetRepeat === 1) mode = 'SHUFFLE';
    else mode = 'SHUFFLE_NOREPEAT';
  } else {
    if (targetRepeat === 2) mode = 'REPEAT_ONE';
    else if (targetRepeat === 1) mode = 'REPEAT_ALL';
    else mode = 'NORMAL';
  }

  await sendSonosAction(
    cfg,
    state,
    'urn:schemas-upnp-org:service:AVTransport:1',
    '/MediaRenderer/AVTransport/Control',
    'SetPlayMode',
    `<InstanceID>0</InstanceID><NewPlayMode>${mode}</NewPlayMode>`
  );
}

async function cmdShuffle(cfg, state, val) {
  const s = (val === 1 || val === '1' || val === true) ? 1 : 0;
  await updatePlayMode(cfg, state, s, state.repeat || 0);
}

async function cmdRepeat(cfg, state, val) {
  let rep = 0;
  const num = parseInt(val, 10);
  if (val === 'all' || num === 1) {
    rep = 1;
  } else if (val === 'one' || num === 2) {
    rep = 2;
  }
  await updatePlayMode(cfg, state, state.shuffle || 0, rep);
}

// ── URI & Sonos Favoriten / Presets ──

async function cmdPlayUri(cfg, state, uri, metaXml = '') {
  if (!uri) return;
  const cleanUri = String(uri).trim();
  const escapedUri = escapeXml(cleanUri);
  const escapedMeta = metaXml ? escapeXml(metaXml) : '';

  try {
    await soapRequest(
      cfg.ip,
      cfg.port,
      'urn:schemas-upnp-org:service:AVTransport:1',
      '/MediaRenderer/AVTransport/Control',
      'SetAVTransportURI',
      `<InstanceID>0</InstanceID><CurrentURI>${escapedUri}</CurrentURI><CurrentURIMetaData>${escapedMeta}</CurrentURIMetaData>`,
      4000
    );
    await cmdPlay(cfg, state);
  } catch (e) {
    state.warn?.(`Sonos Play URI fehlgeschlagen: ${e.message}`);
  }
}

async function cmdFavorite(cfg, state, favIdentifier) {
  if (!favIdentifier) return;
  if (!cfg.ip) {
    state.warn?.('Sonos IP-Adresse nicht konfiguriert');
    return;
  }

  try {
    // Metadaten inklusive äußerem Senderlogo für das Status-Polling behalten.
    const items = await readFavorites(cfg, state, true);
    if (!items || items.length === 0) {
      state.warn?.('Keine Sonos Favoriten in der Liste');
      return;
    }

    let targetItem = null;
    const num = parseInt(favIdentifier, 10);

    if (!isNaN(num) && num >= 1 && num <= items.length) {
      // Index 1..N
      targetItem = items[num - 1];
    } else {
      // Namenssuche
      const searchStr = String(favIdentifier).trim().toLowerCase();
      targetItem = items.find((it) => {
        const title = (getXmlTag(it, 'title') || '').toLowerCase();
        return title === searchStr || title.includes(searchStr);
      });
    }

    if (!targetItem) {
      state.warn?.(`Sonos Favorit "${favIdentifier}" nicht gefunden`);
      return;
    }

    const uri = getXmlTag(targetItem, 'res');
    const meta = getXmlTag(targetItem, 'resMD') || '';

    if (!uri) {
      state.warn?.('Favorit enthält keine gültige URI');
      return;
    }

    await cmdPlayUri(cfg, state, uri, meta);

  } catch (e) {
    state.warn?.(`Sonos Favorit abrufen fehlgeschlagen: ${e.message}`);
  }
}

// ── Plugin-Export ──────────────────────────────────────────────────────────────

module.exports = {
  dispose(nodeId) {
    const ids = nodeId == null ? [..._states.keys()] : [nodeId];
    for (const id of ids) {
      const state = _states.get(id);
      if (!state) continue;
      clearInterval(state.timer);
      state.disposed = true;
      state.emit = null;
      state.warn = null;
      state.nodeLog = null;
      state.setStatus = null;
      _states.delete(id);
    }
  },
  type:        'sonos',
  category:    'Geräte',
  label:       'Sonos Player',
  description: 'Steuert Sonos-Lautsprecher (Play:1, Play:3, Play:5, One, Move, Roam, Beam, Arc, Era etc.) ' +
               'über die lokale UPnP/SOAP HTTP-Schnittstelle. Unterstützt Play, Pause, Stop, Next/Prev, ' +
               'Lautstärke (absolut, relativ, KNX 4-Bit DPT 3.007 Dimmer), Mute, Favoriten/Presets, ' +
               'Shuffle, Repeat, Direkt-URI und Status-Polling.',
  color:       '#D97706',

  inputs: [
    { handle: 'play',          label: 'Play (Trigger)' },
    { handle: 'pause',         label: 'Pause (Trigger)' },
    { handle: 'stop',          label: 'Stop (Trigger)' },
    { handle: 'playPause',     label: 'Play/Pause Toggle (0/1-Wechsel)' },
    { handle: 'next',          label: 'Nächster Titel (Trigger)' },
    { handle: 'prev',          label: 'Vorheriger Titel (Trigger)' },
    { handle: 'volume',        label: 'Lautstärke (0–100 %)' },
    { handle: 'volumeInc',     label: 'Lauter (Trigger)' },
    { handle: 'volumeDec',     label: 'Leiser (Trigger)' },
    { handle: 'dim',           label: 'Lautstärke Dimmer (KNX 4-Bit DPT 3.007)' },
    { handle: 'mute',          label: 'Stumm (0=Ton, 1=Mute)' },
    { handle: 'muteToggle',    label: 'Mute Toggle (Trigger)' },
    { handle: 'favorite',      label: 'Favorit / Preset (1–N oder Name)' },
    { handle: 'playUri',       label: 'Audio / Radio URI abspielen' },
    { handle: 'shuffle',       label: 'Zufallswiedergabe (0/1)' },
    { handle: 'repeat',        label: 'Wiederholung (0=Aus, 1=Alle, 2=Titel)' },
    { handle: 'triggerStatus', label: 'Status abfragen (Trigger)' },
  ],

  outputs: [
    { handle: 'connected',     label: 'Verbunden (0/1)' },
    { handle: 'isPlaying',     label: 'Wiedergabe aktiv (0/1)' },
    { handle: 'state',         label: 'Status (play/pause/stop/transitioning)' },
    { handle: 'volume',        label: 'Lautstärke (0–100 %)' },
    { handle: 'mute',          label: 'Stumm (0/1)' },
    { handle: 'title',         label: 'Titel / Song / Sender' },
    { handle: 'artist',        label: 'Künstler / Interpret' },
    { handle: 'album',         label: 'Album' },
    { handle: 'streamContent', label: 'Stream-Info (Radio-Titel)' },
    { handle: 'imageUrl',      label: 'Cover Art URL' },
    { handle: 'trackText',     label: 'Titelanzeige (Artist - Title)' },
    { handle: 'duration',      label: 'Titel-Gesamtlaufzeit' },
    { handle: 'position',      label: 'Aktuelle Position' },
    { handle: 'shuffle',       label: 'Shuffle (0/1)' },
    { handle: 'repeat',        label: 'Repeat (0/1/2)' },
    { handle: 'uri',           label: 'Aktuelle Track/Stream URI' },
  ],

  globalSettings: [
    {
      key:         'ip',
      label:       'Sonos Player IP-Adresse',
      type:        'text',
      placeholder: '192.168.1.50',
      description: 'Standard-IP-Adresse des Sonos Players',
    },
    {
      key:         'port',
      label:       'Port',
      type:        'number',
      placeholder: '1400',
      description: 'Standard-Port der Sonos HTTP-API (1400)',
    },
  ],

  config: [
    {
      key:         'ip',
      label:       'IP-Adresse (überschreibt globale Einstellung)',
      type:        'text',
      placeholder: '192.168.1.50',
    },
    {
      key:         'port',
      label:       'Port (Standard: 1400)',
      type:        'number',
      placeholder: '1400',
    },
    {
      key:         'volumeStep',
      label:       'Schrittweite für Lauter/Leiser %',
      type:        'number',
      placeholder: '2',
      default:     2,
    },
    {
      key:         'interval',
      label:       'Status-Polling Intervall in Sekunden (0 = aus)',
      type:        'number',
      placeholder: '3',
      default:     3,
    },
  ],

  execute(inputs, data, context) {
    const nodeId = context.nodeId || 'default';
    const state  = getState(nodeId);

    // Callbacks aktualisieren
    state.emit      = (h, v) => context.emitOutput(h, v);
    state.warn      = (...a) => context.warn(...a);
    state.log       = (...a) => context.log(...a);
    state.nodeLog   = (...a) => context.nodeLog(...a);
    state.setStatus = (connected) => context.setNodeStatus(connected);

    // Konfiguration zusammenführen
    const cfg = {
      ip:         (data.ip && String(data.ip).trim()) || (context.globalSetting('ip') || '').trim(),
      port:       parseInt(data.port || context.globalSetting('port') || '1400', 10),
      volumeStep: parseInt(data.volumeStep || '2', 10),
      interval:   parseInt(data.interval != null ? data.interval : '3', 10),
    };
    state.cfg = cfg;

    if (!cfg.ip) {
      context.warn('Sonos IP-Adresse nicht konfiguriert (weder in Node-Config noch in globalen Einstellungen)');
      context.nodeLog('✗ Keine IP');
      context.setNodeStatus(false);
      return {};
    }

    // Verbindungsparameter geändert → Zustand zurücksetzen
    const endpointChanged = state.ip !== cfg.ip || state.port !== cfg.port;
    if (endpointChanged) {
      state.ip = cfg.ip;
      state.port = cfg.port;
      state.prevEmitted = {};
      state.favorites = [];
      state.favoritesReadAt = 0;
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
    }

    // Polling initialisieren
    if (cfg.interval > 0) {
      if (!state.timer) {
        state.timer = setInterval(() => fetchStatus(cfg, state), cfg.interval * 1000);
        fetchStatus(cfg, state);
      }
    } else if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }

    // Beim Reload nur Polling starten und die Flankenerkennung wiederherstellen.
    // Ein bereits ausgewählter Favorit darf beim nächsten Signal nicht neu starten.
    if (context.initialInputs) {
      state.prevInputs = { ...context.initialInputs };
      return {};
    }

    // Prüfen, ob sich ein Eingang geändert hat (Flankenerkennung für Trigger & Wertänderungen)
    const prev = state.prevInputs;
    const isTriggered = (handle) => {
      const val = inputs[handle];
      if (val === undefined || val === null) return false;
      if (prev[handle] === val) return false;
      return !!val;
    };

    const hasChanged = (handle) => {
      const val = inputs[handle];
      if (val === undefined || val === null) return false;
      return prev[handle] !== val;
    };

    // ── Befehle ausführen ──

    if (isTriggered('play')) {
      cmdPlay(cfg, state);
    } else if (isTriggered('pause')) {
      cmdPause(cfg, state);
    } else if (isTriggered('stop')) {
      cmdStop(cfg, state);
    } else if (hasChanged('playPause')) {
      cmdPlayPause(cfg, state);
    } else if (isTriggered('next')) {
      cmdNext(cfg, state);
    } else if (isTriggered('prev')) {
      cmdPrev(cfg, state);
    } else if (isTriggered('volumeInc')) {
      cmdVolumeInc(cfg, state, cfg.volumeStep);
    } else if (isTriggered('volumeDec')) {
      cmdVolumeDec(cfg, state, cfg.volumeStep);
    } else if (isTriggered('muteToggle')) {
      cmdMuteToggle(cfg, state);
    } else if (isTriggered('triggerStatus')) {
      fetchStatus(cfg, state);
    }

    if (hasChanged('volume')) {
      cmdVolume(cfg, state, inputs.volume);
    }

    if (hasChanged('dim')) {
      cmdDim(cfg, state, inputs.dim);
    }

    if (hasChanged('mute')) {
      cmdMute(cfg, state, inputs.mute);
    }

    if (hasChanged('favorite')) {
      cmdFavorite(cfg, state, inputs.favorite);
    }

    if (hasChanged('playUri')) {
      cmdPlayUri(cfg, state, inputs.playUri);
    }

    if (hasChanged('shuffle')) {
      cmdShuffle(cfg, state, inputs.shuffle);
    }

    if (hasChanged('repeat')) {
      cmdRepeat(cfg, state, inputs.repeat);
    }

    // Aktuelle Inputs für nächsten Durchlauf merken
    state.prevInputs = { ...inputs };

    return {};
  },
};
