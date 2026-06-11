/* catalog.js — the pieces available on the board, derived from the pptx media. */
(function (global) {
  'use strict';

  // type -> { label, img }.  `img` paths are relative to index.html.
  const MARKERS = {
    'jack':        { label: 'Jack',              img: 'assets/markers/jack.png' },
    'carriage':    { label: 'Carriage',          img: 'assets/markers/carriage.png' },
    'lamp':        { label: 'Lamppost',          img: 'assets/markers/lamp.png' },
    'cop-green':   { label: 'Constable · Green',  img: 'assets/markers/cop-green.png' },
    'cop-yellow':  { label: 'Constable · Yellow', img: 'assets/markers/cop-yellow.png' },
    'cop-teal':    { label: 'Constable · Teal',   img: 'assets/markers/cop-teal.png' },
    'cop-brown':   { label: 'Constable · Brown',  img: 'assets/markers/cop-brown.png' },
    'disc-red':    { label: 'Disc · Red',         img: 'assets/markers/disc-red.png' },
    'disc-yellow': { label: 'Disc · Yellow',      img: 'assets/markers/disc-yellow.png' },
    'disc-grey':   { label: 'Disc · Grey',        img: 'assets/markers/disc-grey.png' },
  };

  // order they appear in the tray
  const TRAY_ORDER = [
    'jack', 'carriage', 'lamp',
    'cop-green', 'cop-yellow', 'cop-teal', 'cop-brown',
    'disc-red', 'disc-yellow', 'disc-grey',
  ];

  // soft player colours, picked deterministically from a name/id
  const PLAYER_COLORS = [
    '#e0533d', '#e0a23d', '#7bb661', '#3da3e0',
    '#9b6fe0', '#e06fb4', '#4ec9b0', '#d4b483',
  ];

  function colorFor(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return PLAYER_COLORS[h % PLAYER_COLORS.length];
  }

  global.Catalog = { MARKERS, TRAY_ORDER, colorFor };
})(window);
