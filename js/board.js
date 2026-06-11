/* board.js — rendering + all pointer interaction for the shared board.
 *
 * Coordinate model: the board has an intrinsic size (BASE_W × BASE_H px) that
 * mirrors the map image's aspect ratio. Markers live at normalised [0,1]
 * positions, drawn with percentage offsets, so they line up on every screen.
 * Pan & zoom are a single CSS transform on the stage; converting a pointer to
 * a normalised position just reads the board's on-screen rect, so it stays
 * correct at any zoom.
 *
 * The board owns no game state — it calls back out (onAdd/onMove/onLive/onRemove/
 * onCursor) and re-renders whenever app/state tells it to.
 */
(function (global) {
  'use strict';

  const BASE_W = 1920, BASE_H = 1200;   // matches assets/board.jpg aspect
  const MARKER = 50;                    // px on the base board
  const MIN_SCALE = 0.15, MAX_SCALE = 4;
  const CURSOR_TTL = 4000;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  class Board {
    constructor(refs, cb) {
      this.viewport = refs.viewport;
      this.stage = refs.stage;
      this.board = refs.board;
      this.markersEl = refs.markers;
      this.cursorsEl = refs.cursors;
      this.trashEl = refs.trash;
      this.cb = cb || {};

      this.scale = 1; this.tx = 0; this.ty = 0;
      this.els = new Map();             // markerId -> img element
      this.cursors = new Map();         // clientId -> { el, timer }
      this.gesture = null;
      this._lastCursorPub = 0;

      this.board.style.width = BASE_W + 'px';
      this.board.style.height = BASE_H + 'px';

      this._bind();
    }

    /* ============ transform ============ */
    apply() {
      this.stage.style.transform =
        `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    }

    fit() {
      const vw = this.viewport.clientWidth, vh = this.viewport.clientHeight;
      const s = Math.min(vw / BASE_W, vh / BASE_H) * 0.98;
      this.scale = clamp(s, MIN_SCALE, MAX_SCALE);
      this.tx = (vw - BASE_W * this.scale) / 2;
      this.ty = (vh - BASE_H * this.scale) / 2;
      this.apply();
    }

    zoomAt(px, py, factor) {
      const ns = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
      this.tx = px - (px - this.tx) * (ns / this.scale);
      this.ty = py - (py - this.ty) * (ns / this.scale);
      this.scale = ns;
      this.apply();
    }

    /* ============ coordinate helpers ============ */
    clientToNorm(cx, cy) {
      const r = this.board.getBoundingClientRect();
      return { x: clamp((cx - r.left) / r.width, 0, 1), y: clamp((cy - r.top) / r.height, 0, 1) };
    }
    overBoard(cx, cy) {
      const r = this.board.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    }
    overTrash(cx, cy) {
      const r = this.trashEl.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    }

    /* ============ marker rendering ============ */
    renderAll(markers) {
      const seen = new Set();
      markers.forEach((m) => { this.upsert(m, true); seen.add(m.id); });
      for (const id of [...this.els.keys()]) if (!seen.has(id)) this.removeEl(id);
    }

    upsert(m) {
      const meta = global.Catalog.MARKERS[m.type];
      if (!meta) return;
      let el = this.els.get(m.id);
      if (!el) {
        el = document.createElement('img');
        el.className = 'marker appear';            // gentle pop only on first appearance
        el.draggable = false;
        el.dataset.id = m.id;
        el.style.width = MARKER + 'px';
        el.style.height = MARKER + 'px';
        el.src = meta.img;
        this.markersEl.appendChild(el);
        this.els.set(m.id, el);
      }
      // don't fight the local pointer while we're the one dragging this piece
      if (this.gesture && this.gesture.kind === 'move' && this.gesture.id === m.id) return;
      el.style.left = (m.x * 100) + '%';
      el.style.top = (m.y * 100) + '%';
      el.title = meta.label + (m.by ? ' · last moved by ' + m.by : '');
    }

    isDragging(id) {
      return !!(this.gesture && this.gesture.kind === 'move' && this.gesture.id === id);
    }

    removeEl(id) {
      const el = this.els.get(id);
      if (el) { el.remove(); this.els.delete(id); }
    }

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
      const entry = this.cursors.get(cid);
      if (entry) { clearTimeout(entry.timer); entry.el.remove(); this.cursors.delete(cid); }
    }

    /* ============ pointer plumbing ============ */
    _bind() {
      this.viewport.addEventListener('pointerdown', (e) => this._onDown(e));
      window.addEventListener('pointermove', (e) => this._onMove(e), { passive: false });
      window.addEventListener('pointerup', (e) => this._onUp(e));
      window.addEventListener('pointercancel', () => this._endGesture());

      this.viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = this.viewport.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      }, { passive: false });

      // right-click a marker to remove it
      this.markersEl.addEventListener('contextmenu', (e) => {
        const el = e.target.closest('.marker');
        if (!el) return;
        e.preventDefault();
        this.cb.onRemove && this.cb.onRemove(el.dataset.id);
      });

      // pinch zoom (two pointers)
      this._pointers = new Map();
    }

    // called by app for tray drags
    startCreate(type, ev) {
      this._endGesture();
      const ghost = document.createElement('img');
      ghost.className = 'drag-ghost';
      ghost.src = global.Catalog.MARKERS[type].img;
      document.body.appendChild(ghost);
      this.gesture = { kind: 'create', type, ghost, pointerId: ev.pointerId };
      this._moveGhost(ev.clientX, ev.clientY);
    }

    _onDown(e) {
      if (e.button === 2) return;                 // right-click handled elsewhere
      this._pointers.set(e.pointerId, e);
      if (this._pointers.size === 2) { this._beginPinch(); return; }

      const markerEl = e.target.closest('.marker');
      if (markerEl) {
        this.gesture = {
          kind: 'move', id: markerEl.dataset.id, el: markerEl, pointerId: e.pointerId,
          moved: false,
        };
        markerEl.classList.add('grabbing');
        e.preventDefault();
        return;
      }
      // empty board → pan
      this.gesture = {
        kind: 'pan', pointerId: e.pointerId,
        sx: e.clientX, sy: e.clientY, tx0: this.tx, ty0: this.ty,
      };
      this.viewport.classList.add('panning');
    }

    _onMove(e) {
      // live cursor broadcast (independent of any gesture)
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
        if (this.overTrash(e.clientX, e.clientY)) {
          this.cb.onRemove && this.cb.onRemove(g.id);
        } else if (g.moved && g.lastN) {
          this.cb.onMove && this.cb.onMove(g.id, g.lastN.x, g.lastN.y);
        }
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

    /* ---- pinch zoom (touch) ---- */
    _beginPinch() {
      const pts = [...this._pointers.values()];
      this.gesture = null;
      this._pinch = {
        d0: this._dist(pts[0], pts[1]),
        s0: this.scale,
        cx: (pts[0].clientX + pts[1].clientX) / 2,
        cy: (pts[0].clientY + pts[1].clientY) / 2,
      };
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
