# Phase 5D — fiabilité statistique (5D-0 banc d'essai, 5D-1 corrections)

Ce document remplace, pour la coordination, les p-values de la 5C (jugées mal calibrées par l'audit
`social-phase5c-audit.md`). **Données synthétiques ou semi-synthétiques uniquement : aucun taux réel de manipulation
n'est mesuré ni revendiqué.**

## Priorité 0 — sécurité des conclusions
- `hypotheses.enabled = false` par défaut (`src/social/coordination/model.ts`). Aucune HYPOTHÈSE de coordination n'est
  écrite au ledger ; chaque groupe porte `hypothesisBlockedBy`. Réactivation volontaire : `withConfig({ hypotheses: { enabled: true } })`.
- Restent produits : FAITS vérifiables, mesures descriptives, INDICES qualifiés, lacunes NON VÉRIFIÉ.
- Les anciennes p-values (synchronie du lancement, test de permutation des aller-retours, p de groupe « contre le reste de
  la cohorte ») sont **supprimées** des résultats, du ledger et du rendu.

## Ce qui est testé, et ce qui ne l'est pas (`inference.ts`)
Question : *les wallets qui partagent une source de financement non neutre se ressemblent-ils (même entrée, taille proche,
sortie synchrone) plus souvent que si le financement n'avait aucun lien avec le comportement ?*
- **Modèle nul** : le comportement de chaque wallet (slot d'entrée, montant, sorties, nombre d'opérations) est conservé
  comme **une seule unité** — donc les dépendances temps ↔ montant ↔ sortie et l'activité par wallet sont préservées
  exactement ; seuls les liens de financement sont permutés entre wallets.
- **Sélection répétée** : à chaque permutation, la même détection de groupes est rejouée (composantes connexes de paires à
  ≥ 2 familles). Le j-ᵉ plus grand groupe observé est comparé au j-ᵉ plus grand de chaque permutation (statistique d'ordre,
  p ajusté en escalier, jamais décroissant avec le rang) : contrôle du taux d'erreur par famille, choix des groupes inclus.
- La statistique d'un groupe est le **nombre de ses wallets qui partagent une clé de financement avec un autre wallet du même
  groupe** (une paire se rencontre par hasard, huit wallets non).
- **Non testable** : la similarité purement comportementale (même slot + montant proche + même sortie, sans financement commun).
  Elle est décrite (INDICE) sans p-value, car un comportement grégaire ordinaire a la même allure.
- **Aller-retours** : plus aucun test de significativité. Acheter puis revendre est un comportement ordinaire. Mesures
  descriptives : part du volume, concentration, régularité, et « motif d'aller-retours répétés équilibrés » (≥ 5 cycles dont les
  totaux achetés/vendus diffèrent de ≤ 2 %), qui décrit aussi bien un teneur de marché qu'un wash trading.

## Lien observé / absence de lien / inconnu
- `knowledge = known` : un financeur a été observé, ou un historique COMPLET n'en contient pas. `unknown` : historique manquant,
  ou partiel sans rien trouvé. L'absence de lien n'est jamais déduite d'un historique partiel.
- Inférence de groupe : `ok` seulement si le financement est connu pour ≥ 12 wallets ET ≥ 50 % des wallets tracés, et si
  `1/(permutations+1) < alpha`. Sinon `unknown` avec la raison, `adjustedP = null`, jamais un zéro.
- Score brouillon (`draft_unvalidated`) : une composante inconnue vaut `null` (pas 0) ; moins de 3 composantes connues → score `null`.
  « Financement commun » est une borne inférieure, `null` si moins de 50 % des financements sont connus.

## Banc d'essai (graines fixes, sans réseau) — résultats
Rapport complet : `docs/social-phase5d-benchmark-report.txt` (régénérable : `node --experimental-strip-types --no-warnings scripts/social/coordination-benchmark.ts 200`).
Régimes nuls (200 lancements chacun) : organique indépendant (chaud/étalé), organique **corrélé arrivée/montant/sortie** (chaud/étalé),
copy-trading, market making + arbitrage, semi-réels A et B (lancements réels, financement indépendant par construction).
- Faux positifs par lancement à alpha = 0,01 : 0 à 1 sur 200 selon le régime (0–0,5 %) ; à alpha = 0,05 : 0 à 11 sur 200 (0–5,5 %, B semi-réel au niveau nominal).
- Hypothèses écrites : 0 partout. Régime corrélé (celui qui donnait 100/100 de faux signaux en 5C) : 0/200 et 0/200.
- Calibration : la plus petite p ajustée par lancement n'est jamais inférieure à sa part nominale (testé sur 800 lancements poolés).
- Puissance (100 lancements par case) : k=3 : 9–13 % (**sous-puissant, non revendiqué**) ; k=5 : 79–88 % ; k=8 : 89–98 % ; k=12 : 79–99 % (F+T seul le plus faible) ;
  sans financement commun : 0 % (par construction, voir « non testable »).
- Semi-réel : financement planté sur 4 wallets réels de B entrés au même slot : 98 % détecté. Planté sur les groupes comportementaux réels de A : 3 % et 0 %
  (ces groupes sont trop proches du bruit du lancement pour être distingués).
- Sensibilité : faux positifs 0/100 pour toutes les variantes (alpha, permutations 100/1000, tolérance de montant 2/10 %, sync 0/3 slots, sortie 1/5 slots, 3 familles par paire) ;
  puissance k=8 de 78 % (sync 3 slots) à 100 %. Un alpha inatteignable avec les permutations (ex. 0,001 avec 500) renvoie `unknown`, pas « rien trouvé ».
- Robustesse : 25 % d'historiques dégradés → puissance 91 %, 0 faux positif ; 50 % → inférence exécutée sur ~61 % des lancements, puissance 44 %, 0 faux positif ;
  75 % → UNKNOWN sur 100 % des lancements (aucune p-value, aucun zéro).
- Confondeur (communautés financées par un fondateur et achetant ensemble) : signalé dans 3 % des cas seulement ; la procédure est **conservatrice** quand le
  comportement est dense (des liens fortuits fusionnent les groupes dans les permutations).

## Rejeu A / B / C / F
Aucun groupe n'est testable aujourd'hui : financement connu pour 12/50 wallets (A), 18/45 (B), 1 (C), 0/1 (F) → inférence UNKNOWN ; score brouillon `null`.
F : motif d'aller-retours équilibrés détecté de façon descriptive (2 wallets, 98,7 % du volume jugé) — sans test, sans verdict.

## Limites statistiques connues
1. **Synthétique** : le taux de faux positifs est celui des générateurs choisis ; un marché réel peut violer leurs hypothèses (corrélations non modélisées).
   Les seuils d'acceptation du banc d'essai ont été fixés après lecture des premières mesures, avec une marge ; ils ne sont pas pré-enregistrés.
2. **Association, pas intention** : un groupe significatif signifie « financement et comportement sont liés », jamais « contrôle commun » ni « manipulation »
   (amis, communauté, opérateur de bots, copy-trading d'un même service y ressemblent).
3. **Hypothèse d'indépendance sous le nul** : le financement est supposé indépendant du comportement à comportement donné. Un financeur commun légitime
   (aggrégateur, faucet non étiqueté) est traité comme non neutre s'il n'est ni étiqueté ni très actif.
4. **Données manquantes non aléatoires** : la validité suppose que la disponibilité des historiques est indépendante du comportement. Les wallets très actifs
   (souvent des bots) sont plus souvent partiels : biais possible vers les wallets peu actifs.
5. **Puissance** : faible pour de petits groupes (k=3) et pour la coordination sans financement commun ; ces cas restent décrits sans verdict.
6. **Définition de groupe** : paires à ≥ 2 familles (réglable) ; la famille « transfert » est un fait ponctuel hors inférence. Les tolérances (montant, slots)
   changent les groupes ; la sensibilité est mesurée mais pas optimisée.
7. **Résolution des p-values** : 1/(permutations+1) (0,002 avec 500). Graine fixe : résultat reproductible, mais un autre tirage donnerait des p légèrement différents.
8. **Fenêtre de lecture** (250 transactions) et ordre intra-slot ignoré : limites de la 5C inchangées (voir audit Q5/Q6).
