# DETECTIVE — audit d'intégration et plan du MVP (aucun code du MVP n'est écrit)

Commit local de référence : `f784616` (5D). Audit du 2026-10-12, lecture du dépôt uniquement.

## 1. État exact des fonctionnalités

Légende : **LIVE** = fonctionne aujourd'hui sur des lectures réseau réelles (code du scanner existant, testé avec des
doubles) ; **FIXTURES** = code pur, testé sur captures figées/synthétiques, jamais branché à une lecture en direct ;
**LECTURES À AJOUTER** = il manque la collecte RPC/HTTP.

| Besoin du rapport | Où c'est fait aujourd'hui | État |
|---|---|---|
| Paires, prix, liquidité DEX, marché | `src/api/dexscreener.ts` (+ `getPairsByTokenAddresses`), `src/domain`, `src/scoring` | **LIVE** (public, gratuit, limites appliquées côté client) |
| Identité on-chain : supply, décimales, autorités mint/gel, extensions Token-2022 | `src/onchain/collect.ts` (`mintInfo`) ; `social/depth/decode.ts` décode en plus frais de transfert, délégué permanent, hook | scanner **LIVE** ; décodeur 5B **FIXTURES** |
| Taxes (frais de transfert Token-2022) | extensions listées par le scanner ; calcul exact des frais seulement en 5B (`token2022.ts`) | extension **LIVE**, calcul **FIXTURES** |
| Holders, concentration, wallets techniques (pools, burn) | `src/onchain/*` (`getProgramAccounts`, classification `KNOWN_PROGRAMS`) | **LIVE** |
| Créateur (« wallet associé au déploiement ») et son activité | `src/onchain/collect.ts` (courbe pump.fun, pool PumpSwap, activité récente) | **LIVE** (heuristique, non prouvé) |
| Premiers acheteurs, lancement, cohortes, groupes « potentiellement liés » | `src/wallets/*` (`collectTokenScan`: 25 pages de signatures max, 40 premières transactions, 20 récentes) | **LIVE**, mais limité : les tokens de plus de 25 000 signatures (A : 38 112, B : 138 959, C : > 400 000) n'atteignent pas leur lancement |
| Historique de wallets (financeur, bots, âge) | `src/history/*` (Helius en premier, repli RPC public ; routes serveur `/api/wallet-history`) | **LIVE** (clé Helius côté serveur seulement) |
| Financement à 2 sauts, sources communes, liens avec le créateur | `social/coordination/funding.ts` | **FIXTURES** (fournisseur injectable, collecteur CLI hors ligne) |
| Coordination 5C/5D (synchronie, groupes, inférence, UNKNOWN) | `social/coordination/*` | **FIXTURES** + banc d'essai synthétique ; aucune lecture en direct |
| Aller-retours, motifs de volume | `social/coordination/washVolume.ts` | **FIXTURES** (nécessite les transactions du token) |
| Liquidité réellement disponible, profondeur achat/vente, simulation de vente, aller-retour | `social/depth/*` (CLMM, CP-Swap, PumpSwap) | **FIXTURES** ; lecture des comptes de pool à ajouter (`getMultipleAccounts` existe dans `SolanaRpc`) |
| Grand livre de preuves, score de fiabilité des données | `social/ledger.ts`, `dataConfidence.ts` | **FIXTURES** (pur ; aucune persistance) |
| Décision finale existante | `src/final/assessment.ts` | **LIVE** ; ne doit pas être modifiée |
| Signaux sociaux | aucun dans le scanner (DexScreener expose des liens sociaux, non lus) ; les posts X ont été collectés à la main (Apify, payant) | **absent** en direct |
| Interface | `src/ui` (React) + `server/` (une seule route `/api/wallet-history`) | **LIVE** pour le scanner ; rien pour les moteurs 5A–5D |

Constats utiles :
- `ParsedTransaction` du scanner a la même forme que l'entrée de `normalizeTx` (5C) : **aucune conversion à écrire**.
- `OnchainService` et `WalletIntelService` prennent une ligne `ScoredPair` (issue de DexScreener) : une saisie par adresse de token passe par
  `getPairsByTokenAddresses` puis le scoring existant, sans le modifier.
- Couverture de profondeur 5B : CLMM Raydium, CP-Swap Raydium, PumpSwap. **Non couverts** : courbe de bonding pump.fun avant migration (la plupart des
  jeunes tokens), Raydium AMM v4, Orca, Meteora. Le rapport devra dire « non simulé » pour ces venues.
- La collecte de la 5C/5D (`scripts/social/coordination-capture.ts`) est un script d'investigation, pas un service : budget fixe, pas de reprise fine.
- Une clé Helius existe côté serveur dans l'environnement (non affichée) ; les limites exactes du plan **ne sont pas vérifiées** à ce jour.

## 2. Composants réutilisables tels quels
Client DexScreener ; `SolanaRpc` (cache, limites par méthode, `getMultipleAccounts`, `getTransaction`, `getSignatures`) et `FailoverSolanaRpc` ;
`collectOnchain` / `analyzeOnchain` ; `collectTokenScan` et décodage des trades ; `WalletHistoryService` ; `assessToken` (lecture seule) ;
5A (`EvidenceLedger`, statuts FAIT/INDICE/HYPOTHÈSE/NON VÉRIFIÉ) ; 5B (`buildClmmVenue`/`buildCpmmVenue`/`buildPumpVenue`, `analyzeDepth`, `recordDepthEvidence`) ;
5C/5D (`analyzeCoordination`, `recordCoordinationEvidence`, `formatCoordination`, `runInference`, scores `draft_unvalidated`).

## 3. Fonctionnalités manquantes (par ordre d'importance)
1. **Orchestrateur par adresse de token** (aujourd'hui il faut un `ScoredPair`) avec budgets, modes (rapide/standard/profond) et reprise.
2. **Collecteurs en direct** pour 5B (découverte du pool depuis DexScreener, lecture des comptes, tick arrays CLMM, config de frais PumpSwap) et pour 5C (transactions du mint
   pour une fenêtre de slots, historiques de financement) branchés sur `SolanaRpc`/`WalletHistoryService`, avec la couverture déclarée.
3. **Venues non couvertes** : au minimum la courbe de bonding pump.fun (formule connue, à vérifier sur événements réels) ; sinon mention « non simulé ».
4. **Rapport unique** (types, rendu texte/Markdown/JSON) avec vocabulaire commun : FAIT / INDICE / HYPOTHÈSES DÉSACTIVÉES / INCONNU.
5. **Signaux sociaux gratuits** : liens sociaux de DexScreener (existence, domaines) et import optionnel de posts déjà collectés ; pas de collecte X en direct sans service payant.
6. **Synthèse lisible** sans certitude inventée (règles ci-dessous) et séparation stricte d'avec `FinalAssessment`.
7. Persistance du ledger et du rapport (fichier JSON horodaté), CLI, puis route serveur et panneau UI (facultatifs pour le MVP).

## 4. Architecture minimale du MVP
```
saisie: adresse du token
  └─ scripts/detective.ts (CLI)  →  src/detective/run.ts (orchestrateur, pur + ports injectés)
        ports: DexPort (DexScreener)  RpcPort (SolanaRpc)  HistoryPort (WalletHistoryService, facultatif)  ClockPort
        1. resolve.ts     adresse → paires DexScreener → pool principal, venue, token de cotation, prix
        2. identity.ts    OnchainService existant → mint, supply, autorités, extensions, taxes, holders, créateur
        3. liquidity.ts   lecture des comptes du pool → 5B buildXxxVenue → analyzeDepth → recordDepthEvidence
        4. launch.ts      fenêtre de transactions du mint (budget) → normalizeTx → 5C analyzeCoordination → recordCoordinationEvidence
        5. social.ts      liens sociaux DexScreener (+ import optionnel)
        6. report.ts      assemble 10 sections + lacunes + budgets consommés ; synthesis.ts  règles de synthèse ; render.ts  texte/Markdown/JSON
  └─ sortie: report.json + report.md + ledger.json
```
Règles de conception : aucun appel d'écriture ni de trading ; tout bloc sans lecture suffisante devient **INCONNU** avec sa raison ; les scores 5A–5D restent
`draft_unvalidated`, **jamais** additionnés aux scores Opportunity/Risk/Quality/Confidence ni à `FinalAssessment` ; une p-value n'est jamais traduite en probabilité de fraude ;
`hypotheses.enabled` reste faux et la section « hypothèses » affiche « désactivées » ; chaque chiffre affiche sa source, sa couverture et sa date.

Contenu du rapport (correspond aux 10 demandes) : 1 identité/supply/autorités/taxes — 2 créateur et historique observable — 3 premiers acheteurs et concentration —
4 financements communs et groupes (avec statut d'inférence) — 5 liquidité achat/vente réellement disponible — 6 simulations de vente (50 / 100 / 500 / 1 000 / 10 000 $, 1 % et 5 % de l'offre) —
7 aller-retours et volumes répétitifs — 8 signaux sociaux — 9 risques, preuves (signatures, slots) et données manquantes — 10 synthèse.
Synthèse : une phrase par constat avec son niveau, un bandeau « ce rapport ne prédit ni prix ni fraude », la liste des inconnues en tête quand la couverture est partielle,
et aucun verdict binaire.

## 5. Plan d'implémentation en 3 étapes
**Étape A — Socle et liquidité (rapport utilisable)** : `src/detective/` (ports, résolution par adresse, identité via `OnchainService`, liquidité 5B en direct, rendu),
CLI `npm run detective -- <mint>`, tests avec ports factices + fixtures existantes (A/B/C/F), mode rapide. Livrable : sections 1, 2, 5, 6, 8 (liens DexScreener), 9, 10.
**Étape B — Lancement, wallets, coordination** : collecte de la fenêtre de lancement par slots (Helius en ascendant si le plan le permet, sinon RPC public avec plafond déclaré),
financement 2 sauts via `WalletHistoryService` quand disponible, 5C/5D en direct, aller-retours, ledger persistant. Livrable : sections 3, 4, 7 avec couverture et UNKNOWN.
**Étape C — Synthèse, validation, finition** : règles de synthèse + tests de langage (aucune accusation, aucune probabilité tirée d'une p-value), rejeu de bout en bout A/B/C/F contre les fixtures,
trois tests en direct documentés, route serveur et panneau UI optionnels, README, vérification que les scores existants sont inchangés. Critère d'arrêt : le rapport tient sur une page lisible pour 3 tokens réels.

## 6. Coûts et limites RPC (mesures réelles de ce dépôt, public RPC, 1 requête/s soutenue)
- Coût monétaire : **0 $** (RPC public, DexScreener public). Helius : clé serveur présente, quotas du plan **à vérifier avant usage** (non mesurés). Aucun Actor Apify (payant) dans le MVP.
- Limites client existantes : 30 requêtes / 10 s, 10 / 10 s pour `getTransaction` et `getSignaturesForAddress`, 3 / 10 s pour `getProgramAccounts` ; erreurs 429 observées en pratique.
- Mesures de la collecte 5C (250 transactions du mint + 50 wallets + 2 sauts) : F 324 appels / 271 s ; A 928 / 747 s ; B 1 105 / 953 s ; C 795 / 895 s. Soit **4,5 à 16 minutes** par token en mode profond sur le RPC public.
- Atteindre le lancement : 1 appel par 1 000 signatures (A ≈ 38 appels, B ≈ 139, C > 400 : le plafond actuel de 25 pages ne suffit pas). Avec l'historique ascendant de Helius, quelques appels, sous réserve du plan.
- Liquidité 5B : moins de 15 appels (comptes du pool, config de frais, tick arrays CLMM) ≈ 10–20 s.
- Budget proposé : **rapide** ≈ 100–150 appels (≈ 2–3 min : identité, liquidité, 120 transactions, cohorte de 20 wallets à 1 saut) ; **standard** ≈ 400 appels (≈ 7 min) ; **profond** ≈ 1 000 appels (≈ 16 min).
  Chaque plafond atteint est écrit dans le rapport (couverture), jamais masqué.

## 7. Limites et risques à garder dans le rapport
Lancement non atteint pour les gros tokens avec le RPC public ; pump.fun avant migration non simulé ; financement connu pour une minorité de wallets très actifs (A : 12/50, B : 18/45) donc
inférence de groupe souvent UNKNOWN ; pseudonymat ; adaptateur Helius non validé sur réponse brute ; banc d'essai synthétique seulement ; pas de signaux sociaux en direct sans service payant.
