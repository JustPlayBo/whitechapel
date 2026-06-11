/* mapboard.js — a board whose background is a MapLibre GL map.
 *
 * Same controller interface as Board (setDef / renderAll / upsert / removeEl /
 * showCursor / dropCursor / fit / isDragging / startCreate / dispose), so app.js
 * can swap it in for any pack whose `board.map` is a MapLibre style. Pieces live
 * at geographic coordinates: a marker's {x,y} is interpreted as {lng,lat}, so it
 * pins to the map and stays put as everyone pans and zooms.
 *
 * MapLibre GL is loaded lazily from a CDN the first time a map pack is opened, so
 * non-map games never pay for it.
 */
(function (global) {
  'use strict';

  const MAPLIBRE_JS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4/dist/maplibre-gl.js';
  const MAPLIBRE_CSS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4/dist/maplibre-gl.css';
  const CURSOR_TTL = 4000;

  let _libPromise = null;
  function ensureMapLibre() {
    if (global.maplibregl) return Promise.resolve();
    if (_libPromise) return _libPromise;
    _libPromise = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = MAPLIBRE_CSS;
      document.head.appendChild(link);
      const s = document.createElement('script');
      s.src = MAPLIBRE_JS;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load MapLibre GL'));
      document.head.appendChild(s);
    });
    return _libPromise;
  }

  // a lat/lng graticule as GeoJSON, for the optional grid overlay
  function graticule(step) {
    const f = [];
    const line = (coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
    for (let lng = -180; lng <= 180; lng += step) f.push(line([[lng, -85], [lng, 85]]));
    for (let lat = -80; lat <= 80; lat += step) {
      const seg = []; for (let lng = -180; lng <= 180; lng += 5) seg.push([lng, lat]);
      f.push(line(seg));
    }
    return { type: 'FeatureCollection', features: f };
  }

  class MapBoard {
    constructor(refs, cb) {
      this.mapEl = refs.mapContainer;
      this.viewport = refs.viewport;
      this.trashEl = refs.trash;
      this.cb = cb || {};
      this.def = null; this.pieceMap = new Map();
      this.map = null; this._ready = false;
      this._markers = new Map();   // id -> maplibregl.Marker
      this._cursors = new Map();   // cid -> { mk, el, timer }
      this._want = [];             // desired marker set (applied once ready)
      this._dragId = null;
      this._lastCur = 0;
    }

    async setDef(def) {
      this.def = def;
      this.pieceMap = global.GameDef.pieceMap(def);
      await ensureMapLibre();
      const style = def.board.map;
      if (!this.map) {
        this.viewport.classList.add('hidden');
        this.mapEl.classList.remove('hidden');
        this.map = new global.maplibregl.Map({
          container: this.mapEl, style,
          center: def.board.center || [0, 20],
          zoom: def.board.zoom != null ? def.board.zoom : 1.4,
          attributionControl: true,
        });
        this.map.addControl(new global.maplibregl.NavigationControl({ showCompass: false }), 'top-left');
        this.map.on('load', () => { this._ready = true; this._addGrid(); this._sync(); this._wireCursor(); });
        this.map.on('styledata', () => { if (this._ready) this._addGrid(); });
      } else {
        this.map.setStyle(style);
        if (def.board.center) this.map.setCenter(def.board.center);
        if (def.board.zoom != null) this.map.setZoom(def.board.zoom);
      }
    }

    _addGrid() {
      const g = this.def && this.def.board.grid;
      if (!g || !this.map) return;
      const id = 'lfw-grid';
      try {
        if (!this.map.getSource(id)) this.map.addSource(id, { type: 'geojson', data: graticule(g.step || 15) });
        if (!this.map.getLayer(id)) this.map.addLayer({
          id, type: 'line', source: id,
          paint: { 'line-color': g.color || '#3a587a', 'line-width': g.width || 0.6, 'line-opacity': g.opacity != null ? g.opacity : 0.5 },
        });
      } catch (e) { /* style not ready yet — styledata will retry */ }
    }

    _wireCursor() {
      this.map.on('mousemove', (e) => {
        if (!this.cb.onCursor) return;
        const t = performance.now();
        if (t - this._lastCur < 60) return;
        this._lastCur = t;
        this.cb.onCursor(e.lngLat.lng, e.lngLat.lat);
      });
    }

    _sizePx(piece) {
      const frac = (piece && piece.size) || (this.def && this.def.board.pieceSize) || 0.05;
      return Math.max(22, Math.min(72, Math.round(frac * 800)));
    }

    /* ---- markers ---- */
    renderAll(markers) { this._want = markers.slice(); if (this._ready) this._sync(); }
    _sync() {
      const seen = new Set();
      this._want.forEach((m) => { this._draw(m); seen.add(m.id); });
      for (const id of [...this._markers.keys()]) if (!seen.has(id)) this.removeEl(id);
    }

    upsert(m) {
      const i = this._want.findIndex((x) => x.id === m.id);
      if (i >= 0) this._want[i] = m; else this._want.push(m);
      if (this._ready) this._draw(m);
    }

    _draw(m) {
      const ML = global.maplibregl;
      let mk = this._markers.get(m.id);
      if (!mk) {
        const piece = this.pieceMap.get(m.type) || global.GameDef.fallbackPiece(m.type);
        const el = global.GameDef.renderPiece(piece);
        el.classList.add('map-piece');
        el.style.setProperty('--sz', this._sizePx(piece) + 'px');
        el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.cb.onRemove && this.cb.onRemove(m.id); });
        mk = new ML.Marker({ element: el, anchor: 'center', draggable: true });
        mk.setLngLat([m.x, m.y]).addTo(this.map);
        mk.on('dragstart', () => { this._dragId = m.id; });
        mk.on('drag', () => {
          const ll = mk.getLngLat();
          el.classList.toggle('over-trash', this._overTrashLngLat(ll));
          this.cb.onLive && this.cb.onLive(m.id, ll.lng, ll.lat);
        });
        mk.on('dragend', () => {
          const ll = mk.getLngLat();
          this._dragId = null; el.classList.remove('over-trash');
          if (this._overTrashLngLat(ll)) this.cb.onRemove && this.cb.onRemove(m.id);
          else this.cb.onMove && this.cb.onMove(m.id, ll.lng, ll.lat);
        });
        this._markers.set(m.id, mk);
      } else if (this._dragId !== m.id) {
        mk.setLngLat([m.x, m.y]);
      }
    }

    removeEl(id) {
      const mk = this._markers.get(id);
      if (mk) { mk.remove(); this._markers.delete(id); }
      this._want = this._want.filter((x) => x.id !== id);
    }

    isDragging(id) { return this._dragId === id; }

    /* ---- cursors ---- */
    showCursor(cid, c) {
      if (!this._ready) return;
      const ML = global.maplibregl;
      let e = this._cursors.get(cid);
      if (!e) {
        const el = document.createElement('div');
        el.className = 'cursor';
        el.innerHTML = '<span class="cursor-dot"></span><span class="cursor-name"></span>';
        const mk = new ML.Marker({ element: el, anchor: 'top-left' });
        mk.setLngLat([c.x, c.y]).addTo(this.map);
        e = { mk, el, timer: 0 };
        this._cursors.set(cid, e);
      } else { e.mk.setLngLat([c.x, c.y]); }
      e.el.style.setProperty('--c', c.color || '#fff');
      e.el.querySelector('.cursor-name').textContent = c.name || '';
      clearTimeout(e.timer);
      e.timer = setTimeout(() => this.dropCursor(cid), CURSOR_TTL);
    }
    dropCursor(cid) {
      const e = this._cursors.get(cid);
      if (e) { clearTimeout(e.timer); e.mk.remove(); this._cursors.delete(cid); }
    }

    /* ---- tray drag-to-add (the map itself handles marker drag + camera) ---- */
    startCreate(type, ev) {
      const piece = this.pieceMap.get(type) || global.GameDef.fallbackPiece(type);
      const ghost = global.GameDef.renderPiece(piece);
      ghost.classList.add('drag-ghost');
      ghost.style.setProperty('--sz', this._sizePx(piece) + 'px');
      document.body.appendChild(ghost);
      const move = (e) => {
        ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
        ghost.classList.toggle('on-board', this._overMap(e.clientX, e.clientY));
      };
      const up = (e) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        ghost.remove();
        if (this._overMap(e.clientX, e.clientY) && !this._overXY(this.trashEl, e.clientX, e.clientY)) {
          const r = this.mapEl.getBoundingClientRect();
          const ll = this.map.unproject([e.clientX - r.left, e.clientY - r.top]);
          this.cb.onAdd && this.cb.onAdd(type, ll.lng, ll.lat);
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      move(ev);
    }

    /* ---- geometry helpers ---- */
    _overMap(x, y) { return this._overXY(this.mapEl, x, y); }
    _overXY(el, x, y) { const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
    _overTrashLngLat(ll) {
      const p = this.map.project(ll); const mr = this.mapEl.getBoundingClientRect();
      return this._overXY(this.trashEl, p.x + mr.left, p.y + mr.top);
    }

    fit() { if (this.map) this.map.resize(); }

    dispose() {
      this._cursors.forEach((e) => { clearTimeout(e.timer); e.mk.remove(); });
      this._cursors.clear();
      this._markers.forEach((mk) => mk.remove());
      this._markers.clear();
      if (this.map) { this.map.remove(); this.map = null; }
      this._ready = false;
      this.mapEl.classList.add('hidden');
      this.viewport.classList.remove('hidden');
    }
  }

  global.MapBoard = MapBoard;
})(window);
