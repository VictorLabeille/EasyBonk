// Prédicteur de trajectoire de la Death Ball — module pur (testable hors-ligne).
// Unités : positions en mètres, vitesses en m/s. Intégration au pas physique (1/30 s).
//
// v1 = BALISTIQUE (gravité + plafond de vitesse). Les collisions statiques (rebonds
// sur la géométrie) seront ajoutées ensuite via `world`. Validé contre les captures
// réelles dans test/validate-predict.js.
//
// Constantes dérivées des captures recon-1/recon-2 :
//   G ≈ 10 u/s² (vers le bas, y+) · MAX_SPEED = 60 u/s · FPS = 30.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.EasyBonkPredict = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CONST = { G: 10, MAX_SPEED: 60, FPS: 30 };

  function clampSpeed(vx, vy, max) {
    const s = Math.hypot(vx, vy);
    if (s > max && s > 0) { const k = max / s; return [vx * k, vy * k]; }
    return [vx, vy];
  }

  // Intègre la balle `frames` pas en avant. Retourne la liste des positions [x,y]
  // (une par pas), en partant juste APRÈS l'état fourni.
  // p0,v0 : [x,y] / [vx,vy]. opts.g, opts.maxSpeed, opts.fps surchargeables.
  function predictBallistic(p0, v0, frames, opts) {
    opts = opts || {};
    const g = opts.g != null ? opts.g : CONST.G;
    const maxSpeed = opts.maxSpeed != null ? opts.maxSpeed : CONST.MAX_SPEED;
    const dt = 1 / (opts.fps || CONST.FPS);

    let x = p0[0], y = p0[1], vx = v0[0], vy = v0[1];
    const out = [];
    for (let i = 0; i < frames; i++) {
      // a = gravité ; v += a*dt ; clamp ; p += v*dt  (ordre type Box2D)
      vy += g * dt;
      [vx, vy] = clampSpeed(vx, vy, maxSpeed);
      x += vx * dt;
      y += vy * dt;
      out.push([x, y]);
    }
    return out;
  }

  return { CONST, clampSpeed, predictBallistic };
});
