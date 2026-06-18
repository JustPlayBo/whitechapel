# Vendored: @3d-dice/dice-box

Self-hosted copy of **[@3d-dice/dice-box](https://github.com/3d-dice/dice-box)**
v1.1.4 (MIT License, © Frank Ekholm / the 3d-dice authors), used by `js/dice3d.js`
for the optional 3D physics dice.

This is the package's own `dist/` served from our origin so the launcher has **no
runtime CDN dependency**. dice-box's dist is self-contained — Babylon.js is inlined
into the `world.*.js` modules, which the entry loads via relative dynamic imports —
so no bundler step is needed.

Files (the runtime subset of `dist/`; source maps and the `.min` variants are omitted):

```
dice-box.es.js        entry — dynamically imports the right world.* below
world.onscreen.js     WebGL renderer on the main thread (imports ./dice-box.es.js, ./Dice.js)
world.offscreen.js    OffscreenCanvas renderer (self-contained; runs in an inlined worker)
world.none.js         no-render fallback
Dice.js               dice meshes / theme loading
assets/themes/default/ default theme (textures + config)
assets/ammo/          ammo.js physics wasm
```

To update: re-fetch the same files from
`https://cdn.jsdelivr.net/npm/@3d-dice/dice-box@<version>/dist/…` and strip the
trailing `//# sourceMappingURL=` comment from each `.js`. Keep `js/dice3d.js`'s
version comment in sync.
