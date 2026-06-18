/* gamedef.js — the abstraction layer.
 *
 * A "game pack" is plain JSON that fully describes a table:
 *
 *   {
 *     "schema": "boardgame/1",
 *     "id": "chess", "name": "Chess", "description": "...",
 *     "board": {
 *       "image": "url | data-uri",        // OR a generated pattern:
 *       "pattern": { "type": "checker|grid|solid", ... },
 *       "aspect": 1.6,                     // w/h; optional (derived if omitted)
 *       "color": "#140e09",                // backdrop behind the board
 *       "pieceSize": 0.05                  // default piece size, fraction of board width
 *     },
 *     "pieces": [
 *       { "type": "jack", "label": "Jack", "image": "url|data-uri", "size": 0.03 },
 *       { "type": "wp",   "label": "Pawn", "glyph": "♙", "color": "#fff" }
 *     ],
 *     "setup": [ { "type": "jack", "x": 0.5, "y": 0.5 } ],  // optional preset layout
 *
 *     // ---- optional "tell players how to play" blocks (additive, boardgame/1.1) ----
 *     "rules":   { "objective": "...", "players": "2", "setup": "...",
 *                  "howToPlay": ["...","..."], "winning": "...",
 *                  "variants": ["..."], "duration": "10–20 min" },
 *     "context": { "period": "Roman Empire", "blurb": "...",
 *                  "sources": ["..."], "links": [{ "label":"…","url":"…" }],
 *                  "image": "url", "credit": "…" },
 *     "dice":    [ { "id":"tesserae", "label":"Tesserae", "sides":6, "count":2 } ],
 *     "turns":   { "players": ["Albus","Ruber"], "track": true },
 *
 *     // ---- optional card decks (additive, boardgame/1.2) ----
 *     // a CardForge / cardsapi.com (deckofcardsapi-compatible) deck. The engine
 *     // creates a server-side deck, shares its deck_id over MQTT, and draws cards
 *     // that become image-backed pieces on the table.
 *     "decks":   [ { "id":"main", "label":"Tavern deck",
 *                    "cardforge":"openfantasymap/cardforge-ab12cd", "shuffle":true } ]
 *   }
 *
 * Pieces are either image-backed or glyph-backed (emoji / unicode / a letter),
 * so a complete game can be authored with zero binary assets. The engine never
 * hard-codes any of this — it just loads, normalises and renders the def.
 *
 * `rules`/`context`/`dice`/`turns` are all OPTIONAL — packs that omit them behave
 * exactly as before (no drawer, no dice tray, no turn chip). The engine still
 * enforces nothing: dice are a synced roller, turns are a shared indicator.
 */
(function (global) {
  'use strict';

  const SCHEMA = 'boardgame/1';
  const DEFAULT_PIECE_SIZE = 0.05;     // fraction of board width

  function resolveUrl(src, baseUrl) {
    if (!src) return src;
    if (/^(data:|https?:|blob:)/.test(src)) return src;       // already absolute
    try { return new URL(src, baseUrl || global.location.href).href; }
    catch (e) { return src; }
  }

  // turn a short pack reference into a fetchable URL.
  //   gh:org/repo[@ver]/path  |  org/repo/path  ->  jsDelivr CDN
  //   npm:pkg[@ver]/path      ->  jsDelivr npm
  //   packs/…, ./…, /…, http(s)://…, data:  ->  used as-is
  function resolveRef(ref) {
    if (!ref || typeof ref !== 'string') return ref;
    if (/^(https?:|data:|blob:)/.test(ref)) return ref;
    let m;
    if ((m = ref.match(/^gh:(.+)$/))) return 'https://cdn.jsdelivr.net/gh/' + m[1];
    if ((m = ref.match(/^npm:(.+)$/))) return 'https://cdn.jsdelivr.net/npm/' + m[1];
    const segs = ref.split('/');
    // bare "org/repo/path" (>=3 parts, not a local path) -> GitHub via jsDelivr
    if (segs.length >= 3 && segs[0] && segs[0] !== 'packs'
        && !ref.startsWith('.') && !ref.startsWith('/')) {
      return 'https://cdn.jsdelivr.net/gh/' + ref;
    }
    return ref;                                               // local / relative
  }

  /* ---- board background patterns (generated as inline SVG, so they scale) ---- */
  function svgUri(svg) { return 'data:image/svg+xml,' + encodeURIComponent(svg); }

  function checkerSvg(cols, rows, light, dark) {
    let cells = '';
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        if ((r + c) % 2) cells += `<rect x="${c}" y="${r}" width="1" height="1" fill="${dark}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols} ${rows}" preserveAspectRatio="none">`
      + `<rect width="${cols}" height="${rows}" fill="${light}"/>${cells}</svg>`;
  }

  function gridSvg(cols, rows, line, stars) {
    const W = 100, H = 100;
    const px = (i, n) => ((i + 0.5) / n * 100).toFixed(3);
    let lines = '';
    for (let c = 0; c < cols; c++)
      lines += `<line x1="${px(c, cols)}" y1="${px(0, rows)}" x2="${px(c, cols)}" y2="${px(rows - 1, rows)}" stroke="${line}" stroke-width="0.2"/>`;
    for (let r = 0; r < rows; r++)
      lines += `<line x1="${px(0, cols)}" y1="${px(r, rows)}" x2="${px(cols - 1, cols)}" y2="${px(r, rows)}" stroke="${line}" stroke-width="0.2"/>`;
    let dots = '';
    (stars || []).forEach(([c, r]) => {
      dots += `<circle cx="${px(c, cols)}" cy="${px(r, rows)}" r="0.6" fill="${line}"/>`;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${lines}${dots}</svg>`;
  }

  function patternBackground(p, color) {
    if (!p || p.type === 'solid') return p && p.color || color || '#1d160f';
    const bg = p.bg || color || '#000';
    if (p.type === 'checker') {
      const svg = checkerSvg(p.cols || 8, p.rows || 8, p.light || '#e8d0a8', p.dark || '#9c6b3f');
      return `${bg} url("${svgUri(svg)}") center/100% 100% no-repeat`;
    }
    if (p.type === 'grid') {
      const svg = gridSvg(p.cols || 19, p.rows || 19, p.line || '#2b2014', p.stars);
      return `${bg} url("${svgUri(svg)}") center/100% 100% no-repeat`;
    }
    return bg;
  }

  /* ---- optional info blocks: rules / context / dice / turns ---- */
  function str(v) { return v == null ? '' : String(v); }
  function strList(v) {
    if (v == null) return [];
    const a = Array.isArray(v) ? v : [v];
    return a.map((x) => str(x)).filter((s) => s.trim() !== '');
  }
  function hasAny(obj) { return Object.keys(obj).some((k) => {
    const v = obj[k]; return Array.isArray(v) ? v.length : (v !== '' && v != null);
  }); }

  function normRules(r) {
    if (!r || typeof r !== 'object') return null;
    const out = {
      objective: str(r.objective || r.goal),
      players: str(r.players),
      duration: str(r.duration),
      setup: str(r.setup),
      howToPlay: strList(r.howToPlay || r.steps || r.play),
      winning: str(r.winning || r.win),
      variants: strList(r.variants),
    };
    return hasAny(out) ? out : null;
  }

  function normContext(c, baseUrl) {
    if (!c || typeof c !== 'object') return null;
    const links = (Array.isArray(c.links) ? c.links : []).map((l) => {
      if (!l) return null;
      if (typeof l === 'string') return { label: l, url: l };
      return { label: str(l.label || l.title || l.url), url: str(l.url || l.href) };
    }).filter((l) => l && l.url);
    const out = {
      period: str(c.period),
      blurb: str(c.blurb || c.description),
      sources: strList(c.sources),
      links,
      image: c.image ? resolveUrl(str(c.image), baseUrl) : '',
      credit: str(c.credit),
    };
    return hasAny(out) ? out : null;
  }

  // a face is { label, value } — numeric faces auto-generate from `sides`
  function normDice(d) {
    if (!Array.isArray(d)) return [];
    return d.map((x, i) => {
      if (!x || typeof x !== 'object') return null;
      let faces = null;
      if (Array.isArray(x.faces) && x.faces.length) {
        faces = x.faces.map((f) => (f && typeof f === 'object')
          ? { label: str(f.label != null ? f.label : f.value), value: num(f.value) }
          : { label: str(f), value: num(f) || str(f) });
      }
      const sides = num(x.sides) || (faces ? faces.length : 6);
      return {
        id: str(x.id || x.label || ('die' + i)) || ('die' + i),
        label: str(x.label || x.id || ('Die ' + (i + 1))),
        sides: Math.max(2, sides | 0),
        count: Math.max(1, (num(x.count) || 1) | 0),
        glyph: str(x.glyph) || null,          // optional tray glyph (🎲 default in UI)
        faces,                                // null = plain 1..sides
      };
    }).filter(Boolean);
  }

  function normTurns(t) {
    if (!t || typeof t !== 'object') return null;
    const players = strList(t.players);
    const track = t.track !== false;          // default on when a turns block exists
    if (!players.length && !track) return null;
    return { players, track };
  }

  // a deck drawn from a CardForge / cardsapi.com deckofcardsapi-compatible API.
  //   { id, label, api, cardforge, shuffle, back, cardSize }
  // `cardforge: "org/repo"` selects a custom CardForge project; omit for a
  // standard 52-card deck. The engine creates a server-side deck, shares its
  // deck_id over MQTT, and draws cards that become image-backed pieces.
  const DEFAULT_DECK_API = 'https://forge.cardsapi.com';
  function normDecks(d) {
    if (!Array.isArray(d)) return [];
    return d.map((x, i) => {
      if (!x || typeof x !== 'object') return null;
      return {
        id: str(x.id || ('deck' + i)) || ('deck' + i),
        label: str(x.label || x.id || 'Deck'),
        api: (str(x.api) || DEFAULT_DECK_API).replace(/\/+$/, ''),
        cardforge: str(x.cardforge) || null,     // "org/repo"; null = standard 52
        shuffle: x.shuffle !== false,            // default shuffle on
        back: str(x.back) || '🂠',               // glyph or image url for the pile face
        cardSize: num(x.cardSize) || null,       // drawn-card size, fraction of board width
      };
    }).filter(Boolean);
  }

  /* ---- normalisation: raw json -> a predictable internal shape ---- */
  function normalize(raw, baseUrl) {
    if (!raw || typeof raw !== 'object') throw new Error('Game pack is not an object');
    const board = raw.board || {};
    const pattern = board.pattern || null;

    let aspect = num(board.aspect);
    if (!aspect && pattern && pattern.cols && pattern.rows) aspect = pattern.cols / pattern.rows;

    const pieces = (raw.pieces || []).map((p, i) => {
      if (!p || !p.type) throw new Error('Piece #' + i + ' is missing "type"');
      return {
        type: String(p.type),
        label: p.label != null ? String(p.label) : String(p.type),
        image: p.image ? resolveUrl(p.image, baseUrl) : null,
        glyph: p.glyph != null ? String(p.glyph) : null,
        color: p.color || null,
        bg: p.bg || null,
        size: num(p.size) || null,
      };
    });

    return {
      schema: raw.schema || SCHEMA,
      id: raw.id || 'untitled',
      name: raw.name || raw.id || 'Untitled board',
      description: raw.description || '',
      board: {
        image: board.image ? resolveUrl(board.image, baseUrl) : null,
        // a MapLibre style: a URL string (resolved) or an inline style object
        map: board.map ? (typeof board.map === 'string' ? resolveUrl(board.map, baseUrl) : board.map) : null,
        center: Array.isArray(board.center) ? board.center.map(Number) : null,
        zoom: board.zoom != null ? num(board.zoom) : null,
        grid: board.grid || null,               // graticule overlay for map boards
        pattern,
        color: board.color || '#140e09',
        aspect: aspect || null,                 // may still be null for raw images
        pieceSize: num(board.pieceSize) || DEFAULT_PIECE_SIZE,
      },
      pieces,
      // coords are board-fraction [0,1] for image/pattern boards, or lng/lat for
      // map boards — so we keep them raw rather than clamping.
      setup: (raw.setup || []).filter((s) => s && s.type).map((s) => ({
        type: String(s.type), x: num(s.x), y: num(s.y),
      })),
      // optional "how to play / what is this" blocks — null/[] when absent
      rules: normRules(raw.rules),
      context: normContext(raw.context, baseUrl),
      dice: normDice(raw.dice),
      turns: normTurns(raw.turns),
      decks: normDecks(raw.decks),
      source: { ref: null, raw },              // filled in by load()
    };
  }

  /* ---- loaders ---- */
  async function loadRef(ref) {
    const url = resolveUrl(resolveRef(ref), global.location.href);   // gh:/org/repo/… → CDN
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Could not fetch pack (' + res.status + '): ' + ref);
    const raw = await res.json();
    const def = normalize(raw, url);
    def.source = { ref, raw };                                       // keep the short ref for sharing
    return def;
  }

  function loadInline(raw) {
    const def = normalize(raw, global.location.href);
    def.source = { ref: null, raw };
    return def;
  }

  // accepts a ref string, a {ref} / {def} message payload, or a raw object
  async function load(input) {
    if (typeof input === 'string') return loadRef(input);
    if (input && input.ref) return loadRef(input.ref);
    if (input && input.def) return loadInline(input.def);
    if (input && (input.pieces || input.board)) return loadInline(input);
    throw new Error('Nothing to load');
  }

  /* ---- identity / sync helpers ---- */
  function key(def) {
    if (!def) return '';
    return def.source && def.source.ref ? 'ref:' + def.source.ref : 'id:' + def.id;
  }
  function toPayload(def) {
    return def.source && def.source.ref ? { ref: def.source.ref } : { def: def.source.raw };
  }

  /* ---- rendering ---- */
  function pieceMap(def) {
    const m = new Map();
    def.pieces.forEach((p) => m.set(p.type, p));
    return m;
  }
  function fallbackPiece(type) {
    return { type, label: type, image: null, glyph: (type || '?').slice(0, 2),
      color: '#e7dcc7', bg: '#3a2c1d', size: null };
  }

  // build a fresh, unpositioned marker element for a piece
  function renderPiece(piece) {
    let el;
    if (piece.image) {
      el = document.createElement('img');
      el.className = 'marker piece-img';
      el.src = piece.image;
      el.draggable = false;
    } else {
      el = document.createElement('div');
      el.className = 'marker piece-glyph';
      // note: an explicit empty glyph ("") means "blank chip" (e.g. a Go stone)
      el.textContent = piece.glyph != null ? piece.glyph : (piece.label || '?').slice(0, 2);
      if (piece.color) el.style.setProperty('--pc', piece.color);
      if (piece.bg) { el.classList.add('has-bg'); el.style.setProperty('--bg', piece.bg); }
    }
    return el;
  }

  function applyBoard(def, boardEl, imgEl) {
    const b = def.board;
    if (b.image) {
      imgEl.src = b.image;
      imgEl.style.display = 'block';
      boardEl.style.background = b.color;
    } else {
      imgEl.removeAttribute('src');
      imgEl.style.display = 'none';
      boardEl.style.background = patternBackground(b.pattern, b.color);
    }
  }

  /* ---- tiny utils ---- */
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function clamp01(v) { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; }

  // does this pack carry anything the Rules drawer would show?
  function hasInfo(def) {
    return !!(def && (def.rules || def.context || (def.description && def.description.trim())));
  }

  global.GameDef = {
    SCHEMA, DEFAULT_PIECE_SIZE,
    load, loadRef, loadInline, normalize,
    key, toPayload, pieceMap, fallbackPiece, renderPiece, applyBoard, resolveUrl, resolveRef,
    hasInfo,
  };
})(window);
