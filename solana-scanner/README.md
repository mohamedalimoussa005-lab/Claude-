# Solana Scanner — données DEX Screener + scoring

Scanner **en lecture seule** des paires Solana, alimenté par l'API publique
officielle de DEX Screener (<https://docs.dexscreener.com/api/reference>).

Pas de trading, pas d'achat, pas de wallet, pas d'IA. L'étape 1 récupère les données réelles ;
l'étape 2 les note avec des scores **descriptifs** (voir [Scoring](#scoring)) : Opportunity, Risk, Quality et Confidence.
Aucun score ne prédit le prix.

## Lancer

```bash
cd solana-scanner
npm install
npm run dev:full     # backend d'historique (server/, lit .env) + interface sur http://localhost:5173, Ctrl+C arrête les deux
npm run dev          # interface seule (Wallet Intelligence : historiques UNKNOWN tant que `npm run server` ne tourne pas)
npm run test:live    # test réel de tous les endpoints (nécessite l'accès réseau à api.dexscreener.com)
npm run score:live   # scan réel + top 10 par Opportunity Score, détail des points et anomalies (-- 20 pour un top 20)
npm run onchain:live # scan réel → sélection des candidats → analyse on-chain (RPC Solana public), DEX et on-chain côte à côte
npm run wallets:live # + wallet intelligence sur les candidats (historiques via WalletHistoryService ; -- 1 --deep pour autoriser un DEEP sélectif)
npm test             # tests unitaires hors ligne (normalisation, rate limit, retries, pipeline, scoring)
npm run typecheck
```

Node ≥ 22.6 requis (les scripts et tests TypeScript tournent via `--experimental-strip-types`, sans dépendance supplémentaire).

## Fonctionnement

1. **Découverte** : on récupère des tokens récemment actifs depuis trois flux (limite 60 req/min) :
   `/token-profiles/latest/v1`, `/token-boosts/latest/v1`, `/token-boosts/top/v1`,
   puis on garde ceux dont `chainId === "solana"`, sans doublons.
2. **Paires** : on récupère les paires via `/tokens/v1/solana/{adresses}` (30 adresses max par appel, limite 300 req/min).
3. **Normalisation** (`src/domain/normalize.ts`) : un format commun `NormalizedPair` où chaque métrique vaut
   `number | null`. `null` = champ absent ou inutilisable (jamais remplacé par 0). Les nombres envoyés sous forme
   de chaîne (`priceUsd`) sont parsés. Une paire sans `pairAddress` ou sans `baseToken.address` est ignorée.
4. On ne garde que les paires où le token découvert est le **base token**, car `priceUsd`, `marketCap` et `fdv`
   décrivent le base token.

| Champ normalisé | Chemin DEX Screener |
|---|---|
| tokenName / tokenSymbol / tokenAddress | `baseToken.name` / `baseToken.symbol` / `baseToken.address` |
| pairAddress, dexId, url, pairCreatedAt | idem |
| priceUsd, marketCap, fdv | idem |
| liquidityUsd | `liquidity.usd` |
| volumeM5 / H1 / H6 / H24 | `volume.m5` / `h1` / `h6` / `h24` |
| buysM5 / sellsM5 / buysH1 / sellsH1 | `txns.m5.buys` / `txns.m5.sells` / `txns.h1.buys` / `txns.h1.sells` |
| priceChangeM5 / H1 / H6 | `priceChange.m5` / `h1` / `h6` |

## Rate limits et erreurs

- Un limiteur à fenêtre glissante par groupe : 55/min pour profiles/boosts (documenté 60),
  280/min pour tokens/pairs/search (documenté 300).
- HTTP 429 : pause globale du groupe selon `Retry-After` (sinon backoff exponentiel), puis nouvel essai (3 max).
- 5xx, erreurs réseau et timeouts (15 s) : backoff exponentiel, 3 essais max. Les 4xx ne sont pas réessayés.
- Chaque erreur est typée (`http`, `rate_limit`, `network`, `timeout`, `parse`) et affichée dans l'interface,
  avec l'endpoint et le code HTTP. Si une source échoue, les autres sont quand même affichées.

## Interface

Tableau triable (clic sur l'en-tête), filtre texte, bouton **Refresh**, option « 1 paire par token (la plus liquide) »,
panneau **Couverture des champs** (combien de paires ont chaque champ) et **Journal des requêtes**
(endpoint, essai, code HTTP, durée).

En dev et en preview, le navigateur appelle `/dex/...`, que Vite relaie vers `https://api.dexscreener.com`
(pas de souci CORS). Pour appeler l'API directement, définir `VITE_DEXSCREENER_BASE_URL=https://api.dexscreener.com`.

## Scoring

Code : `src/scoring/`. **Toutes les règles, pondérations et seuils sont dans
[`src/scoring/config.ts`](src/scoring/config.ts)**. Le moteur (`score.ts`) est une fonction pure
`scorePair(pair, now, config)` : mêmes données → même score.

Les seuils sont des courbes `[x, y]` interpolées linéairement (bornées aux extrémités). Pour l'Opportunity,
`y` est la fraction (0–1) des points de l'item ; pour le Risk, `y` est directement le nombre de points.

### Opportunity Score (0–100) : qualité du setup et momentum observé

| Catégorie | Pts | Items (points max) |
|---|---|---|
| Momentum | 25 | Δ prix 5 min (7) · Δ prix 1 h (10) · accélération : Δ5m − moyenne 5 min de l'heure (5) · tendance 6 h (3). Courbes décroissantes au-delà de +25 % / 5 min et +150 % / 1 h ; plafond à 12/25 si +100 % / 5 min, +500 % / 1 h ou +2000 % / 6 h |
| Volume | 20 | volume 5 min (5) · volume 1 h (6) · volume 1 h / liquidité (5, maximum entre 1× et 3×, 0 à 15×) · accélération : volume 5 min / moyenne 5 min de l'heure (4) |
| Buy Pressure | 20 | ratio achats 5 min (7) · ratio achats 1 h (7) · nombre de transactions 1 h (6). Ratio ignoré sous 5 txns (5 min) / 10 txns (1 h), confiance progressive jusqu'à 30 / 100 txns |
| Liquidity | 15 | liquidity.usd (10) · liquidité / market cap (5, réduit si liquidité > market cap) |
| Market Cap | 10 | favorise ~$100K–$1M, faible sous $20K ; plafonné à 3/10 si liquidité absente ou < $5K |
| Age | 10 | facteur âge × facteur activité (transactions 1 h) : un token récent sans activité réelle n'a aucun point |

Pour une paire de moins d'une heure, la fenêtre « 1 h » ne couvre que son âge : les moyennes par 5 min en tiennent compte.

### Risk Score (0–100) : somme des facteurs, plafonnée à 100

Liquidité faible · liquidité absente (pump.fun bonding curve : +20, autre DEX : +25) · market cap extrêmement faible ·
très peu de transactions · chute de prix extrême (pire de Δ1h / Δ6h) · chute brutale sur 5 min · volume anormal
par rapport à la liquidité · mouvements violents (5 min, 1 h) · paire très récente · données importantes manquantes
(+3 par champ, max 15).

Si l'activité semble peu fiable, les points d'Opportunity concernés sont réduits (config `opportunity.adjustments`) :
- ticket moyen 1 h (volume / transactions) très faible : ratios achats/ventes, nombre de transactions et facteur d'activité de l'âge × 0,2 à 1 ;
- volume 1 h / liquidité élevé : points de volume 5 min et 1 h × 0,2 à 1 ;
- activité sans réaction du prix : ratios achats/ventes × 0,5.

Les ratios achats/ventes extrêmes (> 80 % d'achats) rapportent **moins** de points qu'un ratio sain (65–80 %).

### Quality Score (0–100) : crédibilité des données et de l'activité

`src/scoring/quality.ts`. Quality = 100 − déductions (config `quality`) :

| Signal | Anomalie affichée |
|---|---|
| Ticket moyen faible (volume / transactions, fenêtre avec ≥ 50 txns) | `Unusually small average transaction size`, ou `Possible artificial activity` si < $3 avec ≥ 300 txns |
| Part d'achats > 80 %, pondérée par le nombre de transactions | `Extreme buy/sell imbalance` |
| ≥ 1000 txns / 1 h (ou 150 / 5 min), achats dominants, prix quasi plat | `High transaction activity with limited price response` |
| Volume 1 h / liquidité (4 pts à 5×, 25 à 30×, 40 à 200×) | `Extreme volume/liquidity ratio` |
| Hausse ou chute extrême (+1000 % ou −95 % : −30), mouvement violent 5 min | `Extreme price movement` |
| Liquidité > market cap | `Liquidity above market cap` |
| Fenêtres incohérentes (ex. volume 5 min > volume 1 h) | `Inconsistent time windows` |
| Peu de transactions, historique très court, liquidité absente, champs manquants | (limites des données, pas des anomalies) |

Une anomalie signale un motif inhabituel ; le moteur ne conclut jamais qu'il s'agit d'un bot.
Les nouveaux facteurs de Risk associés : ticket moyen très faible, déséquilibre achats/ventes extrême, activité sans réaction du prix.

### Confidence : LOW / MEDIUM / HIGH

Points (0–100) : données disponibles (25), âge (20), transactions 1 h (20), liquidité (15), cohérence des fenêtres (20),
moins 6 par anomalie (max 30). HIGH ≥ 70, MEDIUM ≥ 45. Plafonds : moins de 15 min ou Quality < 40 → LOW ;
moins de 60 min, âge inconnu, liquidité absente ou Quality < 60 → au plus MEDIUM.
Un token récent peut donc avoir un Opportunity élevé et une Confidence LOW.

### Données absentes

Une donnée absente n'est **jamais** remplacée par 0 : l'item qui en dépend ne reçoit aucun point, il est marqué
« absent » dans l'explication, et le manque augmente le Risk. (Un vrai `priceChange.m5 = 0 %` reçoit, lui, des points.)
Les filtres excluent une paire dont la valeur testée est absente.

### Étiquettes descriptives

`HIGH RISK` (Risk ≥ 50), `MOMENTUM` (Opportunity ≥ 60, Momentum ≥ 15/25, Risk ≤ 40, Quality ≥ 60, Confidence ≠ LOW),
`WATCH` (Opportunity ≥ 45, Risk ≤ 49, Quality ≥ 40). Comme Quality et Confidence, elles décrivent l'état observé ;
**ce ne sont pas des recommandations d'achat**.

### Interface

Colonnes : Token (+ étiquette), Opportunity, Risk, Quality (+ nombre d'anomalies), Confidence, MCap, Liquidity,
Vol 5m, Vol 1h, Buys/Sells (5 min et 1 h), Age. Tri par défaut sur l'Opportunity Score.
Filtres : âge max, market cap min/max, liquidité min, volume 1 h min, Opportunity min, Risk max, Quality min.
Un clic sur une ligne ouvre « Why this score? » : les quatre mesures, Positive signals, Negative signals, Anomalies,
puis le détail des points (Opportunity par catégorie, déductions de Quality, calcul de Confidence, facteurs de Risk).

## Étape 3 : analyse on-chain (On-chain Risk)

Code : `src/onchain/`. Couche **indépendante** des scores DEX Screener (aucun score combiné). Lecture seule :
aucune transaction, aucun wallet. Tous les poids, seuils, limites et adresses reconnues sont dans
[`src/onchain/config.ts`](src/onchain/config.ts).

### Sources de données (gratuites, sans clé)

RPC public officiel `https://api.mainnet-beta.solana.com` (`SOLANA_RPC_URL` / `VITE_SOLANA_RPC_URL` pour un autre
endpoint). Dans le navigateur, l'appel passe par le proxy Vite `/solana-rpc` : l'endpoint public répond 403 aux
requêtes portant un en-tête `Origin: localhost`.

| Donnée | Méthode | Sans clé ? |
|---|---|---|
| Mint / freeze authority, programme (SPL / Token-2022), extensions | `getAccountInfo` (jsonParsed) | oui |
| Tous les comptes du token → holders, top N, nombre de holders | `getProgramAccounts` + filtre `memcmp` sur le mint, `dataSlice` owner + montant | oui (≈ 0,5 s pour quelques milliers de comptes) |
| Type des gros comptes (wallet, pool, bonding curve, programme) | `getMultipleAccounts` | oui |
| Deployment-associated wallet (pump.fun) | décodage du champ `creator` de la bonding curve ou `coin_creator` de la pool PumpSwap | oui |
| Deployment-associated wallet (autres) | fee payer de la transaction `initializeMint`, si l'historique du mint tient en 3 pages | oui, souvent hors de portée |
| Activité du deployment-associated wallet, financement des gros wallets | `getSignaturesForAddress`, `getTransaction`, `getBalance` | oui, mais limité |

Limites observées sur les endpoints publics : `getTokenLargestAccounts` renvoie 429 en continu (non utilisé) ;
publicnode refuse `getProgramAccounts` sans token ; limites par méthode (≈ 10–40 req / 10 s). Le client applique
un limiteur global et par méthode, des retries avec backoff, et un cache TTL (transactions 24 h, holders 3 min…).

Ce qui nécessiterait un fournisseur externe (Helius, Birdeye, Solscan Pro, etc.) : historique complet des gros
wallets (pagination illimitée), identification des exchanges, label des wallets, création des tokens non-pump.fun
au-delà de 3000 transactions, nombre de holders pour les tokens à très grand nombre de comptes, données de
bundles / snipers au lancement.

### Pipeline

DEX Screener → filtres → Opportunity / Risk / Quality → `selectCandidates` (Opportunity ≥ 50, DEX Risk ≤ 49,
Quality ≥ 40, 5 max) → **seulement ensuite** analyse on-chain (≈ 25–40 appels RPC par token). Les autres tokens
s'analysent au clic.

### Holders : RAW et ADJUSTED

RAW = % de l'offre totale. ADJUSTED = % de l'offre hors comptes techniques **vérifiés** : propriétaire = adresse de
la paire DEX Screener, compte détenu par un programme AMM / bonding curve connu (vérifié on-chain), autorité de pool
documentée, adresse de burn. Un compte détenu par un programme inconnu (locker, vesting…) n'est **pas** exclu.

### On-chain Risk (0–100)

| Catégorie | Max | Contenu |
|---|---|---|
| Authorities | 20 | mint active (12), freeze active (10), inconnue (6 chacune), extensions Token-2022 à risque (permanent delegate, transfer hook, frais de transfert, gel par défaut, non transférable) |
| Holder concentration | 30 | plus gros holder non technique, top 5, top 10, nombre de holders, distribution extrêmement concentrée (top 10 ≥ 70 %) ; inconnue : 18 |
| Creator / deployer | 20 | tokens détenus, ventes et transferts vers d'autres wallets parmi ses transactions récentes ; inconnu : 6 |
| Wallet relationships | 15 | part du plus grand groupe de « potentially related wallets », liens forts ; non analysé : 6 |
| Data completeness | 15 | points par section de données indisponible |

Wallets potentiellement liés (heuristiques, jamais « same owner ») : financés dans la même transaction, l'un
financé par l'autre, présents dans les mêmes transactions, financés à ≤ 10 min d'écart par une même adresse
**comptée peu active** (liens forts) ; même adresse comptée peu active à des moments différents (moyen) ; adresse
de financement très active (≥ 1 000 signatures), probablement un exchange, **quelle que soit la proximité
temporelle** (faible, non regroupé) ; adresse dont l'activité n'a pas été comptée (inconnu, jamais présumée rare,
non regroupé). Seuls les liens forts et moyens forment des groupes.

**On-chain Confidence** : part des sections vérifiées (mint 25, holders 25, classification 15, deployment wallet 15,
activité 10, wallets 10) → HIGH ≥ 80, MEDIUM ≥ 50 ; LOW si le mint ou les holders manquent.

Une donnée inconnue reste UNKNOWN et ajoute des points de risque : elle n'améliore jamais le score.
Le panneau de détail affiche : authorities, concentration RAW / ADJUSTED, deployment-associated wallet,
potentially related wallets, On-chain Risk et Confidence, puis RED FLAGS, POSITIVE STRUCTURAL SIGNALS et
UNKNOWN / NOT VERIFIED. Aucun token n'est présenté comme « safe ».

## Étape 4 : wallet intelligence

Code : `src/wallets/` (config dans [`src/wallets/config.ts`](src/wallets/config.ts)). Aucun score combiné, aucun
trading, aucun wallet utilisateur. Une adresse n'est pas une personne ; aucun wallet n'est une recommandation.

### Ce que le RPC gratuit permet (mesuré)

| Mesure | Résultat |
|---|---|
| `getTransaction` | ≈ 1 transaction/s (limite de méthode 10 / 10 s). Les transactions récentes exigent `maxSupportedTransactionVersion: 1` |
| Première transaction d'un token | atteinte pour un token jeune (≈ 5 000–25 000 signatures) ; hors de portée au-delà du budget (25 pages) |
| Historique des premiers acheteurs | sur un échantillon, 9/15 avaient ≥ 5 000 transactions (bots / snipers) et 5/15 étaient créés le jour même |

Conséquence : reconstruire l'historique d'un wallet actif sur ce RPC coûterait plus d'une heure d'appels **par
wallet**. Les historiques de wallets passent donc par la couche historique (étapes 4.1 / 4.2, Helius-first) ; le RPC
public ne sert plus qu'au scan du token. Aucune **reconstruction partielle** :
- côté token (vérifiable) : premiers et derniers acheteurs décodés depuis les soldes avant/après de chaque
  transaction (seuls les signataires sont des traders ; transferts, routes multi-tokens et quotes non-SOL sont
  ignorés, pas devinés), délai d'entrée après la première transaction, montant en SOL, market cap d'entrée
  (prix d'exécution × offre, USD estimé au prix SOL actuel), achats du deployment-associated wallet, acheteurs
  dans le bloc de création ;
- côté wallet (couche historique) : activité récente, origine, financement initial, liens (heuristiques de
  l'étape 3), et historique de trades **seulement s'il est complet**. Sinon trades, PnL, rendements, entrées précoces
  et durée de détention restent UNKNOWN.
- non calculable sans source de prix : multiple maximum après l'entrée (pas d'OHLCV via RPC).

### Faux « smart wallets »

Pénalités : deployment-associated wallet, lien avec lui (voir ci-dessous), financé moins d'1 h avant
le lancement, wallet créé moins de 48 h avant son entrée, ≥ 5 000 transactions (bot / haute fréquence),
micro-transactions, achète presque tous les nouveaux tokens, potentiellement lié à d'autres acheteurs,
historique incomplet. Un ou deux trades gagnants ne suffisent jamais (poids de l'échantillon).

**Lien avec le deployment-associated wallet** (`classifyCreatorLink`, même taxonomie et mêmes constantes que les
relations entre wallets, fenêtre 10 min, financeur très actif ≥ 1 000 signatures) ; le deployment wallet n'entre
jamais dans les clusters :

| Preuve | Force | Flag |
|---|---|---|
| financé directement par lui | forte | `fundedByCreator`, high |
| même transaction de financement | forte | `sameFunderAsCreator`, high |
| même financeur compté peu actif, financements à ≤ 10 min | forte | `sameFunderAsCreator`, high |
| même financeur compté peu actif, à d'autres moments | moyenne | `sameFunderAsCreator`, medium |
| même financeur très actif (exchange / service) | faible | aucun (note descriptive) |
| même financeur, activité non comptée | inconnue | aucun (note : preuve insuffisante) ; jamais présumé rare |

L'activité du financeur du deployment wallet est comptée par `checkFunders` (une requête `getSignatures`, au plus
une par token) seulement si un wallet analysé partage ce financeur ; déjà comptée → réutilisée.

**Pénalités en double** : quand la même preuve déclenche plusieurs flags du même phénomène, seule la pénalité existante
la plus forte du groupe s'applique ; les autres flags restent affichés (`penaltyApplied: false`, `suppressedBy`).
Groupes : événement de financement (`fresh` et `fundedBeforeLaunch` lus sur la même première transaction), automatisation
(`buysEverything` quand l'étendue des tokens est ce qui rend le wallet bot-like, sur un historique complet ; `micro`
reste indépendant), lien de financement (`related` quand tous ses liens viennent du financement du wallet déjà
pénalisé par un lien avec le deployment wallet ; un `sharedTx` ou un `fundedBy` entre wallets le garde). Sans
provenance traçable (signature d'origine ou liens inconnus), rien n'est neutralisé.

**Wallet Quality (0–100)** : taille d'échantillon 25, régularité 15, entrées précoces 10, performance réalisée 15,
pire position 15, complétude 20, moins les pénalités. **Wallet Confidence** : HIGH ≥ 25 positions évaluables avec
historique complet, MEDIUM ≥ 10, sinon LOW.

**Wallet Quality UNKNOWN** : la Quality est un nombre (`{ status: "measured", value }`) seulement quand
l'historique est complet (trades reconstruits) et qu'au moins une position est évaluable.
Sinon elle est `{ status: "unknown", reason }`, jamais 0 par défaut : `no_evaluable_position` (voir B2), `history_incomplete` (détails relevés par
la couche History : `history_too_long`, `completion_budget`, `deep_disabled`, `deep_incomplete`),
`provider_failure` ou `skipped` (avec le type d'échec de la lecture d'historique). Les motifs observés
(creatorLink, busy, fresh, related…) restent affichés comme observations, sans points retirés ; « Historique trop
incomplet » est un statut de données, pas un motif suspect. Confidence reste LOW. Les wallets UNKNOWN restent dans
les totaux et leurs clusters ; high-quality ne compte que des Quality mesurées ; compteurs `measured`, `unknown`
et `unknownByReason`.

**Data Confidence et Risk observations (B1)** : `dataConfidence` ne décrit que les données — UNKNOWN si la
Quality est UNKNOWN, sinon HIGH ≥ 25 positions évaluables, MEDIUM ≥ 10, LOW en dessous (positions évaluables,
pas reconstruites) ; aucun flag ne la plafonne. `risk` résume les flags existants : sévérité maximale observée et
appliquée, flags appliqués, neutralisés, ou simples observations sur une Quality UNKNOWN (aucune pénalité
retirée) ; « Historique trop incomplet » n'en fait pas partie. `confidence` reste l'indicateur historique
(mêmes seuils, plafonné HIGH → MEDIUM une fois par un flag HIGH appliqué). Un wallet peut donc avoir Data
Confidence HIGH et `fundedByCreator` HIGH. Compteurs ajoutés, descriptifs et **jamais des prédictions de
rentabilité** : `highConfidenceData` (Data Confidence HIGH), `highQualityMeasured` (Quality mesurée ≥ 60 et
Data Confidence MEDIUM/HIGH — aujourd'hui le même ensemble que `highQuality`) et
`highQualityWithoutHighRiskFlags` (le même ensemble sans flag HIGH appliqué).

**Performance évaluable (B2)** : un historique complet sans aucune position évaluable (aucun trade, transferts
seuls, ventes sans achat reconstructible, positions ouvertes sans prix) n'a plus de Quality numérique (avant :
20, les seuls points de complétude) mais `UNKNOWN (no_evaluable_position)`, avec Data Confidence LOW (les données
sont là, la performance non) et Legacy Confidence LOW ; ce n'est ni une panne, ni un historique incomplet, ni un
motif suspect, et `incomplete` n'est pas ajouté. Dès qu'une position est évaluable, la formule est inchangée
(complétude 20, coefficients, pénalités, seuil 60).

**Cluster adjustment** : les wallets potentiellement liés forment un seul cluster indépendant
(« 3 wallets detected, 1 independent cluster »).

### Pipeline

DEX candidates → on-chain validation → (à la demande) wallet discovery sur le token → shortlist (8 wallets :
premiers acheteurs puis plus gros) + jusqu'à 3 wallets structurels de l'étape 3 → faits par wallet depuis la couche
historique. Cache RPC + limiteurs.

Un seul chemin d'historique de wallets :

```
Navigateur : WalletIntelService → HttpHistorySource → backend /api/wallet-history → WalletHistoryService
Scripts / serveur : WalletIntelService → WalletHistoryService (createServerWalletIntelService)
WalletHistoryService → Helius PRIMARY (getTransactionsForAddress) → Helius enhanced (fallback) → RPC public
```

`WalletIntelService` exige cette couche (`options.history`) : sans elle, il refuse de se construire ; il n'existe
aucun autre chemin ni repli.

## Étape 4.1 : accès aux historiques de wallets (Helius-first + fallback RPC)

Code : `src/history/` (config dans [`src/history/config.ts`](src/history/config.ts)). Couche d'accès uniquement :
aucun score modifié ou ajouté. Les providers ne s'exécutent jamais dans le navigateur.

| Chemin | Détail |
|---|---|
| Abstraction | `WalletHistoryProvider.getPage()` ; `WalletHistoryService` : `getHistoryPage`, `getRecentHistory`, `getOldestHistory`, `quick`, `getFullHistory`. Providers essayés dans l'ordre (Helius puis RPC public) |
| PRIMARY (Helius) | `getTransactionsForAddress` : `transactionDetails: "full"`, `jsonParsed`, `paginationToken` (`slot:position`), `sortOrder` asc/desc, `commitment: finalized`, `filters.status`. Documenté « Developer plan+ » : essayé, jamais supposé |
| FALLBACK (Helius) | `getSignaturesForAddress` (pagination `before`) + `POST /v0/transactions` (décodage enhanced, ≤ 100 signatures). Signatures déjà en cache non retéléchargées |
| Bascule | 403 / 404 / méthode indisponible → fallback (désactive PRIMARY pour l'instance) ; 429 après retries → fallback pour cet appel ; 401 → provider RPC public |
| PUBLIC_RPC | `SolanaRpc` existant (`getSignatures` + `getTransaction`), pages de 25 |
| Classification | `classifyForWallet` : BUY / SELL / TRANSFER / UNKNOWN depuis les soldes (tokens pré/post, lamports, WSOL), signataires et programmes, mêmes règles que `decodeTrade`. Le `type`/`source` Helius n'est qu'un indice, jamais utilisé. Une transaction qui n'invoque que system/token/ATA/compute-budget/memo est un TRANSFER |
| QUICK | 1 page récente (100) + 1 page la plus ancienne (20) : activité et origine du wallet |
| DEEP | pagination newest → oldest, `maxPages`, `maxTransactions`, arrêt (`end_of_history`, `max_pages`, `max_transactions`, `error`, `stalled`), dédup par signature, état sauvegardé après chaque page (reprise). Uniquement sur appel explicite, 8 wallets max par instance |
| Cache | `MemoryHistoryCache` : transactions finalisées par signature, index par wallet, état de pagination ; `snapshot()` / `fromSnapshot()` pour persister |

**Clé Helius** : lue uniquement par `src/history/server/heliusEnv.ts` (`HELIUS_API_KEY`, jamais `VITE_*`), gardée dans un
champ privé, placée seulement dans l'URL de la requête sortante, masquée de toute erreur et de tout log, jamais sérialisée.
Le provider refuse de s'instancier dans un navigateur ; aucun fichier de `src/ui` ne l'importe (vérifié par les tests) ;
`.env` est ignoré par git. Le navigateur passe par le backend local ci-dessous, qui renvoie des transactions
normalisées, jamais la clé ni une URL Helius.

### Backend local : `GET /api/wallet-history`

Code : `server/` (Node `node:http`, aucun framework, hors de `src/` donc jamais bundlé par Vite).

```bash
npm run dev:full # les deux d'un coup, ou séparément :
npm run server   # API sur http://127.0.0.1:8787 (lit solana-scanner/.env s'il existe)
npm run dev      # dans un autre terminal : Vite transmet /api au backend
```

L'interface utilise ce backend pour **tous** les historiques de wallets de Wallet Intelligence
(`src/history/httpSource.ts` → `/api/wallet-history`, via `createBrowserWalletIntelService`) : mêmes modules que les
scripts (acheteurs + wallets structurels Step 3, QUICK, complétion QUICK, bot, relations, clusters, Quality /
Confidence), DEEP jamais demandé. Backend absent → historiques UNKNOWN et bandeau d'avertissement, sans autre
chemin ni appel Helius depuis le navigateur. Le scan du token et l'analyse on-chain (Step 3) restent sur
le RPC public via `/solana-rpc`.

Variables **serveur uniquement** (fichier `.env`, ignoré par git ; jamais de `VITE_*`) : `HELIUS_API_KEY` (optionnelle,
sinon RPC public), `WALLET_HISTORY_DEEP_TOKEN` (optionnelle, sinon DEEP désactivé), `WALLET_HISTORY_PORT`,
`WALLET_HISTORY_CACHE`.

| Paramètre / règle | Détail |
|---|---|
| `address` | base58 décodant exactement 32 octets ; tout autre paramètre → 400 |
| `mode=quick` | page récente + page la plus ancienne ; 30 requêtes / min / client |
| `mode=completion` | complétion QUICK d'un wallet : `cursor` (renvoyé par `mode=quick` : `sig:<signature>` ou `gtfa:<slot>:<position>`, tout autre format → 400) et `pages` optionnel (1 à 2) ; transactions (200) et taille de page (100) fixées côté serveur ; fenêtre de 30 / min distincte de `quick` |
| `mode=deep` | exige `WALLET_HISTORY_DEEP_TOKEN` côté serveur, `Authorization: Bearer <token>` et un client loopback ; 3 / min ; budget 20 pages / 2 000 transactions par analyse ; reprise automatique à l'appel suivant (`resumable`) |
| Réponse | `address`, `mode`, `status` (`quick_complete` / `quick_partial` / `upstream_partial` / `deep_complete` / `deep_partial`, `failed` en 502), `provider(s)`, `providerTrace`, `completeness` (`recentComplete`, `originComplete`, `historyComplete`), `resumable`, `stopReason` (QUICK : `quick_budget` ou `end_of_history`), `pagination`, `recent` (compteurs), `origin`, `transactions` (normalisées, réussies uniquement), `truncated`, `warnings` |
| `providerTrace` | étapes par phase (`recent`, `origin`, `deep`) : `helius_primary` / `helius_enhanced` / `public_rpc` × `success`, `unauthorized`, `forbidden`, `rate_limited`, `method_unavailable`, `timeout`, `network`, `invalid_response`, `unknown`, `disabled` (+ `cause`), `skipped`. Codes fixes uniquement : jamais de message amont, URL, clé, en-tête ou stack |
| `recent` | `signaturesRequested`, `signaturesListed`, `transactionsFetched`, `transactionsFromCache`, `transactionsSucceeded`, `transactionsFailed` (`null` si filtrées côté Helius), `transactionsNormalized`, `missing`. Les transactions échouées sont comptées, jamais renvoyées ni classées BUY/SELL |
| `origin` | `found`, `firstSeen`, `signature`, `method` (`helius_primary_asc`, `signature_walk`, `recent_page`, `cache`, `none`), `complete`, `reason` (`found`, `history_start_reached`, `budget_exhausted`, `primary_unavailable`, `unsupported`, `error`), `signaturesScanned`. Sans PRIMARY, la recherche reste bornée à 10 000 signatures : au-delà, `budget_exhausted` (QUICK reste QUICK). Une origine trouvée est mise en cache |
| Protections | écoute sur 127.0.0.1, en-tête Host local obligatoire (anti DNS-rebinding), 2 analyses simultanées max (503), timeout 60 s (504, l'analyse garde son créneau jusqu'à sa fin réelle), réponse ≤ 2 Mo (transactions les plus anciennes retirées, `truncated`), `cache-control: no-store` |
| Erreurs | codes fixes (`invalid_address`, `rate_limited`, `upstream_unavailable` + `{provider, kind}`…) ; jamais la clé, une URL Helius, une variable d'environnement ni le message amont |
| Cache | `MemoryHistoryCache` partagé, persisté dans `.cache/wallet-history.json` (écriture atomique, ignoré par git) après chaque analyse et à l'arrêt ; rechargé au démarrage, donc un DEEP reprend après redémarrage. Contient uniquement des transactions normalisées, l'état de pagination et les origines trouvées (snapshot v2 ; un snapshot v1 sans `version`/`origins` se recharge tel quel) |

## Étape 4.2 : Wallet Intelligence sur WalletHistoryService

Code : `src/wallets/historyFacts.ts`, `botSignals.ts`, `server/walletIntel.ts`, `browserService.ts`.
`WalletIntelService` reçoit la couche historique par injection (`options.history`, obligatoire, une instance par
token). L'UI ne construit jamais Helius. Aucune formule de Wallet Quality ni aucun seuil de Confidence ne change.

| Point | Règle |
|---|---|
| Collecte | QUICK d'abord (activité récente + origine). DEEP seulement si l'historique est incomplet, que le wallet n'est pas clairement un bot, que son historique peut tenir dans le budget DEEP (2 000 transactions), et au plus 8 wallets par token ; désactivé par défaut (`deep: true` pour l'autoriser) |
| Complétude | trades, positions, PnL réalisé et win rate existent si et seulement si l'historique est **complet** (page récente couvrant tout l'historique, complétion QUICK arrivée au bout, ou DEEP terminé), quelle que soit sa longueur |
| UNKNOWN | origine non trouvée → âge et financement UNKNOWN (listés dans `unknowns`), jamais un signal négatif ; historique incomplet → pas de trades inventés. `signatureCount` devient une borne inférieure quand l'historique est incomplet |
| Bot / haute fréquence | depuis les transactions normalisées : transactions/min, achats revendus en ≤ 60 s, reventes de la quantité exacte, nombre de tokens, tickets (seuils dans `WALLET_CONFIG.bot`). Alimente le flag existant « Activité de type bot / haute fréquence » (même sévérité, même pénalité) |
| Transferts | classés TRANSFER depuis les soldes (jamais le type Helius), conservés avec leurs contreparties ; jamais BUY/SELL |
| Distribution du créateur | transferts du deployment wallet vers d'autres wallets (nombre, destinataires, % de l'offre), destinataires suivis, et reventes observées chez 5 destinataires au plus |
| Positions | entrée, sortie, durée de détention, SOL dépensé / reçu, `realizedPnlSol` (sur la part vendue) et `closed` par position. Pas de PnL USD historique, de PnL latent ni de multiple max (pas encore d'historique de prix) |

`npm run wallets:live -- 1 [--deep]` l'exécute côté Node (clé Helius lue uniquement dans ce processus).

### Étape 4.2b : résilience RPC

Code : `src/history/failure.ts`, `src/wallets/resilience.ts`. Aucune formule, pénalité ni seuil modifié.

| Point | Règle |
|---|---|
| Erreurs structurées | `quota_exhausted` (HTTP/RPC 413, « data allowance »…), `rate_limited`, `timeout`, `network`, `method_unavailable`, `invalid_response`, `rpc_error`, `unknown`. Le message amont sert uniquement à classer ; il n'est jamais stocké dans le résultat ni utilisé comme signal |
| Circuit breaker | `RunRpcGuard`, un par analyse de token : `healthy` → `quota_exhausted` → `unavailable_for_run`. Ensuite les appels au même RPC ne sont plus envoyés (échec immédiat, comptés dans `rpcCallsSkipped`). Timeout / réseau / rate limit ne l'ouvrent pas |
| Isolation par wallet | un échec rend UNKNOWN les données du wallet concerné (`failure` : code + étape `history`), les wallets suivants continuent. Si tous les fournisseurs d'historique ont épuisé leur quota, les wallets restants (et le deployment wallet) ne sont pas demandés ; Helius reste utilisé tant qu'il répond |
| Token-fatal | uniquement si aucune signature du mint ne peut être listée (aucun acheteur identifiable) |
| Résultat | `analysisStatus` (`complete` / `partial` / `failed`) et `diagnostics` (`walletsAttempted`, `walletsCompleted`, `walletsPartial`, `walletsSkipped`, `failureKinds`, `stages`, `tokenFatal`, `rpcCircuit`, `rpcCallsSkipped`) |
| UNKNOWN | une panne ne crée aucun flag ni aucune pénalité : Quality identique à celle des mêmes faits sans l'enregistrement de l'échec. Les règles existantes s'appliquent aux données manquantes (dont le flag `incomplete`, inchangé) |

### RPC Solana côté serveur (authentifié + fallback public)

Code : `src/rpc/serverRpc.ts` (Node uniquement ; jamais importé par `src/ui`). Utilisé par `server/index.ts`,
`wallets:live` et `onchain:live`. L'UI reste sur le RPC public via le proxy Vite `/solana-rpc`.

| Point | Règle |
|---|---|
| Fournisseurs | `HELIUS_API_KEY` défini → `authenticated_rpc` puis `public_rpc` ; sinon `public_rpc` seul (comme avant). `SOLANA_RPC_URL` reste possible pour un endpoint public personnalisé, mais refusé s'il contient une clé |
| Secret | l'URL authentifiée n'existe que dans la closure de `authenticatedFetch` ; le client porte le libellé `authenticated_rpc`. Réponses et erreurs sont réécrites : l'endpoint devient `[authenticated_rpc]`, toute clé `[redacted]`. Aucune URL dans les logs, erreurs, sections Step 3, diagnostics, cache ou réponses API |
| Bascule | au plus un fallback par opération (authentifié → public) ; circuit breaker par fournisseur : quota épuisé, 401 ou 403 → fournisseur indisponible pour l'exécution ; timeout / réseau → fallback pour cet appel seulement. `RunRpcGuard` reste au-dessus |
| Diagnostics | `diagnostics.rpcProviders` (libellé, état, cause, compteurs) et `rpcFallbacks` ; jamais l'URL |
| Algorithmes | Step 3 et Step 4 inchangés : seul le transport change (`getAccountInfo`, `getProgramAccounts`, `getMultipleAccounts`, `getSignaturesForAddress`, `getTransaction`, `getBalance`). La couche historique Helius Enhanced reste séparée |

### Étape 4.2c : complétion QUICK et nombre de signatures

| Point | Règle |
|---|---|
| Complétion QUICK | après QUICK, pour un historique **court** seulement (ce n'est pas DEEP : ni état DEEP, ni plafond DEEP). Origine non atteinte dans le budget (milliers de signatures) → jamais. Taille totale connue exactement (le parcours des signatures a atteint le début, ou la page récente couvre tout) → seulement si ≤ 300 signatures et si le reste tient dans 2 pages / 200 transactions. Taille inconnue → une seule page de sonde. Paramètres : `WALLET_CONFIG.historyLayer.quickCompletion` |
| Complétude | `historyComplete` seulement si la fin de l'historique est réellement atteinte (`quick_completion_end`) ; budget atteint (`quick_completion_budget`) → incomplet, aucune métrique globale |
| `origin.signaturesScanned` | signatures réellement listées par la recherche d'origine (échouées comprises), jamais les transactions décodées ; `origin.totalSignatures` = taille exacte quand le début a été atteint |
| Borne inférieure | `signatureCount` ≥ signatures parcourues (5 000, 10 000…) ; alimente le flag existant « bot / haute fréquence » sans changer son seuil ni sa pénalité |

## Final Decision Engine V1 (`src/final/assessment.ts`)

Une décision par token à partir des résultats déjà calculés — aucun score global pondéré, aucun nouvel appel
réseau. DEX = intérêt / timing, on-chain = sécurité structurelle, Wallet Intelligence = confirmation /
warnings, Data Confidence = incertitude. Labels : **MOMENTUM, WATCH, CAUTION, AVOID, NO SIGNAL** (jamais
SAFE / BUY / SELL) ; ils décrivent ce que le scanner a observé, pas une recommandation.

1. **Base = label DEX inchangé** : MOMENTUM → MOMENTUM, WATCH → WATCH, HIGH RISK → CAUTION, aucun → NO SIGNAL.
   Les wallets ne relèvent jamais la décision (NO SIGNAL reste NO SIGNAL).
2. **AVOID** (hard blocker confirmé, quelle que soit la base) : freeze authority ACTIVE, Token-2022
   `nonTransferable`, `defaultAccountState = frozen`, `permanentDelegate` actif.
3. **CAUTION** (si la base est MOMENTUM / WATCH / HIGH RISK) : mint authority ACTIVE, Token-2022 `transferHook`,
   top 10 ≥ 70 % sur la base **ajustée** uniquement (seuil Step 3 existant), deployment wallet ≥ 5 % de l'offre,
   ou ventes / transferts du deployment wallet (red flags Step 3 existants).
4. Sinon, la base DEX.

Seuls des faits **confirmés** déclenchent un gate : les red flags Step 3 sont désormais étiquetés à la source
(`redFlagFacts`, mêmes textes que `redFlags`), émis uniquement à partir de données obtenues. Le score On-chain
Risk brut n'est **jamais** un gate (il compte aussi les données inconnues) ; il reste affiché. Données
indisponibles, holders non classés, Quality UNKNOWN, Data Confidence LOW / UNKNOWN, `sameFunderUnknownActivity`
→ UNCERTAINTY, jamais NEGATIVE. Relations fortes (`sameTx`, `fundedBy`, `sharedTx`, `sameFunderClose`) et
liens forts avec le deployment wallet → NEGATIVE sans dégrader le label (non calibré en V1) ; `sameFunder` →
negative plus faible ; `sameBusyFunder` / `timing` → INFORMATIONAL. Wallets de qualité mesurée sans risque HIGH
→ POSITIVE (confirmation) ; Quality mesurée sous 60 → NEGATIVE faible (pas un signe de scam) ; `transferFee`
→ NEGATIVE avec sa valeur, sans gate.

**Déduplication de présentation** : une relation Step 3 et une relation Step 4 ne font qu'une raison seulement
si elles ont la même identité (type + paire de wallets + clé du lien) ; un `fundedByCreator` et le lien
`fundedBy` identique (wallet ↔ deployment wallet) aussi. Sans identité commune fiable, rien n'est fusionné.
Présentation (sans effet sur la décision ni sur les relations) : les paires `sharedTx` d'un même groupe connecté
forment une seule raison (« 4 wallets reliés, 6 paires ») ; une ligne qui regroupe des paires vues par les deux
moteurs (même financeur) indique combien de paires chacun a vues ; les champs DEX manquants que Step 2 rapporte deux
fois ne donnent qu'une incertitude ; « WHY CHANGED » n'apparaît que si la décision diffère de la base (sinon
« STRUCTURAL CAUTION ») ; Wallet Intelligence lancée sans aucun wallet suivi est une incertitude distincte de « non
lancée ».
Aucun score Step 2 / 3 / 4, aucune pénalité ni aucun cluster ne change. Affichage : panneau FINAL ASSESSMENT
dans le détail d'un token ; `scripts/wallets-live.ts` imprime `formatAssessment`.

## Outcome Tracker V1 (`src/outcomes/`, `scripts/outcomes.ts`)

Couche d'**observation** séparée : elle consomme les résultats du scanner et n'en modifie aucun. Rien de ce
qu'elle mesure ne revient dans Step 2 / 3 / 4 ni dans le Final Decision Engine.

- **Snapshot (T0, immuable)** : ce que le scanner savait au moment du scan DEX — identité (mint, paire exacte,
  symbole, dex), marché (prix, liquidité, market cap / FDV, volumes, achats / ventes, âge), Step 2 (Opportunity,
  DEX Risk / Quality / Confidence, label), Step 3 et Step 4 seulement s'ils ont réellement tourné (sinon `null`),
  FinalAssessment complet (décision, base, blockers, cautions, raisons), et le funnel (`candidate`,
  `step3Status` / `step4Status` : `NOT_RUN`, `COMPLETE`, `PARTIAL`, `FAILED`). Le snapshot est copié (détaché des
  objets du scanner) et haché (sha256) à la capture : toute mise à jour qui le modifierait est refusée.
- **Outcomes** : ajoutés plus tard à côté du snapshot, aux checkpoints **5m, 15m, 30m, 1h, 3h, 6h, 12h, 24h** après
  T0 — `targetAt`, `observedAt` (heure réelle de la mesure), `delayMs`, prix, liquidité, market cap / FDV,
  volumes, `returnPct` = (prix / prix T0 − 1) × 100, ou `null` si un des deux prix manque (jamais NaN / Infinity).
- **Statuts** : `OK` (la paire T0 a répondu), `UNAVAILABLE` (le fournisseur a répondu sans cette paire),
  `PROVIDER_ERROR` (échec de la requête), `MISSED` (fenêtre passée sans mesure). Aucun ne vaut prix 0 ni −100 % ;
  un checkpoint non encore stocké est NOT_DUE ou en attente. UNAVAILABLE / PROVIDER_ERROR sont retentés tant que la
  fenêtre est ouverte ; OK et MISSED sont définitifs (idempotence).
- **Fenêtre d'un checkpoint** : de sa cible jusqu'à la cible du suivant (24h : sans limite, retard enregistré). Une
  mesure prise plus tard décrirait un autre horizon, donc le checkpoint devient MISSED. `outcomes:update` doit donc
  tourner régulièrement (au moins toutes les ~5 min pour 5m / 15m).
- **Paire** : toujours la paire exacte du snapshot (lookup DexScreener par adresse de paire, par lots de 30), jamais
  une autre paire du même mint.
- **Métriques de chemin** : `maxObservedReturnPct` / `minObservedReturnPct` calculées sur les seuls checkpoints
  observés — pas un vrai ATH ni un vrai drawdown entre deux checkpoints.
- **Aucune étiquette d'issue** (gagnant, rug…) et aucun seuil : valeurs brutes uniquement.

Commandes :

```bash
npm run outcomes:capture             # scan normal → snapshots T0 de tous les tokens scorés
npm run outcomes:capture -- --wallets   # + Step 4 sur les candidats (comme le bouton de l'UI)
npm run outcomes:update              # remplit les checkpoints dus (1 appel DexScreener par 30 paires)
npm run outcomes:report              # rapport descriptif : funnel, décisions, couverture, rendements par horizon
npm run outcomes:export              # CSV plat (signaux T0 + outcomes) dans le dossier du dataset
```

Population : chaque capture enregistre **tous** les tokens scorés par le scan (FinalAssessment Step 2 seul pour
la plupart) ; Step 3 ne tourne que sur `selectCandidates`, comme dans l'UI, et Step 4 seulement avec `--wallets`.
Le snapshot dit quels moteurs ont tourné ; aucun résultat manquant n'est fabriqué. L'identifiant
`mint:paire:T0` empêche de dupliquer une observation ; chaque nouvelle capture (nouveau T0) crée de nouvelles
observations, y compris pour un token déjà suivi.

Dataset : `solana-scanner/data/outcomes/observations.json` (ignoré par git ; `OUTCOMES_DIR` pour un autre dossier).
Pour réinitialiser : supprimer `data/outcomes/`. La décision du scanner décrit ce qu'il observait à T0 ; l'outcome
est ce que le marché a fait ensuite. Le rapport affiche `n` partout et ne revendique aucune significativité.

### Collecte des données (Data Collection V1)

```bash
npm run outcomes:collect                  # UPDATE toutes les 5 min, CAPTURE --wallets toutes les 30 min (Ctrl+C pour arrêter)
npm run outcomes:collect -- --once        # une CAPTURE puis un UPDATE, puis sortie
npm run outcomes:collect -- --no-wallets  # captures sans Step 4
npm run outcomes:status                   # santé du dataset, sans réseau
npm run outcomes:backup                   # copie dans data/outcomes/backups/observations-YYYYMMDD-HHMMSS.json
```

- Le runner n'orchestre que les commandes existantes (aucune logique de scoring). Les deux calendriers sont
  indépendants : une capture longue (Step 3 / 4 : plusieurs minutes) ne retarde jamais les mises à jour de 5 min.
  Jamais deux captures ni deux mises à jour en même temps.
- **Un seul écrivain** : chaque lecture-modification-écriture du dataset se fait sous un verrou
  (`data/outcomes/observations.lock`, créé en exclusif avec pid + heure). Un verrou dont le processus a disparu,
  ou vieux de plus de 15 min, est repris ; il est libéré en fin d'opération et sur Ctrl+C / SIGTERM. La capture
  ne verrouille que son ajout final (le scan peut durer) ; la mise à jour verrouille chargement → fetch →
  écriture, pour qu'une capture concurrente ne soit jamais écrasée par une copie périmée.
- **Reprise** : après un arrêt, un crash ou une erreur fournisseur, relancer suffit — `update` reprend les
  checkpoints dus ; une capture déjà enregistrée n'est pas dupliquée ; un checkpoint OK n'est jamais réécrit.
- **Chaque capture crée une nouvelle observation par token** (T0 = heure du scan) : un token présent dans
  plusieurs scans donne plusieurs séries qui se chevauchent, à traiter à l'analyse.
- Le dossier `data/outcomes/` (backups compris) est ignoré par git : aucune observation live n'est commitée.
