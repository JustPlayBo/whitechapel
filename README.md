# JustPlay — a shared-board engine

A tiny **engine for real-time shared tabletops**. Players join a room, drag pieces
around a board, and every move is seen live by everyone else. There are deliberately
**no rules** — it's a synced table. Move the pieces however your house rules demand.

The board and its pieces aren't hard-coded — they're described by an **abstract JSON
"game pack"** that's loaded and run. Swap the pack and you've got a different game;
the engine is the same. It ships with three packs:

| Pack | Board | Pieces |
| ---- | ----- | ------ |
| **Whitechapel — Stay At Home** | the `LFW_StayAtHome.pptx` map (image) | Jack, carriage, lamppost, constables, discs (images) |
| **Chess — open table** | generated checkerboard | the 12 chess pieces (unicode glyphs) |
| **Go — 19×19 goban** | generated grid | black & white stones |
| **World map** | a live **MapLibre** vector map | flags, pins, crowns at real lng/lat |

…and anyone can load their own pack by **URL**, **pasted JSON**, or straight from
**GitHub via jsDelivr** — `gh:<org>/<repo>/<path>` (or just `<org>/<repo>/<path>`),
or even a clean path `…/<org>/<repo>/<game>` in the address bar. A complete pack can
be authored with **zero binary assets** (pattern/map board + glyph pieces).

→ Pack format: [`packs/SCHEMA.md`](packs/SCHEMA.md)

## What it does

- **Easy setup** — one static page, no build step, no server of your own.
- **Loads resources from a pack** — the board image (or generated pattern) and the
  piece tray come straight from the JSON. *Load sample layout* drops pieces into the
  pack's preset (e.g. the chess opening, or the original Whitechapel slide positions).
- **Shared rooms** — pick/scan a room code, share the invite link, and anyone who
  opens it lands on the same board running the same pack.
- **The whole room shares one game** — change the pack and everyone switches; the
  choice is a retained MQTT message so late joiners get it automatically.
- **Pieces managed by all** — drag from the tray to add, drag a piece to move,
  drag to the 🗑️ (or right-click) to remove. Live cursors show where others point.
- **Persisted locally** — every player mirrors the whole board into their browser's
  `localStorage`, so a refresh or a dropped connection keeps the table intact and
  can re-seed the room for others.
- **Tells players how to play** *(opt-in, per pack)* — a pack can carry `rules` and
  `context` (a slide-in **ℹ︎ Rules** drawer), a `dice` block (a synced dice roller —
  rolls are broadcast to the room) and a `turns` block (a shared "whose turn" chip).
  Still no enforced rules: dice are a shared roller, the turn chip is a shared marker.
  Packs without these blocks are unaffected. → [`packs/SCHEMA.md`](packs/SCHEMA.md)
  Numeric dice **tumble in 3D** ([`@3d-dice/dice-box`](https://github.com/3d-dice/dice-box),
  loaded lazily from a CDN) when WebGL is available, and fall back to an instant roll
  otherwise — the settled physics value is what gets broadcast.
- **Card decks** *(opt-in, per pack)* — a `decks` block deals from a
  [cardsapi.com](https://forge.cardsapi.com) / deckofcardsapi-compatible API
  (standard 52, or your own **CardForge** project via `cardforge: "org/repo"`). The
  room shares one server-shuffled deck over MQTT; a drawn card becomes an ordinary
  image-backed piece that syncs and drags like any token. → the *Card table* built-in.

## Run it

It's pure static files. Any of these work:

```bash
# from this folder
python3 -m http.server 8777
# then open http://localhost:8777
```

or just open `index.html` directly in a browser (`file://` works too).

Open it in **two tabs/devices with the same room code** to see the sync. Share the
**Invite** button's link to bring others in.

> Tip: add `?room=baker-street-42` to the URL to jump straight into a named room.

## Deploy to GitHub Pages

It's a static site at the repo root, so Pages needs no build. Two ways:

**A. GitHub Actions (included, auto-deploys on every push to `main`)**

```bash
git init && git add -A && git commit -m "Whitechapel shared board"
gh repo create whitechapel-stayathome --public --source=. --remote=origin --push
# enable Pages with the Actions source, then trigger the workflow:
gh api -X POST repos/:owner/whitechapel-stayathome/pages -f build_type=workflow || true
```

The workflow is `.github/workflows/pages.yml`. Your game lands at
`https://<user>.github.io/whitechapel-stayathome/`.

**B. Branch deploy (no workflow)** — in the repo's **Settings → Pages**, set
*Source: Deploy from a branch → `main` / `(root)`*. Done.

Because Pages is served over **HTTPS**, the app automatically uses the secure broker
endpoint `wss://broker.hivemq.com:8884/mqtt` — no config needed. All asset paths are
relative, so it works under the `/<repo>/` sub-path, and a `.nojekyll` file keeps
GitHub from touching the files.

## How the sync works

Real-time state rides on the **public HiveMQ MQTT broker** over WebSockets — no
backend to deploy.

| Page served over | Broker endpoint used                  |
| ---------------- | ------------------------------------- |
| `http://` / `file://` | `ws://broker.hivemq.com:8000/mqtt`  |
| `https://`            | `wss://broker.hivemq.com:8884/mqtt` |

Topics, all under `lfw/<room>/`:

| Topic                 | Retained | Meaning                                   |
| --------------------- | :------: | ----------------------------------------- |
| `game`                |   yes    | the pack the room runs: `{ref}` or `{def}` |
| `m/<markerId>`        |   yes    | a marker `{type,x,y,t,by}`; empty = removed |
| `presence/<clientId>` |   yes    | `{name,color}`; empty (or LWT) = left     |
| `cursor/<clientId>`   |    no    | live pointer position, throttled          |
| `sync/req` `sync/full`|    no    | a joiner asks; peers answer with the board |
| `dice`                |    no    | a shared dice roll `{by,label,results,total,t}` |
| `turn`                |   yes    | whose turn it is `{idx,by,t}` (shared indicator) |
| `deck/<deckId>`       |   yes    | the room's shared server-side deck `{deck_id,remaining,…}` |
| `deckdraw`            |    no    | announces a draw `{by,deckId,cards,t}` (for the log) |

- The **`game`** topic is how the whole room agrees on one pack: the first player to
  arrive publishes it (retained); anyone using *Change game…* republishes it and
  everyone adopts it. Late joiners read it on subscribe.
- Marker positions are **normalised `[0,1]`** coordinates, so every screen size and
  zoom level agrees on where a piece sits.
- **Retained** marker messages mean a late joiner gets the current board replayed the
  instant they subscribe; `sync/req`→`sync/full` is a belt-and-braces backup that lets
  a peer re-seed from its `localStorage`.
- Conflicts resolve **last-writer-wins** by timestamp.

> The HiveMQ public broker is shared and unauthenticated — fine for a game night,
> not for anything private. Anyone who knows your room code can join.

## Project layout

```
index.html             markup + shells (lobby / game / pack-loader modal)
css/styles.css          theme + glyph-piece / pattern-board styles
js/gamedef.js           the abstraction: load/normalise a pack, render board & pieces
js/identity.js          per-player colour
js/state.js             board model + localStorage persistence (last-writer-wins)
js/net.js               MQTT transport (HiveMQ over WebSockets), incl. the `game` topic
js/extras.js            opt-in play aids: rules/context drawer, synced dice, turn chip
js/dice3d.js            optional 3D physics dice (@3d-dice/dice-box), lazy CDN load
js/cards.js             opt-in card decks: cardsapi.com / CardForge pile, draw, shared deck
js/board.js             DOM board: image/pattern boards, pan/zoom, drag, cursors
js/mapboard.js          MapLibre board: geo (lng/lat) pieces, grid overlay, cursors
js/app.js               glue: lobby, pack picker, controller switching, presence, menu
lib/mqtt.min.js         vendored MQTT.js v5 (no CDN needed)
404.html                GitHub-Pages SPA redirect (enables /<org>/<repo>/<game> paths)
packs/index.json        registry of built-in packs (lobby dropdown)
packs/*.json            the game packs (incl. world.json — a MapLibre map)
packs/SCHEMA.md         pack format reference
assets/board.jpg        Whitechapel map (pptx image11)
assets/markers/*.png    Whitechapel tokens (pptx image1–10)
```

## Controls

| Action            | How                                         |
| ----------------- | ------------------------------------------- |
| Pick / change game| lobby dropdown, or **Menu ▾ → Change game…** |
| Add a piece       | drag it from the bottom tray onto the board |
| Move a piece      | drag it                                      |
| Remove a piece    | drag to the 🗑️ corner, or right-click it    |
| Pan / zoom        | drag empty board / mouse-wheel (pinch on touch) |
| Re-centre, clear, sample layout, leave | **Menu ▾**            |

## Make your own game

Author a pack (see [`packs/SCHEMA.md`](packs/SCHEMA.md)) — here's a complete,
asset-free one:

```json
{
  "name": "Tic-tac-toe",
  "board": { "pattern": { "type": "grid", "cols": 3, "rows": 3, "line": "#333", "bg": "#f3ead6" }, "aspect": 1 },
  "pieces": [
    { "type": "x", "label": "X", "glyph": "✕", "color": "#c0392b" },
    { "type": "o", "label": "O", "glyph": "◯", "color": "#2c3e50" }
  ]
}
```

Load it in the room via **Menu ▾ → Change game… → paste JSON**, and everyone switches
to it instantly.
