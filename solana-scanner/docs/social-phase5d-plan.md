# Plan de la Phase 5D (proposition — rien n'est implémenté)

Contraintes : lecture seule, sources gratuites, aucun Actor Apify, aucun trading, aucun changement des scores
existants, tests sans réseau, aucun commit/push sans autorisation. Chaque étape livre ses tests avant la suivante.

## 5D-0 — Mesure en premier : banc d'essai des faux positifs / faux négatifs (avant toute correction)
- Générateurs étiquetés, reproductibles : organique (attributs indépendants), organique **à attributs corrélés**
  (montant lié à la phase), copy-trading, teneur de marché, rafale « bundle » plantée (tailles 3, 5, 8, 12 ; 2 à 4 familles).
- Fixtures semi-réelles : rééchantillonnage des marges réelles de A/B/F (tailles, slots), liens de financement permutés
  (organique) ou plantés (suspect). Les cas réels restent étiquetés « non vérifiés » tant qu'aucune source publique ne les confirme.
- Métriques : taux de faux positifs par lancement et par groupe, puissance par taille de groupe, calibration (histogramme
  des p-values sous le nul). Test d'intégration : erreur de type I ≤ 2 × alpha sur tous les régimes, sinon échec.
- Livrables : `test/helpers/benchmark.ts`, `test/socialCoordinationBenchmark.test.ts`, rapport chiffré.

## 5D-1 — Corrections statistiques (issues de l'audit Q1-Q4)
1. Test à statistique maximale : appliquer **la même détection** à chaque permutation, p de chaque groupe = P(nul max ≥ taille). Supprime l'effet de sélection et les comparaisons multiples.
2. Permutations **stratifiées** : conserver le couple (slot, montant) de chaque wallet, mélanger seulement les relations
   de financement/sortie, ou permuter dans des strates de slot et de taille. Cible : la porte d'hypothèse ne s'ouvre pas sur
   100 % des lancements corrélés.
3. Aller-retours : remplacer le test de permutation des étiquettes (non informatif) par : (a) permutation par blocs qui
   conserve la suite des opérations de chaque wallet, (b) comparaison à une base de lancements organiques de référence,
   (c) mesures de taille d'effet (part, nombre de wallets distincts, concentration). Retirer le libellé « au-dessus du modèle nul » tant qu'il n'est pas calibré.
4. Trois états partout : **présent / absent (historique complet) / inconnu**. Le score renvoie `null` si la part d'inconnu
   dépasse un seuil configurable, et affiche une borne [observé ; observé + inconnu] au lieu d'un zéro.
5. Mesure de rupture : tant que 5D-1 n'est pas livré, ne pas écrire d'HYPOTHÈSE (désactivable par configuration).

## 5D-2 — Historiques plus complets, dont le lancement de C
- Fenêtre définie en **slots/temps**, pas en nombre de transactions : arrêt quand `slot > premier + fenêtre`, avec reprise
  (points de contrôle) et plafond de requêtes configurable.
- Lancement de C : signatures du mint en ordre **croissant** via Helius `getTransactionHistory` (lecture seule, déjà utilisé :
  C a été créé le 2026-10-09 à 05:15:38 UTC), puis transactions par RPC public. Vérifier d'abord les limites du plan
  (`getHeliusPlanInfo`, `getRateLimitInfo`, lecture seule).
- Phases suivantes à échantillonner : migration vers PumpSwap, +1 h, +24 h (fenêtres séparées, chacune avec sa couverture).
- Pour F : séparer « lancement » (premiers slots) de « activité sur 13,5 jours », avec fenêtres glissantes.
- Ordre intra-slot via `transactionIndex` (validé sur un slot ; à valider sur ≥ 20 slots de A/B/F avant usage).

## 5D-3 — Similarité des tailles de vente (les quatre wallets de B)
- Nouvelle famille « taille de sortie » : parts de position vendues et produits de vente comparés (tolérance configurable),
  uniquement pour des sorties proches (slots ou `transactionIndex`), avec garde contre les montants ronds.
- Test dédié sur les quatre wallets de B (même slot d'entrée, ≈ 2,5 SOL vendus chacun) : doit former un groupe à deux
  familles au moins, sans hypothèse, avec p-value stratifiée.
- Mesure de faux positifs sur copy-trading et teneurs de marché.

## 5D-4 — Financements communs et indirects
- Recherche **autour du premier achat** (signatures remontées depuis le premier achat sur ≤ 24 h) au lieu des « 6 plus
  anciennes transactions » : corrige les wallets très actifs (A : 38/50 inconnus).
- Passages par des relais (A→relais→B avec montant conservé et délai court), éclatements en rafale d'une même source
  (≥ k destinataires), dépôts via SOL enveloppé ou comptes intermédiaires.
- Liste d'entités (échanges, ponts, bots publics) **versionnée avec source et date** pour chaque entrée ; aucune entrée sans source.
- Chaîne du créateur : même recherche pour établir son financement (A, B, C : non établi aujourd'hui).

## 5D-5 — Adaptateur Helius validé sur une réponse brute
- Obtenir une réponse brute réelle : soit via le MCP (`expandResult` / détail complet, si la structure JSON est exposée),
  soit un échantillon fourni par vous. **Aucune clé n'est affichée ni stockée.**
- Test différentiel : mêmes signatures lues par RPC et par Helius → mêmes virements SOL et mêmes variations de jetons.
- Documenter l'imprécision connue (signataires, loyers de comptes) ou la corriger.

## 5D-6 — Rejeu et rapport
Rejeu A/B/C/F avec les nouvelles fenêtres, comparaison avant/après de chaque indicateur, mise à jour de la documentation.

## Ordre et dépendances
5D-0 → 5D-1 → (5D-2, 5D-5 en parallèle) → 5D-3 → 5D-4 → 5D-6. Les tests du banc d'essai bloquent chaque étape suivante.

## Risques
Limites de débit du RPC public (≈ 1 req/s soutenu) ; plan Helius gratuit (pagination ascendante, quotas) ; absence de vérité terrain
pour les cas réels ; le banc d'essai synthétique ne remplace pas des lancements réels étiquetés.
