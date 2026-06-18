/* cards.js — CardForge / cardsapi.com decks for the shared table.
 *
 * A pack may declare `decks` (boardgame/1.2). Each deck is drawn from a
 * deckofcardsapi.com-compatible API (default https://forge.cardsapi.com), with an
 * optional `cardforge: "org/repo"` selecting a custom CardForge project (omit for a
 * standard 52-card deck).
 *
 * The API is server-stateful: creating a deck returns a `deck_id` that owns the
 * shuffle/draw order. We exploit that for sync — the first player to deal CREATES
 * the deck and publishes its `deck_id` on a RETAINED MQTT topic; everyone then
 * draws from the same authoritative deck, so draw order is consistent and late
 * joiners adopt it automatically. A drawn card becomes an ordinary image-backed
 * piece (its PNG/SVG), so it syncs, persists and drags like any other token.
 *
 * The engine still enforces nothing: anyone may draw, and the cards are just
 * pieces once on the table.
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const isUrl = (s) => /^(https?:|data:)/.test(s || '');
  const jitter = (c, r) => c + (Math.random() * 2 - 1) * r;

  class DeckManager {
    constructor(refs, net, identity, deps) {
      this.refs = refs;            // { deckTray }
      this.net = net;
      this.identity = identity;
      this.deps = deps || {};      // { placeCard(type,x,y,extra), toast(msg), onAids() }
      this.decks = [];
      this.byId = {};              // deck.id -> deck spec
      this.handles = {};           // deck.id -> { deck_id, remaining, cardforge }
      this.tiles = {};             // deck.id -> { count, draw } DOM refs
      this.busy = {};              // deck.id -> bool (in-flight guard)
    }

    /* ---------- pack change ---------- */
    setDef(def) {
      this.decks = (def && def.decks) || [];
      this.byId = {};
      this.tiles = {};
      this.decks.forEach((d) => (this.byId[d.id] = d));
      this._build();
      this._refreshAids();
    }

    _build() {
      const tray = this.refs.deckTray;
      if (!tray) return;
      tray.innerHTML = '';
      if (!this.decks.length) { tray.classList.add('hidden'); return; }
      tray.classList.remove('hidden');

      this.decks.forEach((deck) => {
        const tile = el('div', 'deck-tile');
        const pile = el('button', 'deck-pile');
        pile.title = 'Draw a card from ' + deck.label;
        if (isUrl(deck.back)) { const img = el('img', 'deck-back-img'); img.src = deck.back; pile.appendChild(img); }
        else pile.appendChild(el('span', 'deck-back', deck.back || '🂠'));
        pile.onclick = () => this.draw(deck);
        tile.appendChild(pile);

        const meta = el('div', 'deck-meta');
        meta.appendChild(el('span', 'deck-label', deck.label));
        const count = el('span', 'deck-count', this._countText(deck.id));
        meta.appendChild(count);
        const newBtn = el('button', 'deck-new', '⟳');
        newBtn.title = 'Shuffle a fresh deck';
        newBtn.onclick = () => this.newDeck(deck);
        meta.appendChild(newBtn);
        tile.appendChild(meta);

        tray.appendChild(tile);
        this.tiles[deck.id] = { count };
      });
    }

    _countText(id) {
      const h = this.handles[id];
      if (!h) return 'tap to deal';
      return (h.remaining != null ? h.remaining : '?') + ' left';
    }
    _renderCount(id) {
      const t = this.tiles[id];
      if (t && t.count) t.count.textContent = this._countText(id);
    }

    /* ---------- API ---------- */
    _newUrl(deck) {
      const q = deck.cardforge ? ('cardforge=' + deck.cardforge + '&') : '';
      return `${deck.api}/api/deck/new/?${q}shuffle=${deck.shuffle ? 'true' : 'false'}`;
    }
    async _fetchJson(url) {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j && j.success === false) throw new Error(j.error || 'deck API error');
      return j;
    }

    async _ensureDeck(deck) {
      const h = this.handles[deck.id];
      if (h && h.deck_id) return h.deck_id;
      return this._create(deck);
    }

    async _create(deck) {
      const j = await this._fetchJson(this._newUrl(deck));
      const handle = { deck_id: j.deck_id, remaining: j.remaining, cardforge: deck.cardforge || null };
      this.handles[deck.id] = handle;
      this.net.publishDeck(deck.id, Object.assign({ by: this.identity.name, t: Date.now() }, handle));
      this._renderCount(deck.id);
      return handle.deck_id;
    }

    async draw(deck) {
      if (this.busy[deck.id]) return;
      this.busy[deck.id] = true;
      try {
        const deckId = await this._ensureDeck(deck);
        const j = await this._fetchJson(`${deck.api}/api/deck/${deckId}/draw/?count=1`);
        const card = (j.cards || [])[0];
        if (!card) { this._toast('Deck is empty — shuffle a fresh one (⟳)'); return; }
        const img = (card.images && (card.images.png || card.images.svg)) || card.image || null;
        const label = card.value ? (card.value + (card.suit ? ' of ' + card.suit : '')) : (card.code || 'Card');
        const type = 'card:' + deck.id + ':' + (card.code || card.value || Math.random().toString(36).slice(2));

        if (img && this.deps.placeCard) {
          this.deps.placeCard(type, jitter(0.5, 0.08), jitter(0.46, 0.1), { img, label, sz: deck.cardSize || 0.12 });
        }
        // update + share the remaining count, announce the draw
        if (this.handles[deck.id]) this.handles[deck.id].remaining = j.remaining;
        this.net.publishDeck(deck.id, Object.assign({ by: this.identity.name, t: Date.now() }, this.handles[deck.id]));
        this.net.publishDeckDraw({ by: this.identity.name, deckId: deck.id,
          cards: [{ code: card.code, value: card.value, suit: card.suit }], t: Date.now() });
        this._renderCount(deck.id);
      } catch (e) {
        this._toast('Could not draw: ' + e.message);
      } finally {
        this.busy[deck.id] = false;
      }
    }

    async newDeck(deck) {
      if (this.busy[deck.id]) return;
      this.busy[deck.id] = true;
      try {
        await this._create(deck);
        this._toast(deck.label + ' — fresh deck shuffled (' + (this.handles[deck.id].remaining || '?') + ' cards)');
      } catch (e) {
        this._toast('Could not shuffle: ' + e.message);
      } finally {
        this.busy[deck.id] = false;
      }
    }

    /* ---------- inbound sync ---------- */
    onDeck(uiId, payload) {
      if (!payload) { delete this.handles[uiId]; this._renderCount(uiId); return; }
      this.handles[uiId] = { deck_id: payload.deck_id, remaining: payload.remaining, cardforge: payload.cardforge || null };
      this._renderCount(uiId);
    }
    onDeckDraw(payload) {
      if (!payload || !payload.cards) return;
      const deck = this.byId[payload.deckId];
      const what = payload.cards.map((c) => c.value ? (c.value + (c.suit ? ' of ' + c.suit : '')) : c.code).join(', ');
      this._toast(`${payload.by || 'Someone'} drew ${what}${deck ? ' from ' + deck.label : ''}`);
    }

    _toast(m) { if (this.deps.toast) this.deps.toast(m); }
    _refreshAids() { if (this.deps.onAids) this.deps.onAids(); }
  }

  global.DeckManager = DeckManager;
})(window);
