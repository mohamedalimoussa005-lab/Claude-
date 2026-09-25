# Solana Scanner — données DEX Screener + scoring

Scanner **en lecture seule** des paires Solana, alimenté par l'API publique
officielle de DEX Screener (<https://docs.dexscreener.com/api/reference>).

Pas de trading, pas d'achat, pas de wallet, pas d'IA. L'étape 1 récupère les données réelles ;
l'étape 2 les note avec deux scores **descriptifs** (voir [Scoring](#scoring)). Aucun score ne prédit le prix.

## Lancer

```bash
cd solana-scanner
npm install
npm run dev          # interface sur http://localhost:5173
npm run test:live    # test réel de tous les endpoints (nécessite l'accès réseau à api.dexscreener.com)
npm run score:live   # scan réel + top 10 par Opportunity Score, détail des points et anomalies (-- 20 pour un top 20)
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

### Données absentes

Une donnée absente n'est **jamais** remplacée par 0 : l'item qui en dépend ne reçoit aucun point, il est marqué
« absent » dans l'explication, et le manque augmente le Risk. (Un vrai `priceChange.m5 = 0 %` reçoit, lui, des points.)
Les filtres excluent une paire dont la valeur testée est absente.

### Étiquettes descriptives

`HIGH RISK` (Risk ≥ 50), `MOMENTUM` (Opportunity ≥ 60, Momentum ≥ 15/25, Risk ≤ 40), `WATCH` (Opportunity ≥ 45,
Risk ≤ 49). Elles décrivent l'état observé ; **ce ne sont pas des recommandations d'achat**.

### Interface

Colonnes Opportunity, Risk, points par catégorie, achats/ventes 5 min et 1 h ; tri par défaut sur l'Opportunity Score.
Filtres : âge max, market cap min/max, liquidité min, volume 1 h min, Opportunity min, Risk max.
Un clic sur une ligne ouvre « Pourquoi ce token a obtenu X/100 ? » : points de chaque catégorie et de chaque item,
valeur mesurée, plafonds appliqués, facteurs de risque et champs absents.
