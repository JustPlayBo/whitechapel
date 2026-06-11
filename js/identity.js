/* identity.js — per-player presentation (colour from a stable seed).
 * Game content (board + pieces) is no longer hard-coded here — it lives in
 * loadable packs handled by gamedef.js. */
(function (global) {
  'use strict';

  const PLAYER_COLORS = [
    '#e0533d', '#e0a23d', '#7bb661', '#3da3e0',
    '#9b6fe0', '#e06fb4', '#4ec9b0', '#d4b483',
  ];

  function colorFor(seed) {
    seed = String(seed || '');
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return PLAYER_COLORS[h % PLAYER_COLORS.length];
  }

  global.Identity = { PLAYER_COLORS, colorFor };
})(window);
