// Simulateur de trajectoire AVEC rebonds — extension du prédicteur balistique.
// But : tester hors-ligne jusqu'où une simulation « maison » suit la vraie balle,
// notamment dans le cycle « canon ». Module pur (Node + navigateur).
//
// Physique répliquée (approximation de Box2D) :
//   • gravité 10, plafond de vitesse 60 ;
//   • collision balle (cercle r≈1.04) ↔ murs (boîtes éventuellement tournées) en
//     CONTINU (balayage / swept) — les murs sont fins, sinon la balle les traverse ;
//   • restitution = max(reBalle, reMur) (convention Box2D) ; -1 = défaut (0.8) ;
//   • surfaces « canon » re=99999 → la balle repart au plafond de vitesse.
// NON répliqué (cause de divergence attendue) : contacts au repos, friction de
// glissement, sous-pas exacts du solveur, poches où la balle se cale.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.EasyBonkSimulate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // DEF_RE = restitution des surfaces « re=-1 » (= défaut bonk). Combine Box2D = max(reA,reB).
  // La balle (re=-1→0) + mur normal (re=-1→0) ⇒ 0 : la balle ne rebondit pas, elle s'arrête/glisse.
  // Seules les surfaces à re explicite rebondissent : cages 0.8, plateformes 3, canons 99999.
  const DFLT = { G: 10, MAX_SPEED: 60, FPS: 30, DEF_RE: 0, BALL_NAME: "DeathBall" };

  // ── Extraction de la géométrie statique depuis map.physics ───────────────────
  function extractWorld(map, opts) {
    opts = opts || {};
    const defRe = opts.defRe != null ? opts.defRe : DFLT.DEF_RE;
    const ph = map.physics;
    const shapes = ph.shapes, fixtures = ph.fixtures, bodies = ph.bodies;
    const rot = (x, y, a) => (a ? [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)] : [x, y]);
    const resolveRe = (v) => (v == null || v === -1 ? defRe : v);

    // Calques de collision bonk : 2 corps se touchent s'ils partagent ≥1 calque (f_1..f_4).
    // La balle traverse tout corps avec qui elle ne partage aucun calque (ex. « Barriers »
    // = diviseur central + barres latérales : bloquent les joueurs, pas la balle).
    const layers = (s) => [s.f_1, s.f_2, s.f_3, s.f_4];
    const ballBody = bodies.find((b) => b.s && b.s.n === DFLT.BALL_NAME);
    const ballLayers = ballBody ? layers(ballBody.s) : [true, true, true, true];
    const collidesWithBall = (s) => layers(s).some((v, i) => v && ballLayers[i]);

    let ballRadius = null, ballRe = defRe;
    const colliders = [];          // collision BALLE (calque commun → exclut « Barriers »)
    const grappleColliders = [];   // surfaces GRAPPABLES (np=false, ng=false → inclut « Barriers »)
    for (const b of bodies) {
      const isBall = b.s && b.s.n === DFLT.BALL_NAME;
      const bodyRe = resolveRe(b.s && b.s.re);
      const ba = b.a || 0, bp = b.p || [0, 0];
      if (isBall) {                                   // la balle : on retient juste son rayon/re
        for (const fi of (b.fx || [])) { const f = fixtures[fi]; const s = f && shapes[f.sh]; if (s && s.type === "ci") { ballRadius = s.r; ballRe = bodyRe; } }
        continue;                                     // le corps balle n'est pas un obstacle
      }
      const bHitsBall = collidesWithBall(b.s);
      for (const fi of (b.fx || [])) {
        const f = fixtures[fi]; if (!f) continue;
        const s = shapes[f.sh]; if (!s) continue;
        if (f.np === true) continue;                  // « no physics » → décoratif (ni collision ni grappin)
        const re = f.re != null ? f.re : bodyRe;      // restitution effective de la surface
        const [wcx, wcy] = rot(s.c[0], s.c[1], ba);
        const cx = bp[0] + wcx, cy = bp[1] + wcy, ang = ba + (s.a || 0);
        const box = s.type === "bx" ? { type: "bx", cx, cy, hw: s.w / 2, hh: s.h / 2, ang, re, deadly: !!f.d }
          : s.type === "ci" ? { type: "ci", cx, cy, r: s.r, re, deadly: !!f.d } : null;
        if (!box) continue;
        if (bHitsBall) colliders.push(box);           // la balle y rebondit
        if (f.ng !== true) grappleColliders.push(box); // le grappin peut s'y accrocher
      }
    }
    return { colliders, grappleColliders, ballRadius: ballRadius || 1.0416666, ballRe };
  }

  // ── Collision continue : cercle (p, rayon r, déplacement d) vs boîte tournée ──
  // Minkowski = rectangle aux COINS ARRONDIS (rayon r). On teste les faces (slab) ET
  // les coins (cercle), sinon un frôlement de coin déclenche un faux rebond (ex. lèvre
  // du haut de cage). Retourne {t∈[0,1], nx, ny (normale monde)} ou null.
  function sweptCircleBox(px, py, dx, dy, r, box) {
    const ca = Math.cos(box.ang), sa = Math.sin(box.ang);
    const rx = px - box.cx, ry = py - box.cy;
    const lx = rx * ca + ry * sa, ly = -rx * sa + ry * ca;     // position locale
    const vx = dx * ca + dy * sa, vy = -dx * sa + dy * ca;     // déplacement local
    const hw = box.hw, hh = box.hh, ex = hw + r, ey = hh + r;
    const toWorld = (nx, ny) => ({ nx: nx * ca - ny * sa, ny: nx * sa + ny * ca });

    // déjà en chevauchement réel (face, ou coin dans le rayon) → contact immédiat
    if (Math.abs(lx) <= ex && Math.abs(ly) <= ey) {
      const ox = Math.abs(lx) - hw, oy = Math.abs(ly) - hh;
      if (!(ox > 0 && oy > 0 && ox * ox + oy * oy > r * r)) {  // sinon : coin hors rayon → laisse passer
        if (ox > 0 && oy > 0) {                                // chevauchement de coin
          const nx = lx - (lx < 0 ? -hw : hw), ny = ly - (ly < 0 ? -hh : hh), d = Math.hypot(nx, ny) || 1;
          return { t: 0, ...toWorld(nx / d, ny / d) };
        }
        const penX = ex - Math.abs(lx), penY = ey - Math.abs(ly);
        return { t: 0, ...(penX < penY ? toWorld(lx < 0 ? -1 : 1, 0) : toWorld(0, ly < 0 ? -1 : 1)) };
      }
    }
    // entrée dans l'AABB dilatée (slab) → temps d'entrée + axe
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
    const cxl = lx + vx * tEnter, cyl = ly + vy * tEnter;       // point de contact (local)
    const otherWithin = axis === 0 ? Math.abs(cyl) <= hh : Math.abs(cxl) <= hw;
    if (otherWithin) return { t: tEnter, ...toWorld(axis === 0 ? sign : 0, axis === 1 ? sign : 0) }; // face
    // sinon : zone de coin → vrai test cercle vs coin (sinon faux positif)
    const cnx = cxl < 0 ? -hw : hw, cny = cyl < 0 ? -hh : hh;   // coin le plus proche
    const ox = lx - cnx, oy = ly - cny;
    const A = vx * vx + vy * vy, Bq = 2 * (ox * vx + oy * vy), Cq = ox * ox + oy * oy - r * r;
    const disc = Bq * Bq - 4 * A * Cq;
    if (disc < 0 || A < 1e-12) return null;                     // rate le coin → pas de collision
    const tc = (-Bq - Math.sqrt(disc)) / (2 * A);
    if (tc <= 0 || tc >= 1) return null;
    let nx = ox + vx * tc, ny = oy + vy * tc; const dn = Math.hypot(nx, ny) || 1;
    return { t: tc, ...toWorld(nx / dn, ny / dn) };
  }

  function clampSpeed(vx, vy, max) {
    const s = Math.hypot(vx, vy);
    if (s > max && s > 0) { const k = max / s; return [vx * k, vy * k]; }
    return [vx, vy];
  }

  // ── Simulation pas-à-pas avec rebonds ────────────────────────────────────────
  // Retourne { path:[[x,y]...], bounces:[{frame,x,y,re}], enteredCannon:frame|null }.
  function simulate(p0, v0, world, frames, opts) {
    opts = opts || {};
    const g = opts.g != null ? opts.g : DFLT.G;
    const maxSpeed = opts.maxSpeed != null ? opts.maxSpeed : DFLT.MAX_SPEED;
    const dt = 1 / (opts.fps || DFLT.FPS);
    const r = opts.radius != null ? opts.radius : world.ballRadius;
    const ballRe = world.ballRe != null ? world.ballRe : DFLT.DEF_RE;
    const cols = world.colliders;

    let x = p0[0], y = p0[1], vx = v0[0], vy = v0[1];
    const path = [], bounces = [];
    let enteredCannon = null;

    for (let f = 0; f < frames; f++) {
      vy += g * dt;
      [vx, vy] = clampSpeed(vx, vy, maxSpeed);
      let remain = 1, guard = 0;
      while (remain > 1e-4 && guard++ < 8) {
        const dx = vx * dt * remain, dy = vy * dt * remain;
        // trouve la 1re collision sur ce sous-déplacement
        let hit = null;
        for (const c of cols) {
          if (c.type !== "bx") continue;               // (cercles statiques rares ici)
          const s = sweptCircleBox(x, y, dx, dy, r, c);
          if (s && (!hit || s.t < hit.t)) hit = { ...s, c };
        }
        if (!hit) { x += dx; y += dy; break; }
        // avance jusqu'au contact
        x += dx * hit.t; y += dy * hit.t;
        const e = Math.max(ballRe, hit.c.re);          // restitution combinée (Box2D = max)
        // réflexion de la composante normale
        const vn = vx * hit.nx + vy * hit.ny;
        if (vn < 0) { vx -= (1 + e) * vn * hit.nx; vy -= (1 + e) * vn * hit.ny; }
        [vx, vy] = clampSpeed(vx, vy, maxSpeed);
        bounces.push({ frame: f, x, y, re: hit.c.re });
        if (hit.c.re >= 100 && enteredCannon == null) enteredCannon = f;   // surface canon
        remain *= (1 - hit.t);
        // léger décollement pour éviter de re-coller la même surface
        x += hit.nx * 1e-3; y += hit.ny * 1e-3;
      }
      path.push([x, y]);
    }
    return { path, bounces, enteredCannon };
  }

  return { DFLT, extractWorld, sweptCircleBox, simulate };
});
