/* net.js — the shared-room transport over MQTT (public HiveMQ broker).
 *
 * Topic map, all under  lfw/<room>/ :
 *   game                  retained  the game pack the room is running: {ref} or {def}
 *   m/<markerId>          retained  marker JSON, or empty payload = deleted
 *   presence/<clientId>   retained  {name,color,t}, or empty = left (also the LWT)
 *   cursor/<clientId>     volatile  {x,y} live pointer, throttled
 *   sync/req             volatile  {from}            "send me the board"
 *   sync/full            volatile  {markers:[...]}   a full-state answer
 *
 * Late joiners are covered two ways: MQTT *retained* marker messages replay the
 * current board on subscribe, and a sync/req → sync/full round-trip lets any
 * peer (in practice whoever has it in localStorage) re-seed the room.
 */
(function (global) {
  'use strict';

  const HOST = 'broker.hivemq.com';
  const PORTS = { ws: 8000, wss: 8884 };

  function brokerUrl() {
    const secure = global.location.protocol === 'https:';
    const scheme = secure ? 'wss' : 'ws';
    const port = secure ? PORTS.wss : PORTS.ws;
    return `${scheme}://${HOST}:${port}/mqtt`;
  }

  class Net {
    constructor(room, identity, handlers) {
      this.room = room;
      this.id = identity.id;
      this.identity = identity;          // {id, name, color}
      this.h = handlers;                 // callbacks (see app.js)
      this.base = `lfw/${room}`;
      this.client = null;
      this.connected = false;
    }

    topic(suffix) { return `${this.base}/${suffix}`; }

    connect() {
      const willTopic = this.topic(`presence/${this.id}`);
      this.client = mqtt.connect(brokerUrl(), {
        clientId: `lfw_${this.id}`,
        clean: true,
        keepalive: 30,
        reconnectPeriod: 2500,
        connectTimeout: 12000,
        will: { topic: willTopic, payload: '', qos: 0, retain: true },
      });

      this.client.on('connect', () => {
        this.connected = true;
        this.client.subscribe(`${this.base}/#`, { qos: 0 });
        this.publishPresence();          // announce ourselves (retained)
        this.requestSync();              // ask peers for the current board
        this.h.onStatus && this.h.onStatus('online');
      });

      this.client.on('reconnect', () => this.h.onStatus && this.h.onStatus('reconnecting'));
      this.client.on('close',    () => { this.connected = false; this.h.onStatus && this.h.onStatus('offline'); });
      this.client.on('error',    (e) => this.h.onStatus && this.h.onStatus('error', e));
      this.client.on('message',  (t, payload) => this._route(t, payload));
    }

    _route(topic, payload) {
      if (!topic.startsWith(this.base + '/')) return;
      const rest = topic.slice(this.base.length + 1);
      const text = payload.toString();

      if (rest === 'game') {
        const g = safe(text);
        if (g) this.h.onGame && this.h.onGame(g);
        return;
      }
      if (rest.startsWith('m/')) {
        const id = rest.slice(2);
        if (!text) { this.h.onMarkerDelete && this.h.onMarkerDelete(id); return; }
        const m = safe(text); if (m) { m.id = id; this.h.onMarker && this.h.onMarker(m); }
        return;
      }
      if (rest.startsWith('presence/')) {
        const cid = rest.slice('presence/'.length);
        if (cid === this.id) return;
        this.h.onPresence && this.h.onPresence(cid, text ? safe(text) : null);
        return;
      }
      if (rest.startsWith('cursor/')) {
        const cid = rest.slice('cursor/'.length);
        if (cid === this.id) return;
        const c = safe(text); if (c) this.h.onCursor && this.h.onCursor(cid, c);
        return;
      }
      if (rest === 'sync/req') {
        const r = safe(text);
        if (r && r.from !== this.id) this.h.onSyncRequest && this.h.onSyncRequest(r.from);
        return;
      }
      if (rest === 'sync/full') {
        const r = safe(text);
        if (r && r.to === this.id) this.h.onSyncFull && this.h.onSyncFull(r.markers || []);
        return;
      }
    }

    /* ---- publishers ---- */
    _pub(suffix, obj, opts) {
      if (!this.client) return;
      const payload = obj == null ? '' : JSON.stringify(obj);
      this.client.publish(this.topic(suffix), payload, opts || { qos: 0 });
    }

    publishGame(payload) { this._pub('game', payload, { qos: 0, retain: true }); }

    publishMarker(m) {
      this._pub(`m/${m.id}`, { type: m.type, x: m.x, y: m.y, t: m.t, by: m.by },
        { qos: 0, retain: true });
    }
    deleteMarker(id)   { this._pub(`m/${id}`, null, { qos: 0, retain: true }); }
    publishPresence()  { this._pub(`presence/${this.id}`,
        { name: this.identity.name, color: this.identity.color, t: Date.now() },
        { qos: 0, retain: true }); }
    clearPresence()    { this._pub(`presence/${this.id}`, null, { qos: 0, retain: true }); }
    publishCursor(x, y){ this._pub(`cursor/${this.id}`, { x, y, name: this.identity.name, color: this.identity.color }); }
    requestSync()      { this._pub('sync/req', { from: this.id }); }
    sendFull(to, markers) { this._pub('sync/full', { to, markers }); }

    leave() {
      try { this.clearPresence(); } catch (e) {}
      try { this.client && this.client.end(true); } catch (e) {}
    }
  }

  function safe(text) { try { return JSON.parse(text); } catch (e) { return null; } }

  global.Net = Net;
  global.Net.brokerUrl = brokerUrl;
})(window);
