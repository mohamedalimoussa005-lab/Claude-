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
npm run dev          # interface sur http://localhost:5173
npm run test:live    # test réel de tous les endpoints (nécessite l'accès réseau à api.dexscreener.com)
npm run score:live   # scan réel + top 10 par Opportunity Score, détail des points et anomalies (-- 20 pour un top 20)
npm run onchain:live # scan réel → sélection des candidats → analyse on-chain (RPC Solana public), DEX et on-chain côte à côte
npm run wallets:live # + wallet intelligence sur les candidats (lent : ≈ 1 transaction/s sur le RPC gratuit)
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
financé par l'autre, présents dans les mêmes transactions, financés par la même adresse à quelques minutes
d'écart (liens forts) ; même adresse de financement à des moments différents (moyen) ; adresse de financement
très active, probablement un exchange (faible, non regroupé).

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

Conséquence : reconstruire l'historique complet de swaps et le PnL d'un wallet actif coûterait plus d'une heure
d'appels **par wallet** sans garantie d'atteindre son début. Le module ne fait donc **aucune reconstruction partielle** :
- côté token (vérifiable) : premiers et derniers acheteurs décodés depuis les soldes avant/après de chaque
  transaction (seuls les signataires sont des traders ; transferts, routes multi-tokens et quotes non-SOL sont
  ignorés, pas devinés), délai d'entrée après la première transaction, montant en SOL, market cap d'entrée
  (prix d'exécution × offre, USD estimé au prix SOL actuel), achats du deployment-associated wallet, acheteurs
  dans le bloc de création ;
- côté wallet : taille d'historique (5 pages max), financement initial, liens (réutilise les heuristiques de
  l'étape 3), et historique de trades **seulement s'il est complet** (≤ 150 transactions, budget 300 transactions
  par session). Sinon trades, PnL, rendements, entrées précoces et durée de détention restent UNKNOWN.
- non calculable sans source de prix : multiple maximum après l'entrée (pas d'OHLCV via RPC).

### Faux « smart wallets »

Pénalités : deployment-associated wallet, financé par lui ou par le même financeur, financé moins d'1 h avant
le lancement, wallet créé moins de 48 h avant son entrée, ≥ 5 000 transactions (bot / haute fréquence),
micro-transactions, achète presque tous les nouveaux tokens, potentiellement lié à d'autres acheteurs,
historique incomplet. Un ou deux trades gagnants ne suffisent jamais (poids de l'échantillon).

**Wallet Quality (0–100)** : taille d'échantillon 25, régularité 15, entrées précoces 10, performance réalisée 15,
pire position 15, complétude 20, moins les pénalités. **Wallet Confidence** : HIGH ≥ 25 positions évaluables avec
historique complet, MEDIUM ≥ 10, sinon LOW.

**Cluster adjustment** : les wallets potentiellement liés forment un seul cluster indépendant
(« 3 wallets detected, 1 independent cluster »).

### Pipeline

DEX candidates → on-chain validation → (à la demande) wallet discovery sur le token → shortlist (8 wallets :
premiers acheteurs puis plus gros) → faits par wallet et historique borné. Cache RPC + limiteurs.

## Étape 4.1 : accès aux historiques de wallets (Helius-first + fallback RPC)

Code : `src/history/` (config dans [`src/history/config.ts`](src/history/config.ts)). Couche d'accès uniquement :
aucun score modifié ou ajouté, pas encore branchée sur l'étape 4. Rien ne s'exécute dans le navigateur.

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
`.env` est ignoré par git. L'application actuelle étant 100 % frontend (Vite), il faut une petite couche serveur
(fonction serverless ou route Node) qui appelle `createServerHistoryService({ env: process.env, rpc })` et renvoie
au navigateur des transactions normalisées, jamais la clé ni une URL Helius.

### Backend local : `GET /api/wallet-history`

Code : `server/` (Node `node:http`, aucun framework, hors de `src/` donc jamais bundlé par Vite).

```bash
npm run server   # API sur http://127.0.0.1:8787 (lit solana-scanner/.env s'il existe)
npm run dev      # dans un autre terminal : Vite transmet /api au backend
```

Variables **serveur uniquement** (fichier `.env`, ignoré par git ; jamais de `VITE_*`) : `HELIUS_API_KEY` (optionnelle,
sinon RPC public), `WALLET_HISTORY_DEEP_TOKEN` (optionnelle, sinon DEEP désactivé), `WALLET_HISTORY_PORT`,
`WALLET_HISTORY_CACHE`.

| Paramètre / règle | Détail |
|---|---|
| `address` | base58 décodant exactement 32 octets ; tout autre paramètre → 400 |
| `mode=quick` | page récente + page la plus ancienne ; 30 requêtes / min / client |
| `mode=deep` | exige `WALLET_HISTORY_DEEP_TOKEN` côté serveur, `Authorization: Bearer <token>` et un client loopback ; 3 / min ; budget 20 pages / 2 000 transactions par analyse ; reprise automatique à l'appel suivant (`resumable`) |
| Réponse | `address`, `mode`, `status` (`quick_complete` / `quick_partial` / `upstream_partial` / `deep_complete` / `deep_partial`, `failed` en 502), `provider(s)`, `providerTrace`, `completeness` (`recentComplete`, `originComplete`, `historyComplete`), `resumable`, `stopReason` (QUICK : `quick_budget` ou `end_of_history`), `pagination`, `recent` (compteurs), `origin`, `transactions` (normalisées, réussies uniquement), `truncated`, `warnings` |
| `providerTrace` | étapes par phase (`recent`, `origin`, `deep`) : `helius_primary` / `helius_enhanced` / `public_rpc` × `success`, `unauthorized`, `forbidden`, `rate_limited`, `method_unavailable`, `timeout`, `network`, `invalid_response`, `unknown`, `disabled` (+ `cause`), `skipped`. Codes fixes uniquement : jamais de message amont, URL, clé, en-tête ou stack |
| `recent` | `signaturesRequested`, `signaturesListed`, `transactionsFetched`, `transactionsFromCache`, `transactionsSucceeded`, `transactionsFailed` (`null` si filtrées côté Helius), `transactionsNormalized`, `missing`. Les transactions échouées sont comptées, jamais renvoyées ni classées BUY/SELL |
| `origin` | `found`, `firstSeen`, `signature`, `method` (`helius_primary_asc`, `signature_walk`, `recent_page`, `cache`, `none`), `complete`, `reason` (`found`, `history_start_reached`, `budget_exhausted`, `primary_unavailable`, `unsupported`, `error`), `signaturesScanned`. Sans PRIMARY, la recherche reste bornée à 10 000 signatures : au-delà, `budget_exhausted` (QUICK reste QUICK). Une origine trouvée est mise en cache |
| Protections | écoute sur 127.0.0.1, en-tête Host local obligatoire (anti DNS-rebinding), 2 analyses simultanées max (503), timeout 60 s (504, l'analyse garde son créneau jusqu'à sa fin réelle), réponse ≤ 2 Mo (transactions les plus anciennes retirées, `truncated`), `cache-control: no-store` |
| Erreurs | codes fixes (`invalid_address`, `rate_limited`, `upstream_unavailable` + `{provider, kind}`…) ; jamais la clé, une URL Helius, une variable d'environnement ni le message amont |
| Cache | `MemoryHistoryCache` partagé, persisté dans `.cache/wallet-history.json` (écriture atomique, ignoré par git) après chaque analyse et à l'arrêt ; rechargé au démarrage, donc un DEEP reprend après redémarrage. Contient uniquement des transactions normalisées, l'état de pagination et les origines trouvées (snapshot v2 ; un snapshot v1 sans `version`/`origins` se recharge tel quel) |

## Étape 4.2 : Wallet Intelligence sur WalletHistoryService

Code : `src/wallets/historyFacts.ts`, `botSignals.ts`, `compare.ts`. `WalletIntelService` reçoit la couche historique
par injection (`options.history`, une instance par token) ; sans elle, le chemin RPC de l'étape 4 reste utilisé tel quel.
L'UI ne construit jamais Helius. Aucune formule de Wallet Quality ni aucun seuil de Confidence ne change.

| Point | Règle |
|---|---|
| Collecte | QUICK d'abord (activité récente + origine). DEEP seulement si l'historique est incomplet, que le wallet n'est pas clairement un bot, que son historique peut tenir dans le budget DEEP (2 000 transactions), et au plus 8 wallets par token ; désactivé par défaut (`deep: true` pour l'autoriser) |
| Limite des 150 transactions | supprimée sur ce chemin : trades, positions, PnL réalisé et win rate existent si et seulement si l'historique est **complet** (page récente couvrant tout l'historique, ou DEEP terminé), quelle que soit sa longueur |
| UNKNOWN | origine non trouvée → âge et financement UNKNOWN (listés dans `unknowns`), jamais un signal négatif ; historique incomplet → pas de trades inventés. `signatureCount` devient une borne inférieure quand l'historique est incomplet |
| Bot / haute fréquence | depuis les transactions normalisées : transactions/min, achats revendus en ≤ 60 s, reventes de la quantité exacte, nombre de tokens, tickets (seuils dans `WALLET_CONFIG.bot`). Alimente le flag existant « Activité de type bot / haute fréquence » (même sévérité, même pénalité) |
| Transferts | classés TRANSFER depuis les soldes (jamais le type Helius), conservés avec leurs contreparties ; jamais BUY/SELL |
| Distribution du créateur | transferts du deployment wallet vers d'autres wallets (nombre, destinataires, % de l'offre), destinataires suivis, et reventes observées chez 5 destinataires au plus |
| Positions | entrée, sortie, durée de détention, SOL dépensé / reçu, `realizedPnlSol` (sur la part vendue) et `closed` par position. Pas de PnL USD historique, de PnL latent ni de multiple max (pas encore d'historique de prix) |
| Comparaison | `compareIntel(old, new)` : wallets analysés, historiques complets, positions reconstruites / réalisées, signaux bot, âge et financement connus, liens créateur, entrées de Confidence disponibles. Descriptif uniquement |

`npm run wallets:live -- 1 --history [--deep]` exécute ce chemin côté Node (clé Helius lue uniquement dans ce processus).

### Étape 4.2b : résilience RPC

Code : `src/history/failure.ts`, `src/wallets/resilience.ts`. Aucune formule, pénalité ni seuil modifié.

| Point | Règle |
|---|---|
| Erreurs structurées | `quota_exhausted` (HTTP/RPC 413, « data allowance »…), `rate_limited`, `timeout`, `network`, `method_unavailable`, `invalid_response`, `rpc_error`, `unknown`. Le message amont sert uniquement à classer ; il n'est jamais stocké dans le résultat ni utilisé comme signal |
| Circuit breaker | `RunRpcGuard`, un par analyse de token : `healthy` → `quota_exhausted` → `unavailable_for_run`. Ensuite les appels au même RPC ne sont plus envoyés (échec immédiat, comptés dans `rpcCallsSkipped`). Timeout / réseau / rate limit ne l'ouvrent pas |
| Isolation par wallet | ancien et nouveau chemin : un échec rend UNKNOWN les données du wallet concerné (`failure` : code + étapes `signatures` / `funding` / `history`), les données déjà obtenues sont gardées, les wallets suivants continuent. Nouveau chemin : si tous les fournisseurs d'historique ont épuisé leur quota, les wallets restants ne sont pas demandés ; Helius reste utilisé tant qu'il répond |
| Token-fatal | uniquement si aucune signature du mint ne peut être listée (aucun acheteur identifiable) |
| Résultat | `analysisStatus` (`complete` / `partial` / `failed`) et `diagnostics` (`walletsAttempted`, `walletsCompleted`, `walletsPartial`, `walletsSkipped`, `failureKinds`, `stages`, `tokenFatal`, `rpcCircuit`, `rpcCallsSkipped`) |
| UNKNOWN | une panne ne crée aucun flag ni aucune pénalité : Quality identique à celle des mêmes faits sans l'enregistrement de l'échec. Les règles existantes s'appliquent aux données manquantes (dont le flag `incomplete`, inchangé) |
