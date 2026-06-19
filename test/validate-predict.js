// Valide le prédicteur balistique contre les VRAIS arcs en vol libre des captures.
// On ne teste que les fenêtres où la balle est réellement en chute libre (vx≈const,
// vy croît de ~g·dt) — sinon (roulement au sol, canaux, canons) le balistique n'a
// pas à coller. Sur ces arcs, l'erreur doit rester très faible.
//
//   node test/validate-predict.js reference/recon-2.json

const fs = require("fs");
const { predictBallistic, CONST } = require("../src/predict.js");

const file = process.argv[2] || "reference/recon-2.json";
const d = JSON.parse(fs.readFileSync(file, "utf8"));
const S = d.samples || [];
const ballAt = (s) => {
  if (s.ball) return { p: s.ball.p, lv: s.ball.lv };
  const bs = s.gameState && s.gameState.physics.bodies;
  if (bs) for (const b of bs) if (b && b.s && b.s.n === "DeathBall") return { p: b.p, lv: b.lv };
  return null;
};

// pas d'échantillonnage dominant (frames entre 2 samples)
const deltas = {};
for (let i = 1; i < S.length; i++) { const dd = S[i].frame - S[i - 1].frame; if (dd > 0) deltas[dd] = (deltas[dd] || 0) + 1; }
const SP = +Object.keys(deltas).sort((a, b) => deltas[b] - deltas[a])[0]; // spacing
const dtS = SP / 30;
const HORIZON = 9;

// une fenêtre [i, i+HORIZON] est "vol libre" si, sur chaque pas, vx≈const et Δvy≈g·dtS
function isFreeFall(i) {
  for (let k = 0; k < HORIZON; k++) {
    const a = ballAt(S[i + k]), b = ballAt(S[i + k + 1]);
    if (!a || !b) return false;
    if (S[i + k + 1].frame - S[i + k].frame !== SP) return false;
    if (Math.abs(b.lv[0] - a.lv[0]) > 0.6) return false;            // vx ~ constant
    if (Math.abs((b.lv[1] - a.lv[1]) - CONST.G * dtS) > 0.8) return false; // vy croît de g·dt
  }
  return true;
}

const errAtStep = Array.from({ length: HORIZON }, () => []);
let nWin = 0, best = null;
for (let i = 0; i + HORIZON < S.length; i++) {
  if (!isFreeFall(i)) continue;
  nWin++;
  const b0 = ballAt(S[i]);
  const pred = predictBallistic(b0.p, b0.lv, HORIZON * SP);
  const errs = [];
  for (let k = 1; k <= HORIZON; k++) {
    const real = ballAt(S[i + k]).p;
    const pp = pred[k * SP - 1];
    const e = Math.hypot(pp[0] - real[0], pp[1] - real[1]);
    errAtStep[k - 1].push(e); errs.push(e);
  }
  if (!best || errs[HORIZON - 1] < best.errs[HORIZON - 1]) best = { i, errs, b0, pred };
}

const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log(`Fichier: ${file} | spacing=${SP} frames (dt=${dtS.toFixed(3)}s) | G=${CONST.G}`);
console.log(`Fenêtres en vol libre détectées : ${nWin}`);
if (nWin) {
  console.log("\nErreur médiane (m) sur arcs libres, par horizon :");
  for (let k = 0; k < HORIZON; k++)
    console.log(`  t=${((k + 1) * dtS).toFixed(2)}s : ${median(errAtStep[k]).toFixed(3)}  (n=${errAtStep[k].length})`);
  console.log(`\nMeilleur arc (i=${best.i}) — réel vs prédit :`);
  for (let k = 1; k <= HORIZON; k++) {
    const real = ballAt(S[best.i + k]).p, pp = best.pred[k * SP - 1];
    console.log(`  +${(k * dtS).toFixed(2)}s  réel=(${real[0].toFixed(1)},${real[1].toFixed(1)})  prédit=(${pp[0].toFixed(1)},${pp[1].toFixed(1)})  err=${best.errs[k - 1].toFixed(2)}`);
  }
}
