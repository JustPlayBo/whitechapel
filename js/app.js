/* app.js — glue: lobby (name + room + game pack) → load def → wire state/net/board.
 * The engine is generic: everything board-specific comes from a loadable pack. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const Identity = window.Identity, GameDef = window.GameDef;

  // built-ins shown if packs/index.json can't be fetched (e.g. file://)
  const FALLBACK_PACKS = [
    { id: 'whitechapel', name: 'Whitechapel — Stay At Home', ref: 'packs/whitechapel.json' },
    { id: 'chess', name: 'Chess — open table', ref: 'packs/chess.json' },
    { id: 'go', name: 'Go — 19×19 goban', ref: 'packs/go.json' },
  ];

  const lobby = $('lobby'), game = $('game');
  const nameInput = $('nameInput'), roomInput = $('roomInput');
  const gameSelect = $('gameSelect'), gameChosen = $('gameChosen');

  const WORDS = ['baker', 'street', 'fog', 'gaslight', 'raven', 'hansom', 'whitechapel',
    'dorset', 'mitre', 'goulston', 'berner', 'buck', 'thames', 'cobble', 'lantern'];
  const rnd = (n) => (Math.random() * n) | 0;
  const randomRoom = () => `${WORDS[rnd(WORDS.length)]}-${WORDS[rnd(WORDS.length)]}-${rnd(90) + 10}`;
  const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const params = new URLSearchParams(location.search);
  let packs = FALLBACK_PACKS.slice();
  let lobbyChoice = packs[0].ref;        // a ref string OR a {def} object

  roomInput.value = slug(params.get('room') || '') || randomRoom();
  nameInput.value = localStorage.getItem('lfw:name') || '';

  /* ---------------- lobby setup ---------------- */
  (async function initLobby() {
    packs = await loadRegistry();
    fillSelect(gameSelect, packs);

    // a game can come from the path (/<org>/<repo>/<game>) or the ?game= param
    const choice = routeGameRef() || paramToChoice(params.get('game'));
    if (choice) {
      lobbyChoice = choice;
      const hit = packs.find((p) => p.ref === choice);
      if (hit) { gameSelect.value = hit.ref; }
      else { try { const def = await GameDef.load(choice); showChosen(def.name); } catch (e) { /* show on enter */ } }
    } else {
      lobbyChoice = gameSelect.value || packs[0].ref;
    }
  })();

  gameSelect.onchange = () => { lobbyChoice = gameSelect.value; gameChosen.textContent = ''; };
  $('gameCustomBtn').onclick = async () => {
    const input = await openLoader();
    if (!input) return;
    try {
      const def = await GameDef.load(input);
      lobbyChoice = input;
      showChosen(def.name);
    } catch (e) { toast('Could not load pack: ' + e.message); }
  };
  function showChosen(name) { gameChosen.textContent = '▶ ' + name + ' (custom)'; }

  $('diceBtn').onclick = () => { roomInput.value = randomRoom(); };
  $('enterBtn').onclick = enter;
  [roomInput, nameInput].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); }));

  function enter() {
    const name = (nameInput.value || '').trim() || 'Anon';
    const room = slug(roomInput.value) || randomRoom();
    localStorage.setItem('lfw:name', name);
    const url = new URL(location.href);
    url.searchParams.set('room', room);
    if (typeof lobbyChoice === 'string') url.searchParams.set('game', lobbyChoice);
    history.replaceState(null, '', url);
    startGame(room, name, lobbyChoice);
  }

  /* ---------------- registry / params ---------------- */
  async function loadRegistry() {
    try {
      const r = await fetch('packs/index.json', { cache: 'no-cache' });
      if (r.ok) { const j = await r.json(); if (j && j.packs && j.packs.length) return j.packs; }
    } catch (e) { /* offline / file:// — use fallback */ }
    return FALLBACK_PACKS.slice();
  }
  function paramToChoice(p) {
    if (!p) return null;
    const hit = packs.find((x) => x.id === p || x.ref === p);
    return hit ? hit.ref : p;            // an id maps to its ref; otherwise a URL / gh ref
  }

  // the app's own directory, e.g. "/whitechapel/" — used to peel off the route
  function appBasePath() {
    const s = [...document.scripts].find((x) => /\/js\/app\.js(\?|$)/.test(x.src));
    try { return new URL('../', s ? s.src : location.href).pathname; }
    catch (e) { return '/'; }
  }
  // /<base>/<org>/<repo>/<game…>  ->  "org/repo/game…" (a jsDelivr gh shorthand)
  function routeGameRef() {
    let p = decodeURIComponent(location.pathname);
    const base = appBasePath();
    if (p.startsWith(base)) p = p.slice(base.length);
    p = p.replace(/^\/+|\/+$/g, '');
    if (!p || p === 'index.html') return null;
    const segs = p.split('/').filter(Boolean);
    return segs.length >= 3 ? segs.join('/') : null;
  }
  function fillSelect(sel, list) {
    sel.innerHTML = '';
    list.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.ref; o.textContent = p.name;
      sel.appendChild(o);
    });
  }

  /* ---------------- game session ---------------- */
  async function startGame(room, name, choice) {
    lobby.classList.add('hidden');
    game.classList.remove('hidden');

    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const identity = { id, name, color: Identity.colorFor(id) };
    $('roomCode').textContent = room;

    const state = new window.BoardState(room);
    const refs = {
      viewport: $('viewport'), stage: $('stage'), board: $('board'), boardImg: $('boardImg'),
      markers: $('markers'), cursors: $('cursors'), trash: $('trash'), mapContainer: $('mapContainer'),
    };

    let liveTimer = 0;
    function liveMove(mid, x, y) {
      const m = state.get(mid); if (!m) return;
      const now = Date.now();
      if (now - liveTimer < 55) return;
      liveTimer = now;
      net.publishMarker({ id: mid, type: m.type, x, y, t: now, by: name });
    }

    // one callback set, shared by whichever board controller is active
    const cb = {
      onAdd: (type, x, y) => { const m = state.add(type, x, y, name); net.publishMarker(m); },
      onMove: (mid, x, y) => { const m = state.move(mid, x, y, name); if (m) net.publishMarker(m); },
      onLive: (mid, x, y) => liveMove(mid, x, y),
      onRemove: (mid) => { if (state.remove(mid)) net.deleteMarker(mid); },
      onCursor: (x, y) => net.publishCursor(x, y),
    };

    // pick the right controller for the pack: a MapLibre map, or the DOM board
    let board = null, boardKind = null;
    function ensureController(def) {
      const kind = def.board.map ? 'map' : 'dom';
      if (board && boardKind === kind) return;
      if (board && board.dispose) board.dispose();
      board = (kind === 'map') ? new window.MapBoard(refs, cb) : new window.Board(refs, cb);
      boardKind = kind;
    }

    state.onChange((kind, m) => {
      if (!board) return;
      if (kind === 'saved') { flashSave(); return; }
      if (kind === 'clear') { board.renderAll([]); return; }
      if (kind === 'remove') { board.removeEl(m.id); return; }
      if (m) board.upsert(m);
    });

    /* ---- the game pack the room is running ---- */
    let currentDef = null;
    let roomGameKnown = false;
    let extras = null;                       // RoomExtras — created once net exists
    let decks = null;                        // DeckManager — created once net exists

    async function applyGame(def) {
      ensureController(def);
      currentDef = def;
      await board.setDef(def);              // MapBoard.setDef is async (loads MapLibre)
      buildTray(def, board);
      $('gameName').textContent = def.name;
      if (extras) extras.setDef(def);       // rules drawer / dice / turn for this pack
      if (decks) decks.setDef(def);         // card decks for this pack
      board.renderAll(state.all());
      board.fit();
    }

    // show the floating play-aids panel if any of turn / dice / decks is active
    function refreshAids() {
      const pa = $('playaids');
      const has = !$('turnBar').classList.contains('hidden')
        || !$('diceTray').classList.contains('hidden')
        || !$('deckTray').classList.contains('hidden');
      pa.classList.toggle('hidden', !has);
    }
    async function loadAndApply(input, opts) {
      const def = await GameDef.load(input);
      await applyGame(def);
      if (opts && opts.publish) {
        net.publishGame(GameDef.toPayload(def)); roomGameKnown = true;
        if (extras) extras.publishReset();  // a local game switch resets the shared turn
      }
      return def;
    }

    // load the chosen pack (fall back to the first built-in on failure)
    try { await loadAndApply(choice); }
    catch (e) { toast('Pack failed (' + e.message + ') — using default'); await loadAndApply(FALLBACK_PACKS[0].ref); }

    const players = new Map();
    players.set(id, { name, color: identity.color, self: true });

    const net = new window.Net(room, identity, {
      onStatus: setStatus,
      onGame: (payload) => onRoomGame(payload),
      onMarker: (m) => { if (!board.isDragging(m.id)) state.applyRemote(m); },
      onMarkerDelete: (mid) => state.applyRemoteDelete(mid),
      onPresence: (cid, info) => { if (info) players.set(cid, info); else { players.delete(cid); board.dropCursor(cid); } renderPresence(); },
      onCursor: (cid, c) => board.showCursor(cid, c),
      onSyncRequest: (from) => { if (state.all().length) net.sendFull(from, state.all()); },
      onSyncFull: (markers) => markers.forEach((m) => state.applyRemote(m)),
      onDice: (roll) => extras && extras.applyDice(roll),
      onTurn: (turn) => extras && extras.applyTurn(turn),
      onDeck: (uiId, payload) => decks && decks.onDeck(uiId, payload),
      onDeckDraw: (payload) => decks && decks.onDeckDraw(payload),
    });

    // the play-aids layer (rules drawer / synced dice / turn indicator) needs net
    extras = new window.RoomExtras({
      infoBtn: $('infoBtn'), drawer: $('infoDrawer'), drawerBody: $('drawerBody'),
      drawerTitle: $('drawerTitle'), drawerClose: $('drawerClose'), backdrop: $('drawerBackdrop'),
      playaids: $('playaids'), turnBar: $('turnBar'), turnWho: $('turnWho'),
      turnNext: $('turnNext'), diceTray: $('diceTray'), diceResult: null,
      onAids: refreshAids,
    }, net, identity, toast);

    // a drawn card is just an image-backed marker that syncs like any piece
    function placeCard(type, x, y, extra) {
      const m = state.add(type, x, y, name, extra);
      net.publishMarker(m);
    }
    decks = new window.DeckManager({ deckTray: $('deckTray') }, net, identity,
      { placeCard, toast, onAids: refreshAids });

    if (currentDef) { extras.setDef(currentDef); decks.setDef(currentDef); }  // catch up: first pack loaded before net existed

    // adopt the room's game if it differs from ours; otherwise just note it's set
    async function onRoomGame(payload) {
      const incomingKey = payload.ref ? 'ref:' + payload.ref : (payload.def ? 'id:' + (payload.def.id || 'untitled') : '');
      roomGameKnown = true;
      if (incomingKey && incomingKey !== GameDef.key(currentDef)) {
        try { await loadAndApply(payload); toast('Now playing: ' + currentDef.name); }
        catch (e) { toast('Room sent a pack that failed to load'); }
      }
    }

    renderPresence();
    net.connect();
    // if nobody has claimed a game for this room yet, publish ours
    setTimeout(() => {
      if (!roomGameKnown && currentDef) { net.publishGame(GameDef.toPayload(currentDef)); roomGameKnown = true; }
    }, 900);

    wireMenu(state, net, () => board, room, () => currentDef, loadAndApply);
    window.addEventListener('resize', () => board && board.fit());
    window.addEventListener('beforeunload', () => net.leave());
    window.__lfw = { state, net, players, identity, get board() { return board; }, get def() { return currentDef; } };

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

  /* ---------------- tray (built from the def's pieces) ---------------- */
  function buildTray(def, board) {
    const wrap = $('trayItems');
    wrap.innerHTML = '';
    def.pieces.forEach((piece) => {
      const item = document.createElement('button');
      item.className = 'tray-item';
      item.title = 'Drag onto board: ' + piece.label;
      const preview = GameDef.renderPiece(piece);
      preview.classList.add('tray-preview');
      preview.style.setProperty('--sz', '38px');
      const span = document.createElement('span');
      span.textContent = piece.label;
      item.appendChild(preview); item.appendChild(span);
      item.addEventListener('pointerdown', (e) => { e.preventDefault(); board.startCreate(piece.type, e); });
      wrap.appendChild(item);
    });
  }

  /* ---------------- menu ---------------- */
  function wireMenu(state, net, getBoard, room, getDef, loadAndApply) {
    const menu = $('menu'), btn = $('menuBtn');
    btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
    document.addEventListener('click', () => menu.classList.add('hidden'));

    menu.addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      menu.classList.add('hidden');
      if (act === 'recenter') getBoard().fit();
      if (act === 'seed') seed(state, net, getDef());
      if (act === 'change') {
        const input = await openLoader();
        if (!input) return;
        try { await loadAndApply(input, { publish: true }); toast('Now playing: ' + getDef().name); }
        catch (err) { toast('Could not load pack: ' + err.message); }
      }
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
      const def = getDef();
      if (def && def.source && def.source.ref) url.searchParams.set('game', def.source.ref);
      else url.searchParams.delete('game');     // inline custom packs sync via MQTT, not the link
      try { await navigator.clipboard.writeText(url.toString()); toast('Invite link copied'); }
      catch (e) { prompt('Copy this invite link:', url.toString()); }
    };
  }

  function seed(state, net, def) {
    if (!def || !def.setup || !def.setup.length) { toast('This pack has no sample layout'); return; }
    def.setup.forEach((s) => { const m = state.add(s.type, s.x, s.y, 'sample'); net.publishMarker(m); });
    toast('Loaded sample layout (' + def.setup.length + ' pieces)');
  }

  /* ---------------- pack loader modal ---------------- */
  function openLoader() {
    return new Promise((resolve) => {
      const modal = $('gameModal'), sel = $('modalSelect');
      const urlIn = $('modalUrl'), jsonIn = $('modalJson');
      fillSelect(sel, packs);
      urlIn.value = ''; jsonIn.value = '';
      modal.classList.remove('hidden');

      const close = (val) => { modal.classList.add('hidden'); cleanup(); resolve(val); };
      const onLoad = () => {
        const json = jsonIn.value.trim(), url = urlIn.value.trim();
        if (json) { try { close({ def: JSON.parse(json) }); } catch (e) { toast('Invalid JSON'); } return; }
        if (url) return close(url);
        if (sel.value) return close(sel.value);
        close(null);
      };
      const onCancel = () => close(null);
      const onBackdrop = (e) => { if (e.target === modal) close(null); };
      function cleanup() {
        $('modalLoad').removeEventListener('click', onLoad);
        $('modalCancel').removeEventListener('click', onCancel);
        modal.removeEventListener('click', onBackdrop);
      }
      $('modalLoad').addEventListener('click', onLoad);
      $('modalCancel').addEventListener('click', onCancel);
      modal.addEventListener('click', onBackdrop);
    });
  }

  /* ---------------- status / toast / save ---------------- */
  function setStatus(s) {
    const dot = $('connDot');
    const map = { online: ['on', 'Connected — live'], reconnecting: ['warn', 'Reconnecting…'], offline: ['off', 'Offline'], error: ['off', 'Connection error'] };
    const [cls, tip] = map[s] || ['off', s];
    dot.className = 'conn-dot ' + cls; dot.title = tip;
    if (s === 'online') toast('Connected to room');
    if (s === 'offline') toast('Disconnected — retrying…');
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  let saveTimer = 0;
  function flashSave() {
    const el = $('saveBadge');
    el.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => el.classList.remove('show'), 900);
  }
})();
