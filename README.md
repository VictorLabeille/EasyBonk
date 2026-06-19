# Bonkers — aide visuelle pour bonk.io

Overlay **client-only** et **lecture seule** pour aider un joueur débutant sur la map
custom **« Death Ball Cannons Pvp Grapple 1v1 Pr0 »** de [bonk.io](https://bonk.io) (mode
grappin) : il dessine par-dessus le jeu, sans jamais toucher à la simulation.

> But du mode : on **meurt si on touche la Death Ball** ; il faut la **renvoyer** au grappin
> en jouant avec l'inertie. L'overlay aide à anticiper la balle et à viser le grappin.

## Ce que ça fait

| Aide | Détail |
|---|---|
| 🔴 **Trajectoire de la balle** | Vol libre (gravité 10, plafond 60) **+ rebonds d'arène** (collision continue, restitution réelle). Marqueur **orange « → canon »** là où elle entre dans un canal (la suite, dans le canon, n'est pas prédictible). Validée **hors-ligne à 0.00 m** sur des captures réelles. |
| 🎯 **Point d'accroche du grappin** | La surface grappable la **plus proche** de ton disque : **rouge** (mur / sol / barrières) → **vert** quand c'est la **balle** (= grappiner maintenant l'attraperait). |
| ➡️ **Indicateur hors-champ** | Flèche rouge au bord de l'écran pointant vers la balle quand elle a quitté la vue (canon). |

**100 % visuel, lecture seule.** Aucune injection d'input, aucune modif de la physique →
**pas de désync, pas de kick**. (La physique de bonk est déterministe et synchronisée : tout
changement de simulation côté client seul ferait désync.)

### Touches

| Touche | Effet |
|---|---|
| `²` | overlay on/off |
| `G` | point d'accroche grappin on/off |
| `M` | repères disque/balle (debug, off par défaut) |
| `P` | diagnostic de calibration (console) |

Réglage en direct : `__BONKERS__.grappleRange` (portée d'accroche, défaut 9.5).

## Installation

1. Un gestionnaire de userscripts : **Tampermonkey** ou **Violentmonkey**.
2. **Code Injector – Bonk.io** : <https://greasyfork.org/scripts/433861>
3. **BonkLIB** : <https://greasyfork.org/scripts/508104>
4. Charger **`src/bonkers.user.js`** dans le gestionnaire.
5. Ouvrir bonk.io et lancer une partie sur la map. Bouge un peu (et envoie la balle) : la
   caméra se cale automatiquement, puis se **verrouille** (`[Bonkers] calage verrouillé` en
   console). Les 3 scripts doivent être activés.

## Comment ça marche (les points durs résolus)

L'overlay s'appuie sur **BonkLIB** (`window.bonkAPI`), qui patche le bundle obfusqué du jeu
et expose des hooks propres (`stepEvent`, `gameStart`, `graphicsUpdate`, conteneur Pixi…).
Deux problèmes non triviaux ont demandé du reverse-engineering (détaillé dans
[`docs/reverse-engineering.md`](docs/reverse-engineering.md)) :

- **Aligner le dessin sur la caméra.** Bonk n'applique PAS le zoom via un transform Pixi
  (tous les conteneurs sont en `scale=1`) : il « cuit » `monde × ppm × scaleRatio + pan`
  dans les coordonnées, et `scaleRatio` n'est pas lisible (code chiffré). On le **retrouve
  à l'exécution** : les entités qui bougent sont des nœuds Pixi dont on connaît la position
  *monde* (gameState) et qu'on lit à l'écran (arbre Pixi) → on cale un transform `échelle +
  translation`, puis on le **verrouille** (la caméra de cette map est fixe) pour la stabilité
  et la perf.
- **Physique exacte.** Constantes et règles extraites des données de la map et validées
  contre des captures : gravité 10, vitesse max 60, restitution par surface (murs normaux 0,
  cages 0.8, plateformes 3, **canons `re=99999`**), **calques de collision** (la balle
  traverse les « Barriers » que le grappin, lui, peut accrocher).

Le cœur physique est un **module pur testable hors-ligne** (`src/predict.js`,
`src/simulate.js`), miroir de la logique inlinée dans le userscript.

## Validation hors-ligne

```bash
node test/validate-predict.js     # prédicteur balistique vs captures réelles
node test/validate-simulate.js    # simulateur à rebonds vs cycle « canon »
```

En vol libre, l'erreur est **0.00 m** ; on a aussi vérifié empiriquement que le **cycle
canon n'est pas prédictible** par une simulation maison (d'où l'arrêt « → canon »).

## Structure

```
bonkers/
├── README.md
├── src/
│   ├── bonkers.user.js          # le userscript (l'overlay complet)
│   ├── predict.js               # prédicteur balistique (module pur, testé)
│   └── simulate.js              # simulateur trajectoire + rebonds (module pur, testé)
├── test/
│   ├── validate-predict.js      # validation du prédicteur sur captures réelles
│   └── validate-simulate.js     # validation du simulateur sur le cycle canon
├── docs/
│   └── reverse-engineering.md   # toutes les trouvailles de recon (coords, physique, grappin…)
├── .claude/specs/               # cadrage fonctionnel (périmètre, faisabilité)
└── reference/                   # copies locales pour étude — gitignoré, NON redistribué
```

## Notes légales / éthique

- Le code de bonk.io est **propriétaire et obfusqué**. Le dossier `reference/` (bundle du
  jeu, BonkLIB, captures) sert uniquement à l'étude locale et est **gitignoré — ne pas le
  redistribuer**.
- Cet overlay est **client-side, lecture seule** (confort / lisibilité) : il n'injecte aucun
  input et ne modifie pas la partie des autres joueurs. Pas d'aimbot ni d'automatisation —
  c'est volontaire et assumé dès le cadrage.
