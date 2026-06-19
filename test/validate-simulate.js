// Mesure jusqu'où le simulateur (avec rebonds) suit la VRAIE balle de la capture.
// On part d'un échantillon (p, lv connus), on simule en avant, et on compare la
// position prédite à la position réelle à chaque échantillon suivant.
//
//   node test/validate-simulate.js [reference/recon-2.json]

const fs = require("fs");
const { extractWorld, simulate } = require("../src/simulate.js");

const file = process.argv[2] || "reference/recon-2.json";
const d = JSON.parse(fs.readFileSync(file, "utf8"));
const world = extractWorld(d.map);
console.log(`Géométrie : ${world.colliders.length} obstacles | rayon balle = ${world.ballRadius.toFixed(3)} | re défaut balle = ${world.ballRe}`);
const cannons = world.colliders.filter((c) => c.re >= 100);
console.log(`Surfaces « canon » (re≥100) : ${cannons.length}`);

const ballAt = (s) => (s.ball && s.ball.p ? { p: s.ball.p, lv: s.ball.lv, frame: s.frame } : null);
const S = (d.samples || []).map(ballAt).filter((b) => b && b.lv);
// pas d'échantillonnage (frames entre 2 samples)
const spacing = (() => { const t = {}; for (let i = 1; i < S.length; i++) { const dd = S[i].frame - S[i - 1].frame; if (dd > 0) t[dd] = (t[dd] || 0) + 1; } return +Object.keys(t).sort((a, b) => t[b] - t[a])[0]; })();
console.log(`Échantillons avec balle : ${S.length} | spacing ≈ ${spacing} frames\n`);

// Choisit des points de départ où la balle bouge vraiment (vol), pour tester la prédiction.
const MIN_SPEED = 8, HORIZON_SAMPLES = 12;
function runFrom(i) {
  const start = S[i];
  const horizon = Math.min(HORIZON_SAMPLES, S.length - 1 - i);
  if (horizon < 2) return null;
  const frames = horizon * spacing;
  const sim = simulate(start.p, start.lv, world, frames, {});
  const rows = [];
  let firstBigErr = null;
  for (let k = 1; k <= horizon; k++) {
    const real = S[i + k]; if (real.frame - S[i + k - 1].frame !== spacing) break;
    const pp = sim.path[k * spacing - 1];
    const err = Math.hypot(pp[0] - real.p[0], pp[1] - real.p[1]);
    rows.push({ dt: k * spacing / 30, real: real.p, pred: pp, err });
    if (firstBigErr == null && err > 3) firstBigErr = k * spacing / 30;
  }
  return { start, rows, sim, firstBigErr };
}

// Repère les départs « en vol » et montre le plus parlant (celui qui traverse le canon).
const starts = [];
for (let i = 0; i + 2 < S.length; i++) if (Math.hypot(S[i].lv[0], S[i].lv[1]) > MIN_SPEED) starts.push(i);
console.log(`Départs « en vol » (v>${MIN_SPEED}) : ${starts.length}\n`);

let shown = 0;
for (const i of starts) {
  const R = runFrom(i); if (!R || !R.rows.length) continue;
  // n'affiche que quelques cas représentatifs
  if (shown >= 4) break;
  shown++;
  console.log(`━━ départ frame ${R.start.frame}  p=(${R.start.p[0].toFixed(1)},${R.start.p[1].toFixed(1)}) v=(${R.start.lv[0].toFixed(1)},${R.start.lv[1].toFixed(1)})`);
  console.log(`   canon rencontré au pas : ${R.sim.enteredCannon != null ? R.sim.enteredCannon : "—"} | rebonds simulés : ${R.sim.bounces.length}`);
  for (const r of R.rows)
    console.log(`   +${r.dt.toFixed(2)}s  réel=(${r.real[0].toFixed(1)},${r.real[1].toFixed(1)})  sim=(${r.pred[0].toFixed(1)},${r.pred[1].toFixed(1)})  err=${r.err.toFixed(2)}${r.err > 3 ? "  ⚠" : ""}`);
  console.log(`   → 1re grosse erreur (>3 m) à : ${R.firstBigErr != null ? R.firstBigErr.toFixed(2) + "s" : "jamais sur l'horizon"}\n`);
}

// Statistique globale : erreur médiane par horizon, sur tous les départs en vol.
const errByK = {};
for (const i of starts) {
  const R = runFrom(i); if (!R) continue;
  R.rows.forEach((r, k) => { (errByK[k] = errByK[k] || []).push(r.err); });
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log("Erreur médiane (m) par horizon, tous départs en vol confondus :");
for (let k = 0; k < HORIZON_SAMPLES; k++) if (errByK[k]) console.log(`  +${((k + 1) * spacing / 30).toFixed(2)}s : ${median(errByK[k]).toFixed(2)}  (n=${errByK[k].length})`);
