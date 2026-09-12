# Clogged

A falling-block puzzle game about unblocking a pipe. Grime is wedged in the
pipework; drop two-tone couplers on top of it and line up **four of a colour**
— across or down — to dissolve it. Clear every last speck to open the level.

**▶ [Play it](https://epiphenomena.github.io/clogged/)** — works offline, installs to your home screen.

<p align="center">
  <img src="docs/screenshot-menu.png" alt="The Clogged title screen" width="300">
  <img src="docs/screenshot.png" alt="A game in progress: couplers stacked over coloured grime" width="300">
</p>

## Playing

Couplers fall in pairs of two coloured halves. Land them so four same-coloured
cells line up and the whole run dissolves. Grime counts toward a run, so the
goal is always to build lines *through* it.

Two details make or break a plan:

- **Grime never falls.** It stays wherever the level put it, even with nothing
  underneath, so you can build up to it.
- **Half a coupler falls on its own.** When one half of a pair is dissolved the
  survivor is cut loose and drops — which is how you set up chains. Loose halves
  are drawn without the metal collar, so you can always see which pieces are free.

Chains multiply your score: each cascade step in a single landing doubles the
multiplier, up to 16×.

## Controls

Everything is reachable with one thumb. The pipe itself is the main control
surface — the on-screen buttons are there when you'd rather not cover the board.

| Action | Touch | Keyboard |
| --- | --- | --- |
| Move | Drag anywhere on the pipe | <kbd>←</kbd> <kbd>→</kbd> |
| Rotate | Tap the pipe, or the ⟲ / ⟳ buttons | <kbd>Z</kbd> / <kbd>X</kbd> or <kbd>↑</kbd> |
| Soft drop | Hold below where you started the drag | <kbd>↓</kbd> |
| Hard drop | Flick down | <kbd>Space</kbd> |
| Pause | ⏸ in the header | <kbd>P</kbd> or <kbd>Esc</kbd> |

Dragging maps your finger to an absolute column, so the piece tracks your thumb
instead of drifting. A dashed outline previews where the piece will land.

Each colour also carries a shape — ring, bar, cross — so the game is playable
without relying on colour vision.

## Install

Open the link on a phone and choose **Add to Home Screen**. It runs standalone
and fully offline after the first load. Scores are kept in `localStorage` on the
device; there is no account, server, or telemetry.

## Development

No build step, no dependencies, no framework. Clone it and serve the folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Use a real HTTP server rather than opening `index.html` directly — browsers
refuse to register a service worker over `file://`.

The rules live in [`core.js`](core.js) as pure functions over a board array,
with no DOM access, so they can be tested directly:

```sh
node test/core.test.js   # board rules
node test/smoke.test.js  # boots the real game.js against a stubbed DOM and plays it
```

The first covers match detection, coupler splitting, gravity, cascades, rotation
kicks, and level seeding. The second stubs enough DOM and canvas for
[`game.js`](game.js) to run headlessly, then drives it with a greedy player that
clears levels — so wiring and state-machine regressions get caught without a
browser. Both run on every push.

| File | What's in it |
| --- | --- |
| `core.js` | Board rules — matching, gravity, cascades, seeding |
| `game.js` | Canvas rendering, gestures, game loop, scoring |
| `style.css` | Layout and theming, mobile-first |
| `sw.js` | Offline cache (bump `CACHE` when assets change) |

## Deploying

Pushing to `main` runs the tests and publishes the repo root to GitHub Pages via
[`.github/workflows/pages.yml`](.github/workflows/pages.yml). Enable it once
under **Settings → Pages → Source → GitHub Actions**.

Every path in the app is relative and the manifest's `start_url` is `./`, so it
also works from a subdirectory or any static host.

## License

[MIT](LICENSE)
