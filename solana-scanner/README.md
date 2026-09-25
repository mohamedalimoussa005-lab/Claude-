# Solana Scanner — étape 1 : récupération des données DEX Screener

Scanner **en lecture seule** des paires Solana, alimenté par l'API publique
officielle de DEX Screener (<https://docs.dexscreener.com/api/reference>).

Pas de trading, pas d'achat, pas de wallet, pas d'IA, pas de scoring : cette
étape sert uniquement à vérifier que les données réelles sont bien récupérées.

## Lancer

```bash
cd solana-scanner
npm install
npm run dev          # interface sur http://localhost:5173
npm run test:live    # test réel de tous les endpoints (nécessite l'accès réseau à api.dexscreener.com)
npm test             # tests unitaires hors ligne (normalisation, rate limit, retries, pipeline)
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
