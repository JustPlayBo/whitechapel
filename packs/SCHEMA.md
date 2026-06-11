# Game pack schema (`boardgame/1`)

A **pack** is a single JSON file that fully describes a shared table: a board and
a set of pieces. The engine has no game-specific code — it loads a pack, renders
it, and syncs piece moves over MQTT. Anyone in a room can load a pack and everyone
switches to it.

A pack can be authored with **zero binary assets**: boards can be generated
patterns and pieces can be unicode/emoji glyphs.

## Top level

| Field         | Type     | Notes                                              |
| ------------- | -------- | -------------------------------------------------- |
| `schema`      | string   | `"boardgame/1"` (optional, informational)          |
| `id`          | string   | stable id, used for room sync identity             |
| `name`        | string   | shown in the lobby, topbar, and menus              |
| `description` | string   | optional blurb                                     |
| `board`       | object   | see **Board**                                      |
| `pieces`      | array    | see **Pieces** — the tray of draggable tokens      |
| `setup`       | array    | optional preset layout (the "Load sample layout")  |

## Board

```json
"board": {
  "image": "url | data-uri",          // a picture board, OR…
  "pattern": { "type": "checker | grid | solid", ... },
  "map": "maplibre-style-url | {…}",   // …OR a live MapLibre map
  "aspect": 1.6,                        // width / height; derived if omitted
  "color": "#140e09",                   // backdrop behind the board
  "pieceSize": 0.05                     // default piece size, fraction of board width
}
```

Give **one** of `image`, `pattern`, or `map`. For an image, `aspect` is auto-detected
from the file if you omit it. Relative `image`/`map` paths resolve against the pack's
own URL.

**Patterns** (generated as crisp inline SVG):

| `type`    | extra fields                                             |
| --------- | -------------------------------------------------------- |
| `solid`   | `color`                                                  |
| `checker` | `cols`, `rows`, `light`, `dark`, `bg`                    |
| `grid`    | `cols`, `rows`, `line`, `bg`, `stars` (array of `[c,r]`) |

For patterns, `aspect` defaults to `cols / rows`.

### Map boards (MapLibre)

Set `board.map` to a [MapLibre GL **style**](https://maplibre.org/maplibre-style-spec/)
— a URL (e.g. `https://tiles.openfreemap.org/styles/liberty`, an OpenFantasyMap style,
or your own) or an inline style object. MapLibre GL is loaded lazily the first time a
map pack is opened.

```json
"board": {
  "map": "https://tiles.openfreemap.org/styles/liberty",
  "center": [8, 30],                          // [lng, lat]
  "zoom": 1.5,
  "grid": { "step": 15, "color": "#3a6ea5", "width": 0.6, "opacity": 0.45 }
}
```

On a map board the **map owns pan & zoom**, and a piece's `x`,`y` is its **`lng`,`lat`**
— tokens pin to real coordinates and stay put as everyone moves the map. `setup`
coordinates are therefore `lng`,`lat` too. The optional `grid` draws a lat/lng
graticule overlay (`step` in degrees).

## Pieces

Each piece is a tray token players can drag onto the board. Use `image` **or**
`glyph`.

```json
{ "type": "wk", "label": "White King", "glyph": "♚", "color": "#f6f2e7" }
{ "type": "jack", "label": "Jack", "image": "../assets/markers/jack.png" }
{ "type": "b", "label": "Black stone", "glyph": "", "bg": "#141414" }
```

| Field   | Notes                                                                 |
| ------- | --------------------------------------------------------------------- |
| `type`  | **required**, unique id; placed markers reference this                 |
| `label` | tray caption / tooltip (defaults to `type`)                           |
| `image` | url or data-uri (relative paths resolve against the pack URL)         |
| `glyph` | unicode/emoji/letters, drawn as text                                 |
| `color` | glyph text colour                                                    |
| `bg`    | if set, the glyph is drawn on a round chip of this colour (e.g. a stone) |
| `size`  | piece size as a fraction of board width (overrides `board.pieceSize`) |

A placed marker whose `type` isn't in the current pack renders as a labelled
fallback chip, so switching packs never breaks the board.

## Setup (optional)

A preset layout loaded on demand from the menu. Coordinates are normalised `[0,1]`.

```json
"setup": [ { "type": "wp", "x": 0.0625, "y": 0.8125 }, … ]
```

## Loading a pack

- Pick a **built-in** in the lobby (registered in `packs/index.json`).
- **URL** — host a pack anywhere CORS-readable and paste its URL.
- **GitHub via jsDelivr** — `gh:<org>/<repo>[@ver]/<path>` or just `<org>/<repo>/<path>`
  resolves to `https://cdn.jsdelivr.net/gh/…`. (`npm:<pkg>/<path>` works too.)
- **Paste JSON** — inline a whole pack; it's shared to the room verbatim over MQTT.
- **Link** — `?game=<id|url|org/repo/path>` on the invite URL preloads a pack.
- **Clean path** — `/<org>/<repo>/<game>` after the app loads that pack from GitHub
  via jsDelivr, e.g. `…/whitechapel/JustPlayBo/whitechapel/packs/chess.json`.
  (Served on GitHub Pages through the SPA `404.html` redirect.)

A pack referenced by any of these forms is shared to the room by its short ref, so it
stays compact; pasted-JSON packs are shared in full.

The room's current pack lives in the retained MQTT topic `lfw/<room>/game` as
`{ "ref": "<ref>" }` or `{ "def": { …whole pack… } }`, so late joiners get it
automatically.
