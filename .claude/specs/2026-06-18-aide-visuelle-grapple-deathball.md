# Cadrage — Aide visuelle débutant : grapple-football « Death Ball »

> Statut : validé · Date : 2026-06-18

## 1. Contexte & objectif métier

- **Problème / besoin** : la map custom **« Death Ball Cannons Pvp Grapple 1v1 Pr0 »**
  (bonk.io, mode Grapple, 1v1) est dure pour un débutant. Toucher la *death ball*
  avec son corps = mort. On interagit avec la balle en l'**accrochant au grappin**
  pour la **renvoyer** (jeu d'inertie). Deux difficultés clés :
  1. savoir **si / où** le grappin va s'accrocher (balle vs plateforme) avant de tirer ;
  2. **anticiper la balle**, qui circule vite et **revient souvent depuis hors de l'écran**
     (la vue en jeu est limitée au cadre jaune ; la balle sort par des canaux et
     est redirigée vers le bas par les plateformes inclinées du haut).
- **Valeur** : permettre au débutant de comprendre, survivre et tenter des renvois —
  donc s'amuser sans frustration.
- **Parties prenantes** : un joueur **débutant** (l'utilisateur l'accompagne). Le mod
  est installé **uniquement sur le PC du débutant** (client-only).
- **Indicateurs de succès** : le débutant identifie correctement la cible de son
  grappin avant de tirer ; il anticipe mieux la balle (y compris hors-champ) ;
  subjectivement, il meurt moins « bêtement » et ose des renvois.

## 2. Périmètre

### Dans le périmètre (v1)
- **Point de ciblage du grappin** : marqueur temps réel montrant **où le grappin
  s'accrocherait s'il était déclenché maintenant** ; **rouge** par défaut, **vert**
  quand la cible serait la **balle**.
- **Trajectoire de la balle**, deux volets :
  - **où elle va** : prédiction de son chemin à court terme, **y compris quand elle
    sort du cadre visible** (repère de bord d'écran / direction d'arrivée) ;
  - **où elle irait si on la lâche maintenant** : aperçu de renvoi quand la balle est
    accrochée au grappin (direction/vecteur de départ).
- **100 % visuel** : lecture d'état (BonkLIB `stepEvent`) + dessin overlay. **Aucune
  injection d'input. Mod client-only.**

### Hors périmètre (explicite)
- Toute **modification de la simulation** (gravité, vitesse de balle, *cible réelle*
  du grappin) → désync/kick, impossible en client-only.
- Toute **automatisation de jeu** (auto-grappin, auto-déplacement, bot) → écartée :
  l'**intention de tir est humaine** + équité.
- Cercle de portée, alerte de danger de proximité, repère de cible adverse → **reportés** (post-v1).
- Modélisation fine de la relance longue/multi-rebonds → **v2** (la v1 vise le court terme).

### Hypothèses (à confirmer)
- Physique bonk **déterministe/synchronisée** ; lire l'état et dessiner ne désync pas.
- Le grappin **peut accrocher la balle** (confirmé) ; règle de ciblage supposée =
  « cible grappinable **la plus proche** dans un **rayon** » (à valider en recon).
- La balle **ne se téléporte pas** : elle circule en **physique continue** dans des
  canaux hors-champ et est redirigée vers le bas par les plateformes inclinées du
  haut → une **prédiction par simulation physique** est possible (précision
  décroissante avec l'horizon).
- La **vue est limitée** (cadre jaune) mais l'**état physique complet** (balle
  hors-champ incluse) reste **lisible** → un indicateur « balle hors-champ » est
  faisable et porte sans doute la **plus grande valeur**.
- **Lecture de la map** (capture éditeur `reference/map.png`), **confirmée par
  l'utilisateur** : zone visible = cadre jaune ; map symétrique bleu (gauche) /
  rouge (droite) ; spawns en bas ; death ball au centre ; **plateformes cyan en
  haut = relanceurs** ; **canaux diagonaux → piliers latéraux = trajet hors-champ**
  de la balle ; **« trous » = les espaces de chaque côté AU-DESSUS des cages** (la
  balle qui y entre est relancée par le haut vers une cage) ; « red win » /
  « blue win » + 2 **Cap Zones** = condition de victoire (capture ; **respawn** à la mort).

## 3. Cas limites, erreurs & états dégradés

| Cas | Déclencheur | Comportement attendu |
|-----|-------------|----------------------|
| Balle hors du cadre visible | la balle entre dans un canal / passe au-dessus | l'indiquer quand même : repère en bord d'écran + direction (et idéalement délai d'arrivée) |
| Trajectoire traversant un « trou » | le chemin prédit atteint un canal | physique continue (pas de cas téléport) ; si la précision lâche, **tronquer l'horizon proprement** plutôt qu'afficher du faux |
| Aucune cible dans le rayon | rien de grappinable à portée | le point passe **rouge / « rien »** — **jamais** de faux positif vert |
| Grappin en recharge | jauge de charge épuisée | signaler que le grappin est **indisponible** (ne pas promettre une accroche impossible) — *à confirmer* |
| Balle **et** plateforme à portée | les deux dans le rayon | montrer **LA** cible que le jeu choisirait réellement (réplication fidèle de la règle), pas une supposition |
| Prédiction imprécise | horizon long / nombreux rebonds | **dégradé visuel** (estomper la fin de trajectoire) plutôt qu'une fausse certitude |
| Balle tenue par l'adversaire | l'autre joueur l'a au grappin | se baser sur l'état réel ; pas d'aperçu de renvoi trompeur |
| Hors manche active | menu / spectateur / mort | **masquer** les overlays |

## 4. Critères d'acceptation (v1)
- [ ] Le point de ciblage suit la **cible réelle** du grappin et vire au **vert ssi** le jeu accrocherait la **balle** (validé en comparant à des accroches réelles).
- [ ] La trajectoire de la balle s'affiche, **y compris un repère quand la balle est hors-champ**.
- [ ] L'aperçu de renvoi montre la **direction de départ** de la balle quand elle est accrochée.
- [ ] **Aucun input injecté** ; aucun désync/kick ; overlays masqués hors manche.

## 5. Questions ouvertes / à trancher
- [ ] **Règle exacte de ciblage** du grappin (rayon, « plus proche », types grappinables) — à mesurer en **recon**.
- [ ] La **balle** est-elle grappinable comme une plateforme (même rayon/priorité) ?
- [ ] **Horizon de prédiction** utile (en secondes) et rendu hors-champ (flèche de bord vs mini-carte) — à décider après un 1er essai.
- [x] **Lecture de la map confirmée** : trous = espaces de chaque côté au-dessus des cages.
- [x] **Géométrie via recon** validée : auto-capture (map décodée via BonkLIB), pas d'export manuel.
