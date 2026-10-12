# DETECTIVE — utilisation

Lecture seule d'un token Solana : un mint en entrée, un rapport (Markdown + JSON + grand livre de preuves) en sortie.
Aucun trade, aucune signature, aucun service payant, aucun verdict de fraude, aucune hypothèse de coordination.

```
npm run detective -- <MINT> [--mode rapide|standard|profond] [--out DIR] [--max-calls N] [--max-seconds N] [--helius] [--quiet]
```

Derrière un proxy : `NODE_USE_ENV_PROXY=1 npm run detective -- <MINT>`.
Par défaut : RPC Solana public + API publique DexScreener. `--helius` (explicite) utilise la clé serveur du
environnement, dont le quota n'est pas vérifié par défaut.

| Mode | Appels | Temps | Lancement (pages de 1 000 signatures) | Cohorte tracée | Sauts |
|---|---|---|---|---|---|
| rapide | 150 | 4 min | 3 | 12 | 1 |
| standard | 450 | 10 min | 15 | 30 | 2 |
| profond | 1 100 | 20 min | 60 | 50 | 2 |

`--max-calls` et `--max-seconds` abaissent (ou relèvent) les plafonds. Chaque rapport affiche les appels consommés,
le temps écoulé et les limites atteintes (« Budget consommé »).

Dix sections : identité, créateur et autorités, premiers acheteurs, financements et wallets liés, liquidité réelle,
simulations de sortie, transactions répétitives, signaux sociaux, preuves et inconnues, synthèse.

Règles : INCONNU n'est jamais « zéro » ; un historique partiel est signalé ; un pool non pris en charge (courbe pump.fun
avant migration, Raydium AMM v4, Orca, Meteora…) affiche NON SIMULÉ avec sa raison ; les formules PumpSwap sont des
INDICES (source du programme non publique) ; les p-values éventuelles ne sont jamais des probabilités de fraude.
