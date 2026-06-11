# Whitechapel — Stay At Home

A tiny **shared game board** built from the artwork inside `LFW_StayAtHome.pptx`
(the "Letters from Whitechapel" #StayAtHome print-and-play). Players join a room,
drag pieces onto the Whitechapel map, and every move is seen live by everyone else.

There are deliberately **no rules** — it's a synced table. Move the markers however
your house rules demand.

![pieces: Jack, carriage, lamppost, constables, discs]

## What it does

- **Easy setup** — one static page, no build step, no server of your own.
- **Loads the resources** from the pptx: the map becomes the board, the ten tokens
  (Jack, the carriage, the lamppost, four constable helmets, three discs) become a
  drag-out tray. *Load sample layout* drops them where the original slide had them.
- **Shared rooms** — pick/scan a room code, share the invite link, and anyone who
  opens it lands on the same board.
- **Markers managed by all** — drag from the tray to add, drag a piece to move,
  drag to the 🗑️ (or right-click) to remove. Live cursors show where others point.
- **Persisted locally** — every player mirrors the whole board into their browser's
  `localStorage`, so a refresh or a dropped connection keeps the table intact and
  can re-seed the room for others.

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
| `m/<markerId>`        |   yes    | a marker `{type,x,y,t,by}`; empty = removed |
| `presence/<clientId>` |   yes    | `{name,color}`; empty (or LWT) = left     |
| `cursor/<clientId>`   |    no    | live pointer position, throttled          |
| `sync/req` `sync/full`|    no    | a joiner asks; peers answer with the board |

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
index.html            markup + shells (lobby / game)
css/styles.css         Victorian-sepia theme
js/catalog.js          the 10 pieces + player colours
js/layout.js           sample arrangement lifted from the pptx slide
js/state.js            board model + localStorage persistence (last-writer-wins)
js/net.js              MQTT transport (HiveMQ over WebSockets)
js/board.js            rendering, pan/zoom, drag, cursors
js/app.js              glue: lobby, presence, menu, toasts
lib/mqtt.min.js        vendored MQTT.js v5 (no CDN needed)
assets/board.jpg       the map (pptx image11)
assets/markers/*.png   the tokens (pptx image1–10)
```

## Controls

| Action            | How                                         |
| ----------------- | ------------------------------------------- |
| Add a piece       | drag it from the bottom tray onto the board |
| Move a piece      | drag it                                      |
| Remove a piece    | drag to the 🗑️ corner, or right-click it    |
| Pan / zoom        | drag empty map / mouse-wheel (pinch on touch) |
| Re-centre, clear, sample layout, leave | **Menu ▾**            |
