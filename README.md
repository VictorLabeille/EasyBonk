# EasyBonk

**It draws on top of the game. It never touches the game.**

A read-only overlay for [bonk.io](https://bonk.io), for one custom map — *Death Ball Cannons Pvp
Grapple 1v1 Pr0*, grapple mode. You die if you touch the Death Ball; you survive by grappling it
back, playing the inertia. The overlay helps a beginner read where the ball is going and where the
grapple would catch.

## What it shows

| Aid | What it does |
| --- | --- |
| 🔴 **Ball trajectory** | Free flight plus arena bounces, with continuous collision and real per-surface restitution. An orange **"→ cannon"** marker where the ball enters a channel — what happens inside the cannon is not predictable, so the line stops there and says so |
| 🎯 **Grapple anchor** | The grappable surface nearest your disc: **red** for wall, floor or barrier, turning **green** when it is the ball — grapple now and you catch it |
| ➡️ **Off-screen arrow** | Points at the ball once a cannon has taken it out of view |

| Key | Effect |
| --- | --- |
| `²` | overlay on/off |
| `G` | grapple anchor on/off |
| `M` | disc/ball markers (debug, off by default) |
| `R` | force a recalibration, if things look offset after a restart |
| `P` | calibration diagnostics, in the console |

Live tuning: `__EASYBONK__.grappleRange`, the catch range, default 9.5.

## Install

1. Install **Tampermonkey** (or Violentmonkey) — once; it is the engine that runs userscripts.
2. [**Click here**](https://raw.githubusercontent.com/VictorLabeille/EasyBonk/main/src/easybonk.user.js),
   then **Install** in the manager window.
3. Open bonk.io and start a game on the map. Move around, send the ball once: the camera calibrates
   itself, then locks — `[EasyBonk] calage verrouillé` appears in the console.

One userscript, nothing else. Its two dependencies — Code Injector
([433861](https://greasyfork.org/scripts/433861)) and BonkLIB
([508104](https://greasyfork.org/scripts/508104)) — are pulled in by `@require` and update
themselves.

## The two hard parts

Full write-up in [`docs/reverse-engineering.md`](docs/reverse-engineering.md).

**Drawing where the game draws.** Bonk does not apply zoom through a Pixi transform — every
container sits at `scale=1`. It bakes `world × ppm × scaleRatio + pan` straight into the
coordinates, and `scaleRatio` is not readable: that code is encrypted. So it is recovered at
runtime instead. Entities that move are Pixi nodes whose world position is known from the game
state and whose screen position can be read from the Pixi tree; two readings give a scale and a
translation. Once found, the transform is **locked** — this map's camera is fixed, and locking buys
both stability and frames.

**Getting the physics right.** Constants and rules were pulled out of the map data and checked
against real captures: gravity 10, terminal speed 60, restitution per surface (plain walls 0, cages
0.8, platforms 3, cannons `re=99999`), and collision layers — the ball passes through the barriers
that the grapple can still catch.

The physics core is a **pure module, testable offline**, mirroring the logic inlined in the
userscript:

```bash
node test/validate-predict.js     # ballistic predictor against real captures
node test/validate-simulate.js    # bouncing simulator against the cannon cycle
```

In free flight the error is **0.00 m**. The cannon cycle, measured, turned out **not** to be
reproducible by a home simulation — which is why the prediction stops at the cannon mouth rather
than guessing.

## Repository map

| Path | What is there |
| --- | --- |
| `src/easybonk.user.js` | The userscript — the whole overlay |
| `src/predict.js`, `src/simulate.js` | Ballistic predictor and bouncing simulator, pure and tested |
| `test/` | Offline validation against real captures |
| `docs/reverse-engineering.md` | Everything the reconnaissance found: coordinates, physics, grapple |
| `.claude/specs/` | The functional brief — scope and feasibility |
| `reference/` | Local copies kept for study — git-ignored, **not redistributed** |

Documentation is in French; this page is not.

## Legal and ethics

bonk.io's code is **proprietary and obfuscated**. `reference/` holds the game bundle, BonkLIB and
captures for local study only; it is git-ignored and must not be redistributed.

This overlay is **client-side and read-only**. It injects no input, alters no physics and changes
nothing for the other players — bonk's simulation is deterministic and synchronised, so touching it
client-side would desync and get you kicked anyway. No aimbot, no automation. That line was drawn
in the brief, before the first line of code, and it is the reason the project stays where it is.
