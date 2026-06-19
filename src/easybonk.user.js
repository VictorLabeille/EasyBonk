// ==UserScript==
// @name         EasyBonk — aide visuelle Death Ball (v1.9)
// @namespace    easybonk
// @version      1.9.2
// @description  Trajectoire (rebonds, stop canon) + point d'accroche du grappin (rouge→vert) + balle hors-champ. Lecture seule.
// @author       victor
// @match        https://bonk.io/gameframe-release.html
// @run-at        document-start
// @grant        none
// ==/UserScript==

// PRÉREQUIS : Code Injector (433861) → BonkLIB (508104) → ce script.
//
// Ce que ça fait :
//   • TRAJECTOIRE de la balle : vol libre (gravité 10 + plafond 60) + rebonds d'arène
//     (collision continue, restitution 0.8), validée hors-ligne à 0.00 m. Marqueur orange
//     « → canon » là où elle entre dans un canal : la suite (canon) n'est pas prédictible.
//   • POINT D'ACCROCHE DU GRAPPIN : la surface grappable la plus proche de ton disque,
//     ROUGE (mur/sol) → VERT quand c'est la balle (= grappiner maintenant l'attrape).
//     Portée réglable en jeu : __EASYBONK__.grappleRange. Touche G = on/off.
//   • INDICATEUR HORS-CHAMP : flèche rouge au bord quand la balle quitte la vue.
//   • Repères de calibration (touche M) — utiles pour vérifier l'alignement.
//
// ── ALIGNEMENT CAMÉRA (le point dur, résolu ici) ─────────────────────────────
// Bonk n'applique PAS le zoom caméra via un transform Pixi (tous les conteneurs
// sont en scale=1) : il « cuit » `monde×ppm×scaleRatio + panCaméra` directement
// dans les coordonnées de dessin. Dessiner naïvement en monde×ppm rate donc le
// zoom (~0.9) et le pan. On ne peut pas lire `scaleRatio` (code obfusqué), alors
// on le RETROUVE chaque frame : les disques bougent → ce sont les nœuds Pixi
// « dynamiques ». On connaît leur position MONDE (gameState) et on lit leur
// position ÉCRAN (arbre Pixi) → on cale un transform (échelle s + translation T).
// La balle sert de validateur indépendant. Tout le reste est dessiné via ce
// transform. Robuste au redimensionnement / changement de zoom.
//
// Touches : ² = on/off · M = repères · P = diagnostic calibration (console).

(function () {
  "use strict";

  const CFG = {
    PPM_DEFAULT: 12,
    HORIZON_FRAMES: 24,     // 0.8 s
    MIN_BALL_SPEED: 3,
    SHOW_MARKERS: false,    // repères disque/balle (OFF par défaut ; touche M pour les voir)
    OFFSCREEN_MARGIN: 38,   // marge (px écran) pour la flèche de bord
    CALIB_MIN_MOVE: 0.5,    // px : déplacement mini d'un nœud pour le juger « dynamique »
    CALIB_PERP_TOL: 6,      // px : tolérance de non-parallélisme (rejet rotation/mismatch)
    CALIB_MATCH_TOL: 14,    // px : chaque entité connue doit retrouver un nœud à cette distance
    CALIB_MIN_SEP: 70,      // px : écart mini entre 2 entités pour caler (sinon mal conditionné)
    CALIB_SNAP_TOL: 30,     // px : on colle l'ancre balle au nœud rendu le plus proche
    CALIB_EVERY: 12,        // perf : recaler la caméra 1 frame sur 12 (elle est fixe)
    CALIB_MAX_NODES: 24,    // perf : plafonne les nœuds testés (les plus mobiles) → évite le O(n⁴)
    CALIB_MOTION_MIN: 40,   // px : déplacement mini du disque pour amorcer le calage via sa motion
    CALIB_EMA: 0.2,         // lissage du transform (caméra fixe → on peut lisser fort)
    CALIB_LOCK_N: 12,       // caméra fixe : après N bons calages, on VERROUILLE (médiane) → figé + perf
    CALIB_LOCK_SCORE: 1.5,  // score maxi d'un calage pour compter vers le verrouillage
    TOGGLE_KEY: "Backquote",
  };
  const log = (...a) => console.log("%c[EasyBonk]", "color:#e94;font-weight:bold", ...a);

  // ── Simulateur trajectoire : balistique + rebonds d'arène (miroir de src/simulate.js,
  //    validé hors-ligne à 0.00 m en vol libre). S'arrête à l'entrée du canon. ───────
  // DEF_RE = restitution des surfaces « re=-1 » (défaut bonk = 0). Combine Box2D = max(reA,reB) :
  // balle(0)+mur normal(0) ⇒ pas de rebond (elle s'arrête/glisse) ; seules cages 0.8 / plateformes 3
  // / canons 99999 rebondissent.
  const PHYS = { G: 10, MAX_SPEED: 60, FPS: 30, DEF_RE: 0 };
  // Hors de cette boîte (mètres) = canal/canon → trajectoire non prédictible, on stoppe.
  const ARENA = { xMin: 1, xMax: 60, yMin: 0 };

  function extractWorld(map) {
    const ph = map.physics, shapes = ph.shapes, fixtures = ph.fixtures, bodies = ph.bodies;
    const rot = (x, y, a) => (a ? [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)] : [x, y]);
    const re0 = (v) => (v == null || v === -1 ? PHYS.DEF_RE : v);
    const layers = (s) => [s.f_1, s.f_2, s.f_3, s.f_4];
    const ballBody = bodies.find((b) => b.s && b.s.n === "DeathBall");
    const bl = ballBody ? layers(ballBody.s) : [true, true, true, true];
    const hitsBall = (s) => layers(s).some((v, i) => v && bl[i]);   // partage un calque avec la balle
    let ballRadius = null, ballRe = PHYS.DEF_RE;
    const colliders = [];          // collision de la BALLE (calque commun → exclut « Barriers »)
    const grappleColliders = [];   // surfaces GRAPPABLES (np=false, ng=false → inclut « Barriers »)
    for (const b of bodies) {
      const isBall = b.s && b.s.n === "DeathBall";
      const bodyRe = re0(b.s && b.s.re), ba = b.a || 0, bp = b.p || [0, 0];
      if (isBall) { for (const fi of (b.fx || [])) { const f = fixtures[fi]; const s = f && shapes[f.sh]; if (s && s.type === "ci") { ballRadius = s.r; ballRe = bodyRe; } } continue; }
      const bHitsBall = hitsBall(b.s);
      for (const fi of (b.fx || [])) {
        const f = fixtures[fi]; if (!f) continue;
        const s = shapes[f.sh]; if (!s || s.type !== "bx" || f.np === true) continue;  // décoratif / non-box
        const [wcx, wcy] = rot(s.c[0], s.c[1], ba);
        const box = { cx: bp[0] + wcx, cy: bp[1] + wcy, hw: s.w / 2, hh: s.h / 2, ang: ba + (s.a || 0), re: f.re != null ? f.re : bodyRe };
        if (bHitsBall) colliders.push(box);            // la balle y rebondit
        if (f.ng !== true) grappleColliders.push(box); // le grappin peut s'y accrocher
      }
    }
    return { colliders, grappleColliders, ballRadius: ballRadius || 1.0416666, ballRe };
  }

  // collision continue cercle (p, rayon r, déplacement d) ↔ boîte tournée → {t,nx,ny}|null
  // Minkowski à coins arrondis : faces (slab) ET coins (cercle), sinon un frôlement de coin
  // (ex. lèvre du haut de cage) fait un faux rebond.
  function sweptCircleBox(px, py, dx, dy, r, box) {
    const ca = Math.cos(box.ang), sa = Math.sin(box.ang);
    const rx = px - box.cx, ry = py - box.cy;
    const lx = rx * ca + ry * sa, ly = -rx * sa + ry * ca;
    const vx = dx * ca + dy * sa, vy = -dx * sa + dy * ca;
    const hw = box.hw, hh = box.hh, ex = hw + r, ey = hh + r;
    const tw = (nx, ny) => ({ nx: nx * ca - ny * sa, ny: nx * sa + ny * ca });
    if (Math.abs(lx) <= ex && Math.abs(ly) <= ey) {
      const ox0 = Math.abs(lx) - hw, oy0 = Math.abs(ly) - hh;
      if (!(ox0 > 0 && oy0 > 0 && ox0 * ox0 + oy0 * oy0 > r * r)) {
        if (ox0 > 0 && oy0 > 0) { const nx = lx - (lx < 0 ? -hw : hw), ny = ly - (ly < 0 ? -hh : hh), d = Math.hypot(nx, ny) || 1; return { t: 0, ...tw(nx / d, ny / d) }; }
        const penX = ex - Math.abs(lx), penY = ey - Math.abs(ly);
        return { t: 0, ...(penX < penY ? tw(lx < 0 ? -1 : 1, 0) : tw(0, ly < 0 ? -1 : 1)) };
      }
    }
    let tEnter = 0, tExit = 1, axis = -1, sign = 0;
    for (let i = 0; i < 2; i++) {
      const p = i === 0 ? lx : ly, v = i === 0 ? vx : vy, e = i === 0 ? ex : ey;
      if (Math.abs(v) < 1e-9) { if (p < -e || p > e) return null; continue; }
      let t1 = (-e - p) / v, t2 = (e - p) / v, sg = -1;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sg = 1; }
      if (t1 > tEnter) { tEnter = t1; axis = i; sign = sg; }
      if (t2 < tExit) tExit = t2;
      if (tEnter > tExit) return null;
    }
    if (axis < 0 || tEnter <= 0 || tEnter >= 1) return null;
    const cxl = lx + vx * tEnter, cyl = ly + vy * tEnter;
    if (axis === 0 ? Math.abs(cyl) <= hh : Math.abs(cxl) <= hw) return { t: tEnter, ...tw(axis === 0 ? sign : 0, axis === 1 ? sign : 0) };
    const ox = lx - (cxl < 0 ? -hw : hw), oy = ly - (cyl < 0 ? -hh : hh);
    const A = vx * vx + vy * vy, Bq = 2 * (ox * vx + oy * vy), Cq = ox * ox + oy * oy - r * r, disc = Bq * Bq - 4 * A * Cq;
    if (disc < 0 || A < 1e-12) return null;
    const tc = (-Bq - Math.sqrt(disc)) / (2 * A);
    if (tc <= 0 || tc >= 1) return null;
    let nx = ox + vx * tc, ny = oy + vy * tc; const dn = Math.hypot(nx, ny) || 1;
    return { t: tc, ...tw(nx / dn, ny / dn) };
  }
  const clampSpeed = (vx, vy, max) => { const s = Math.hypot(vx, vy); return s > max && s > 0 ? [vx * max / s, vy * max / s] : [vx, vy]; };

  // Retourne { path:[[x,y]…], stop:{x,y}|null }. stop ≠ null = entrée canon/canal.
  function simulate(p0, v0, world, frames) {
    const dt = 1 / PHYS.FPS, r = world.ballRadius, ballRe = world.ballRe, cols = world.colliders;
    let x = p0[0], y = p0[1], vx = v0[0], vy = v0[1];
    const path = []; let stop = null;
    for (let f = 0; f < frames; f++) {
      vy += PHYS.G * dt;
      [vx, vy] = clampSpeed(vx, vy, PHYS.MAX_SPEED);
      let remain = 1, guard = 0, cannon = false;
      while (remain > 1e-4 && guard++ < 8) {
        const dx = vx * dt * remain, dy = vy * dt * remain;
        let hit = null;
        for (const c of cols) { const s = sweptCircleBox(x, y, dx, dy, r, c); if (s && (!hit || s.t < hit.t)) hit = { t: s.t, nx: s.nx, ny: s.ny, re: c.re }; }
        if (!hit) { x += dx; y += dy; break; }
        x += dx * hit.t; y += dy * hit.t;
        const e = Math.max(ballRe, hit.re), vn = vx * hit.nx + vy * hit.ny;
        if (vn < 0) { vx -= (1 + e) * vn * hit.nx; vy -= (1 + e) * vn * hit.ny; }
        [vx, vy] = clampSpeed(vx, vy, PHYS.MAX_SPEED);
        if (hit.re >= 100) cannon = true;
        remain *= (1 - hit.t); x += hit.nx * 1e-3; y += hit.ny * 1e-3;
      }
      path.push([x, y]);
      if (cannon || x < ARENA.xMin || x > ARENA.xMax || y < ARENA.yMin) { stop = { x, y }; break; }
    }
    return { path, stop };
  }

  // ── Lecture du gameState ─────────────────────────────────────────────────────
  const findBall = (gs) => {
    const bs = (gs.physics && gs.physics.bodies) || [];
    for (const b of bs) if (b && b.s && b.s.n === "DeathBall") return b;
    return null;
  };
  const worldDiscs = (gs) => {
    const ds = gs.discs || [];
    const out = [];
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i];
      if (d && Number.isFinite(d.x) && Number.isFinite(d.y)) out.push({ x: d.x, y: d.y });
    }
    return out;
  };
  // mon disque : index aligné players↔discs, repéré par bonkAPI.getMyID() (solo → discs[0])
  const findMyDisc = (gs, api) => {
    const discs = gs.discs || [], players = gs.players || [];
    const myID = api && (api.getMyID ? api.getMyID() : api.myID);
    let idx = players.findIndex((p) => p && p.id === myID);
    if (idx < 0) idx = 0;
    return discs[idx] || discs[0] || null;
  };
  // point le plus proche d'une boîte (tournée) à un point monde → {x, y, d}
  const nearestOnBox = (px, py, box) => {
    const ca = Math.cos(box.ang), sa = Math.sin(box.ang);
    const rx = px - box.cx, ry = py - box.cy;
    const lx = Math.max(-box.hw, Math.min(box.hw, rx * ca + ry * sa));
    const ly = Math.max(-box.hh, Math.min(box.hh, -rx * sa + ry * ca));
    const wx = box.cx + lx * ca - ly * sa, wy = box.cy + lx * sa + ly * ca;
    return { x: wx, y: wy, d: Math.hypot(px - wx, py - wy) };
  };

  const B = (window.__EASYBONK__ = window.__EASYBONK__ || {});
  Object.assign(B, {
    version: "1.9.2", cfg: CFG, enabled: true, markers: CFG.SHOW_MARKERS,
    ppm: CFG.PPM_DEFAULT, pathDelta: null, pathPrev: null, pathStop: null, stepTime: 0,
    world: null, cal: null, calLocked: false, calSamples: [], ballNode: null, ballNodeRef: null, calDbg: null,
    grapple: null, grappleOn: true, grappleRange: 9.5, // grappleRange réglable en direct via console
    myDiscW: null, prevMyDiscW: null,
  });

  let PIXI = null, gfx = null, pixiCtx = null, frameCount = 0;
  let ballWorld = null, discsWorldNow = [];
  const prevNodePos = new WeakMap();   // nœud → dernière position (espace pixiCtx)
  const _p = () => new PIXI.Point();

  function onStep(api, e) {
    const gs = e.gameState;
    // filet de sécurité : si gameStart a été raté, on construit le monde depuis le gameState
    // (il contient shapes/fixtures/bodies/ppm) → la trajectoire marche même sans gameStart.
    if (!B.world && gs.physics && gs.physics.shapes && gs.physics.fixtures) {
      try { B.world = extractWorld(gs); if (gs.physics.ppm) B.ppm = gs.physics.ppm; log("monde (via gameState) :", B.world.colliders.length, "obstacles"); }
      catch (err) { /* ignore, on réessaiera */ }
    }
    const ball = findBall(gs);
    ballWorld = ball ? { x: ball.p[0], y: ball.p[1] } : null;
    discsWorldNow = worldDiscs(gs);
    const me = findMyDisc(gs, api);
    B.myDiscW = me ? { x: me.x, y: me.y } : null;     // pour le calage via la motion du disque
    let deltas = null, stop = null;
    if (ball && B.world) {
      const sp = Math.hypot(ball.lv[0], ball.lv[1]);
      if (sp > CFG.MIN_BALL_SPEED) {
        const r = simulate(ball.p, ball.lv, B.world, CFG.HORIZON_FRAMES);
        deltas = r.path.map((p) => [p[0] - ball.p[0], p[1] - ball.p[1]]);  // relatif à la balle
        stop = r.stop;
      }
    }
    B.pathPrev = B.pathDelta;        // pas précédent → interpolation de forme au rendu (60 Hz)
    B.pathDelta = deltas; B.pathStop = stop; B.stepTime = performance.now();
    computeGrapple(me, ball);
  }

  // Point d'accroche du grappin = surface grappable la PLUS PROCHE de mon disque dans le rayon.
  // (règle validée recon : au sol → le sol ; en l'air près de la balle → la balle.)
  // onBall=true quand c'est la balle. À régler via B.grappleRange en jeu.
  function computeGrapple(me, ball) {
    if (!B.grappleOn || !B.world || !me) { B.grapple = null; return; }
    let best = null;
    for (const c of B.world.grappleColliders) {     // murs / sol / barrières (tout ce qui est grappable)
      const p = nearestOnBox(me.x, me.y, c);
      if (!best || p.d < best.d) best = { x: p.x, y: p.y, d: p.d, onBall: false };
    }
    if (ball) {                                     // balle (point de surface vers le disque)
      const bx = ball.p[0], by = ball.p[1], dc = Math.hypot(me.x - bx, me.y - by);
      const r = B.world.ballRadius, surf = dc - r;
      const ux = dc > 1e-6 ? (me.x - bx) / dc : 0, uy = dc > 1e-6 ? (me.y - by) / dc : 0;
      if (!best || surf < best.d) best = { x: bx + ux * r, y: by + uy * r, d: surf, onBall: true };
    }
    if (best && best.d <= B.grappleRange) { best.fromx = me.x; best.fromy = me.y; B.grapple = best; }
    else B.grapple = null;
  }

  // ── Auto-calibration caméra ──────────────────────────────────────────────────
  // Parcourt l'arbre (hors notre pixiCtx) et retourne les nœuds qui ont bougé
  // depuis la frame précédente, exprimés dans l'espace local de pixiCtx.
  // Retourne { moved:[…nœuds qui ont bougé, avec leur delta…], all:[…tous les nœuds…] }.
  function collectDynamic(root) {
    const moved = [], all = [];
    const inv = pixiCtx.worldTransform;
    const stack = [root];
    const g = _p(), lp = _p();
    while (stack.length) {
      const n = stack.pop();
      if (!n || n === pixiCtx || n === gfx) continue;   // ne pas descendre dans notre overlay
      const wt = n.worldTransform;
      if (wt) {
        g.set(wt.tx, wt.ty);                 // origine globale du nœud
        inv.applyInverse(g, lp);             // → espace local pixiCtx
        const x = lp.x, y = lp.y;
        all.push({ x, y, n });
        const prev = prevNodePos.get(n);
        prevNodePos.set(n, { x, y });
        if (prev) { const dvx = x - prev.x, dvy = y - prev.y, mv = Math.hypot(dvx, dvy); if (mv > CFG.CALIB_MIN_MOVE) moved.push({ n, x, y, m: mv, dvx, dvy }); }
      }
      const kids = n.children;
      if (kids) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    return { moved, all };
  }

  // Cale s (échelle uniforme, sans rotation) + T tels que  écran = s·monde×ppm + T.
  // Entités connues = disques + balle (positions monde). On essaie d'apparier une
  // PAIRE de connus à une paire de nœuds dynamiques (écran), puis on valide que
  // TOUTES les autres entités connues retrouvent un nœud à l'endroit prédit.
  // Marche en solo (1 disque + balle) comme en 1v1 (2 disques + balle).
  function calibrate(dyn) {
    const K = B.ppm;
    if (dyn.length < 2 || !ballWorld) return null;
    if (dyn.length > CFG.CALIB_MAX_NODES) dyn = dyn.slice().sort((a, b) => b.m - a.m).slice(0, CFG.CALIB_MAX_NODES);
    const known = discsWorldNow.map((d) => ({ x: d.x * K, y: d.y * K }));
    known.push({ x: ballWorld.x * K, y: ballWorld.y * K });
    const ballIdx = known.length - 1;
    if (known.length < 2) return null;        // besoin d'au moins 2 points (ex. 1 disque + balle)
    let best = null;
    for (let i = 0; i < known.length; i++) for (let j = 0; j < known.length; j++) {
      if (i === j) continue;
      const dW = { x: known[i].x - known[j].x, y: known[i].y - known[j].y };
      const dW2 = dW.x * dW.x + dW.y * dW.y;
      if (dW2 < CFG.CALIB_MIN_SEP * CFG.CALIB_MIN_SEP) continue;  // entités trop proches → mauvais levier (ex. grappin)
      const inv = 1 / Math.sqrt(dW2);
      for (let a = 0; a < dyn.length; a++) for (let b = 0; b < dyn.length; b++) {
        if (a === b) continue;
        const dC = { x: dyn[a].x - dyn[b].x, y: dyn[a].y - dyn[b].y };
        const s = (dC.x * dW.x + dC.y * dW.y) / dW2;        // meilleure échelle (proj.)
        if (s < 0.3 || s > 3) continue;
        const perp = Math.abs(dC.x * -dW.y + dC.y * dW.x) * inv;
        if (perp > CFG.CALIB_PERP_TOL) continue;            // pas parallèle → mauvaise paire
        const tx = dyn[a].x - s * known[i].x, ty = dyn[a].y - s * known[i].y;
        // chaque entité connue doit retrouver un nœud dynamique à l'endroit prédit
        let score = perp, ok = true, ballNode = null;
        for (let m = 0; m < known.length; m++) {
          const ex = s * known[m].x + tx, ey = s * known[m].y + ty;
          let nn = Infinity, nNode = null;
          for (let c = 0; c < dyn.length; c++) {
            const dd = Math.hypot(dyn[c].x - ex, dyn[c].y - ey);
            if (dd < nn) { nn = dd; nNode = dyn[c]; }
          }
          if (nn > CFG.CALIB_MATCH_TOL) { ok = false; break; }
          score += nn;
          if (m === ballIdx) ballNode = nNode.n;       // réf du nœud Pixi de la balle (suivi O(1))
        }
        if (ok && (!best || score < best.score)) best = { s, tx, ty, score, ballNode };
      }
    }
    return best;
  }

  // Amorçage quand la balle est AU REPOS (solo) : le disque, lui, bouge toujours.
  // Son déplacement monde ↔ déplacement écran d'un nœud donne l'échelle ; sa position
  // donne la translation ; on valide en vérifiant qu'un nœud existe là où la balle (au
  // repos) devrait être projetée (rejette le nœud du pseudo, décalé sous le disque).
  function calibrateFromMotion(moved, all) {
    const K = B.ppm;
    if (!B.myDiscW || !B.prevMyDiscW || !ballWorld) return null;
    const dwx = (B.myDiscW.x - B.prevMyDiscW.x) * K, dwy = (B.myDiscW.y - B.prevMyDiscW.y) * K;
    const dw2 = dwx * dwx + dwy * dwy;
    if (dw2 < CFG.CALIB_MOTION_MIN * CFG.CALIB_MOTION_MIN) return null;  // disque pas assez bougé
    const invd = 1 / Math.sqrt(dw2);
    const dxw = B.myDiscW.x * K, dyw = B.myDiscW.y * K, bxw = ballWorld.x * K, byw = ballWorld.y * K;
    const sepx = dxw - bxw, sepy = dyw - byw, sep2 = sepx * sepx + sepy * sepy;
    if (sep2 < CFG.CALIB_MIN_SEP * CFG.CALIB_MIN_SEP) return null;  // disque trop près de la balle → mal conditionné
    const invsep = 1 / Math.sqrt(sep2);
    let best = null;
    for (const d of moved) {
      // 1) la MOTION sert juste à repérer le nœud du disque (direction + échelle grossière)
      const rs = (d.dvx * dwx + d.dvy * dwy) / dw2;
      if (rs < 0.3 || rs > 3) continue;
      if (Math.abs(d.dvx * -dwy + d.dvy * dwx) * invd > CFG.CALIB_PERP_TOL) continue;  // pas la motion du disque
      // 2) cherche le nœud de la balle via une projection grossière
      const tx0 = d.x - rs * dxw, ty0 = d.y - rs * dyw, bx = rs * bxw + tx0, by = rs * byw + ty0;
      let nn = Infinity, bn = null;
      for (const a of all) { const dd = Math.hypot(a.x - bx, a.y - by); if (dd < nn) { nn = dd; bn = a; } }
      if (nn > CFG.CALIB_MATCH_TOL) continue;            // pas de nœud à l'emplacement balle → rejet
      // 3) ÉCHELLE PRÉCISE depuis l'écart INSTANTANÉ nœud-disque ↔ nœud-balle (robuste au zoom)
      const dcx = d.x - bn.x, dcy = d.y - bn.y;
      const s = (dcx * sepx + dcy * sepy) / sep2;
      if (s < 0.3 || s > 3) continue;
      if (Math.abs(dcx * -sepy + dcy * sepx) * invsep > CFG.CALIB_PERP_TOL) continue;
      const score = nn + Math.abs(dcx * -sepy + dcy * sepx) * invsep;
      if (!best || score < best.score) best = { s, tx: d.x - s * dxw, ty: d.y - s * dyw, score, ballNode: bn.n };
    }
    return best;
  }

  function updateCalibration(root) {
    const { moved, all } = collectDynamic(root);
    // transform : calage standard (entités mobiles dont la balle) ; sinon amorçage via la
    // motion du disque (balle au repos). La caméra étant fixe, une fois calé c'est stable.
    const c = calibrate(moved) || calibrateFromMotion(moved, all);
    B.calDbg = { nDyn: moved.length, nAll: all.length, fit: c };
    if (c) {
      if (!B.cal) B.cal = { s: c.s, tx: c.tx, ty: c.ty };
      else {
        const k = CFG.CALIB_EMA;
        B.cal.s += (c.s - B.cal.s) * k;
        B.cal.tx += (c.tx - B.cal.tx) * k;
        B.cal.ty += (c.ty - B.cal.ty) * k;
      }
      if (c.ballNode) B.ballNodeRef = c.ballNode;       // mémorise le nœud Pixi de la balle
      // caméra fixe : accumule les BONS calages → fige sur la médiane (stable + plus de CPU)
      if (c.score < CFG.CALIB_LOCK_SCORE) {
        B.calSamples.push({ s: c.s, tx: c.tx, ty: c.ty });
        if (B.calSamples.length >= CFG.CALIB_LOCK_N) {
          const med = (key) => { const a = B.calSamples.map((o) => o[key]).sort((x, y) => x - y); return a[a.length >> 1]; };
          B.cal = { s: med("s"), tx: med("tx"), ty: med("ty") };
          B.calLocked = true;
          log("calage verrouillé (caméra fixe) : s =", B.cal.s.toFixed(4));
        }
      }
    }
    B.prevMyDiscW = B.myDiscW ? { x: B.myDiscW.x, y: B.myDiscW.y } : null;  // pour la motion au prochain calage
  }

  // ancre balle : lecture O(1) du nœud Pixi mémorisé (à chaque frame, sans parcourir l'arbre)
  function readBallNode() {
    const n = B.ballNodeRef;
    if (!n || n._destroyed || !n.worldTransform || !pixiCtx || !pixiCtx.worldTransform) { B.ballNode = null; return; }
    const g = _p().set(n.worldTransform.tx, n.worldTransform.ty), lp = _p();
    pixiCtx.worldTransform.applyInverse(g, lp);
    // valide : le nœud doit être là où la balle DEVRAIT être (sinon réf périmée = balle du
    // round précédent) → on le jette, l'ancre retombe sur la projection monde courante.
    if (B.cal && ballWorld) {
      const ex = B.cal.s * ballWorld.x * B.ppm + B.cal.tx, ey = B.cal.s * ballWorld.y * B.ppm + B.cal.ty;
      if (Math.hypot(lp.x - ex, lp.y - ey) > CFG.CALIB_SNAP_TOL) { B.ballNode = null; return; }  // réf périmée/transitoire → repli sur ws
    }
    B.ballNode = { x: lp.x, y: lp.y };
  }

  // monde (mètres) → espace local pixiCtx
  const ws = (wx, wy) => ({ x: B.cal.s * wx * B.ppm + B.cal.tx, y: B.cal.s * wy * B.ppm + B.cal.ty });

  // ── Rendu ────────────────────────────────────────────────────────────────────
  function ensureGfx(container) {
    if (!PIXI) PIXI = window.PIXI;
    if (!gfx || gfx._destroyed) gfx = new PIXI.Graphics();
    if (container && !container.children.includes(gfx)) container.addChild(gfx);
  }

  // flèche de bord vers la balle quand elle est hors écran
  function drawOffscreen(container, width, height, lx, ly) {
    let wt; try { wt = container.worldTransform; } catch { return; }
    if (!wt) return;
    const sp = _p(); wt.apply(_p().set(lx, ly), sp);
    if (sp.x >= 0 && sp.x <= width && sp.y >= 0 && sp.y <= height) return; // visible
    const m = CFG.OFFSCREEN_MARGIN, cx = width / 2, cy = height / 2;
    const dx = sp.x - cx, dy = sp.y - cy;
    const tx = dx > 0 ? (width - m - cx) / dx : (m - cx) / dx;
    const ty = dy > 0 ? (height - m - cy) / dy : (m - cy) / dy;
    const t = Math.min(Math.abs(dx) < 1e-3 ? Infinity : tx, Math.abs(dy) < 1e-3 ? Infinity : ty);
    const ex = cx + dx * t, ey = cy + dy * t;
    const w = _p(); wt.applyInverse(_p().set(ex, ey), w);
    const scale = Math.hypot(wt.a, wt.b) || 1, r = 16 / scale, ang = Math.atan2(dy, dx);
    const px = (an) => [w.x + Math.cos(an) * r, w.y + Math.sin(an) * r];
    const p1 = px(ang), p2 = px(ang + 2.5), p3 = px(ang - 2.5);
    gfx.lineStyle(0); gfx.beginFill(0xff3030, 0.95);
    gfx.moveTo(p1[0], p1[1]); gfx.lineTo(p2[0], p2[1]); gfx.lineTo(p3[0], p3[1]); gfx.closePath(); gfx.endFill();
  }

  function draw(container, width, height) {
    pixiCtx = container;
    ensureGfx(container);
    if (!gfx) return;
    gfx.clear();
    if (!B.enabled) return;

    // recalage caméra ESPACÉ (perf) : 1 frame sur CALIB_EVERY (la caméra est fixe).
    // L'ancre balle, elle, est lue à CHAQUE frame en O(1) (nœud Pixi mémorisé).
    let root = container; while (root && root.parent) root = root.parent;
    if (root && !B.calLocked) { frameCount++; if (!B.cal || frameCount % CFG.CALIB_EVERY === 0) updateCalibration(root); }
    readBallNode();
    if (!B.cal) return;                       // pas encore calé → on ne dessine rien de faux

    // ancre balle = nœud rendu réel (collé chaque frame), repli sur la projection monde
    const anchor = B.ballNode || (ballWorld ? ws(ballWorld.x, ballWorld.y) : null);

    if (B.markers) {
      for (const d of discsWorldNow) { const p = ws(d.x, d.y); gfx.lineStyle(2, 0x33ff66, 1); gfx.drawCircle(p.x, p.y, 7); }
      if (anchor) { gfx.lineStyle(2, 0x33aaff, 1); gfx.drawCircle(anchor.x, anchor.y, 7); }
    }

    if (B.pathDelta && B.pathDelta.length && anchor) {
      // trajectoire ancrée sur la balle rendue, deltas monde × (s·ppm), forme interpolée
      // entre 2 pas physiques (lissage 60 Hz). prev utilisable seulement si même longueur.
      const sk = B.cal.s * B.ppm;
      const frac = Math.min(Math.max((performance.now() - B.stepTime) / (1000 / PHYS.FPS), 0), 1);
      const prev = B.pathPrev && B.pathPrev.length === B.pathDelta.length ? B.pathPrev : null;
      gfx.lineStyle(3, 0xff4444, 0.9);
      gfx.moveTo(anchor.x, anchor.y);
      let lx = anchor.x, ly = anchor.y;
      for (let i = 0; i < B.pathDelta.length; i++) {
        const d = B.pathDelta[i];
        let ddx = d[0], ddy = d[1];
        if (prev) { const p = prev[i]; ddx = p[0] + (d[0] - p[0]) * frac; ddy = p[1] + (d[1] - p[1]) * frac; }
        lx = anchor.x + ddx * sk; ly = anchor.y + ddy * sk;
        gfx.lineTo(lx, ly);
      }
      gfx.lineStyle(0);
      if (B.pathStop) {            // entrée canon : la suite n'est pas prédictible → marqueur orange
        gfx.beginFill(0xffaa22, 0.95); gfx.drawCircle(lx, ly, 6); gfx.endFill();
        gfx.lineStyle(2, 0xffaa22, 0.8); gfx.drawCircle(lx, ly, 10);
      } else {                     // fin d'horizon normale
        gfx.beginFill(0xff4444, 0.9); gfx.drawCircle(lx, ly, 4); gfx.endFill();
      }
    }

    // point d'accroche du grappin : rouge (mur/sol) → vert (balle), + fil disque→point
    if (B.grapple) {
      const sk = B.cal.s * B.ppm;
      const col = B.grapple.onBall ? 0x33ff66 : 0xff4040;
      let t;
      if (B.grapple.onBall && ballWorld) {           // collé à la balle rendue (précis)
        const ab = anchor || ws(ballWorld.x, ballWorld.y);
        t = { x: ab.x + (B.grapple.x - ballWorld.x) * sk, y: ab.y + (B.grapple.y - ballWorld.y) * sk };
      } else t = ws(B.grapple.x, B.grapple.y);
      const f = ws(B.grapple.fromx, B.grapple.fromy);
      gfx.lineStyle(1.5, col, 0.35); gfx.moveTo(f.x, f.y); gfx.lineTo(t.x, t.y);
      gfx.lineStyle(2.5, col, 1); gfx.drawCircle(t.x, t.y, 7);
      gfx.lineStyle(0); gfx.beginFill(col, 0.3); gfx.drawCircle(t.x, t.y, 7); gfx.endFill();
    }

    if (anchor && width && height) drawOffscreen(container, width, height, anchor.x, anchor.y);
  }

  // ── Diagnostic calibration ───────────────────────────────────────────────────
  function dumpCalib() {
    const d = B.calDbg;
    console.log("%c==== EasyBonk CALIB ====", "color:#e94;font-weight:bold");
    console.log("ppm =", B.ppm, "| calage retenu =", B.cal);
    if (!d) { console.warn("pas de diagnostic (pas encore de frame ?)"); return; }
    console.log("nœuds dynamiques détectés :", d.nDyn, "| meilleur fit :", d.fit);
    console.log("disques (monde) :", discsWorldNow, "| balle (monde) :", ballWorld);
    console.log("%c→ avec un screenshot, je vérifie que repères verts/bleu collent aux disques/balle.", "color:#e94");
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────────
  function waitForBonkAPI(cb) {
    if (window.bonkAPI && window.bonkAPI.addEventListener) return cb(window.bonkAPI);
    let n = 0; const id = setInterval(() => {
      if (window.bonkAPI && window.bonkAPI.addEventListener) { clearInterval(id); cb(window.bonkAPI); }
      else if (++n > 600) { clearInterval(id); console.error("[EasyBonk] bonkAPI introuvable — BonkLIB installé/activé ?"); }
    }, 100);
  }

  waitForBonkAPI((api) => {
    const grabPpm = (e) => { const p = e && e.mapData && e.mapData.physics && e.mapData.physics.ppm; if (p) B.ppm = p; };
    const buildWorld = (e) => {
      try { if (e && e.mapData && e.mapData.physics) { B.world = extractWorld(e.mapData); log("monde :", B.world.colliders.length, "obstacles, rayon balle", B.world.ballRadius.toFixed(2)); } }
      catch (err) { console.error("[EasyBonk] extractWorld:", err); B.world = null; }
    };
    const resetCal = () => { B.cal = null; B.calLocked = false; B.calSamples = []; B.ballNodeRef = null; B.grapple = null; };
    api.addEventListener("gameStart", (e) => { grabPpm(e); buildWorld(e); resetCal(); log("partie démarrée, ppm =", B.ppm); });
    api.addEventListener("mapSwitch", (e) => { grabPpm(e); buildWorld(e); resetCal(); });
    api.addEventListener("stepEvent", (e) => onStep(api, e));
    api.addEventListener("graphicsUpdate", (g) => draw(g.container, g.width, g.height));

    window.addEventListener("keydown", (ev) => {
      const k = (ev.key || "").toLowerCase();
      if (ev.code === CFG.TOGGLE_KEY || ev.key === "²") { ev.preventDefault(); B.enabled = !B.enabled; log("overlay", B.enabled ? "ON" : "OFF"); }
      else if (k === "m") { B.markers = !B.markers; log("repères", B.markers ? "ON" : "OFF"); }
      else if (k === "g") { B.grappleOn = !B.grappleOn; log("point grappin", B.grappleOn ? "ON" : "OFF"); }
      else if (k === "p") { dumpCalib(); }
    }, true);

    log(`v${B.version} prête. ²=on/off · M=repères · G=point grappin · P=diagnostic. Régler portée : __EASYBONK__.grappleRange`);
  });
})();
