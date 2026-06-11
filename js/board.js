/* board.js — rendering + pointer interaction, driven entirely by a GameDef.
 *
 * The board has an intrinsic size BASE_W × BASE_H px (aspect from the def).
 * Markers live at normalised [0,1] positions drawn with percentage offsets, so
 * they line up on every screen and at any zoom. Piece pixel size is a fraction
 * of the board width, so pieces keep their relative scale across packs.
 */
(function (global) {
  'use strict';

  const BASE_H = 1200;
  const MIN_SCALE = 0.1, MAX_SCALE = 6;
  const CURSOR_TTL = 4000;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  class Board {
    constructor(refs, cb) {
      this.viewport = refs.viewport;
      this.stage = refs.stage;
      this.board = refs.board;
      this.boardImg = refs.boardImg;
      this.markersEl = refs.markers;
      this.cursorsEl = refs.cursors;
      this.trashEl = refs.trash;
      this.cb = cb || {};

      this.def = null; this.pieceMap = new Map();
      this.BASE_W = BASE_H; this.BASE_H = BASE_H;
      this.scale = 1; this.tx = 0; this.ty = 0;
      this.els = new Map();
      this.cursors = new Map();
      this.gesture = null;
      this._pointers = new Map();
      this._lastCursorPub = 0;
      this._markersCache = [];

      this._bind();
    }

    /* ============ load a game definition ============ */
    setDef(def) {
      this.def = def;
      this.pieceMap = global.GameDef.pieceMap(def);
      this._applyAspect(def.board.aspect || 1.6);

      // image packs may not declare an aspect — adopt the real one once loaded.
      // attach the handler BEFORE applyBoard sets src, and cover the cached case.
      const onImg = () => {
        if (this.boardImg.naturalWidth && this.boardImg.naturalHeight) {
          this._applyAspect(this.boardImg.naturalWidth / this.boardImg.naturalHeight);
          this._applySizes();
          this.fit();
        }
      };
      this.boardImg.onload = def.board.image ? onImg : null;

      global.GameDef.applyBoard(def, this.board, this.boardImg);
      if (def.board.image && this.boardImg.complete && this.boardImg.naturalWidth) onImg();

      // wipe and rebuild marker elements for the new piece set
      this.els.forEach((el) => el.remove());
      this.els.clear();
    }

    _applyAspect(aspect) {
      this.BASE_H = BASE_H;
      this.BASE_W = Math.round(BASE_H * (aspect || 1.6));
      this.board.style.width = this.BASE_W + 'px';
      this.board.style.height = this.BASE_H + 'px';
    }

    _sizePx(piece) {
      const frac = (piece && piece.size) || (this.def && this.def.board.pieceSize) || 0.05;
      return Math.round(frac * this.BASE_W);
    }
    _applySizes() {
      this.els.forEach((el, id) => {
        const m = this._markersCache.find((x) => x.id === id);
        const piece = m && (this.pieceMap.get(m.type) || global.GameDef.fallbackPiece(m.type));
        if (piece) el.style.setProperty('--sz', this._sizePx(piece) + 'px');
      });
    }

    /* ============ transform ============ */
    apply() { this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`; }

    fit() {
      const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
      const s = Math.min(vw / this.BASE_W, vh / this.BASE_H) * 0.98;
      this.scale = clamp(s, MIN_SCALE, MAX_SCALE);
      this.tx = (vw - this.BASE_W * this.scale) / 2;
      this.ty = (vh - this.BASE_H * this.scale) / 2;
      this.apply();
    }

    zoomAt(px, py, factor) {
      const ns = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
      this.tx = px - (px - this.tx) * (ns / this.scale);
      this.ty = py - (py - this.ty) * (ns / this.scale);
      this.scale = ns;
      this.apply();
    }

    /* ============ coords ============ */
    clientToNorm(cx, cy) {
      const r = this.board.getBoundingClientRect();
      return { x: clamp((cx - r.left) / r.width, 0, 1), y: clamp((cy - r.top) / r.height, 0, 1) };
    }
    overBoard(cx, cy) { const r = this.board.getBoundingClientRect(); return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom; }
    overTrash(cx, cy) { const r = this.trashEl.getBoundingClientRect(); return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom; }

    /* ============ markers ============ */
    renderAll(markers) {
      this._markersCache = markers.slice();
      const seen = new Set();
      markers.forEach((m) => { this.upsert(m); seen.add(m.id); });
      for (const id of [...this.els.keys()]) if (!seen.has(id)) this.removeEl(id);
    }

    upsert(m) {
      const piece = this.pieceMap.get(m.type) || global.GameDef.fallbackPiece(m.type);
      let el = this.els.get(m.id);
      if (!el) {
        el = global.GameDef.renderPiece(piece);
        el.classList.add('appear');
        el.dataset.id = m.id;
        el.style.setProperty('--sz', this._sizePx(piece) + 'px');
        this.markersEl.appendChild(el);
        this.els.set(m.id, el);
        if (!this._markersCache.find((x) => x.id === m.id)) this._markersCache.push(m);
      }
      if (this.isDragging(m.id)) return;          // don't fight our own pointer
      el.style.left = (m.x * 100) + '%';
      el.style.top = (m.y * 100) + '%';
      el.title = piece.label + (m.by ? ' · last moved by ' + m.by : '');
    }

    removeEl(id) {
      const el = this.els.get(id);
      if (el) { el.remove(); this.els.delete(id); }
      this._markersCache = this._markersCache.filter((x) => x.id !== id);
    }

    isDragging(id) { return !!(this.gesture && this.gesture.kind === 'move' && this.gesture.id === id); }

    /* ============ cursors ============ */
    showCursor(cid, c) {
      let entry = this.cursors.get(cid);
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'cursor';
        el.innerHTML = '<span class="cursor-dot"></span><span class="cursor-name"></span>';
        this.cursorsEl.appendChild(el);
        entry = { el, timer: 0 };
        this.cursors.set(cid, entry);
      }
      entry.el.style.left = (c.x * 100) + '%';
      entry.el.style.top = (c.y * 100) + '%';
      entry.el.style.setProperty('--c', c.color || '#fff');
      entry.el.querySelector('.cursor-name').textContent = c.name || '';
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.dropCursor(cid), CURSOR_TTL);
    }
    dropCursor(cid) {
      const e = this.cursors.get(cid);
      if (e) { clearTimeout(e.timer); e.el.remove(); this.cursors.delete(cid); }
    }

    /* ============ pointer plumbing ============ */
    _bind() {
      this._h = {
        down: (e) => this._onDown(e),
        move: (e) => this._onMove(e),
        up: (e) => this._onUp(e),
        cancel: () => this._endGesture(),
        wheel: (e) => {
          e.preventDefault();
          const r = this.viewport.getBoundingClientRect();
          this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
        },
        ctx: (e) => {
          const el = e.target.closest('.marker');
          if (!el) return;
          e.preventDefault();
          this.cb.onRemove && this.cb.onRemove(el.dataset.id);
        },
      };
      this.viewport.addEventListener('pointerdown', this._h.down);
      window.addEventListener('pointermove', this._h.move, { passive: false });
      window.addEventListener('pointerup', this._h.up);
      window.addEventListener('pointercancel', this._h.cancel);
      this.viewport.addEventListener('wheel', this._h.wheel, { passive: false });
      this.markersEl.addEventListener('contextmenu', this._h.ctx);
    }

    dispose() {
      const h = this._h;
      if (h) {
        this.viewport.removeEventListener('pointerdown', h.down);
        window.removeEventListener('pointermove', h.move);
        window.removeEventListener('pointerup', h.up);
        window.removeEventListener('pointercancel', h.cancel);
        this.viewport.removeEventListener('wheel', h.wheel);
        this.markersEl.removeEventListener('contextmenu', h.ctx);
      }
      this.els.forEach((el) => el.remove());
      this.els.clear();
    }

    startCreate(type, ev) {
      this._endGesture();
      const piece = this.pieceMap.get(type) || global.GameDef.fallbackPiece(type);
      const ghost = global.GameDef.renderPiece(piece);
      ghost.classList.add('drag-ghost');
      ghost.style.setProperty('--sz', Math.round(this._sizePx(piece) * this.scale) + 'px');
      document.body.appendChild(ghost);
      this.gesture = { kind: 'create', type, ghost, pointerId: ev.pointerId };
      this._moveGhost(ev.clientX, ev.clientY);
    }

    _onDown(e) {
      if (e.button === 2) return;
      this._pointers.set(e.pointerId, e);
      if (this._pointers.size === 2) { this._beginPinch(); return; }
      const markerEl = e.target.closest('.marker');
      if (markerEl) {
        this.gesture = { kind: 'move', id: markerEl.dataset.id, el: markerEl, pointerId: e.pointerId, moved: false };
        markerEl.classList.add('grabbing');
        e.preventDefault();
        return;
      }
      this.gesture = { kind: 'pan', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, tx0: this.tx, ty0: this.ty };
      this.viewport.classList.add('panning');
    }

    _onMove(e) {
      this._maybePublishCursor(e);
      if (this._pinch) { this._updatePinch(e); return; }
      const g = this.gesture;
      if (!g || e.pointerId !== g.pointerId) return;
      if (g.kind === 'pan') {
        this.tx = g.tx0 + (e.clientX - g.sx);
        this.ty = g.ty0 + (e.clientY - g.sy);
        this.apply();
      } else if (g.kind === 'move') {
        g.moved = true;
        const n = this.clientToNorm(e.clientX, e.clientY);
        g.el.style.left = (n.x * 100) + '%';
        g.el.style.top = (n.y * 100) + '%';
        g.lastN = n;
        g.el.classList.toggle('over-trash', this.overTrash(e.clientX, e.clientY));
        this.cb.onLive && this.cb.onLive(g.id, n.x, n.y);
      } else if (g.kind === 'create') {
        this._moveGhost(e.clientX, e.clientY);
        g.ghost.classList.toggle('on-board', this.overBoard(e.clientX, e.clientY));
      }
    }

    _onUp(e) {
      this._pointers.delete(e.pointerId);
      if (this._pinch && this._pointers.size < 2) this._endPinch();
      const g = this.gesture;
      if (!g || e.pointerId !== g.pointerId) return;
      if (g.kind === 'move') {
        g.el.classList.remove('grabbing', 'over-trash');
        if (this.overTrash(e.clientX, e.clientY)) this.cb.onRemove && this.cb.onRemove(g.id);
        else if (g.moved && g.lastN) this.cb.onMove && this.cb.onMove(g.id, g.lastN.x, g.lastN.y);
      } else if (g.kind === 'create') {
        if (this.overBoard(e.clientX, e.clientY)) {
          const n = this.clientToNorm(e.clientX, e.clientY);
          this.cb.onAdd && this.cb.onAdd(g.type, n.x, n.y);
        }
        g.ghost.remove();
      }
      this._endGesture();
    }

    _endGesture() {
      this.viewport.classList.remove('panning');
      if (this.gesture && this.gesture.ghost) this.gesture.ghost.remove();
      this.gesture = null;
    }

    _moveGhost(cx, cy) {
      const g = this.gesture;
      if (!g || !g.ghost) return;
      g.ghost.style.left = cx + 'px';
      g.ghost.style.top = cy + 'px';
    }

    _maybePublishCursor(e) {
      if (!this.cb.onCursor) return;
      const t = e.timeStamp || performance.now();
      if (t - this._lastCursorPub < 60) return;
      if (!this.overBoard(e.clientX, e.clientY)) return;
      this._lastCursorPub = t;
      const n = this.clientToNorm(e.clientX, e.clientY);
      this.cb.onCursor(n.x, n.y);
    }

    _beginPinch() {
      const pts = [...this._pointers.values()];
      this.gesture = null;
      this._pinch = { d0: this._dist(pts[0], pts[1]), s0: this.scale, cx: (pts[0].clientX + pts[1].clientX) / 2, cy: (pts[0].clientY + pts[1].clientY) / 2 };
    }
    _updatePinch(e) {
      this._pointers.set(e.pointerId, e);
      const pts = [...this._pointers.values()];
      if (pts.length < 2) return;
      const d = this._dist(pts[0], pts[1]);
      const r = this.viewport.getBoundingClientRect();
      const target = clamp(this._pinch.s0 * (d / this._pinch.d0), MIN_SCALE, MAX_SCALE);
      this.zoomAt(this._pinch.cx - r.left, this._pinch.cy - r.top, target / this.scale);
    }
    _endPinch() { this._pinch = null; }
    _dist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  }

  global.Board = Board;
})(window);
