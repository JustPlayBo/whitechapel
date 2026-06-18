# Game pack schema (`boardgame/1`)

A **pack** is a single JSON file that fully describes a shared table: a board and
a set of pieces. The engine has no game-specific code — it loads a pack, renders
it, and syncs piece moves over MQTT. Anyone in a room can load a pack and everyone
switches to it.

A pack can be authored with **zero binary assets**: boards can be generated
patterns and pieces can be unicode/emoji glyphs.

Packs may also carry optional **`rules`**, **`context`**, **`dice`** and **`turns`**
blocks (added in the additive revision **`boardgame/1.1`**) that *tell players how to
play* — a rules drawer, a synced dice roller, and a shared turn indicator. They are
purely informational/assistive: the engine still enforces nothing, and a pack that
omits them behaves exactly as a `boardgame/1` pack. See **Telling players how to play**.

## Top level

| Field         | Type     | Notes                                              |
| ------------- | -------- | -------------------------------------------------- |
| `schema`      | string   | `"boardgame/1"` or `"boardgame/1.1"` (optional, informational) |
| `id`          | string   | stable id, used for room sync identity             |
| `name`        | string   | shown in the lobby, topbar, and menus              |
| `description` | string   | optional blurb (shown atop the rules drawer)       |
| `board`       | object   | see **Board**                                      |
| `pieces`      | array    | see **Pieces** — the tray of draggable tokens      |
| `setup`       | array    | optional preset layout (the "Load sample layout")  |
| `rules`       | object   | optional — how to play (drawer). See below.        |
| `context`     | object   | optional — what/when this game is (drawer). See below. |
| `dice`        | array    | optional — declares a synced dice roller. See below. |
| `turns`       | object   | optional — a shared "whose turn" indicator. See below. |

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

## Telling players how to play (optional, `boardgame/1.1`)

The engine is a *bare synced table* — it never enforces rules. These four optional
blocks let a pack carry the human-readable rules and a couple of shared table aids,
so players opening a room they've never seen know what to do. All are optional and
omitting them changes nothing. They ride inside the pack, so they sync to the whole
room automatically (the pack is shared verbatim over MQTT).

### `rules` — the "How to play" drawer

Opens from the **ℹ︎ Rules** button in the topbar (shown only when a pack has `rules`,
`context`, or a `description`).

```json
"rules": {
  "objective": "Bear all your pieces off before your opponent.",
  "players": "2",
  "duration": "10–20 min",
  "setup": "Place the pieces as the sample layout shows…",
  "howToPlay": [ "Roll the dice.", "Move a piece by that many points.", "…" ],
  "winning": "First to bear off every piece wins.",
  "variants": [ "Play to two games out of three." ]
}
```

| Field       | Type            | Notes                                        |
| ----------- | --------------- | -------------------------------------------- |
| `objective` | string          | one-line goal (alias: `goal`)                |
| `players`   | string          | e.g. `"2"`, `"2–4"`                          |
| `duration`  | string          | rough length                                 |
| `setup`     | string          | how the board starts                         |
| `howToPlay` | array\<string\> | ordered steps (aliases: `steps`, `play`)     |
| `winning`   | string          | win/end condition (alias: `win`)             |
| `variants`  | array\<string\> | optional rule variations                     |

### `context` — the "Context" drawer section

```json
"context": {
  "period": "Roman Empire, 1st–4th c. CE",
  "blurb": "A race game found scratched on tavern tables across the empire…",
  "image": "https://upload.wikimedia.org/…/board.jpg",
  "credit": "Roman game board, British Museum (CC BY)",
  "sources": [ "Austin, R. G. (1934). Roman board games. Greece & Rome." ],
  "links": [ { "label": "Tabula — Wikipedia", "url": "https://en.wikipedia.org/wiki/Tabula_(game)" } ]
}
```

| Field     | Type                         | Notes                                  |
| --------- | ---------------------------- | -------------------------------------- |
| `period`  | string                       | shown as a pill                        |
| `blurb`   | string                       | a paragraph (alias: `description`)     |
| `image`   | url                          | hot-linked illustration (relative paths resolve against the pack URL) |
| `credit`  | string                       | caption under the image                |
| `sources` | array\<string\>              | bibliography lines                     |
| `links`   | array\<`{label,url}`\>       | external links (also accepts bare url strings) |

### `dice` — a synced dice roller

Declares one or more dice. Each appears as a button in a floating tray; a roll is
**broadcast to the whole room** (volatile — late joiners don't see past rolls) and
shown as `Name rolled ⚄⚂ = 8`. The engine computes a sum only when all faces are
numeric.

```json
"dice": [
  { "id": "tesserae", "label": "Tesserae", "sides": 6, "count": 2 },
  { "id": "tali", "label": "Tali", "count": 4,
    "faces": [ { "label": "I", "value": 1 }, { "label": "III", "value": 3 },
               { "label": "IV", "value": 4 }, { "label": "VI", "value": 6 } ] }
]
```

| Field   | Type                          | Notes                                            |
| ------- | ----------------------------- | ------------------------------------------------ |
| `id`    | string                        | optional id                                      |
| `label` | string                        | tray caption                                     |
| `sides` | int                           | numeric die `1..sides` (default 6; ignored if `faces`) |
| `count` | int                           | dice rolled together (default 1)                 |
| `faces` | array\<string \| `{label,value}`\> | non-uniform faces (e.g. the four faces of an astragalus). Strings are taken as both label and value. |
| `glyph` | string                        | optional tray glyph (default 🎲)                 |
| `d3d`   | bool                          | set `false` to force the flat roller (default: 3D when available) |
| `themeColor` | string                   | hex tint for the 3D dice                         |

d6 numeric rolls render as pip glyphs (⚀–⚅); everything else shows its label.

**3D physics dice.** When [`@3d-dice/dice-box`](https://github.com/3d-dice/dice-box)
loads, numeric polyhedral dice (`sides` ∈ 4/6/8/10/12/20/100) **tumble in 3D** over the
board and the settled physics values feed the roll — so the animation the roller sees
is exactly the number broadcast to the room. It's progressive enhancement: `faces`
dice (e.g. tali astragali), non-polyhedral sides, browsers without WebGL, or any load
failure fall back to the instant roller automatically. The library is self-hosted in
`lib/dice-box/` (no runtime CDN) and loaded lazily at first roll, so it only downloads
if a 3D roll actually happens.

### `turns` — a shared turn indicator

A chip showing whose go it is, plus a **Next ▸** button anyone can press; the current
seat is **retained**, so late joiners see it. It is an indicator only — nothing is
enforced, and any player may advance it.

```json
"turns": { "players": [ "Albus", "Ruber" ], "track": true }
```

| Field     | Type            | Notes                                                       |
| --------- | --------------- | ----------------------------------------------------------- |
| `players` | array\<string\> | seat names, cycled in order. Omit for a plain "Turn N" counter. |
| `track`   | bool            | defaults `true` when a `turns` block is present             |

If a player's display name matches the active seat name, the chip highlights as
"(you)".

### `decks` — card decks (`boardgame/1.2`)

Declares one or more **card decks** drawn from a [cardsapi.com](https://forge.cardsapi.com)
/ [deckofcardsapi.com](https://deckofcardsapi.com)-compatible API. Each deck shows
a face-down **pile** in the play-aids panel: tap it to deal a card onto the table,
or press **⟳** to shuffle a fresh deck.

```json
"decks": [
  { "id": "main", "label": "Tavern deck",
    "cardforge": "openfantasymap/cardforge-ab12cd",
    "shuffle": true, "back": "🂠", "cardSize": 0.12 }
]
```

| Field       | Type   | Notes                                                            |
| ----------- | ------ | --------------------------------------------------------------- |
| `id`        | string | stable id (used for the shared-deck MQTT topic)                 |
| `label`     | string | pile caption                                                    |
| `cardforge` | string | a CardForge project `"org/repo"` — omit for a **standard 52** deck |
| `api`       | string | API base, default `https://forge.cardsapi.com`                  |
| `shuffle`   | bool   | shuffle on deal (default `true`)                                |
| `back`      | string | pile-face glyph (default `🂠`) or an image URL                   |
| `cardSize`  | number | drawn-card size, fraction of board width (default ~0.12)        |

**How sync works.** The deck API is server-stateful — creating a deck returns a
`deck_id` that owns the shuffle/draw order. The first player to deal **creates** the
deck and publishes its `deck_id` on a **retained** MQTT topic (`deck/<id>`); everyone
else adopts it, so the whole room draws from the **same** deck in the same order, and
late joiners pick it up automatically. A drawn card becomes an ordinary
**image-backed piece** (its rendered PNG/SVG), carried on the marker itself — so it
syncs, persists in `localStorage`, drags, and replays for late joiners like any token.
The engine enforces nothing: anyone may draw, and a dealt card is just a piece.

> Drawing calls `forge.cardsapi.com` from the browser, so a deck needs network access
> (the rest of the engine does not). Without a `cardforge` selector you get the
> standard 52-card deck; with one you get your CardForge project's rendered cards.

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
