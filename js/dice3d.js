/* dice3d.js — optional physics 3D dice via @3d-dice/dice-box.
 *
 * Progressive enhancement over the flat roller in extras.js: when it loads, numeric
 * dice (d4/d6/d8/d10/d12/d20/d100) tumble in a canvas over the board and the SETTLED
 * physics values feed the normal synced roll — so the animation the roller sees is
 * exactly the number broadcast to the room. Anything unsupported falls back silently
 * to the instant roller: faces dice (e.g. tali astragali), non-polyhedral sides, no
 * WebGL, or any load/init failure.
 *
 * No build step — the ESM module is dynamically imported at first roll, so the heavy
 * Babylon/wasm payload only loads if a 3D roll actually happens. dice-box is vendored
 * same-origin under lib/dice-box/ (no runtime CDN dependency); the two URLs below are
 * the only things to change to point back at a CDN.
 */
(function (global) {
  'use strict';

  // Vendored same-origin under lib/dice-box/ — no external CDN at runtime. dice-box's
  // published dist is self-contained (Babylon inlined; world.*.js pulled via RELATIVE
  // imports), so we serve the dist straight from our own origin. Both URLs are made
  // ABSOLUTE: the physics worker runs with an opaque origin and resolves assetPath
  // directly, and dynamic import() rejects bare/relative specifiers.
  //   To switch back to the CDN, set these to:
  //     https://cdn.jsdelivr.net/npm/@3d-dice/dice-box@1.1.4/+esm
  //     https://cdn.jsdelivr.net/npm/@3d-dice/dice-box@1.1.4/dist/assets/
  const MODULE_URL = new URL('lib/dice-box/dice-box.es.js', document.baseURI).href;
  const ASSET_PATH = new URL('lib/dice-box/assets/', document.baseURI).href;
  const INIT_TIMEOUT = 9000;                 // give up on a slow/blocked load → fall back
  const CLEAR_AFTER = 4500;                   // sweep the dice off after they settle
  const POLY = new Set([4, 6, 8, 10, 12, 20, 100]);

  let box = null, initPromise = null, disabled = false, _webgl = null, _clearTimer = 0;

  function webglOk() {
    if (_webgl != null) return _webgl;
    try {
      const c = document.createElement('canvas');
      _webgl = !!(global.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { _webgl = false; }
    return _webgl;
  }

  // can this die be shown as physical 3D dice?
  function supports(die) {
    return !disabled && die && !die.faces && POLY.has(die.sides) && die.d3d !== false && webglOk();
  }

  function overlay() {
    let el = document.getElementById('dice3d');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dice3d';
      el.className = 'dice3d-overlay';
      (document.querySelector('.stage-wrap') || document.body).appendChild(el);
    }
    return el;
  }

  function _withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('dice-box init timed out')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  async function ensure() {
    if (box) return box;
    if (disabled) throw new Error('3d dice unavailable');
    if (!initPromise) {
      initPromise = _withTimeout((async () => {
        overlay();
        const mod = await import(/* @vite-ignore */ MODULE_URL);
        const DiceBox = mod.default || mod.DiceBox || mod;
        // v1.1.x: a SINGLE config object (container = mount selector, id = canvas id).
        // assetPath MUST live in here or it silently defaults to /assets/dice-box/.
        const b = new DiceBox({
          container: '#dice3d',
          id: 'dice3d-canvas',
          assetPath: ASSET_PATH,
          theme: 'default',
          scale: 7, gravity: 1.4, throwForce: 6, spinForce: 5,
          enableShadows: true, lightIntensity: 0.9,
        });
        await b.init();
        box = b;
        return b;
      })(), INIT_TIMEOUT).catch((e) => { disabled = true; initPromise = null; throw e; });
    }
    return initPromise;
  }

  // roll one die spec → Promise<[{value, sides}]> from the physics simulation
  async function roll(die, themeColor) {
    const b = await ensure();
    clearTimeout(_clearTimer);
    try { b.clear && b.clear(); } catch (e) {}
    overlay().classList.add('show');
    const notation = (die.count || 1) + 'd' + die.sides;
    const results = await b.roll(notation, themeColor ? { themeColor } : undefined);
    const arr = (Array.isArray(results) ? results : []).map((r) => ({ value: r.value, sides: r.sides || die.sides }));
    _clearTimer = setTimeout(clear, CLEAR_AFTER);
    if (!arr.length) throw new Error('no dice result');     // let caller fall back
    return arr;
  }

  function clear() {
    try { box && box.clear && box.clear(); } catch (e) {}
    const el = document.getElementById('dice3d');
    if (el) el.classList.remove('show');
  }

  global.Dice3D = { supports, roll, clear, ensure, available: () => !disabled && webglOk() };
})(window);
