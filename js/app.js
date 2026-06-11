/* app.js — glue: lobby → identity → wire state + net + board, plus the chrome
 * (presence chips, connection light, menu, invite link, toast, save badge). */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const Catalog = window.Catalog;

  /* ---------------- lobby ---------------- */
  const lobby = $('lobby'), game = $('game');
  const nameInput = $('nameInput'), roomInput = $('roomInput');

  const WORDS = ['baker', 'street', 'fog', 'gaslight', 'raven', 'hansom', 'whitechapel',
    'dorset', 'mitre', 'goulston', 'berner', 'buck', 'thames', 'cobble', 'lantern'];
  function randomRoom() {
    const a = WORDS[(Math.random() * WORDS.length) | 0];
    const b = WORDS[(Math.random() * WORDS.length) | 0];
    return `${a}-${b}-${(Math.random() * 90 + 10) | 0}`;
  }
  function slug(s) { return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  // prefill from URL + last session
  const params = new URLSearchParams(location.search);
  roomInput.value = slug(params.get('room') || '') || randomRoom();
  nameInput.value = localStorage.getItem('lfw:name') || '';

  $('diceBtn').onclick = () => { roomInput.value = randomRoom(); };
  $('enterBtn').onclick = enter;
  roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });

  function enter() {
    const name = (nameInput.value || '').trim() || 'Anon';
    const room = slug(roomInput.value) || randomRoom();
    localStorage.setItem('lfw:name', name);
    const url = new URL(location.href);
    url.searchParams.set('room', room);
    history.replaceState(null, '', url);
    startGame(room, name);
  }

  /* ---------------- game ---------------- */
  function startGame(room, name) {
    lobby.classList.add('hidden');
    game.classList.remove('hidden');

    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const identity = { id, name, color: Catalog.colorFor(id) };

    $('roomCode').textContent = room;

    const state = new window.BoardState(room);
    const board = new window.Board({
      viewport: $('viewport'), stage: $('stage'), board: $('board'),
      markers: $('markers'), cursors: $('cursors'), trash: $('trash'),
    }, {
      onAdd:   (type, x, y) => { const m = state.add(type, x, y, name); net.publishMarker(m); },
      onMove:  (mid, x, y) => { const m = state.move(mid, x, y, name); if (m) net.publishMarker(m); },
      onLive:  (mid, x, y) => liveMove(mid, x, y),
      onRemove:(mid) => { if (state.remove(mid)) net.deleteMarker(mid); },
      onCursor:(x, y) => net.publishCursor(x, y),
    });

    // live drag: broadcast without thrashing localStorage each frame
    let liveTimer = 0;
    function liveMove(mid, x, y) {
      const m = state.get(mid); if (!m) return;
      const now = Date.now();
      if (now - liveTimer < 55) return;
      liveTimer = now;
      net.publishMarker({ id: mid, type: m.type, x, y, t: now, by: name });
    }

    // state → board rendering
    state.onChange((kind, m) => {
      if (kind === 'saved') { flashSave(); return; }
      if (kind === 'clear') { board.renderAll([]); return; }
      if (kind === 'remove') { board.removeEl(m.id); return; }
      if (m) board.upsert(m);
    });

    // presence registry (includes self)
    const players = new Map();
    players.set(id, { name, color: identity.color, self: true });
    renderPresence();

    const net = new window.Net(room, identity, {
      onStatus: setStatus,
      onMarker: (m) => { if (!board.isDragging(m.id)) state.applyRemote(m); },
      onMarkerDelete: (mid) => state.applyRemoteDelete(mid),
      onPresence: (cid, info) => {
        if (info) players.set(cid, info); else { players.delete(cid); board.dropCursor(cid); }
        renderPresence();
      },
      onCursor: (cid, c) => board.showCursor(cid, c),
      onSyncRequest: (from) => { if (state.all().length) net.sendFull(from, state.all()); },
      onSyncFull: (markers) => markers.forEach((m) => state.applyRemote(m)),
    });

    // first paint from localStorage, then go online
    board.renderAll(state.all());
    board.fit();
    net.connect();

    buildTray(board);
    wireMenu(state, net, board, room);
    window.addEventListener('resize', () => board.fit());
    window.addEventListener('beforeunload', () => net.leave());

    // expose for debugging
    window.__lfw = { state, net, board, players, identity };

    /* ---- presence chips ---- */
    function renderPresence() {
      const wrap = $('presence');
      wrap.innerHTML = '';
      const entries = [...players.entries()].sort((a, b) => (b[1].self ? 1 : 0) - (a[1].self ? 1 : 0));
      entries.forEach(([, p]) => {
        const chip = document.createElement('span');
        chip.className = 'pchip' + (p.self ? ' me' : '');
        chip.style.background = p.color || '#888';
        chip.textContent = (p.name || '?').slice(0, 1).toUpperCase();
        chip.title = (p.name || 'player') + (p.self ? ' (you)' : '');
        wrap.appendChild(chip);
      });
      const count = document.createElement('span');
      count.className = 'pcount';
      count.textContent = entries.length + (entries.length === 1 ? ' player' : ' players');
      wrap.appendChild(count);
    }
  }

  /* ---------------- tray ---------------- */
  function buildTray(board) {
    const wrap = $('trayItems');
    wrap.innerHTML = '';
    Catalog.TRAY_ORDER.forEach((type) => {
      const meta = Catalog.MARKERS[type];
      const item = document.createElement('button');
      item.className = 'tray-item';
      item.title = 'Drag onto board: ' + meta.label;
      item.innerHTML = `<img src="${meta.img}" alt="${meta.label}" draggable="false"><span>${meta.label}</span>`;
      item.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        board.startCreate(type, e);
      });
      wrap.appendChild(item);
    });
  }

  /* ---------------- menu ---------------- */
  function wireMenu(state, net, board, room) {
    const menu = $('menu'), btn = $('menuBtn');
    btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
    document.addEventListener('click', () => menu.classList.add('hidden'));

    menu.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      menu.classList.add('hidden');
      if (act === 'recenter') board.fit();
      if (act === 'seed') seed(state, net);
      if (act === 'clear') {
        if (!confirm('Remove every marker for everyone in this room?')) return;
        state.all().forEach((m) => net.deleteMarker(m.id));
        state.clear();
        toast('Board cleared');
      }
      if (act === 'leave') { net.leave(); location.search = ''; }
    });

    $('copyLinkBtn').onclick = async () => {
      const url = new URL(location.href);
      url.searchParams.set('room', room);
      try { await navigator.clipboard.writeText(url.toString()); toast('Invite link copied'); }
      catch (e) { prompt('Copy this invite link:', url.toString()); }
    };
  }

  function seed(state, net) {
    const data = window.SAMPLE_LAYOUT;
    if (!data || !data.markers) { toast('No sample layout found'); return; }
    data.markers.forEach((s) => {
      const m = state.add(s.type, s.x, s.y, 'sample');
      net.publishMarker(m);
    });
    toast('Loaded sample layout (' + data.markers.length + ' pieces)');
  }

  /* ---------------- status light ---------------- */
  function setStatus(s) {
    const dot = $('connDot');
    const map = {
      online: ['on', 'Connected — live'],
      reconnecting: ['warn', 'Reconnecting…'],
      offline: ['off', 'Offline'],
      error: ['off', 'Connection error'],
    };
    const [cls, tip] = map[s] || ['off', s];
    dot.className = 'conn-dot ' + cls;
    dot.title = tip;
    if (s === 'online') toast('Connected to room');
    if (s === 'offline') toast('Disconnected — retrying…');
  }

  /* ---------------- toast + save badge ---------------- */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  let saveTimer = 0;
  function flashSave() {
    const el = $('saveBadge');
    el.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => el.classList.remove('show'), 900);
  }
})();
