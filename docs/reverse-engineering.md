# Reverse-engineering — map « Death Ball Cannons » (notes de recon)

Findings tirés des captures `reference/recon-1.json` / `recon-2.json` (via BonkLIB).
Sert de base au build de l'aide visuelle (cf. `.claude/specs/2026-06-18-…`).

## Capture (API BonkLIB)
- `gameStart` / `mapSwitch` → `{ mapData }` **déjà décodé** (géométrie).
- `stepEvent` → `{ inputState, gameState, currentFrame }` à chaque step physique.
- `gameInputs` → `{ userID, rawInput, frame, sequence }`.

## Coordonnées
- Unités = **mètres** ; `ppm = 12` (pixels/mètre).
- **x** croît vers la droite ; **y croît vers le BAS** (sol ≈ y=38.5 ; haut = y négatif).
- Cages : `red win` x≈**-27.9** (gauche) · `blue win` x≈**88.8** (droite) — hors cadre visible.
- Spawn balle ≈ (30.4, 37.1) ; spawn joueur ≈ (22.1, 38.5).

## Inputs — bitfield 6 bits (`rawInput`)
| bit | valeur | touche |
|-----|--------|--------|
| 0 | 1 | gauche |
| 1 | 2 | droite |
| 2 | 4 | haut |
| 3 | 8 | bas |
| 4 | 16 | heavy (non utilisé ici) |
| 5 | 32 | **grappin** (special) |

Combos additifs (ex. 38 = 32+4+2 = grappin+haut+droite).

## Joueur — `gameState.discs[i]`
Solo : `discs[0]` = moi. En 1v1 : matcher via ordre/`team` (`bonkAPI.myID`).
Champs utiles : `x,y` (pos) · `xv,yv` (vitesse) · `a,av` (angle) · `a1a` (charge grappin 0–1000) ·
`a1,a2` (flags heavy / grappin pressé) · `lhid,lht` (hook id/type — **reste -1**, cf. grappin) ·
`da` (≈270, angle de visée ?) · `sx,sy` (spawn).

## Balle — `gameState.physics.bodies[i]` où `s.n === "DeathBall"`
- ⚠️ l'index n'est pas stable → **chercher par nom**.
- Champs : `p:[x,y]` · `lv:[vx,vy]` · `a,av`. **Vitesse max = 60**.
- **Restitution** : corps balle `re=-1` → **défaut bonk = 0**. Combine Box2D = `max(reA,reB)`.
  ⇒ balle vs **mur normal** (`re=-1`→0) = **0** : elle **ne rebondit quasi pas** (s'arrête/glisse).
  Rebondit seulement sur surfaces à `re` explicite : **cages 0.8**, **plateformes hautes 3**, **canons 99999**.

## Calques de collision ⚠️ (la balle ne touche pas tout)
Chaque corps (`b.s`) porte 4 calques `f_1..f_4` (+ `f_p` = collisionne avec les joueurs).
**Deux corps se touchent s'ils partagent ≥1 calque.** La balle (`DeathBall`) a `f_1..f_4`
tous vrais. Conséquence vérifiée (recon-1) :
- **`Barriers`** (diviseur central + 2 barres latérales) a `f_1..f_4` **tous faux** + `f_p:true`
  ⇒ bloque les **joueurs** mais **la balle le traverse**. Ne PAS le mettre comme obstacle balle.
- Tous les autres corps (`Base, Walls, blue/red win, Unnamed`) partagent un calque ⇒ collisionnent.
- `extractWorld` filtre donc les corps sans calque commun avec la balle (38 obstacles, pas 41).

## Géométrie statique — `gameState.physics.bodies` (9 corps)
`Background, Barriers, Base, Walls` (gros, 29 fixtures), `DeathBall` (dynamique),
`blue win, red win`, 2 `Unnamed`. Chaîne **bodies → fixtures → shapes** (types `bx`=box, `ci`=cercle).
Cap zones liées aux fixtures (`i=14`→blue win, `i=15`→red win) ; victoire = **capture de cap zone**
(présence/durée), **pas** la balle dans la cage. 1 joint statique de map (`lpj`, Base↔monde).

## Grappin — règle d'accroche (établie)
- **Tout est grappable** (`ng=false` sur tous les corps : balle, sol, murs).
- Pas de visée directionnelle (`da` constant à 270 sur clavier).
- **Règle = objet grappable le plus proche (point de surface) dans un rayon R** :
  - disque **au sol** → accroche le **sol** (le plus proche) — vérifié recon (f400/f222 : balle reste au spawn, le sol est pris).
  - disque **en l'air près de la balle** → accroche la **balle** quand elle devient le point le plus proche (recon f435 : balle 6.6 < mur 7.7 → balle prise).
- `R` (portée max) non mesuré précisément (accroche balle vue jusqu'à ~6.6 ; à régler en jeu).
- ⇒ aide « point de ciblage » : dessiner le point grappable le plus proche, **rouge** (mur/sol) → **vert** (balle). À régler/valider en direct.
- ⚠️ **L'ensemble grappable ≠ l'ensemble de collision de la balle** : le grappin s'accroche aussi aux
  **Barriers** (ligne du milieu + barres des cages) que la balle, elle, traverse. `extractWorld`
  renvoie donc deux jeux : `colliders` (balle, filtré par calque) et `grappleColliders` (np=false,
  ng=false → inclut Barriers). Portée réglée à **9.5** en jeu.

## Grappin — état brut OPAQUE ⚠️
- Presser grappin (bit 32 / `disc.a2`) **draine la charge** mais **ne crée AUCUN joint** et **ne
  met PAS `lhid`** dans l'état lisible.
- À **~7 unités** de la balle, grappin pressé → **la balle est tirée** (force d'attraction).
- ⇒ **Rayon du grappin ≈ 7** (à affiner). La **cible** n'est pas exposée : le jeu la calcule en
  interne. Pour l'aide « point de ciblage », il faudra **répliquer la règle** (« objet grappinable
  le plus proche dans le rayon ») et **valider en jeu en direct** (regarder si le grappin va bien
  où le point est dessiné). Pas d'accroche sur plateforme capturée à ce jour.

## Rendu / caméra — `scaleRatio` (clé pour dessiner par-dessus) ✅
- Bonk **ne met PAS le zoom caméra dans un transform Pixi** : tous les conteneurs
  restent en `scale=1`. Il **cuit** `monde × ppm × scaleRatio + panCaméra` directement
  dans les coordonnées de dessin (cf. `this.scaleRatio * o69.physics.ppm` dans `alpha2s.js`).
  ⇒ dessiner naïvement en `monde×ppm` rate le zoom (~0.9) **et** le pan.
- `scaleRatio` (= zoom caméra) **non lisible** (obfusqué, assigné via propriété encodée).
  Les disques sont des sprites positionnés (`discGraphics[i].container.move`), **pas** redessinés.
- BonkLIB `pixiCtx` = conteneur ajouté au stage (`scale=1`) → mêmes coords que le dessin du jeu.
- **Solution retenue (auto-calibration)** : à chaque frame, repérer les **nœuds Pixi qui ont
  bougé** (= disques + balle), connaître leur position **monde** (`gameState`) et lire leur
  position **écran** (arbre Pixi, via `worldTransform`), puis caler `écran = s·monde×ppm + T`
  (échelle uniforme + translation, sans rotation). La balle/les autres entités **valident**
  l'appariement. Marche en solo (1 disque + balle) et en 1v1. Robuste au resize / zoom.
  Implémenté dans `src/easybonk.user.js` (`collectDynamic` + `calibrate`). **Validé en jeu**
  (repère balle pile au centre, trajectoire partant du centre).

## Cycle « canon »
Balle → canal (x≈62) → propulsée vers le haut (y négatif) → sommet → propulsée vers le bas →
entre dans une cage (x≈90.8) → **piégée, rebondit à l'infini**. **Physique continue, pas de
téléport.**

### Mécanique du canon (décodée) — surfaces `re=99999`
- Les fixtures `Walls` fx#33–44 ont **`re=99999`**. Box2D combine la restitution en
  **`max(reA,reB)`** ⇒ contact balle↔canon = restitution énorme → la composante normale
  est renvoyée à très grande vitesse, **plafonnée à 60** (`MAX_SPEED`). C'est le « canon ».
- Vu dans recon-2 (frame 486) : `lv` saute à **(0,−475.6)** puis retombe à **−59.3** la frame
  suivante (impulsion → clamp 60). Le lanceur est **au fond du canal** (la balle descend le
  canal jusqu'à lui avant d'être tirée).
- Ensuite : glissements de contact le long du plafond (vitesse constante, friction), **poches**
  où la balle se cale (v≈0) puis **2ᵉ lanceur** la renvoie. Beaucoup d'événements, **hors champ**
  et **entre les samples**.

### Faisabilité d'une prédiction (testée hors-ligne — `test/validate-simulate.js`)
- **Vol libre : exact** — `src/simulate.js` (balistique + rebonds en collision continue,
  restitution `max`, clamp 60) suit la vraie balle à **0.00 m** tant qu'elle vole.
- **Canon : non prédictible** par une simulation maison — dès l'entrée dans le canal l'erreur
  explose (~28 m en ~0.5 s) et ne se rattrape jamais (lanceurs `re=99999` + contacts/poches).
- ⚠️ De plus, **la balle sous grappin** (`disc.a2=true`) est tirée par une force externe
  (vue recon-2 frames 435–462) → mouvement **non balistique** tant que le grappin tient.
- ⇒ **Périmètre réaliste retenu** : tracer la trajectoire **vol libre + rebonds d'arène**, et
  **s'arrêter à l'entrée du canon** (la flèche hors-champ couvre déjà « où est la balle »).
