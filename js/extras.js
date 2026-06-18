/* extras.js — the "tell players how to play" layer.
 *
 * Three opt-in features driven entirely by the loaded pack (boardgame/1.1):
 *   • a Rules & context drawer   (def.rules / def.context / def.description)
 *   • a synced dice roller        (def.dice)  — rolls broadcast over MQTT, volatile
 *   • a shared turn indicator      (def.turns) — current seat, retained for joiners
 *
 * The engine still enforces NOTHING. Dice are a shared roller; the turn chip is a
 * shared "whose go is it" marker that anyone can advance. A pack that declares none
 * of these blocks shows none of this UI — old packs are unaffected.
 *
 * Pack strings come from untrusted MQTT / URLs, so everything here is built with
 * createElement + textContent. We never assign pack text to innerHTML.
 */
(function (global) {
  'use strict';

  const PIPS = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];        // d6 faces 1..6
  const rnd = (n) => (Math.random() * n) | 0;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function safeUrl(u) {
    return /^https?:\/\//i.test(u || '') ? u : null;       // only linkify real links
  }

  class RoomExtras {
    constructor(refs, net, identity, toast) {
      this.refs = refs;                 // { infoBtn, drawer, drawerBody, drawerTitle, drawerClose,
                                        //   backdrop, playaids, turnBar, turnWho, turnNext,
                                        //   diceTray, diceResult }
      this.net = net;
      this.identity = identity;
      this.toast = toast || function () {};
      this.def = null;
      this.dice = [];
      this.turns = null;
      this.turnIdx = 0;
      this._wire();
    }

    _wire() {
      const r = this.refs;
      if (r.infoBtn) r.infoBtn.onclick = () => this.openDrawer();
      if (r.drawerClose) r.drawerClose.onclick = () => this.closeDrawer();
      if (r.backdrop) r.backdrop.onclick = () => this.closeDrawer();
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeDrawer(); });
      if (r.turnNext) r.turnNext.onclick = () => this.nextTurn();
    }

    /* ---------- called by app.js when the room's pack changes ---------- */
    setDef(def) {
      this.def = def;
      this.dice = (def && def.dice) || [];
      this.turns = (def && def.turns) || null;
      this.turnIdx = 0;

      // Rules button — only when there's something to read
      if (this.refs.infoBtn) {
        this.refs.infoBtn.classList.toggle('hidden', !GameDef.hasInfo(def));
      }
      this._buildDrawer(def);
      this._buildDice();
      this._renderTurn();
      // warm up the 3D dice in the background so the first roll is instant (or has
      // already fallen back to flat) by the time anyone clicks
      if (global.Dice3D && this.dice.some((d) => global.Dice3D.supports(d))) {
        global.Dice3D.ensure().catch(() => {});
      }
      if (this.refs.onAids) this.refs.onAids();      // app coordinates dice+turns+decks
      else this._syncPlayaidsVisibility();
    }

    // when the local player switches the game, reset the retained turn so a stale
    // "Ruber's turn" from the previous pack doesn't carry over
    publishReset() {
      if (this.turns) this.net.publishTurn({ idx: 0, by: this.identity.name, t: Date.now() });
    }

    /* ---------------- Rules & context drawer ---------------- */
    _buildDrawer(def) {
      const body = this.refs.drawerBody;
      if (!body) return;
      body.innerHTML = '';
      if (this.refs.drawerTitle) this.refs.drawerTitle.textContent = (def && def.name) || 'About this game';
      if (!def) return;

      const ctx = def.context, rules = def.rules;

      if (def.description && def.description.trim()) {
        body.appendChild(el('p', 'drawer-lead', def.description.trim()));
      }

      if (ctx) {
        const sec = el('section', 'drawer-sec');
        sec.appendChild(el('h3', 'drawer-h', 'Context'));
        if (ctx.period) sec.appendChild(el('span', 'ctx-period', ctx.period));
        if (ctx.image && safeUrl(ctx.image)) {
          const fig = el('figure', 'ctx-fig');
          const img = el('img', 'ctx-img');
          img.src = ctx.image; img.alt = (def.name || '') + ' — illustration'; img.loading = 'lazy';
          fig.appendChild(img);
          if (ctx.credit) fig.appendChild(el('figcaption', 'ctx-credit', ctx.credit));
          sec.appendChild(fig);
        }
        if (ctx.blurb) sec.appendChild(el('p', null, ctx.blurb));
        if (ctx.sources && ctx.sources.length) {
          sec.appendChild(el('h4', 'drawer-h4', 'Sources'));
          const ul = el('ul', 'drawer-list');
          ctx.sources.forEach((s) => ul.appendChild(el('li', null, s)));
          sec.appendChild(ul);
        }
        if (ctx.links && ctx.links.length) {
          const nav = el('div', 'drawer-links');
          ctx.links.forEach((l) => {
            const u = safeUrl(l.url); if (!u) return;
            const a = el('a', 'drawer-link', l.label || u);
            a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer';
            nav.appendChild(a);
          });
          if (nav.childNodes.length) sec.appendChild(nav);
        }
        body.appendChild(sec);
      }

      if (rules) {
        const sec = el('section', 'drawer-sec');
        sec.appendChild(el('h3', 'drawer-h', 'How to play'));

        const meta = el('div', 'rules-meta');
        if (rules.players) meta.appendChild(this._chip('Players', rules.players));
        if (rules.duration) meta.appendChild(this._chip('Length', rules.duration));
        if (meta.childNodes.length) sec.appendChild(meta);

        if (rules.objective) {
          sec.appendChild(el('h4', 'drawer-h4', 'Objective'));
          sec.appendChild(el('p', null, rules.objective));
        }
        if (rules.setup) {
          sec.appendChild(el('h4', 'drawer-h4', 'Setup'));
          sec.appendChild(el('p', null, rules.setup));
        }
        if (rules.howToPlay && rules.howToPlay.length) {
          sec.appendChild(el('h4', 'drawer-h4', 'Play'));
          const ol = el('ol', 'drawer-steps');
          rules.howToPlay.forEach((s) => ol.appendChild(el('li', null, s)));
          sec.appendChild(ol);
        }
        if (rules.winning) {
          sec.appendChild(el('h4', 'drawer-h4', 'Winning'));
          sec.appendChild(el('p', null, rules.winning));
        }
        if (rules.variants && rules.variants.length) {
          sec.appendChild(el('h4', 'drawer-h4', 'Variants'));
          const ul = el('ul', 'drawer-list');
          rules.variants.forEach((v) => ul.appendChild(el('li', null, v)));
          sec.appendChild(ul);
        }
        body.appendChild(sec);
      }

      if (!ctx && !rules && !(def.description || '').trim()) {
        body.appendChild(el('p', 'drawer-lead', 'This pack ships no rules or context — it’s a free table. Agree your house rules and play.'));
      }
    }

    _chip(k, v) {
      const c = el('span', 'meta-chip');
      c.appendChild(el('b', null, k));
      c.appendChild(document.createTextNode(' ' + v));
      return c;
    }

    openDrawer() {
      if (!this.refs.drawer) return;
      this.refs.drawer.classList.add('open');
      if (this.refs.backdrop) this.refs.backdrop.classList.add('show');
    }
    closeDrawer() {
      if (!this.refs.drawer) return;
      this.refs.drawer.classList.remove('open');
      if (this.refs.backdrop) this.refs.backdrop.classList.remove('show');
    }

    /* ---------------- dice ---------------- */
    _buildDice() {
      const tray = this.refs.diceTray;
      if (!tray) return;
      tray.innerHTML = '';
      if (this.refs.diceResult) this.refs.diceResult.textContent = '';
      if (!this.dice.length) { tray.classList.add('hidden'); return; }
      tray.classList.remove('hidden');

      this.dice.forEach((die) => {
        const btn = el('button', 'die-btn');
        const face = el('span', 'die-face', die.glyph || '🎲');
        btn.appendChild(face);
        const lab = die.count > 1 ? `${die.label} ×${die.count}` : die.label;
        btn.appendChild(el('span', 'die-label', lab));
        btn.title = 'Roll ' + lab;
        btn.onclick = () => this.roll(die);
        tray.appendChild(btn);
      });
      const res = el('div', 'dice-result');
      res.id = 'diceResult';
      this.refs.diceResult = res;
      tray.appendChild(res);
    }

    _rollOne(die) {
      if (die.faces && die.faces.length) {
        const f = die.faces[rnd(die.faces.length)];
        return { label: f.label, value: f.value };
      }
      const n = 1 + rnd(die.sides);
      return { label: String(n), value: n, sides: die.sides };
    }

    roll(die) {
      // 3D physics dice if available (numeric dice only); the settled values feed the
      // synced roll so the animation matches the broadcast number. Otherwise instant.
      if (global.Dice3D && global.Dice3D.supports(die)) {
        global.Dice3D.roll(die, die.themeColor || null)
          .then((results) => this._finishRoll(die, results))
          .catch(() => this._finishRoll(die, this._rollLocal(die)));
        return;
      }
      this._finishRoll(die, this._rollLocal(die));
    }

    _rollLocal(die) {
      const results = [];
      for (let i = 0; i < die.count; i++) results.push(this._rollOne(die));
      return results;
    }

    _finishRoll(die, results) {
      let total = 0, numeric = true;
      results.forEach((r) => { if (typeof r.value === 'number') total += r.value; else numeric = false; });
      const payload = {
        by: this.identity.name, label: die.label,
        results, total: numeric ? total : null, t: Date.now(),
      };
      this.net.publishDice(payload);       // broadcast (echoes back to us too)
      this.applyDice(payload);             // show immediately
    }

    // render an incoming (or our own) roll
    applyDice(roll) {
      const box = this.refs.diceResult;
      if (!box || !roll || !roll.results) return;
      box.innerHTML = '';
      const who = el('span', 'roll-who', (roll.by || 'Someone') + ' rolled');
      box.appendChild(who);
      const faces = el('span', 'roll-faces');
      roll.results.forEach((r) => {
        const f = el('span', 'roll-face');
        f.textContent = (r.sides === 6 && typeof r.value === 'number' && r.value >= 1 && r.value <= 6)
          ? PIPS[r.value] : r.label;
        faces.appendChild(f);
      });
      box.appendChild(faces);
      if (roll.total != null && roll.results.length > 1) {
        box.appendChild(el('span', 'roll-total', '= ' + roll.total));
      }
      box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
    }

    /* ---------------- turns ---------------- */
    nextTurn() {
      if (!this.turns) return;
      this.turnIdx += 1;
      this.net.publishTurn({ idx: this.turnIdx, by: this.identity.name, t: Date.now() });
      this._renderTurn();
    }

    applyTurn(turn) {
      if (!this.turns) return;
      this.turnIdx = (turn && Number.isFinite(turn.idx)) ? turn.idx : 0;
      this._renderTurn();
    }

    _seatName(idx) {
      const ps = this.turns && this.turns.players;
      if (ps && ps.length) return ps[((idx % ps.length) + ps.length) % ps.length];
      return 'Turn ' + (idx + 1);
    }

    _renderTurn() {
      const bar = this.refs.turnBar, who = this.refs.turnWho;
      if (!bar) return;
      if (!this.turns) { bar.classList.add('hidden'); return; }
      bar.classList.remove('hidden');
      const name = this._seatName(this.turnIdx);
      if (who) {
        who.textContent = name;
        const mine = (this.identity.name || '').toLowerCase() === String(name).toLowerCase();
        who.classList.toggle('mine', mine);
      }
    }

    _syncPlayaidsVisibility() {
      const pa = this.refs.playaids;
      if (!pa) return;
      const show = (this.dice && this.dice.length) || this.turns;
      pa.classList.toggle('hidden', !show);
    }
  }

  global.RoomExtras = RoomExtras;
})(window);
