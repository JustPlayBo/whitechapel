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
 *     "setup": [ { "type": "jack", "x": 0.5, "y": 0.5 } ]   // optional preset layout
 *   }
 *
 * Pieces are either image-backed or glyph-backed (emoji / unicode / a letter),
 * so a complete game can be authored with zero binary assets. The engine never
 * hard-codes any of this — it just loads, normalises and renders the def.
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
        pattern,
        color: board.color || '#140e09',
        aspect: aspect || null,                 // may still be null for raw images
        pieceSize: num(board.pieceSize) || DEFAULT_PIECE_SIZE,
      },
      pieces,
      setup: (raw.setup || []).filter((s) => s && s.type).map((s) => ({
        type: String(s.type), x: clamp01(s.x), y: clamp01(s.y),
      })),
      source: { ref: null, raw },              // filled in by load()
    };
  }

  /* ---- loaders ---- */
  async function loadRef(ref) {
    const url = resolveUrl(ref, global.location.href);
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Could not fetch pack (' + res.status + '): ' + ref);
    const raw = await res.json();
    const def = normalize(raw, url);
    def.source = { ref, raw };
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

  global.GameDef = {
    SCHEMA, DEFAULT_PIECE_SIZE,
    load, loadRef, loadInline, normalize,
    key, toPayload, pieceMap, fallbackPiece, renderPiece, applyBoard, resolveUrl,
  };
})(window);
