/* Draw Map — mobile-first PWA. Leaflet is bundled locally; drawings are real map layers. */
(function () {
  'use strict';

  var VIENNA = [48.2082, 16.3738];
  var DEFAULT_ZOOM = 13;
  var STORAGE_KEY = 'draw-map-app:v1';
  var TIP_KEY = 'draw-map-app:tip-v1';
  var EARTH_R = 6378137;
  var COLORS = [
    '#e53935', '#fb8c00', '#fdd835', '#43a047',
    '#1e88e5', '#8e24aa', '#ffffff', '#212121'
  ];
  var LIGHT_COLORS = { '#ffffff': 1, '#fdd835': 1, '#fff': 1 };
  var DRAG_TOOLS = { pen: 1, rectangle: 1, circle: 1 };
  var VERTEX_TOOLS = { line: 1, polygon: 1 };
  var MAX_UNDO = 50;

  var map, streetsLayer, satelliteLayer, drawn, draft, locateLayer;
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

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }

  function nowId() {
    idSeq += 1;
    return 'dm-' + Date.now().toString(36) + '-' + idSeq;
  }

  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 2400);
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
    tool = next;
    document.querySelectorAll('.tool').forEach(function (btn) {
      var on = btn.getAttribute('data-tool') === tool;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on && btn.scrollIntoView) btn.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
    setMapInteractive(tool === 'pan');
    if (tool === 'erase') toast('Tap a drawing to delete it');
    updateHint();
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
    }
    bar.classList.toggle('hidden', !show);
    bar.hidden = !show;
    document.body.classList.toggle('has-hint', show);
  }

  function clearVertexMarkers() {
    vertexMarkers.forEach(function (m) { draft.removeLayer(m); });
    vertexMarkers = [];
  }

  function cancelDraft() {
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
      '.top-ui, .dock, .hint-bar, .sheet, .install-tip, .toast, .leaflet-control, .leaflet-popup'
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

  function onPointerDown(ev) {
    if (!isDrawMode()) return;
    if (eventOnUi(ev.target)) return;
    if (ev.isPrimary === false) return;
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
    if (tool === 'pen') {
      draftLayer = L.polyline(dragPts, pathStyle(false)).addTo(draft);
    } else if (tool === 'rectangle') {
      draftLayer = L.rectangle(L.latLngBounds(dragStart, dragStart), pathStyle(true)).addTo(draft);
    } else if (tool === 'circle') {
      draftLayer = L.circle(dragStart, Object.assign(pathStyle(true), { radius: 1 })).addTo(draft);
    }
  }

  function onPointerMove(ev) {
    if (!dragging || ev.pointerId !== activePointer) return;
    ev.preventDefault();
    var ll = containerLatLng(ev);
    if (tool === 'pen') {
      var last = dragPts[dragPts.length - 1];
      if (haversine(last, ll) < 0.3) return;
      dragPts.push(ll);
      draftLayer.setLatLngs(dragPts);
    } else if (tool === 'rectangle') {
      draftLayer.setBounds(L.latLngBounds(dragStart, ll));
    } else if (tool === 'circle') {
      draftLayer.setRadius(Math.max(1, haversine(dragStart, ll)));
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
    if (tool === 'pen') {
      if (ll) dragPts.push(ll);
      var pts = simplify(dragPts, 2.2);
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
      rectangle: 'Rectangle', circle: 'Circle', marker: 'Pin'
    })[p.tool] || 'Drawing';
    openSheet(title, function (body) {
      var meas = measurementFor(layer, p.tool);
      var extra = p.label ? '<p><strong>' + escapeHtml(p.label) + '</strong></p>' : '';
      body.innerHTML = extra + '<p>' + escapeHtml(meas) + '</p>' +
        '<div class="btn-row">' +
        '<button type="button" class="btn-block" id="sheet-cancel">Close</button>' +
        '<button type="button" class="btn-block danger" id="sheet-ok">Delete</button>' +
        '</div>';
      $('sheet-cancel').onclick = closeSheet;
      $('sheet-ok').onclick = function () {
        deleteLayer(layer);
        closeSheet();
      };
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function openMenu() {
    openSheet('Draw Map', function (body) {
      body.innerHTML =
        '<div class="menu-list">' +
        '<button type="button" class="menu-item" id="m-gmaps">Open in Google Maps</button>' +
        '<button type="button" class="menu-item" id="m-geojson">Export GeoJSON</button>' +
        '<button type="button" class="menu-item" id="m-import">Import GeoJSON</button>' +
        '<button type="button" class="menu-item" id="m-png">Export PNG screenshot</button>' +
        '<button type="button" class="menu-item" id="m-help">Help &amp; install</button>' +
        '</div>' +
        '<input id="import-file" type="file" accept=".json,.geojson,application/geo+json,application/json" hidden>';
      $('m-gmaps').onclick = function () { closeSheet(); openInGoogleMaps(); };
      $('m-geojson').onclick = function () { closeSheet(); exportGeoJSON(); };
      $('m-png').onclick = function () { closeSheet(); exportPng(); };
      $('m-help').onclick = function () { openHelp(); };
      $('m-import').onclick = function () { $('import-file').click(); };
      $('import-file').addEventListener('change', function (ev) {
        var file = ev.target.files && ev.target.files[0];
        ev.target.value = '';
        if (!file) return;
        closeSheet();
        importGeoJSONFile(file);
      });
    });
  }

  function openHelp() {
    openSheet('How to use', function (body) {
      body.innerHTML =
        '<p>Drawings stay anchored to the map when you pan or zoom. Turn on a tool to draw; switch back to <strong>Pan</strong> to move the map with one finger.</p>' +
        '<p><strong>Pen</strong> is freehand. <strong>Line</strong> and <strong>Area</strong> add a point each time you tap — then press Done. <strong>Rect</strong> and <strong>Circle</strong> are drag gestures. <strong>Pin</strong> drops a labeled marker.</p>' +
        '<p>Distances and areas use metric units. Work is auto-saved in this browser.</p>' +
        '<p><strong>iPhone Safari:</strong> Share button → Add to Home Screen.</p>' +
        '<p><strong>iPhone Chrome:</strong> Menu → Add to Home Screen. Chrome on iOS uses the same engine as Safari; install also works from Safari if the menu is missing.</p>' +
        '<p>This app cannot add a drawing tool inside the official Google Maps app. Use “Open in Google Maps” to jump to the same place there.</p>' +
        '<div class="btn-row"><button type="button" class="btn-block primary" id="sheet-ok">Close</button></div>';
      $('sheet-ok').onclick = closeSheet;
    });
  }

  /* ---------- search / locate / layers / gmaps ---------- */
  function nominatimSearch(q) {
    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=0' +
      '&accept-language=de,en&q=' + encodeURIComponent(q);
    return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('search failed');
      return r.json();
    });
  }

  function renderSearchResults(items) {
    var ul = $('search-results');
    ul.innerHTML = '';
    if (!items || !items.length) {
      ul.innerHTML = '<li class="attrib">No places found</li>';
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
        nominatimSearch(q).then(renderSearchResults).catch(function () {
          toast('Search is unavailable right now');
        });
      };
      if (wait > 0) setTimeout(run, wait);
      else run();
    }, 400);
  }

  function locateMe() {
    if (!navigator.geolocation) {
      toast('Location is not supported in this browser');
      return;
    }
    $('btn-locate').classList.add('is-active');
    map.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true, timeout: 12000 });
  }

  function setBasemap(name, silent) {
    currentBase = name === 'satellite' ? 'satellite' : 'streets';
    if (currentBase === 'satellite') {
      if (map.hasLayer(streetsLayer)) map.removeLayer(streetsLayer);
      if (!map.hasLayer(satelliteLayer)) satelliteLayer.addTo(map);
    } else {
      if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
      if (!map.hasLayer(streetsLayer)) streetsLayer.addTo(map);
    }
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
    ctx.fillStyle = currentBase === 'satellite' ? '#1a1a1a' : '#d5e0c8';
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
        : 'Draw Map · Map data © OpenStreetMap · Tiles in export © CARTO';
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
      if (t && t.closest && t.closest('#search-results, .sheet-card, input, textarea')) return;
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

    streetsLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    });
    satelliteLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>'
      }
    );
    streetsLayer.addTo(map);
    L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(map);
    map.attributionControl.setPrefix('');

    drawn = L.featureGroup().addTo(map);
    draft = L.layerGroup().addTo(map);
    locateLayer = L.layerGroup().addTo(map);

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
    $('btn-menu').addEventListener('click', openMenu);
    $('sheet-backdrop').addEventListener('click', closeSheet);

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
      if (!e.target.closest('.top-ui')) {
        hideSearchResults();
        $('layer-menu').classList.add('hidden');
      }
    });

    $('btn-dismiss-tip').addEventListener('click', function () {
      $('install-tip').classList.add('hidden');
      $('install-tip').hidden = true;
      try { localStorage.setItem(TIP_KEY, '1'); } catch (e) { /* ignore */ }
    });

    if (!localStorage.getItem(TIP_KEY) && !window.navigator.standalone) {
      $('install-tip').classList.remove('hidden');
      $('install-tip').hidden = false;
    }
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
  initMap();
  wireUi();
  restore();
  setTool('pan');
  preventPageBounce();
  registerSw();
  updateUndoBtn();
})();
