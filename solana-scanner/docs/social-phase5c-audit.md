# Audit statistique de la Phase 5C (commit 87f0c0d)

Réalisé le 2026-10-11, en lecture seule. Les mesures viennent des fixtures A/B/C/F, d'un échantillon de blocs lu sur le
RPC public et de simulations reproductibles (graines fixes). **Verdict : plusieurs garde-fous sont plus faibles que
ne le suggère le rapport 5C. Aucune hypothèse n'a été écrite sur A, B, C ou F, mais la porte « hypothèse » n'est pas
fiable dans tous les régimes (voir Q1-Q3).**

## Q1 — Les p-values des groupes restent-elles valides après sélection des groupes ?
**Non, pas complètement.** Un groupe est d'abord extrait (composante connexe de paires à ≥ 2 familles), puis testé contre
« le reste de la cohorte » dont les familles sont mélangées. L'extraction est donc choisie sur les données et le test ne
reproduit pas cette sélection (effet de sélection, p-values trop petites).
Mesure (100 lancements organiques simulés, attributs indépendants) :
- lancement chaud (moyenne 12 slots) : 6 lancements sur 100 ont un groupe avec p < 0,01 ; 6 hypothèses écrites à tort ;
- lancement étalé (moyenne 35 slots) : 4 sur 100 ; 2 hypothèses à tort ; le quantile 25 % des p-values vaut 0,025 au lieu de 0,25 attendu (distribution trop biaisée vers les petites valeurs).
Cible visée : ≤ 1 faux signal sur 100. **Limite connue** : p-valeurs de groupe à lire comme un score de rang, pas comme une probabilité.

## Q2 — Faut-il une correction pour comparaisons multiples ?
**Oui.** Jusqu'à 5 groupes sont testés par token (A : 5) sans correction. Avec une correction de Bonferroni (α/k) les faux
signaux tombent de 6 à 3 (lancement chaud) mais ne disparaissent pas : la correction ne règle pas Q1 ni Q3. La bonne
réponse est un test à statistique maximale : appliquer **la même procédure de détection** à chaque permutation et
comparer l'ensemble ordonné des tailles de groupes (contrôle du taux d'erreur par famille, sélection incluse).
Sur A, aucun groupe ne passe le seuil de 0,01 avec ou sans correction (meilleur p = 0,015, k = 5 → seuil 0,002).

## Q3 — Les modèles nuls préservent-ils transactions par wallet, tailles et intensité temporelle ?
| Test | Préserve | Ne préserve pas |
|---|---|---|
| Synchronie du lancement (Monte-Carlo) | intensité temporelle grossière (bins de 10 slots, plafond par slot) | dépendances entre wallets, nombre de transactions par wallet |
| Groupes (permutation des familles) | distributions marginales de chaque famille (slot, montant, sorties, clés de financement) | **la dépendance entre attributs d'un même wallet** (ex. les premiers acheteurs achètent plus gros), le nombre de transactions par wallet |
| Aller-retours (permutation des étiquettes) | nombre de transactions par wallet (multiensemble d'étiquettes), tailles, horaires | la persistance d'un wallet dans le temps (rafales d'un même trader), le mélange achat/vente propre à chaque wallet |

Conséquences mesurées :
- **Groupes, attributs corrélés** : si le montant dépend de la phase d'arrivée (cas plausible sur une courbe de bonding), la porte d'hypothèse s'ouvre sur 100 lancements sur 100 (78 sur 100 en lancement étalé). Le modèle nul sous-estime le hasard. **C'est le défaut le plus grave de la 5C.**
- **Aller-retours** : sur 100 marchés organiques simulés où 70 % des acheteurs revendent dans les 2 minutes, la p-value est < 0,01 dans 100 cas sur 100. Le test mesure surtout « un wallet revend ce qu'il a acheté », ce qui est normal. Le drapeau « au-dessus du modèle nul » (A p = 0,005, B p = 0,03, F p = 0,005) **ne prouve donc rien d'inhabituel** ; seules les parts absolues et la concentration (F : 98,7 %, 2 wallets) restent informatives.

## Q4 — Le moteur distingue-t-il absence de preuve et historique incomplet ?
**Dans les résultats, oui ; dans le score brouillon, non.**
- Résultats : `no_funding_found` (historique complet) est distinct de `history_incomplete_no_funding` ; les lacunes deviennent des preuves NON VÉRIFIÉ ; `partialData` est exposé ; `dataComplete` est faux dès qu'un historique est partiel.
- Défaut : le composant « financement commun » du score est calculé comme si tout était observé. Sur A, 38 wallets sur 50 ont un financement **inconnu** (historique incomplet, rien trouvé) et le composant affiche « 6 % de la cohorte partage une source » (3 points sur 25) ; sur B, 27 sur 45 inconnus et « 0 % » (0 point). L'inconnu est traité comme un zéro.
- Même défaut pour « aucun groupe » quand la lecture est limitée à 250 transactions.
**Limite connue** : tant que ce n'est pas corrigé, lire le score brouillon avec le drapeau `partialData` et les lacunes, jamais seul.

## Q5 — Les 250 transactions correspondent-elles à la fenêtre voulue ?
**Partiellement.** La fenêtre voulue est « 150 slots depuis le premier swap ».
| Token | 250 plus anciennes transactions | Écart avec la fenêtre voulue |
|---|---|---|
| A | slots 454855402 → …543 (141 slots, 0,6 min), 221 swaps, plafond de 50 acheteurs atteint | Coupée par le nombre de transactions, pas par le temps : la fenêtre s'arrête à +141 au lieu de +150. Couvre la courbe de bonding, pas PumpSwap. |
| B | 97 slots (0,4 min), 143 swaps | Idem (+97) |
| C | 5 slots, 2 swaps, mais **pas le lancement** (liste plafonnée à 400 000 signatures) | Hors sujet |
| F | 2 875 977 slots (≈ 13,5 jours), 3 swaps seulement dans les 150 premiers slots | **Pas une fenêtre de lancement** : mélange de 13,5 jours d'activité, 212 swaps |
**Limite connue** : le plafond « 250 transactions » définit la fenêtre au lieu du temps ; pour F, « le lancement » est une notion qui ne s'applique pas à ces lectures.

## Q6 — Le transactionIndex est-il un ordre intra-slot fiable ?
**Oui pour l'ordre d'inclusion dans le bloc, avec réserves.**
- Présent dans 100 % des signatures listées (A 38 110, B 60 000, F 1 343) ; aucune paire (slot, index) dupliquée.
- Vérifié contre `getBlock` sur le slot le plus chargé de A (454855523, 11 transactions du token dans un bloc de 1 124) : les 11 index égalent exactement la position dans le bloc.
- Réserves : c'est l'ordre d'inclusion (les bundles Jito y sont contigus), pas l'ordre de soumission ni une causalité ; vérifié sur un seul slot ; la 5C ne l'utilise pas encore (ordre intra-slot inconnu).
