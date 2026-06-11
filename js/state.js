/* state.js — the shared board model + local persistence.
 *
 * A board is just a map of markers:  id -> { id, type, x, y, t, by }
 *   x, y : normalised board coordinates in [0,1] (so every screen agrees)
 *   t    : last-modified timestamp (ms) — used for last-writer-wins
 *   by   : last editor's display name (for nice "moved by" hints)
 *
 * Persistence: the whole board is mirrored into localStorage under the room
 * key, so a player can refresh / go offline and keep the table intact, and so
 * a returning host can re-seed the room from disk.
 */
(function (global) {
  'use strict';

  function nowId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  class BoardState {
    constructor(roomId) {
      this.roomId = roomId;
      this.key = 'lfw:board:' + roomId;
      this.markers = new Map();
      this._subs = new Set();
      this._load();
    }

    /* ---- subscriptions ---- */
    onChange(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
    _emit(kind, marker) { this._subs.forEach((fn) => fn(kind, marker)); }

    /* ---- persistence ---- */
    _load() {
      try {
        const raw = localStorage.getItem(this.key);
        if (!raw) return;
        const data = JSON.parse(raw);
        (data.markers || []).forEach((m) => this.markers.set(m.id, m));
      } catch (e) { /* corrupt storage — start fresh */ }
    }

    _save() {
      try {
        const data = { markers: [...this.markers.values()] };
        localStorage.setItem(this.key, JSON.stringify(data));
      } catch (e) { /* quota / private mode — ignore */ }
      this._emit('saved', null);
    }

    /* ---- local mutations (return the marker that should be broadcast) ---- */
    add(type, x, y, by) {
      const m = { id: nowId(), type, x, y, t: Date.now(), by };
      this.markers.set(m.id, m);
      this._save();
      this._emit('add', m);
      return m;
    }

    move(id, x, y, by) {
      const m = this.markers.get(id);
      if (!m) return null;
      m.x = x; m.y = y; m.t = Date.now(); m.by = by;
      this._save();
      this._emit('move', m);
      return m;
    }

    remove(id) {
      const m = this.markers.get(id);
      if (!m) return null;
      this.markers.delete(id);
      this._save();
      this._emit('remove', m);
      return m;
    }

    clear() {
      const ids = [...this.markers.keys()];
      this.markers.clear();
      this._save();
      this._emit('clear', null);
      return ids;
    }

    /* ---- remote application (last-writer-wins by timestamp) ---- */
    applyRemote(m) {
      if (!m || !m.id || !m.type) return false;
      const cur = this.markers.get(m.id);
      if (cur && cur.t > m.t) return false;          // we already have newer
      if (cur && cur.t === m.t && cur.x === m.x && cur.y === m.y) return false;
      this.markers.set(m.id, m);
      this._save();
      this._emit(cur ? 'move' : 'add', m);
      return true;
    }

    applyRemoteDelete(id) {
      if (!this.markers.has(id)) return false;
      const m = this.markers.get(id);
      this.markers.delete(id);
      this._save();
      this._emit('remove', m);
      return true;
    }

    get(id) { return this.markers.get(id); }
    all() { return [...this.markers.values()]; }
  }

  global.BoardState = BoardState;
})(window);
