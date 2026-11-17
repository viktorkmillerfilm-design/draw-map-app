/* Draw Map — mobile-first PWA. Leaflet is bundled locally; drawings are real map layers. */
(function () {
  'use strict';

  var VIENNA = [48.2082, 16.3738];
  var DEFAULT_ZOOM = 13;
  var STORAGE_KEY = 'draw-map-app:v1';
  var TIP_KEY = 'draw-map-app:onboard-v2';
  var EARTH_R = 6378137;
  var COLORS = [
    '#e53935', '#fb8c00', '#fdd835', '#43a047',
    '#1e88e5', '#8e24aa', '#ffffff', '#212121'
  ];
  var LIGHT_COLORS = { '#ffffff': 1, '#fdd835': 1, '#fff': 1 };
  var DRAG_TOOLS = { pen: 1, rectangle: 1, circle: 1, route: 1 };
  var VERTEX_TOOLS = { line: 1, polygon: 1 };
  var MORE_TOOLS = { rectangle: 1, circle: 1, erase: 1 };
  var MAX_UNDO = 50;
  var MODE_KEY = 'draw-map-app:route-mode';
  var ROUTE_COLOR = '#1a73e8';
  var ROUTE_CASING = '#083570';
  var MATCH_RADIUS = 40;
  var MATCH_MAX_POINTS = 100;
  var ROUTE_MODES = {
    walk: {
      label: 'Walk',
      travelmode: 'walking',
      matchUrls: ['https://routing.openstreetmap.de/routed-foot/match/v1/foot'],
      routeUrls: ['https://routing.openstreetmap.de/routed-foot/route/v1/foot']
    },
    bike: {
      label: 'Bike',
      travelmode: 'bicycling',
      matchUrls: ['https://routing.openstreetmap.de/routed-bike/match/v1/bike'],
      routeUrls: ['https://routing.openstreetmap.de/routed-bike/route/v1/bike']
    },
    car: {
      label: 'Car',
      travelmode: 'driving',
      matchUrls: [
        'https://router.project-osrm.org/match/v1/driving',
        'https://routing.openstreetmap.de/routed-car/match/v1/driving'
      ],
      routeUrls: [
        'https://router.project-osrm.org/route/v1/driving',
        'https://routing.openstreetmap.de/routed-car/route/v1/driving'
      ]
    }
  };

  var map, lightStreetsLayer, darkStreetsLayer, satelliteLayer, drawn, draft, locateLayer;
  var currentBase = 'streets';
  var tool = 'pan';
  var color = COLORS[0];
  var weight = 4;
  var undoStack = [];
  var idSeq = 1;
  var searchMarker = null;
  var searchTimer = null;
  var lastSearchAt = 0;
  var toastTimer = null;
  var dragging = false;
  var dragPts = [];
  var dragStart = null;
  var draftLayer = null;
  var vertices = [];
  var vertexMarkers = [];
  var activePointer = null;
  var tapCandidate = null;
  var ignoreClickUntil = 0;
  var locateMarker = null;
  var routeMode = 'walk';
  var routePreview = null;
  var routeBusy = false;
  var routeLayerGroup = null;
  var routeCtl = null;
  var routeGen = 0;
  var searchCtl = null;
  var strokeRaf = 0;
  var strokeDirty = false;

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }

  function prefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyThemeMeta() {
    document.documentElement.dataset.theme = prefersDark() ? 'dark' : 'light';
    document.body.classList.toggle('is-dark', prefersDark());
  }


  function nowId() {
    idSeq += 1;
    return 'dm-' + Date.now().toString(36) + '-' + idSeq;
  }

  function toast(msg, ms) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    el.classList.remove('hidden');
    requestAnimationFrame(function () { el.classList.add('is-visible'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-visible');
      toastTimer = setTimeout(function () {
        el.classList.add('hidden');
        el.hidden = true;
      }, 220);
    }, ms || 2400);
  }

  function destPoint(latlng, bearingDeg, distM) {
    var br = bearingDeg * Math.PI / 180;
    var lat1 = latlng.lat * Math.PI / 180;
    var lon1 = latlng.lng * Math.PI / 180;
    var ang = distM / EARTH_R;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(br));
    var lon2 = lon1 + Math.atan2(
      Math.sin(br) * Math.sin(ang) * Math.cos(lat1),
      Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2)
    );
    return L.latLng(lat2 * 180 / Math.PI, ((lon2 * 180 / Math.PI + 540) % 360) - 180);
  }

  function haversine(a, b) {
    var r = Math.PI / 180;
    var dLat = (b.lat - a.lat) * r;
    var dLng = (b.lng - a.lng) * r;
    var s = Math.sin(dLat / 2);
    var t = Math.sin(dLng / 2);
    var h = s * s + Math.cos(a.lat * r) * Math.cos(b.lat * r) * t * t;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function pathLength(latlngs) {
    var n = 0;
    for (var i = 1; i < latlngs.length; i++) n += haversine(latlngs[i - 1], latlngs[i]);
    return n;
  }

  function geodesicArea(latlngs) {
    var pts = latlngs.slice();
    if (pts.length > 1) {
      var a = pts[0], b = pts[pts.length - 1];
      if (a.lat === b.lat && a.lng === b.lng) pts.pop();
    }
    if (pts.length < 3) return 0;
    var rad = Math.PI / 180;
    var area = 0;
    var len = pts.length;
    for (var i = 0; i < len; i++) {
      var p1 = pts[i];
      var p2 = pts[(i + 1) % len];
      area += (p2.lng - p1.lng) * rad * (2 + Math.sin(p1.lat * rad) + Math.sin(p2.lat * rad));
    }
    return Math.abs(area * EARTH_R * EARTH_R / 2);
  }

  function fmtDistance(m) {
    if (m < 1000) return Math.round(m) + ' m';
    if (m < 10000) return (m / 1000).toFixed(2) + ' km';
    return (m / 1000).toFixed(1) + ' km';
  }

  function fmtArea(m2) {
    if (m2 < 1e6) {
      return Math.round(m2).toLocaleString('de-AT') + ' m²';
    }
    return (m2 / 1e6).toFixed(m2 < 1e7 ? 2 : 1) + ' km²';
  }

  function fmtDuration(sec) {
    if (!isFinite(sec) || sec < 0) return '';
    var s = Math.round(sec);
    if (s < 30) return '< 1 min';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    var rm = m % 60;
    return rm ? (h + ' h ' + rm + ' min') : (h + ' h');
  }

  function flattenLatLngs(ll) {
    if (!ll || !ll.length) return [];
    var cur = ll;
    while (Array.isArray(cur) && cur.length && !(cur[0] instanceof L.LatLng) && typeof cur[0].lat !== 'number') {
      cur = cur[0];
    }
    if (cur.length && !(cur[0] instanceof L.LatLng) && typeof cur[0].lat === 'number') {
      return cur.map(function (p) { return L.latLng(p.lat, p.lng); });
    }
    return cur.slice();
  }

  function pathStyle(fill) {
    return {
      color: color,
      weight: weight,
      opacity: 0.95,
      fillColor: color,
      fillOpacity: fill ? 0.22 : 0,
      lineJoin: 'round',
      lineCap: 'round'
    };
  }

  function styleFromProps(p) {
    var fill = p.tool === 'polygon' || p.tool === 'rectangle' || p.tool === 'circle';
    return {
      color: p.color || '#e53935',
      weight: p.weight || 4,
      opacity: 0.95,
      fillColor: p.color || '#e53935',
      fillOpacity: fill ? 0.22 : 0,
      lineJoin: 'round',
      lineCap: 'round'
    };
  }

  /* Douglas-Peucker in metres via current zoom pixel epsilon */
  function simplify(latlngs, epsilonPx) {
    if (latlngs.length <= 2) return latlngs;
    var pts = latlngs.map(function (ll) { return map.latLngToLayerPoint(ll); });
    var keep = rdp(pts, epsilonPx || 2);
    var out = [];
    var j = 0;
    for (var i = 0; i < pts.length; i++) {
      if (keep[i]) {
        out.push(map.layerPointToLatLng(pts[i]));
        j++;
      }
    }
    return out.length >= 2 ? out : latlngs;
  }

  function rdp(pts, eps) {
    var flags = new Array(pts.length);
    for (var i = 0; i < pts.length; i++) flags[i] = false;
    flags[0] = flags[pts.length - 1] = true;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var seg = stack.pop();
      var start = seg[0], end = seg[1];
      var a = pts[start], b = pts[end];
      var maxD = 0, idx = -1;
      for (var k = start + 1; k < end; k++) {
        var d = pointLineDist(pts[k], a, b);
        if (d > maxD) { maxD = d; idx = k; }
      }
      if (maxD > eps && idx >= 0) {
        flags[idx] = true;
        stack.push([start, idx], [idx, end]);
      }
    }
    return flags;
  }

  function pointLineDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /* ---------- measurements ---------- */
  function measurementFor(layer, toolName) {
    var props = layer.featureProps || {};
    if (toolName === 'route' || props.tool === 'route') {
      var parts = [];
      var modeCfg = ROUTE_MODES[props.mode];
      if (modeCfg) parts.push(modeCfg.label);
      var dist = props.distance != null ? props.distance : (layer.getLatLngs ? pathLength(flattenLatLngs(layer.getLatLngs())) : 0);
      parts.push(fmtDistance(dist));
      if (props.duration != null) parts.push(fmtDuration(props.duration));
      return parts.join(' · ');
    }
    if (toolName === 'circle' || layer instanceof L.Circle) {
      var r = layer.getRadius();
      return fmtDistance(r) + ' radius · ' + fmtArea(Math.PI * r * r);
    }
    if (toolName === 'marker' || layer instanceof L.Marker) {
      var lab = (layer.featureProps && layer.featureProps.label) || '';
      return lab || 'Pin';
    }
    var ll = layer.getLatLngs ? flattenLatLngs(layer.getLatLngs()) : [];
    if (toolName === 'polygon' || toolName === 'rectangle' || layer instanceof L.Polygon) {
      return fmtArea(geodesicArea(ll)) + ' · ' + fmtDistance(pathLength(ll.concat([ll[0]]))) + ' around';
    }
    return fmtDistance(pathLength(ll));
  }

  function bindMeasure(layer, toolName) {
    if (toolName === 'marker') return;
    var text = measurementFor(layer, toolName);
    layer.unbindTooltip();
    layer.bindTooltip(text, {
      permanent: true,
      direction: 'center',
      className: 'measure-label',
      opacity: 1,
      interactive: false
    });
    layer.featureProps.measurement = text;
  }

  function midpoint(latlngs) {
    if (!latlngs.length) return null;
    if (latlngs.length === 1) return latlngs[0];
    var half = pathLength(latlngs) / 2;
    var acc = 0;
    for (var i = 1; i < latlngs.length; i++) {
      var d = haversine(latlngs[i - 1], latlngs[i]);
      if (acc + d >= half) {
        var t = d ? (half - acc) / d : 0;
        return L.latLng(
          latlngs[i - 1].lat + (latlngs[i].lat - latlngs[i - 1].lat) * t,
          latlngs[i - 1].lng + (latlngs[i].lng - latlngs[i - 1].lng) * t
        );
      }
      acc += d;
    }
    return latlngs[Math.floor(latlngs.length / 2)];
  }

  /* ---------- features / geojson ---------- */
  function featureProps(toolName, extra) {
    var p = { id: nowId(), tool: toolName, color: color, weight: weight };
    if (extra) Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
    return p;
  }

  function attachLayer(layer, props) {
    layer.featureProps = props;
    layer.on('click', function (e) {
      if (tool === 'erase' && isDrawMode()) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        ignoreClickUntil = Date.now() + 350;
        deleteLayer(layer);
      } else if (!isDrawMode()) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        ignoreClickUntil = Date.now() + 350;
        openFeatureSheet(layer);
      }
    });
    drawn.addLayer(layer);
    bindMeasure(layer, props.tool);
  }

  function serializeLayer(layer) {
    var p = Object.assign({}, layer.featureProps || {});
    var gj;
    if (layer instanceof L.Circle) {
      var c = layer.getLatLng();
      p.tool = p.tool || 'circle';
      p.radius = layer.getRadius();
      gj = {
        type: 'Feature',
        properties: p,
        geometry: { type: 'Point', coordinates: [c.lng, c.lat] }
      };
    } else if (layer instanceof L.Marker) {
      var m = layer.getLatLng();
      p.tool = p.tool || 'marker';
      gj = {
        type: 'Feature',
        properties: p,
        geometry: { type: 'Point', coordinates: [m.lng, m.lat] }
      };
    } else {
      gj = layer.toGeoJSON();
      gj.properties = Object.assign({}, gj.properties || {}, p);
    }
    return gj;
  }

  function toFeatureCollection() {
    var features = [];
    drawn.eachLayer(function (layer) { features.push(serializeLayer(layer)); });
    var c = map.getCenter();
    return {
      type: 'FeatureCollection',
      name: 'Draw Map',
      properties: {
        center: [c.lng, c.lat],
        zoom: map.getZoom(),
        basemap: currentBase,
        savedAt: new Date().toISOString()
      },
      features: features
    };
  }

  function pinIcon(hex, label) {
    var safe = (label || '').replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
    var html = '<div class="pin-wrap"><div class="pin-head" style="--c:' + hex +
      '"></div><div class="pin-dot"></div>' +
      (safe ? '<div class="pin-label">' + safe + '</div>' : '') + '</div>';
    return L.divIcon({
      className: 'pin-icon',
      html: html,
      iconSize: [28, 40],
      iconAnchor: [14, 40]
    });
  }

  function addFromFeature(feat, skipUndo) {
    if (!feat || feat.type !== 'Feature' || !feat.geometry) return;
    var p = Object.assign({}, feat.properties || {});
    p.id = p.id || nowId();
    p.color = p.color || color;
    p.weight = p.weight || weight;
    var g = feat.geometry;
    var layer = null;

    if (p.tool === 'circle' || (p.radius && g.type === 'Point')) {
      var cc = L.latLng(g.coordinates[1], g.coordinates[0]);
      layer = L.circle(cc, Object.assign(styleFromProps(Object.assign({}, p, { tool: 'circle' })), {
        radius: Number(p.radius) || 50
      }));
      p.tool = 'circle';
      p.radius = Number(p.radius) || 50;
    } else if (p.tool === 'marker' || (g.type === 'Point' && !p.radius)) {
      var ml = L.latLng(g.coordinates[1], g.coordinates[0]);
      p.tool = 'marker';
      layer = L.marker(ml, { icon: pinIcon(p.color, p.label || ''), interactive: true });
    } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      var lineCoords = g.type === 'LineString' ? g.coordinates : g.coordinates[0];
      var lls = lineCoords.map(function (c) { return L.latLng(c[1], c[0]); });
      p.tool = p.tool || 'line';
      layer = L.polyline(lls, styleFromProps(p));
    } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      var ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
      var pls = ring.map(function (c) { return L.latLng(c[1], c[0]); });
      p.tool = p.tool || 'polygon';
      if (p.tool === 'rectangle') layer = L.rectangle(L.latLngBounds(pls), styleFromProps(p));
      else layer = L.polygon(pls, styleFromProps(p));
    }
    if (layer) {
      if (skipUndo) {
        attachLayer(layer, p);
      } else {
        pushUndo();
        attachLayer(layer, p);
        persist();
        updateUndoBtn();
      }
    }
  }

  function loadFeatureCollection(fc, replace) {
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
      toast('This file is not valid GeoJSON');
      return false;
    }
    if (replace) {
      pushUndo();
      drawn.clearLayers();
    }
    fc.features.forEach(function (f) { addFromFeature(f, true); });
    if (fc.properties && Array.isArray(fc.properties.center) && fc.properties.zoom) {
      map.setView([fc.properties.center[1], fc.properties.center[0]], fc.properties.zoom);
    }
    if (fc.properties && fc.properties.basemap) setBasemap(fc.properties.basemap);
    persist();
    updateUndoBtn();
    return true;
  }

  /* ---------- persistence / undo ---------- */
  function persist() {
    try {
      var data = toFeatureCollection();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      toast('Could not auto-save (storage full?)');
    }
  }

  function restore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && data.features) {
        data.features.forEach(function (f) { addFromFeature(f, true); });
      }
      if (data && data.properties) {
        if (Array.isArray(data.properties.center) && data.properties.zoom) {
          map.setView([data.properties.center[1], data.properties.center[0]], data.properties.zoom);
        }
        if (data.properties.basemap) setBasemap(data.properties.basemap, true);
      }
    } catch (err) { /* ignore corrupt storage */ }
  }

  function snapshot() {
    var features = [];
    drawn.eachLayer(function (layer) { features.push(serializeLayer(layer)); });
    return JSON.stringify(features);
  }

  function applySnapshot(json) {
    drawn.clearLayers();
    var features = JSON.parse(json);
    features.forEach(function (f) { addFromFeature(f, true); });
  }

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    updateUndoBtn();
  }

  function undo() {
    if (!undoStack.length) return;
    var prev = undoStack.pop();
    applySnapshot(prev);
    persist();
    updateUndoBtn();
    toast('Undone');
  }

  function updateUndoBtn() {
    $('btn-undo').disabled = undoStack.length === 0;
  }

  function deleteLayer(layer) {
    pushUndo();
    drawn.removeLayer(layer);
    persist();
    updateUndoBtn();
  }

  function clearAll() {
    if (drawn.getLayers().length === 0) {
      toast('Nothing to clear');
      return;
    }
    openSheet('Clear all drawings?', function (body) {
      body.innerHTML =
        '<p>This removes every line, shape, and pin on the map. You can undo afterwards.</p>' +
        '<div class="btn-row">' +
        '<button type="button" class="btn-block" id="sheet-cancel">Cancel</button>' +
        '<button type="button" class="btn-block danger" id="sheet-ok">Clear all</button>' +
        '</div>';
      $('sheet-cancel').onclick = closeSheet;
      $('sheet-ok').onclick = function () {
        pushUndo();
        drawn.clearLayers();
        persist();
        updateUndoBtn();
        closeSheet();
        toast('Cleared');
      };
    });
  }

  /* ---------- map interaction mode ---------- */
  function setMapInteractive(on) {
    if (on) {
      map.dragging.enable();
      map.touchZoom.enable();
      map.doubleClickZoom.enable();
      map.scrollWheelZoom.enable();
      map.boxZoom.enable();
      map.keyboard.enable();
      if (map.tap && map.tap.enable) map.tap.enable();
    } else {
      map.dragging.disable();
      map.touchZoom.disable();
      map.doubleClickZoom.disable();
      map.scrollWheelZoom.disable();
      map.boxZoom.disable();
      map.keyboard.disable();
      if (map.tap && map.tap.disable) map.tap.disable();
    }
    var el = map.getContainer();
    el.classList.toggle('draw-active', !on);
    el.style.touchAction = on ? '' : 'none';
  }

  function setTool(next) {
    if (next === tool && next !== 'pan') {
      /* tapping the same draw tool keeps it */
    }
    cancelDraft();
    if (next !== 'route' && next !== 'pan') {
      abortRouteRequests();
      clearRoutePreview();
    }
    tool = next;
    document.querySelectorAll('.tool').forEach(function (btn) {
      var on = btn.getAttribute('data-tool') === tool;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on && btn.scrollIntoView) btn.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
    setMapInteractive(tool === 'pan' || (tool === 'route' && !!routePreview && !routeBusy));
    closeMore();
    var moreBtn = $('btn-more');
    if (moreBtn) {
      var onMore = !!MORE_TOOLS[tool];
      moreBtn.classList.toggle('is-active', onMore);
      moreBtn.setAttribute('aria-pressed', onMore ? 'true' : 'false');
    }
    if (tool === 'erase') toast('Tap a drawing to delete it');
    if (tool === 'route') toast('Draw a rough path to snap it to roads');
    updateHint();
    updateRouteModeButtons();
  }

  function isDrawMode() { return tool !== 'pan'; }

  /* ---------- draft / tools ---------- */
  function updateHint() {
    var bar = $('hint-bar');
    var text = $('hint-text');
    var finish = $('btn-finish-draft');
    var back = $('btn-undo-vertex');
    var show = false;
    if (tool === 'line') {
      show = true;
      text.textContent = vertices.length ? 'Tap the next point, then Done' : 'Tap to place the first point';
      finish.classList.toggle('hidden', vertices.length < 2);
      back.classList.toggle('hidden', vertices.length < 1);
    } else if (tool === 'polygon') {
      show = true;
      text.textContent = vertices.length >= 3
        ? 'Tap the first point to close, or Done'
        : 'Tap points to outline an area';
      finish.classList.toggle('hidden', vertices.length < 3);
      back.classList.toggle('hidden', vertices.length < 1);
    } else if (tool === 'pen') {
      show = true;
      text.textContent = 'Drag your finger to draw a freehand line';
      finish.classList.add('hidden');
      back.classList.add('hidden');
    } else if (tool === 'rectangle') {
      show = true;
      text.textContent = 'Drag from one corner to the opposite corner';
      finish.classList.add('hidden');
      back.classList.add('hidden');
    } else if (tool === 'circle') {
      show = true;
      text.textContent = 'Drag from the center out to set the radius';
      finish.classList.add('hidden');
      back.classList.add('hidden');
    } else if (tool === 'marker') {
      show = true;
      text.textContent = 'Tap the map to drop a pin';
      finish.classList.add('hidden');
      back.classList.add('hidden');
    } else if (tool === 'erase') {
      show = true;
      text.textContent = 'Tap a drawing to delete it';
      finish.classList.add('hidden');
      back.classList.add('hidden');
    } else if (tool === 'route') {
      show = !routePreview;
      text.textContent = 'Draw a rough path — we will snap it to nearby ' + (
        routeMode === 'walk' ? 'footways' : routeMode === 'bike' ? 'cycleways' : 'roads'
      );
      finish.classList.add('hidden');
      back.classList.add('hidden');
    }
    var modes = $('route-modes');
    if (modes) {
      modes.classList.toggle('hidden', tool !== 'route');
    }
    bar.classList.toggle('hidden', !show);
    bar.hidden = !show;
    document.body.classList.toggle('has-hint', show && !routePreview);
    document.body.classList.toggle('has-route-card', !!routePreview);
    var opts = $('tool-options');
    if (opts) opts.classList.toggle('hidden', !!routePreview || tool === 'erase' || tool === 'marker');
    syncDrawer();
  }

  function clearVertexMarkers() {
    vertexMarkers.forEach(function (m) { draft.removeLayer(m); });
    vertexMarkers = [];
  }

  function cancelStrokeRaf() {
    if (strokeRaf) {
      cancelAnimationFrame(strokeRaf);
      strokeRaf = 0;
    }
    strokeDirty = false;
  }

  function scheduleStrokeFlush() {
    strokeDirty = true;
    if (strokeRaf) return;
    strokeRaf = requestAnimationFrame(function () {
      strokeRaf = 0;
      if (!strokeDirty || !draftLayer || !dragPts.length) return;
      strokeDirty = false;
      draftLayer.setLatLngs(dragPts);
    });
  }

  function cancelDraft() {
    cancelStrokeRaf();
    dragging = false;
    dragPts = [];
    dragStart = null;
    activePointer = null;
    vertices = [];
    if (draftLayer) {
      draft.removeLayer(draftLayer);
      draftLayer = null;
    }
    clearVertexMarkers();
  }

  function renderVertexDraft() {
    if (draftLayer) { draft.removeLayer(draftLayer); draftLayer = null; }
    clearVertexMarkers();
    if (!vertices.length) return;
    var style = Object.assign(pathStyle(tool === 'polygon'), { dashArray: '6 6', weight: Math.max(2, weight) });
    if (tool === 'polygon' && vertices.length >= 2) {
      draftLayer = L.polygon(vertices, style).addTo(draft);
    } else {
      draftLayer = L.polyline(vertices, style).addTo(draft);
    }
    vertices.forEach(function (ll, i) {
      var icon = L.divIcon({
        className: 'vertex-icon',
        html: '<div class="draft-vertex' + (i === 0 ? ' first' : '') + '" style="--c:' + color + '"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      });
      var mk = L.marker(ll, { icon: icon, interactive: i === 0 && tool === 'polygon', keyboard: false, zIndexOffset: 600 });
      if (i === 0 && tool === 'polygon') {
        mk.on('click', function (e) {
          L.DomEvent.stop(e);
          if (vertices.length >= 3) finishVertexShape();
        });
      }
      mk.addTo(draft);
      vertexMarkers.push(mk);
    });
  }

  function finishVertexShape() {
    if (tool === 'line' && vertices.length >= 2) {
      var props = featureProps('line');
      var layer = L.polyline(vertices.slice(), pathStyle(false));
      pushUndo();
      attachLayer(layer, props);
      persist();
    } else if (tool === 'polygon' && vertices.length >= 3) {
      var p2 = featureProps('polygon');
      var poly = L.polygon(vertices.slice(), pathStyle(true));
      pushUndo();
      attachLayer(poly, p2);
      persist();
    } else {
      toast('Need more points');
      return;
    }
    cancelDraft();
    updateHint();
  }

  function undoVertex() {
    if (!vertices.length) return;
    vertices.pop();
    renderVertexDraft();
    updateHint();
  }

  function eventOnUi(target) {
    return !!(target && target.closest && target.closest(
      '.top-ui, .side-controls, .dock, .drawer, #bottom-stack, #more-sheet, .hint-bar, .route-card, .route-loading, .sheet, .onboard, .install-tip, .toast, .leaflet-control, .leaflet-popup'
    ));
  }

  function containerLatLng(ev) {
    var rect = map.getContainer().getBoundingClientRect();
    var x = ev.clientX - rect.left;
    var y = ev.clientY - rect.top;
    return map.containerPointToLatLng(L.point(x, y));
  }

  function handleTap(latlng) {
    if (!latlng || !isDrawMode()) return;
    if (tool === 'line' || tool === 'polygon') {
      if (tool === 'polygon' && vertices.length >= 3) {
        var first = vertices[0];
        var px1 = map.latLngToContainerPoint(first);
        var px2 = map.latLngToContainerPoint(latlng);
        if (px1.distanceTo(px2) <= 28) {
          finishVertexShape();
          return;
        }
      }
      vertices.push(latlng);
      renderVertexDraft();
      updateHint();
      return;
    }
    if (tool === 'marker') placeMarker(latlng);
  }

  function chaikin(latlngs, iterations) {
    var pts = latlngs.slice();
    var n, i, next, a, b;
    for (n = 0; n < (iterations || 2); n++) {
      if (pts.length < 3) break;
      next = [pts[0]];
      for (i = 0; i < pts.length - 1; i++) {
        a = pts[i];
        b = pts[i + 1];
        next.push(L.latLng(a.lat * 0.75 + b.lat * 0.25, a.lng * 0.75 + b.lng * 0.25));
        next.push(L.latLng(a.lat * 0.25 + b.lat * 0.75, a.lng * 0.25 + b.lng * 0.75));
      }
      next.push(pts[pts.length - 1]);
      pts = next;
    }
    return pts;
  }

  function smoothFreehand(latlngs) {
    if (!latlngs || latlngs.length < 3) return (latlngs || []).slice();
    return simplify(chaikin(latlngs, 2), 1.4);
  }

  function pointerSamples(ev) {
    var list = [];
    if (ev.getCoalescedEvents) {
      try { list = ev.getCoalescedEvents() || []; } catch (e) { list = []; }
    }
    if (!list.length) list = [ev];
    return list;
  }

  function onPointerDown(ev) {
    if (!isDrawMode()) return;
    if (eventOnUi(ev.target)) return;
    /* Palm / second-finger guard: only the primary pointer may start or continue a stroke. */
    if (ev.isPrimary === false) return;
    if (dragging && ev.pointerId !== activePointer) return;
    if (tool === 'route' && (routeBusy || routePreview)) return;
    if (tool === 'line' || tool === 'polygon' || tool === 'marker') {
      tapCandidate = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, latlng: containerLatLng(ev) };
      return;
    }
    if (!DRAG_TOOLS[tool]) return;
    ev.preventDefault();
    dragging = true;
    activePointer = ev.pointerId;
    dragStart = containerLatLng(ev);
    dragPts = [dragStart];
    if (map.getContainer().setPointerCapture) {
      try { map.getContainer().setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    }
    if (draftLayer) { draft.removeLayer(draftLayer); draftLayer = null; }
    if (tool === 'pen' || tool === 'route') {
      var style = tool === 'route'
        ? { color: color, weight: Math.max(4, weight), opacity: 0.45, lineJoin: 'round', lineCap: 'round' }
        : pathStyle(false);
      /* Pressure is ignored so stroke width stays constant. */
      draftLayer = L.polyline(dragPts, style).addTo(draft);
    } else if (tool === 'rectangle') {
      draftLayer = L.rectangle(L.latLngBounds(dragStart, dragStart), pathStyle(true)).addTo(draft);
    } else if (tool === 'circle') {
      draftLayer = L.circle(dragStart, Object.assign(pathStyle(true), { radius: 1 })).addTo(draft);
    }
  }

  function onPointerMove(ev) {
    if (!dragging || ev.pointerId !== activePointer) return;
    ev.preventDefault();
    if (tool === 'pen' || tool === 'route') {
      var evs = pointerSamples(ev);
      var minPx = 1.15;
      for (var i = 0; i < evs.length; i++) {
        var ll = containerLatLng(evs[i]);
        if (!ll || !dragPts.length) continue;
        var last = dragPts[dragPts.length - 1];
        var p1 = map.latLngToContainerPoint(last);
        var p2 = map.latLngToContainerPoint(ll);
        if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < minPx) continue;
        dragPts.push(ll);
      }
      scheduleStrokeFlush();
    } else if (tool === 'rectangle') {
      var ll2 = containerLatLng(ev);
      if (ll2) draftLayer.setBounds(L.latLngBounds(dragStart, ll2));
    } else if (tool === 'circle') {
      var ll3 = containerLatLng(ev);
      if (ll3) draftLayer.setRadius(Math.max(1, haversine(dragStart, ll3)));
    }
  }

  function onPointerUp(ev) {
    if (tapCandidate && ev.pointerId === tapCandidate.id) {
      var moved = Math.hypot((ev.clientX || 0) - tapCandidate.x, (ev.clientY || 0) - tapCandidate.y);
      var ll = containerLatLng(ev) || tapCandidate.latlng;
      var cancelled = ev.type === 'pointercancel';
      tapCandidate = null;
      if (!cancelled && moved <= 14) {
        ev.preventDefault();
        ignoreClickUntil = Date.now() + 450;
        handleTap(ll);
      }
      return;
    }
    if (!dragging || (activePointer != null && ev.pointerId !== activePointer)) return;
    ev.preventDefault();
    var ll = containerLatLng(ev);
    ignoreClickUntil = Date.now() + 400;
    if (tool === 'route') {
      if (ll) dragPts.push(ll);
      cancelStrokeRaf();
      var routePts = dragPts.slice();
      cancelDraft();
      snapRouteFromStroke(routePts);
    } else if (tool === 'pen') {
      if (ll) dragPts.push(ll);
      cancelStrokeRaf();
      var pts = smoothFreehand(dragPts);
      if (pts.length >= 2 && pathLength(pts) >= 1) {
        var props = featureProps('pen');
        var layer = L.polyline(pts, pathStyle(false));
        pushUndo();
        attachLayer(layer, props);
        persist();
      }
    } else if (tool === 'rectangle') {
      var bounds = L.latLngBounds(dragStart, ll);
      var sw = bounds.getSouthWest();
      var ne = bounds.getNorthEast();
      var w = haversine(sw, L.latLng(sw.lat, ne.lng));
      var h = haversine(sw, L.latLng(ne.lat, sw.lng));
      if (w >= 2 && h >= 2) {
        var rp = featureProps('rectangle');
        var rect = L.rectangle(bounds, pathStyle(true));
        pushUndo();
        attachLayer(rect, rp);
        persist();
      }
    } else if (tool === 'circle') {
      var radius = haversine(dragStart, ll);
      if (radius >= 2) {
        var cp = featureProps('circle', { radius: radius });
        var circ = L.circle(dragStart, Object.assign(pathStyle(true), { radius: radius }));
        pushUndo();
        attachLayer(circ, cp);
        persist();
      }
    }
    cancelDraft();
  }

  function onMapClick(e) {
    if (Date.now() < ignoreClickUntil) return;
    if (!isDrawMode()) return;
    if (DRAG_TOOLS[tool] || tool === 'erase') return;
    handleTap(e.latlng);
  }

  function placeMarker(latlng) {
    openSheet('Pin label', function (body) {
      body.innerHTML =
        '<p>Optional text shown under the pin.</p>' +
        '<input id="label-input" class="text-input" type="text" maxlength="80" placeholder="e.g. Meeting point" enterkeyhint="done">' +
        '<div class="btn-row">' +
        '<button type="button" class="btn-block" id="sheet-cancel">Cancel</button>' +
        '<button type="button" class="btn-block primary" id="sheet-ok">Place pin</button>' +
        '</div>';
      var input = $('label-input');
      setTimeout(function () { try { input.focus(); } catch (e) { /* ignore */ } }, 200);
      $('sheet-cancel').onclick = closeSheet;
      function ok() {
        var label = (input.value || '').trim();
        var props = featureProps('marker', { label: label });
        var mk = L.marker(latlng, { icon: pinIcon(color, label) });
        pushUndo();
        attachLayer(mk, props);
        persist();
        closeSheet();
      }
      $('sheet-ok').onclick = ok;
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); ok(); }
      });
    });
  }

  /* ---------- sheets / menus ---------- */
  function openSheet(title, fill) {
    $('sheet-title').textContent = title;
    var body = $('sheet-body');
    body.innerHTML = '';
    fill(body);
    var sheet = $('sheet');
    sheet.classList.remove('hidden');
    sheet.hidden = false;
  }

  function closeSheet() {
    var sheet = $('sheet');
    sheet.classList.add('hidden');
    sheet.hidden = true;
    $('sheet-body').innerHTML = '';
  }

  function openFeatureSheet(layer) {
    var p = layer.featureProps || {};
    var title = ({
      pen: 'Freehand line', line: 'Path', polygon: 'Area',
      rectangle: 'Rectangle', circle: 'Circle', marker: 'Pin',
      route: ((ROUTE_MODES[p.mode] && ROUTE_MODES[p.mode].label) || 'Route') + ' route'
    })[p.tool] || 'Drawing';
    openSheet(title, function (body) {
      var meas = measurementFor(layer, p.tool);
      var extra = p.label ? '<p><strong>' + escapeHtml(p.label) + '</strong></p>' : '';
      var routeBtns = p.tool === 'route'
        ? '<div class="btn-row">' +
          '<button type="button" class="btn-block" id="sheet-gmaps">Google Maps</button>' +
          '<button type="button" class="btn-block" id="sheet-gpx">Export GPX</button>' +
          '</div>'
        : '';
      body.innerHTML = extra + '<p>' + escapeHtml(meas) + '</p>' + routeBtns +
        '<div class="btn-row">' +
        '<button type="button" class="btn-block" id="sheet-cancel">Close</button>' +
        '<button type="button" class="btn-block danger" id="sheet-ok">Delete</button>' +
        '</div>';
      $('sheet-cancel').onclick = closeSheet;
      $('sheet-ok').onclick = function () {
        deleteLayer(layer);
        closeSheet();
      };
      if (p.tool === 'route') {
        var lls = flattenLatLngs(layer.getLatLngs());
        $('sheet-gmaps').onclick = function () {
          closeSheet();
          openRouteInGoogleMaps(lls, p.mode || 'walk');
        };
        $('sheet-gpx').onclick = function () {
          exportRouteGpx(lls, p.mode || 'walk', p.distance, p.duration);
        };
      }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function openMore() {
    var el = $('more-sheet');
    if (!el) return;
    el.classList.remove('hidden');
    el.hidden = false;
  }

  function closeMore() {
    var el = $('more-sheet');
    if (!el) return;
    el.classList.add('hidden');
    el.hidden = true;
  }

  function openMenu() { openMore(); }

  function openHelp() {
    openSheet('How to use', function (body) {
      body.innerHTML =
        '<p>Drawings stay anchored to the map when you pan or zoom. Turn on a tool to draw; switch back to <strong>Pan</strong> to move the map with one finger.</p>' +
        '<p><strong>Pen</strong> is freehand. <strong>Line</strong> and <strong>Area</strong> add a point each time you tap — then press Done. <strong>Pin</strong> drops a labeled marker. Open <strong>More</strong> for rectangle, circle, eraser, and exports.</p>' +
        '<p><strong>Route</strong> lets you sketch a rough path, then snaps it to the closest walk, bike, or car route. Keep it, export a GPX file, or open the directions in Google Maps.</p>' +
        '<p>Distances and areas use metric units. Work is auto-saved in this browser.</p>' +
        '<p><strong>iPhone Safari:</strong> Share button → Add to Home Screen.</p>' +
        '<p><strong>iPhone Chrome:</strong> Menu → Add to Home Screen. Chrome on iOS uses the same engine as Safari; install also works from Safari if the menu is missing.</p>' +
        '<p>This app cannot add a drawing tool inside the official Google Maps app. Use “Open in Google Maps” to jump to the same place there.</p>' +
        '<div class="btn-row"><button type="button" class="btn-block primary" id="sheet-ok">Close</button></div>';
      $('sheet-ok').onclick = closeSheet;
    });
  }


  /* ---------- draw my route (map matching) ---------- */
  function updateRouteModeButtons() {
    document.querySelectorAll('#route-modes .mode').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-mode') === routeMode);
    });
  }

  function setRouteMode(next) {
    if (!ROUTE_MODES[next]) return;
    var changed = next !== routeMode;
    routeMode = next;
    try { localStorage.setItem(MODE_KEY, routeMode); } catch (e) { /* ignore */ }
    updateRouteModeButtons();
    updateHint();
    if (changed && routePreview && routePreview.sketchPts) {
      var pts = routePreview.sketchPts.slice();
      clearRoutePreview();
      snapRouteFromStroke(pts);
    }
  }

  function setRouteLoading(on) {
    routeBusy = !!on;
    var el = $('route-loading');
    if (!el) return;
    el.classList.toggle('hidden', !on);
    el.hidden = !on;
  }

  function hideRouteCard() {
    var card = $('route-card');
    if (!card) return;
    card.classList.add('hidden');
    card.hidden = true;
    document.body.classList.remove('has-route-card');
  }

  function showRouteCard(result, mode) {
    var cfg = ROUTE_MODES[mode] || ROUTE_MODES.walk;
    var dist = fmtDistance(result.distance);
    var dur = fmtDuration(result.duration);
    $('route-card-title').textContent = cfg.label + ' route';
    $('route-card-stats').textContent = dist + ' · ' + dur;
    if ($('route-distance')) $('route-distance').textContent = dist;
    if ($('route-time')) $('route-time').textContent = dur;
    var fitEl = $('route-fit');
    if (fitEl) {
      if (result.fit != null) {
        var meanTxt = result.mean != null ? ' · ' + Math.round(result.mean) + ' m avg' : '';
        fitEl.textContent = result.fit + '% fit' + meanTxt;
        fitEl.classList.remove('hidden');
        fitEl.hidden = false;
      } else {
        fitEl.textContent = '';
        fitEl.classList.add('hidden');
        fitEl.hidden = true;
      }
    }
    var card = $('route-card');
    card.classList.remove('hidden');
    card.hidden = false;
    document.body.classList.add('has-route-card');
    syncDrawer();
  }

  function clearRoutePreview() {
    if (routeLayerGroup) {
      routeLayerGroup.clearLayers();
    }
    routePreview = null;
    hideRouteCard();
    setRouteLoading(false);
    if (tool === 'route') setMapInteractive(false);
    updateHint();
  }

  function sampleByDistance(latlngs, count) {
    if (!latlngs.length) return [];
    if (count <= 1) return [latlngs[0]];
    if (latlngs.length <= count) return latlngs.slice();
    var total = pathLength(latlngs);
    if (total <= 0) return [latlngs[0], latlngs[latlngs.length - 1]];
    var out = [latlngs[0]];
    var acc = 0;
    var k = 1;
    for (var i = 1; i < latlngs.length && k < count - 1; i++) {
      var d = haversine(latlngs[i - 1], latlngs[i]);
      var next = acc + d;
      var target = total * k / (count - 1);
      while (k < count - 1 && target <= next) {
        var t = d ? (target - acc) / d : 0;
        out.push(L.latLng(
          latlngs[i - 1].lat + (latlngs[i].lat - latlngs[i - 1].lat) * t,
          latlngs[i - 1].lng + (latlngs[i].lng - latlngs[i - 1].lng) * t
        ));
        k += 1;
        target = total * k / (count - 1);
      }
      acc = next;
    }
    var last = latlngs[latlngs.length - 1];
    if (out[out.length - 1].lat !== last.lat || out[out.length - 1].lng !== last.lng) out.push(last);
    return out;
  }

  function bearingDeg(a, b) {
    var lat1 = a.lat * Math.PI / 180;
    var lat2 = b.lat * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var y = Math.sin(dLng) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function turnDegrees(a, b, c) {
    var d = Math.abs(bearingDeg(a, b) - bearingDeg(b, c));
    if (d > 180) d = 360 - d;
    return d;
  }

  function downsampleKeepTurns(pts, maxN) {
    if (pts.length <= maxN) return pts.slice();
    var scores = pts.map(function (p, i) {
      if (i === 0 || i === pts.length - 1) return 1e9;
      return turnDegrees(pts[i - 1], p, pts[i + 1]);
    });
    var order = scores.map(function (s, i) { return { s: s, i: i }; })
      .sort(function (a, b) { return b.s - a.s; });
    var idx = [];
    for (var k = 0; k < order.length && idx.length < maxN; k++) idx.push(order[k].i);
    idx.sort(function (a, b) { return a - b; });
    return idx.map(function (i) { return pts[i]; });
  }

  /* Legacy even-sample prepare, kept to compare deviation against the new snapper. */
  function prepareMatchPoints(latlngs) {
    var simplified = simplify(latlngs, 3);
    if (simplified.length < 2) simplified = latlngs.slice();
    var spaced = [simplified[0]];
    for (var i = 1; i < simplified.length; i++) {
      if (haversine(spaced[spaced.length - 1], simplified[i]) >= 12) spaced.push(simplified[i]);
    }
    var last = simplified[simplified.length - 1];
    if (haversine(spaced[spaced.length - 1], last) > 1) spaced.push(last);
    if (spaced.length > MATCH_MAX_POINTS) spaced = sampleByDistance(spaced, MATCH_MAX_POINTS);
    return spaced;
  }

  function adaptiveSimplify(latlngs) {
    var rdp = simplify(latlngs, 2.4);
    if (rdp.length < 2) rdp = latlngs.slice();
    function key(ll) { return ll.lat.toFixed(6) + ',' + ll.lng.toFixed(6); }
    var keep = {};
    rdp.forEach(function (p) { keep[key(p)] = 1; });
    var i;
    for (i = 1; i < latlngs.length - 1; i++) {
      if (turnDegrees(latlngs[i - 1], latlngs[i], latlngs[i + 1]) >= 32) keep[key(latlngs[i])] = 1;
    }
    var merged = [];
    for (i = 0; i < latlngs.length; i++) {
      if (keep[key(latlngs[i])]) merged.push(latlngs[i]);
    }
    if (merged.length < 2) merged = rdp;
    var out = [merged[0]];
    for (var j = 1; j < merged.length; j++) {
      var prev = out[out.length - 1];
      var cur = merged[j];
      var isLast = j === merged.length - 1;
      var sharp = (j < merged.length - 1) && turnDegrees(prev, cur, merged[j + 1]) >= 32;
      if (isLast || haversine(prev, cur) >= (sharp ? 4 : 8)) out.push(cur);
    }
    var last = merged[merged.length - 1];
    if (haversine(out[out.length - 1], last) > 1) out.push(last);
    if (out.length > MATCH_MAX_POINTS) out = downsampleKeepTurns(out, MATCH_MAX_POINTS);
    return out;
  }

  function zoomRadius() {
    var z = map ? map.getZoom() : 13;
    var r = Math.round(70 - z * 2.2);
    return Math.max(16, Math.min(MATCH_RADIUS, r));
  }

  function pointRadiuses(pts) {
    var base = zoomRadius();
    return pts.map(function (p, i) {
      if (i === 0 || i === pts.length - 1) return Math.min(MATCH_RADIUS, base + 8);
      var ang = turnDegrees(pts[i - 1], p, pts[i + 1]);
      if (ang >= 50) return Math.min(MATCH_RADIUS, base + 10);
      if (ang >= 32) return Math.min(MATCH_RADIUS, base + 4);
      return base;
    });
  }

  function pickWaypoints(pts, budget) {
    if (pts.length <= budget) return pts.slice();
    var even = sampleByDistance(pts, budget);
    var merged = even.slice();
    for (var t = 1; t < pts.length - 1; t++) {
      if (turnDegrees(pts[t - 1], pts[t], pts[t + 1]) < 28) continue;
      var tp = pts[t];
      var near = false;
      var i;
      for (i = 0; i < merged.length; i++) {
        if (haversine(merged[i], tp) < 12) { near = true; break; }
      }
      if (near) continue;
      var best = merged.length - 1;
      var bestD = Infinity;
      for (i = 1; i < merged.length; i++) {
        var d = pointToSegmentMeters(tp, merged[i - 1], merged[i]);
        if (d < bestD) { bestD = d; best = i; }
      }
      merged.splice(best, 0, tp);
    }
    if (merged.length > budget) merged = downsampleKeepTurns(merged, budget);
    return merged;
  }

  function cornerWaypoints(pts) {
    var out = [pts[0]];
    for (var i = 1; i < pts.length - 1; i++) {
      if (turnDegrees(pts[i - 1], pts[i], pts[i + 1]) >= 28) out.push(pts[i]);
    }
    out.push(pts[pts.length - 1]);
    var cleaned = [out[0]];
    for (var j = 1; j < out.length; j++) {
      if (haversine(cleaned[cleaned.length - 1], out[j]) >= 8) cleaned.push(out[j]);
    }
    var last = out[out.length - 1];
    if (haversine(cleaned[cleaned.length - 1], last) > 1) cleaned.push(last);
    return cleaned.length >= 3 ? cleaned : null;
  }

  function pointToSegmentMeters(p, a, b) {
    var lat0 = p.lat * Math.PI / 180;
    var mPerDegLat = 111320;
    var mPerDegLng = 111320 * Math.cos(lat0);
    function xy(ll) {
      return { x: (ll.lng - p.lng) * mPerDegLng, y: (ll.lat - p.lat) * mPerDegLat };
    }
    var A = xy(a);
    var B = xy(b);
    var vx = B.x - A.x;
    var vy = B.y - A.y;
    var len2 = vx * vx + vy * vy;
    var t = len2 > 0 ? Math.max(0, Math.min(1, (-A.x * vx - A.y * vy) / len2)) : 0;
    var dx = A.x + t * vx;
    var dy = A.y + t * vy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function distToLine(p, line) {
    if (!line || !line.length) return Infinity;
    if (line.length === 1) return haversine(p, line[0]);
    var best = Infinity;
    for (var i = 1; i < line.length; i++) {
      var d = pointToSegmentMeters(p, line[i - 1], line[i]);
      if (d < best) best = d;
    }
    return best;
  }

  function sampleEvery(latlngs, spacingM) {
    var total = pathLength(latlngs);
    var n = Math.max(8, Math.min(220, Math.ceil(total / spacingM) + 1));
    return sampleByDistance(latlngs, n);
  }

  function deviationStats(sketch, route) {
    var sk = sampleEvery(sketch, 18);
    var sum = 0;
    var maxSR = 0;
    var i;
    for (i = 0; i < sk.length; i++) {
      var d = distToLine(sk[i], route);
      sum += d;
      if (d > maxSR) maxSR = d;
    }
    return {
      mean: sk.length ? sum / sk.length : 0,
      hausdorff: maxSR
    };
  }

  function scoreCandidate(c, sketch) {
    var d = deviationStats(sketch, c.latlngs);
    var sketchLen = pathLength(sketch);
    var routeLen = c.distance || pathLength(c.latlngs);
    var detour = sketchLen > 0 ? routeLen / sketchLen : 1;
    var detourPenalty = 0;
    if (detour > 1.45) detourPenalty = (detour - 1.45) * 40;
    if (detour > 2.2) detourPenalty += (detour - 2.2) * 80;
    var score = d.mean + 0.22 * d.hausdorff + detourPenalty;
    var fit = Math.round(100 * Math.exp(-d.mean / 55) * Math.exp(-Math.max(0, d.hausdorff - 28) / 140));
    fit = Math.max(0, Math.min(99, fit));
    return { mean: d.mean, hausdorff: d.hausdorff, detour: detour, score: score, fit: fit };
  }

  function removeBacktracks(latlngs) {
    if (!latlngs || latlngs.length < 4) return latlngs;
    var out = latlngs.slice();
    var changed = true;
    var guard = 0;
    while (changed && guard++ < 8) {
      changed = false;
      var next = [out[0]];
      for (var i = 1; i < out.length - 1; i++) {
        var prev = next[next.length - 1];
        var cur = out[i];
        var nxt = out[i + 1];
        var d1 = haversine(prev, cur);
        var d2 = haversine(cur, nxt);
        var straight = haversine(prev, nxt);
        if (d1 + d2 > 12 && straight < 0.35 * (d1 + d2) && d1 + d2 < 80) {
          changed = true;
          continue;
        }
        var diff = turnDegrees(prev, cur, nxt);
        if (diff > 155 && d1 + d2 < 60) {
          changed = true;
          continue;
        }
        next.push(cur);
      }
      next.push(out[out.length - 1]);
      if (next.length < 2) break;
      out = next;
    }
    return out.length >= 2 ? out : latlngs;
  }

  function coordsParam(latlngs) {
    return latlngs.map(function (ll) {
      return ll.lng.toFixed(6) + ',' + ll.lat.toFixed(6);
    }).join(';');
  }

  function waitMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function fetchJson(url, opts) {
    opts = opts || {};
    if (typeof opts === 'number') opts = { timeout: opts };
    var timeoutMs = opts.timeout || 8000;
    var retries = opts.retries == null ? 0 : opts.retries;
    var external = opts.signal;
    var attempt = 0;
    function once() {
      if (external && external.aborted) return Promise.reject(new Error('aborted'));
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, timeoutMs);
      if (external) {
        if (external.aborted) {
          clearTimeout(t);
          return Promise.reject(new Error('aborted'));
        }
        external.addEventListener('abort', function () { ctrl.abort(); });
      }
      return fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
        .then(function (res) {
          if (!res.ok) throw new Error('http ' + res.status);
          return res.json().then(function (data) { return data; }, function () {
            throw new Error('bad json');
          });
        })
        .finally(function () { clearTimeout(t); })
        .catch(function (err) {
          if (external && external.aborted) throw err;
          if (attempt < retries) {
            attempt += 1;
            return waitMs(280 * attempt).then(once);
          }
          throw err;
        });
    }
    return once();
  }

  function parseMatch(data) {
    if (!data || data.code !== 'Ok') return null;
    var matchings = data.matchings || [];
    if (!matchings.length) return null;
    var latlngs = [];
    var dist = 0;
    var dur = 0;
    matchings.forEach(function (m) {
      var coords = m.geometry && m.geometry.coordinates;
      if (!coords || !coords.length) return;
      coords.forEach(function (c, i) {
        var ll = L.latLng(c[1], c[0]);
        if (latlngs.length && i === 0 && haversine(latlngs[latlngs.length - 1], ll) < 8) return;
        latlngs.push(ll);
      });
      dist += m.distance || 0;
      dur += m.duration || 0;
    });
    if (latlngs.length < 2) return null;
    return { latlngs: latlngs, distance: dist, duration: dur, source: 'match' };
  }

  function parseRoute(data) {
    if (!data || data.code !== 'Ok') return null;
    var r = (data.routes || [])[0];
    if (!r || !r.geometry || !r.geometry.coordinates || r.geometry.coordinates.length < 2) return null;
    return {
      latlngs: r.geometry.coordinates.map(function (c) { return L.latLng(c[1], c[0]); }),
      distance: r.distance,
      duration: r.duration,
      source: 'route'
    };
  }

  function tagCandidate(result, kind) {
    if (!result) return null;
    result.kind = kind;
    return result;
  }

  function abortRouteRequests() {
    routeGen += 1;
    if (routeCtl) {
      try { routeCtl.abort(); } catch (e) { /* ignore */ }
    }
    routeCtl = null;
  }

  function firstOk(factories, timeout, signal) {
    var chain = Promise.resolve(null);
    factories.forEach(function (fn) {
      chain = chain.then(function (got) {
        if (got) return got;
        return fn(timeout, signal);
      });
    });
    return chain;
  }

  function osrmMatch(pts, mode, signal) {
    var cfg = ROUTE_MODES[mode];
    var urls = cfg.matchUrls || (cfg.matchUrl ? [cfg.matchUrl] : []);
    var timeout = mode === 'car' ? 5500 : 2200;
    var radsAll = pointRadiuses(pts);

    function matchUrl(base, chunkPts, chunkRads, t, sig) {
      var url = base + '/' + coordsParam(chunkPts) +
        '?overview=full&geometries=geojson&gaps=split&radiuses=' + chunkRads.join(';');
      return fetchJson(url, { timeout: t, retries: 0, signal: sig }).then(parseMatch, function () { return null; });
    }

    function tryChunk(chunkPts, chunkRads) {
      var factories = urls.map(function (u) {
        return function (t, sig) { return matchUrl(u, chunkPts, chunkRads, t, sig); };
      });
      return firstOk(factories, timeout, signal);
    }

    if (pts.length <= 70) return tryChunk(pts, radsAll);

    var chunkSize = 42;
    var overlap = 4;
    var parts = [];
    function next(i) {
      if (i >= pts.length - 1) {
        if (!parts.length) return Promise.resolve(null);
        var latlngs = [];
        var dist = 0;
        var dur = 0;
        parts.forEach(function (p) {
          p.latlngs.forEach(function (ll, k) {
            if (latlngs.length && k === 0 && haversine(latlngs[latlngs.length - 1], ll) < 10) return;
            latlngs.push(ll);
          });
          dist += p.distance || 0;
          dur += p.duration || 0;
        });
        if (latlngs.length < 2) return Promise.resolve(null);
        return Promise.resolve({ latlngs: latlngs, distance: dist, duration: dur, source: 'match' });
      }
      var end = Math.min(pts.length, i + chunkSize);
      var chunk = pts.slice(i, end);
      var cr = radsAll.slice(i, end);
      if (chunk.length < 2) return Promise.resolve(null);
      return tryChunk(chunk, cr).then(function (res) {
        if (!res) return null;
        parts.push(res);
        var nextI = end - overlap;
        if (nextI <= i) nextI = i + Math.max(1, chunk.length - overlap);
        return next(nextI);
      });
    }
    return next(0);
  }

  function osrmRoute(pts, mode, signal) {
    var cfg = ROUTE_MODES[mode];
    var urls = cfg.routeUrls || (cfg.routeUrl ? [cfg.routeUrl] : []);
    function tryAt(i) {
      if (i >= urls.length) return Promise.resolve(null);
      var url = urls[i] + '/' + coordsParam(pts) + '?overview=full&geometries=geojson';
      return fetchJson(url, { timeout: 10000, retries: 1, signal: signal })
        .then(parseRoute, function () { return tryAt(i + 1); });
    }
    return tryAt(0);
  }

  function snapRouteFromStroke(rawPts) {
    abortRouteRequests();
    routeCtl = new AbortController();
    var gen = routeGen;
    var signal = routeCtl.signal;

    if (!rawPts || rawPts.length < 2) {
      toast('Draw a longer path along the streets');
      return;
    }
    var sketch = rawPts.length >= 3 ? chaikin(rawPts, 1) : rawPts.slice();
    var pts = adaptiveSimplify(sketch);
    if (pts.length < 2 || pathLength(rawPts) < 25) {
      toast('Draw a longer path along the streets');
      return;
    }
    clearRoutePreview();
    setRouteLoading(true);
    var mode = routeMode;

    var legacyPts = prepareMatchPoints(rawPts);
    var legacyWay = legacyPts.length <= 20 ? legacyPts : sampleByDistance(legacyPts, 20);
    var denseWay = pickWaypoints(pts, 48);
    var corners = cornerWaypoints(pts);

    var routePs = [
      osrmRoute(denseWay, mode, signal).then(function (r) { return tagCandidate(r, 'route-dense'); }, function () { return null; }),
      osrmRoute(legacyWay, mode, signal).then(function (r) { return tagCandidate(r, 'route-legacy'); }, function () { return null; })
    ];
    if (corners && corners.length >= 3) {
      routePs.push(osrmRoute(corners, mode, signal).then(function (r) { return tagCandidate(r, 'route-corners'); }, function () { return null; }));
    }
    var matchP = osrmMatch(pts, mode, signal).then(function (r) { return tagCandidate(r, 'match'); }, function () { return null; });

    function finalize(cands) {
      if (gen !== routeGen) return;
      var scored = [];
      cands.forEach(function (c) {
        if (!c || !c.latlngs || c.latlngs.length < 2) return;
        c.latlngs = removeBacktracks(c.latlngs);
        if (c.latlngs.length < 2) return;
        var newLen = pathLength(c.latlngs);
        if (c.distance && newLen > 0 && Math.abs(newLen - c.distance) / Math.max(c.distance, 1) > 0.08) {
          if (c.duration) c.duration *= newLen / c.distance;
          c.distance = newLen;
        }
        var stats = scoreCandidate(c, rawPts);
        c.mean = stats.mean;
        c.hausdorff = stats.hausdorff;
        c.detour = stats.detour;
        c.score = stats.score;
        c.fit = stats.fit;
        scored.push(c);
      });
      if (!scored.length) throw new Error('no route');
      scored.sort(function (a, b) { return a.score - b.score; });
      var best = scored[0];
      var legacy = null;
      scored.forEach(function (c) { if (c.kind === 'route-legacy') legacy = c; });
      function rnd(n) { return Math.round(n * 10) / 10; }
      window.__routeDebug = {
        kind: best.kind,
        source: best.source,
        mean: rnd(best.mean),
        hausdorff: rnd(best.hausdorff),
        fit: best.fit,
        detour: Math.round(best.detour * 100) / 100,
        baselineMean: legacy ? rnd(legacy.mean) : null,
        baselineHausdorff: legacy ? rnd(legacy.hausdorff) : null,
        improvement: legacy ? rnd(legacy.mean - best.mean) : null,
        candidates: scored.map(function (c) {
          return { kind: c.kind, mean: rnd(c.mean), hausdorff: rnd(c.hausdorff), score: rnd(c.score), fit: c.fit };
        })
      };
      showRoutePreview(rawPts, best, mode);
    }

    Promise.all(routePs).then(function (routes) {
      if (gen !== routeGen) return null;
      return new Promise(function (resolve) {
        var decided = false;
        function finish(extra) {
          if (decided) return;
          decided = true;
          resolve(routes.concat(extra || []));
        }
        matchP.then(function (m) { finish(m ? [m] : []); }, function () { finish([]); });
        var hasRoute = routes.some(function (r) { return !!r; });
        setTimeout(function () { finish([]); }, hasRoute ? 700 : 2400);
      });
    }).then(function (cands) {
      if (gen !== routeGen) return;
      finalize(cands || []);
    }).catch(function () {
      if (gen !== routeGen) return;
      if (signal.aborted) return;
      toast("Couldn't find a road route for that drawing. Try following the streets more closely.");
    }).finally(function () {
      if (gen !== routeGen) return;
      setRouteLoading(false);
      updateHint();
    });
  }

  function endpointIcon(letter, isEnd) {
    return L.divIcon({
      className: 'route-flag',
      html: '<div class="route-endpoint' + (isEnd ? ' end' : '') + '">' + letter + '</div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
  }

  function showRoutePreview(sketchPts, result, mode) {
    if (!routeLayerGroup) routeLayerGroup = L.layerGroup().addTo(map);
    routeLayerGroup.clearLayers();
    var sketch = L.polyline(sketchPts, {
      color: color,
      weight: Math.max(4, weight),
      opacity: 0.35,
      lineJoin: 'round',
      lineCap: 'round',
      dashArray: '5 8',
      interactive: false
    }).addTo(routeLayerGroup);
    L.polyline(result.latlngs, {
      color: ROUTE_CASING,
      weight: 11,
      opacity: 0.9,
      lineJoin: 'round',
      lineCap: 'round',
      interactive: false
    }).addTo(routeLayerGroup);
    var routeLine = L.polyline(result.latlngs, {
      color: ROUTE_COLOR,
      weight: 6,
      opacity: 1,
      lineJoin: 'round',
      lineCap: 'round',
      interactive: false
    }).addTo(routeLayerGroup);
    var start = result.latlngs[0];
    var end = result.latlngs[result.latlngs.length - 1];
    L.marker(start, { icon: endpointIcon('A', false), interactive: false, zIndexOffset: 800 }).addTo(routeLayerGroup);
    L.marker(end, { icon: endpointIcon('B', true), interactive: false, zIndexOffset: 800 }).addTo(routeLayerGroup);
    routePreview = {
      sketchPts: sketchPts.slice(),
      sketch: sketch,
      routeLine: routeLine,
      latlngs: result.latlngs,
      distance: result.distance,
      duration: result.duration,
      mode: mode,
      source: result.source
    };
    showRouteCard(result, mode);
    updateHint();
    setMapInteractive(true);
    try {
      var mapRect = map.getContainer().getBoundingClientRect();
      var topUi = $('top-ui');
      var side = $('side-controls');
      var dock = $('dock');
      var dockH = dock ? dock.getBoundingClientRect().height : 66;
      /* Use target drawer height so we don't measure mid-transition. */
      var bottomPad = drawerHeights().route + dockH + 16;
      var topPad = 56;
      var rightPad = 56;
      if (topUi) topPad = Math.max(56, topUi.getBoundingClientRect().bottom - mapRect.top + 16);
      if (side) rightPad = Math.max(56, mapRect.right - side.getBoundingClientRect().left + 12);
      map.fitBounds(routeLine.getBounds(), {
        paddingTopLeft: [28, topPad],
        paddingBottomRight: [rightPad, bottomPad],
        maxZoom: 17,
        animate: true
      });
    } catch (e) { /* ignore */ }
  }

  function keepRoutePreview() {
    if (!routePreview) return;
    var p = routePreview;
    var props = featureProps('route', {
      mode: p.mode,
      color: ROUTE_COLOR,
      weight: 6,
      distance: p.distance,
      duration: p.duration,
      source: p.source
    });
    var layer = L.polyline(p.latlngs, {
      color: ROUTE_COLOR,
      weight: 6,
      opacity: 1,
      lineJoin: 'round',
      lineCap: 'round'
    });
    pushUndo();
    attachLayer(layer, props);
    persist();
    if (routeLayerGroup) routeLayerGroup.clearLayers();
    routePreview = null;
    hideRouteCard();
    updateHint();
    setMapInteractive(tool === 'pan');
    toast('Route saved');
  }

  function intermediateWaypoints(latlngs, maxN) {
    if (latlngs.length < 3 || maxN <= 0) return [];
    return sampleByDistance(latlngs, maxN + 2).slice(1, -1);
  }

  function googleDirUrl(latlngs, mode) {
    var start = latlngs[0];
    var end = latlngs[latlngs.length - 1];
    var travel = (ROUTE_MODES[mode] || ROUTE_MODES.walk).travelmode;
    var qs = 'api=1&origin=' + start.lat.toFixed(6) + ',' + start.lng.toFixed(6) +
      '&destination=' + end.lat.toFixed(6) + ',' + end.lng.toFixed(6) +
      '&travelmode=' + encodeURIComponent(travel);
    var mids = intermediateWaypoints(latlngs, 8);
    if (mids.length) {
      qs += '&waypoints=' + mids.map(function (pt) {
        return pt.lat.toFixed(6) + ',' + pt.lng.toFixed(6);
      }).join('|');
    }
    return 'https://www.google.com/maps/dir/?' + qs;
  }

  function openRouteInGoogleMaps(latlngs, mode) {
    if (!latlngs || latlngs.length < 2) return;
    var a = document.createElement('a');
    a.href = googleDirUrl(latlngs, mode);
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function exportRouteGpx(latlngs, mode, distance, duration) {
    if (!latlngs || latlngs.length < 2) return;
    var cfg = ROUTE_MODES[mode] || ROUTE_MODES.walk;
    var name = cfg.label + ' route';
    var desc = [];
    if (distance != null) desc.push(fmtDistance(distance));
    if (duration != null) desc.push(fmtDuration(duration));
    var pts = latlngs.map(function (ll) {
      return '      <trkpt lat="' + ll.lat.toFixed(6) + '" lon="' + ll.lng.toFixed(6) + '"></trkpt>';
    }).join('\n');
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Draw Map" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      '  <metadata><name>' + name + '</name><desc>' + desc.join(' · ') + '</desc></metadata>\n' +
      '  <trk><name>' + name + '</name><type>' + cfg.travelmode + '</type>\n' +
      '    <trkseg>\n' + pts + '\n    </trkseg>\n  </trk>\n</gpx>\n';
    shareOrDownload(new Blob([xml], { type: 'application/gpx+xml' }), 'draw-map-route.gpx', name);
  }

  /* ---------- search / locate / layers / gmaps ---------- */
  function nominatimSearch(q) {
    if (searchCtl) {
      try { searchCtl.abort(); } catch (e) { /* ignore */ }
    }
    searchCtl = new AbortController();
    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=0' +
      '&accept-language=de,en&q=' + encodeURIComponent(q);
    return fetchJson(url, { timeout: 8000, retries: 1, signal: searchCtl.signal });
  }

  function renderSearchResults(items) {
    var ul = $('search-results');
    ul.innerHTML = '';
    if (!items || !items.length) {
      ul.innerHTML = '<li class="empty">No places found</li><li class="attrib">Try a street, landmark, or city name</li>';
      ul.classList.remove('hidden');
      return;
    }
    items.forEach(function (it) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      var name = it.display_name || it.name || '';
      var parts = name.split(',');
      btn.innerHTML = '<span class="result-name">' + escapeHtml(parts[0].trim()) + '</span>' +
        '<span class="result-sub">' + escapeHtml(parts.slice(1).join(',').trim()) + '</span>';
      btn.addEventListener('click', function () {
        var lat = parseFloat(it.lat), lon = parseFloat(it.lon);
        map.setView([lat, lon], Math.max(map.getZoom(), 16));
        if (searchMarker) map.removeLayer(searchMarker);
        searchMarker = L.circleMarker([lat, lon], {
          radius: 8, color: '#1e88e5', weight: 2, fillColor: '#4aa3e8', fillOpacity: 0.6
        }).addTo(map);
        hideSearchResults();
        $('search-input').blur();
      });
      li.appendChild(btn);
      ul.appendChild(li);
    });
    var attr = document.createElement('li');
    attr.className = 'attrib';
    attr.textContent = 'Search © OpenStreetMap contributors (Nominatim)';
    ul.appendChild(attr);
    ul.classList.remove('hidden');
  }

  function hideSearchResults() {
    var ul = $('search-results');
    ul.classList.add('hidden');
    ul.innerHTML = '';
  }

  function onSearchInput() {
    var q = $('search-input').value.trim();
    $('btn-search-clear').classList.toggle('hidden', q.length === 0);
    if (q.length < 3) { hideSearchResults(); return; }
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      var wait = 1100 - (Date.now() - lastSearchAt);
      var run = function () {
        lastSearchAt = Date.now();
        nominatimSearch(q).then(renderSearchResults).catch(function (err) {
          if (err && (err.name === 'AbortError' || err.message === 'aborted')) return;
          toast('Search is unavailable right now');
        });
      };
      if (wait > 0) setTimeout(run, wait);
      else run();
    }, 350);
  }

  function locateMe() {
    if (!navigator.geolocation) {
      toast('Location is not supported in this browser');
      return;
    }
    $('btn-locate').classList.add('is-active');
    map.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true, timeout: 12000 });
  }

  function layerForBase(name) {
    if (name === 'satellite') return satelliteLayer;
    if (name === 'dark') return darkStreetsLayer;
    return lightStreetsLayer;
  }

  function setBasemap(name, silent) {
    if (name === 'satellite') currentBase = 'satellite';
    else if (name === 'dark') currentBase = 'dark';
    else currentBase = 'streets';
    var next = layerForBase(currentBase);
    [lightStreetsLayer, darkStreetsLayer, satelliteLayer].forEach(function (lyr) {
      if (!lyr) return;
      if (lyr === next) {
        if (!map.hasLayer(lyr)) lyr.addTo(map);
      } else if (map.hasLayer(lyr)) {
        map.removeLayer(lyr);
      }
    });
    document.querySelectorAll('.layer-option').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-layer') === currentBase);
    });
    if (!silent) persist();
  }

  function openInGoogleMaps() {
    var c = map.getCenter();
    var z = Math.round(map.getZoom());
    var url = 'https://www.google.com/maps/@' + c.lat.toFixed(6) + ',' + c.lng.toFixed(6) + ',' + z + 'z';
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---------- export / import / png ---------- */
  function shareOrDownload(blob, filename, title) {
    var file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: title || filename }).catch(function (err) {
        if (err && err.name !== 'AbortError') downloadBlob(blob, filename);
      });
    }
    downloadBlob(blob, filename);
    return Promise.resolve();
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2500);
  }

  function exportGeoJSON() {
    var json = JSON.stringify(toFeatureCollection(), null, 2);
    var blob = new Blob([json], { type: 'application/geo+json' });
    shareOrDownload(blob, 'draw-map.geojson', 'Draw Map export');
  }

  function importGeoJSONFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        if (data.type === 'Feature') data = { type: 'FeatureCollection', features: [data] };
        if (loadFeatureCollection(data, false)) toast('Imported ' + data.features.length + ' feature(s)');
      } catch (err) {
        toast('Could not read that GeoJSON file');
      }
    };
    reader.readAsText(file);
  }

  function corsTileUrl(src) {
    var m = src.match(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (m) return 'https://a.basemaps.cartocdn.com/rastertiles/voyager/' + m[1] + '/' + m[2] + '/' + m[3] + '.png';
    if (/arcgisonline\.com\/.*MapServer\/tile\/\d+\/\d+\/\d+/i.test(src)) return src;
    var esri = src.match(/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)/);
    if (esri) return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + esri[1] + '/' + esri[2] + '/' + esri[3];
    var carto = src.match(/basemaps\.cartocdn\.com\/[^/]+\/(\d+)\/(\d+)\/(\d+)/);
    if (carto) return src;
    return null;
  }

  function loadCorsImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('tile')); };
      img.src = url;
    });
  }

  function strokePath(ctx, points, closed) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (var i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (closed) ctx.closePath();
  }

  function drawPinOnCanvas(ctx, p, hex, label) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-12, -16, -12, -28, 0, -32);
    ctx.bezierCurveTo(12, -28, 12, -16, 0, 0);
    ctx.fillStyle = hex;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -22, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    if (label) {
      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
      var w = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(16,18,24,0.88)';
      var bw = Math.min(160, w + 12);
      ctx.fillRect(-bw / 2, 4, bw, 16);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 12, 150);
    }
    ctx.restore();
  }

  function exportPng() {
    toast('Creating screenshot…', 4000);
    var size = map.getSize();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(size.x * dpr);
    canvas.height = Math.round(size.y * dpr);
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = (currentBase === 'satellite' || currentBase === 'dark') ? '#1a1a1a' : '#d5e0c8';
    ctx.fillRect(0, 0, size.x, size.y);

    var containerRect = map.getContainer().getBoundingClientRect();
    var tiles = map.getPane('tilePane').querySelectorAll('img.leaflet-tile');
    var jobs = [];
    tiles.forEach(function (img) {
      if (!img.src || !img.getBoundingClientRect) return;
      var r = img.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      var x = r.left - containerRect.left;
      var y = r.top - containerRect.top;
      var url = corsTileUrl(img.src);
      if (!url) return;
      jobs.push(loadCorsImage(url).then(function (corsImg) {
        ctx.drawImage(corsImg, x, y, r.width, r.height);
      }).catch(function () { /* skip missing tile */ }));
    });

    Promise.all(jobs).then(function () {
      drawn.eachLayer(function (layer) {
        var p = layer.featureProps || {};
        var hex = p.color || '#e53935';
        var w = p.weight || 4;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = hex;
        ctx.fillStyle = hex;
        ctx.lineWidth = w;
        if (layer instanceof L.Circle) {
          var c = map.latLngToContainerPoint(layer.getLatLng());
          var edge = destPoint(layer.getLatLng(), 90, layer.getRadius());
          var rPx = Math.max(1, c.distanceTo(map.latLngToContainerPoint(edge)));
          ctx.beginPath();
          ctx.arc(c.x, c.y, rPx, 0, Math.PI * 2);
          ctx.globalAlpha = 0.22;
          ctx.fill();
          ctx.globalAlpha = 0.95;
          ctx.stroke();
        } else if (layer instanceof L.Marker) {
          var mp = map.latLngToContainerPoint(layer.getLatLng());
          drawPinOnCanvas(ctx, mp, hex, p.label || '');
        } else if (layer.getLatLngs) {
          var lls = flattenLatLngs(layer.getLatLngs());
          var pts = lls.map(function (ll) { return map.latLngToContainerPoint(ll); });
          var closed = layer instanceof L.Polygon;
          strokePath(ctx, pts, closed);
          if (closed) {
            ctx.globalAlpha = 0.22;
            ctx.fill();
            ctx.globalAlpha = 0.95;
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (p.tool !== 'marker') {
          var label = measurementFor(layer, p.tool);
          var anchor;
          if (layer instanceof L.Circle) anchor = map.latLngToContainerPoint(layer.getLatLng());
          else if (layer.getLatLngs) {
            var fl = flattenLatLngs(layer.getLatLngs());
            var mid = (layer instanceof L.Polygon) ? layer.getBounds().getCenter() : midpoint(fl);
            anchor = mid ? map.latLngToContainerPoint(mid) : null;
          }
          if (anchor && label) {
            ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
            var tw = ctx.measureText(label).width + 14;
            ctx.fillStyle = 'rgba(16,18,24,0.82)';
            ctx.fillRect(anchor.x - tw / 2, anchor.y - 9, tw, 18);
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, anchor.x, anchor.y);
          }
        }
      });

      ctx.fillStyle = 'rgba(16,18,24,0.78)';
      ctx.fillRect(0, size.y - 22, size.x, 22);
      ctx.fillStyle = '#fff';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      var credit = currentBase === 'satellite'
        ? 'Draw Map · Tiles © Esri · Screenshot may use satellite imagery'
        : (currentBase === 'dark'
          ? 'Draw Map · Tiles © Esri'
          : 'Draw Map · Map data © OpenStreetMap · Tiles in export © CARTO');
      ctx.fillText(credit, 8, size.y - 11, size.x - 16);

      canvas.toBlob(function (blob) {
        if (!blob) {
          toast('Could not create the PNG');
          return;
        }
        shareOrDownload(blob, 'draw-map.png', 'Draw Map screenshot');
        toast('Screenshot ready');
      }, 'image/png');
    }).catch(function () {
      toast('Could not create the PNG');
    });
  }

  /* ---------- bottom drawer + more sheet ---------- */
  var drawerMode = 'peek';

  function drawerHeights() {
    return { peek: 22, mid: 200, route: 352 };
  }

  function updateChromeBottom(drawerH) {
    var h = drawerH;
    if (h == null) {
      var el = $('drawer');
      h = el ? el.getBoundingClientRect().height : 22;
    }
    document.documentElement.style.setProperty(
      '--chrome-bottom',
      'calc(' + Math.round(h + 8 + 66) + 'px + var(--safe-bottom))'
    );
  }

  function setDrawerMode(mode) {
    var drawer = $('drawer');
    if (!drawer) return;
    drawerMode = mode === 'route' ? 'route' : (mode === 'mid' ? 'mid' : 'peek');
    drawer.classList.remove('is-peek', 'is-mid', 'is-route');
    drawer.classList.add('is-' + drawerMode);
    var h = drawerHeights()[drawerMode];
    drawer.style.height = h + 'px';
    updateChromeBottom(h);
  }

  function syncDrawer() {
    if (routePreview) setDrawerMode('route');
    else if (tool !== 'pan') setDrawerMode('mid');
    else setDrawerMode('peek');
  }

  function initDrawer() {
    var drawer = $('drawer');
    var handle = $('drawer-handle');
    if (!drawer || !handle) return;
    var startY = 0, startH = 0, pointerId = null;
    handle.addEventListener('pointerdown', function (ev) {
      if (ev.isPrimary === false) return;
      ev.preventDefault();
      pointerId = ev.pointerId;
      startY = ev.clientY;
      startH = drawer.getBoundingClientRect().height;
      drawer.classList.add('is-dragging');
      try { handle.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    });
    handle.addEventListener('pointermove', function (ev) {
      if (pointerId == null || ev.pointerId !== pointerId) return;
      ev.preventDefault();
      var next = Math.max(22, Math.min(380, startH - (ev.clientY - startY)));
      drawer.style.height = next + 'px';
      updateChromeBottom(next);
    });
    function endDrag(ev) {
      if (pointerId == null || (ev && ev.pointerId !== pointerId)) return;
      pointerId = null;
      drawer.classList.remove('is-dragging');
      var h = drawer.getBoundingClientRect().height;
      var hs = drawerHeights();
      var target;
      if (routePreview) target = h < (hs.peek + hs.route) / 2 ? 'peek' : 'route';
      else if (tool !== 'pan') target = h < (hs.peek + hs.mid) / 2 ? 'peek' : 'mid';
      else target = h > (hs.peek + hs.mid) / 2 ? 'mid' : 'peek';
      setDrawerMode(target);
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  /* ---------- UI wiring ---------- */
  function buildSwatches() {

    var box = $('color-swatches');
    COLORS.forEach(function (hex) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (LIGHT_COLORS[hex] ? ' light' : '');
      b.style.setProperty('--c', hex);
      b.setAttribute('aria-label', 'Color ' + hex);
      b.title = hex;
      if (hex === color) b.classList.add('is-active');
      b.addEventListener('click', function () {
        color = hex;
        box.querySelectorAll('.swatch').forEach(function (s) { s.classList.remove('is-active'); });
        b.classList.add('is-active');
        if (draftLayer && draftLayer.setStyle) draftLayer.setStyle(pathStyle(tool === 'polygon' || tool === 'rectangle' || tool === 'circle'));
      });
      box.appendChild(b);
    });
  }

  function preventPageBounce() {
    document.addEventListener('touchmove', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('#search-results, .sheet-card, .drawer, #more-sheet, .onboard, input, textarea')) return;
      if (e.touches && e.touches.length > 1 && isDrawMode()) e.preventDefault();
      if (isDrawMode() && t && t.closest && t.closest('#map, .leaflet-container')) e.preventDefault();
    }, { passive: false });
    function preventIfDrawing(e) { if (isDrawMode()) e.preventDefault(); }
    document.addEventListener('gesturestart', preventIfDrawing);
    document.addEventListener('gesturechange', preventIfDrawing);
    document.addEventListener('gestureend', preventIfDrawing);
    map.getContainer().addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function initMap() {
    map = L.map('map', {
      zoomControl: false,
      attributionControl: true,
      maxZoom: 19,
      tap: false,
      bounceAtZoomLimits: false
    }).setView(VIENNA, DEFAULT_ZOOM);

    if (prefersDark()) currentBase = 'dark';
    lightStreetsLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    });
    var darkBase = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        maxNativeZoom: 16,
        attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>'
      }
    );
    var darkRef = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, maxNativeZoom: 16, attribution: '' }
    );
    darkStreetsLayer = L.layerGroup([darkBase, darkRef]);
    satelliteLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>'
      }
    );
    layerForBase(currentBase).addTo(map);
    L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(map);
    map.attributionControl.setPrefix('');

    drawn = L.featureGroup().addTo(map);
    draft = L.layerGroup().addTo(map);
    locateLayer = L.layerGroup().addTo(map);
    routeLayerGroup = L.layerGroup().addTo(map);

    map.on('click', onMapClick);
    map.on('moveend', function () { persist(); });
    map.on('baselayerchange', function () { persist(); });
    map.on('locationfound', function (e) {
      $('btn-locate').classList.remove('is-active');
      locateLayer.clearLayers();
      L.circle(e.latlng, {
        radius: e.accuracy / 2, color: '#1e88e5', weight: 1,
        fillColor: '#4aa3e8', fillOpacity: 0.15, interactive: false
      }).addTo(locateLayer);
      locateMarker = L.circleMarker(e.latlng, {
        radius: 7, color: '#fff', weight: 2, fillColor: '#1e88e5', fillOpacity: 1, interactive: false
      }).addTo(locateLayer);
    });
    map.on('locationerror', function () {
      $('btn-locate').classList.remove('is-active');
      toast('Could not get your location. Allow location access and try again.');
    });

    var container = map.getContainer();
    container.addEventListener('pointerdown', onPointerDown, { passive: false });
    container.addEventListener('pointermove', onPointerMove, { passive: false });
    container.addEventListener('pointerup', onPointerUp, { passive: false });
    container.addEventListener('pointercancel', onPointerUp, { passive: false });

    window.addEventListener('resize', function () { map.invalidateSize(); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { map.invalidateSize(); });
    }
    window.__map = map;
  }

  function wireUi() {
    buildSwatches();
    document.querySelectorAll('.tool').forEach(function (btn) {
      btn.addEventListener('click', function () { setTool(btn.getAttribute('data-tool')); });
    });
    $('width-slider').addEventListener('input', function (e) {
      weight = Number(e.target.value);
      $('width-label').textContent = weight + ' px';
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-clear').addEventListener('click', clearAll);
    $('btn-cancel-draft').addEventListener('click', function () { cancelDraft(); updateHint(); });
    $('btn-undo-vertex').addEventListener('click', undoVertex);
    $('btn-finish-draft').addEventListener('click', finishVertexShape);
    $('btn-locate').addEventListener('click', locateMe);
    $('btn-more').addEventListener('click', function (e) {
      e.stopPropagation();
      openMore();
    });
    if ($('more-backdrop')) $('more-backdrop').addEventListener('click', closeMore);
    $('sheet-backdrop').addEventListener('click', closeSheet);
    if ($('m-gmaps')) $('m-gmaps').addEventListener('click', function () { closeMore(); openInGoogleMaps(); });
    if ($('m-geojson')) $('m-geojson').addEventListener('click', function () { closeMore(); exportGeoJSON(); });
    if ($('m-png')) $('m-png').addEventListener('click', function () { closeMore(); exportPng(); });
    if ($('m-help')) $('m-help').addEventListener('click', function () { closeMore(); openHelp(); });
    if ($('m-import')) $('m-import').addEventListener('click', function () { $('import-file').click(); });
    if ($('import-file')) $('import-file').addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      closeMore();
      importGeoJSONFile(file);
    });
    initDrawer();

    $('btn-layers').addEventListener('click', function (e) {
      e.stopPropagation();
      hideSearchResults();
      $('layer-menu').classList.toggle('hidden');
    });
    document.querySelectorAll('.layer-option').forEach(function (b) {
      b.addEventListener('click', function () {
        setBasemap(b.getAttribute('data-layer'));
        $('layer-menu').classList.add('hidden');
      });
    });

    $('search-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var q = $('search-input').value.trim();
      if (q.length < 2) return;
      lastSearchAt = Date.now();
      nominatimSearch(q).then(renderSearchResults).catch(function () {
        toast('Search is unavailable right now');
      });
    });
    $('search-input').addEventListener('input', onSearchInput);
    $('search-input').addEventListener('focus', function () {
      if ($('search-results').children.length) $('search-results').classList.remove('hidden');
    });
    $('btn-search-clear').addEventListener('click', function () {
      $('search-input').value = '';
      $('btn-search-clear').classList.add('hidden');
      hideSearchResults();
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest('.top-ui, .side-controls')) {
        hideSearchResults();
        $('layer-menu').classList.add('hidden');
      }
    });

    document.querySelectorAll('#route-modes .mode').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        setRouteMode(btn.getAttribute('data-mode'));
      });
    });
    $('btn-route-discard').addEventListener('click', function () {
      abortRouteRequests();
      clearRoutePreview();
      toast('Route discarded');
    });
    $('btn-route-keep').addEventListener('click', keepRoutePreview);
    $('btn-route-gmaps').addEventListener('click', function () {
      if (routePreview) openRouteInGoogleMaps(routePreview.latlngs, routePreview.mode);
    });
    $('btn-route-gpx').addEventListener('click', function () {
      if (routePreview) exportRouteGpx(routePreview.latlngs, routePreview.mode, routePreview.distance, routePreview.duration);
    });
    try {
      var savedMode = localStorage.getItem(MODE_KEY);
      if (ROUTE_MODES[savedMode]) routeMode = savedMode;
    } catch (e) { /* ignore */ }
    updateRouteModeButtons();

    $('btn-dismiss-tip').addEventListener('click', function () {
      $('install-tip').classList.add('hidden');
      $('install-tip').hidden = true;
      try { localStorage.setItem(TIP_KEY, '1'); } catch (e) { /* ignore */ }
    });

    if (!localStorage.getItem(TIP_KEY)) {
      $('install-tip').classList.remove('hidden');
      $('install-tip').hidden = false;
    }

    function syncOfflineBanner() {
      var el = $('offline-banner');
      if (!el) return;
      var off = typeof navigator.onLine === 'boolean' && !navigator.onLine;
      el.classList.toggle('hidden', !off);
      el.hidden = !off;
    }
    window.addEventListener('online', function () {
      syncOfflineBanner();
      toast('Back online');
    });
    window.addEventListener('offline', syncOfflineBanner);
    syncOfflineBanner();
  }

  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    var ok = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!ok) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* optional */ });
    });
  }

  /* ---------- boot ---------- */
  applyThemeMeta();
  if (window.matchMedia) {
    var schemeMq = window.matchMedia('(prefers-color-scheme: dark)');
    if (schemeMq.addEventListener) schemeMq.addEventListener('change', applyThemeMeta);
    else if (schemeMq.addListener) schemeMq.addListener(applyThemeMeta);
  }
  initMap();
  wireUi();
  restore();
  setBasemap(currentBase, true);
  setTool('pan');
  preventPageBounce();
  registerSw();
  updateUndoBtn();
})();
