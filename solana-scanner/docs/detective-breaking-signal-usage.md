# DETECTIVE — Breaking Signal, phase 0 (gratuit)

Phase 0 : **aucun appel X**, aucune dépense, aucun trading. X est affiché `NON CONNECTÉ` tant qu'aucune connexion officielle n'est configurée **et autorisée** (hors phase 0 : API payante).
Les événements viennent de **simulations** ou d'un **fichier JSONL** que vous fournissez.

## Commandes
```
cd solana-scanner
npm run breaking -- status
npm run breaking -- simulate all                         # 6 scénarios, fixtures hors réseau
npm run breaking -- simulate trump-launch --live-checks  # lectures gratuites réelles (RPC public, DEX Screener) + enquête DETECTIVE rapide
npm run breaking -- file events.jsonl --config config/breaking-signal.local.json
npm run breaking -- pumpportal --seconds 20              # flux gratuit des nouveaux tokens pump.fun (sans clé)
```
Derrière un proxy : `NODE_USE_ENV_PROXY=1`. Sorties : `detective-reports/breaking-<date>/results.json`.

## Niveaux (critères explicites)
- **CONFIRMÉ** : C1 identifiant numérique dans la liste blanche, C2 publication originale (ni réponse, ni citation, ni repost), C3 une seule adresse Solana valide dans le post ou sur une page d'un domaine officiel lié, C4 cette adresse est un mint SPL on-chain.
- **PROBABLE** : C1 et C2 vrais, mais contrat non établi (pas d'adresse, adresse ambiguë, adresse seulement sur un site non officiel, vérification on-chain impossible dans le délai ou négative).
- **NON VÉRIFIÉ** : tout le reste (auteur hors liste, pseudo imitateur, réponse/citation/repost).
Un token qui porte seulement le nom « Trump » ne change jamais le niveau : seule l'adresse annoncée compte. Les homonymes sont listés comme contexte, avec l'avertissement « aucun lien établi ».

## Flux
publication → réception → extraction → vérification (plafonnée par `fastCheckMs`) → **message 1** → enquête DETECTIVE rapide → **message 2**. Le message 1 ne dépend jamais de l'enquête. Chaque étape est horodatée (`results.json`, section `delays`).

## Configuration Telegram (jamais dans Git)
1. Dans Telegram, ouvrez @BotFather, `/newbot`, notez le **jeton** (forme `123456789:AA…`).
2. Écrivez un message à votre bot, puis ouvrez `https://api.telegram.org/bot<JETON>/getUpdates` dans votre navigateur (le jeton reste chez vous) et notez `chat.id`.
3. Dans votre terminal (jamais dans un fichier suivi par Git) :
```
export BREAKING_SIGNAL_TELEGRAM_TOKEN='<jeton>'
export BREAKING_SIGNAL_TELEGRAM_CHAT_ID='<chat.id>'
export BREAKING_SIGNAL_TELEGRAM_SEND=yes      # sans cette ligne: simulation, rien n'est envoyé
npm run breaking -- status                    # doit afficher « ENVOI RÉEL AUTORISÉ »
```
Le jeton n'apparaît ni dans les logs, ni dans `results.json`, ni dans les erreurs (rédaction automatique). Ne configurez pas ces variables avant d'avoir décidé d'autoriser l'envoi.

## Liste blanche
Copiez `config/breaking-signal.example.json` vers `config/breaking-signal.local.json` (ignoré par Git) et remplacez `userId` par l'**identifiant numérique** du compte (un pseudo n'est pas une identité et peut être imité ou changé). Une entrée sans identifiant numérique est ignorée.

## Limites de la phase 0
- Aucune publication X réelle n'est lue : seuls la simulation et vos fichiers alimentent le pipeline.
- Truth Social n'est pas couvert (pas d'accès gratuit légitime).
- Les latences mesurées ici sont celles du pipeline interne ; la latence de publication → détection dépendra de la source réelle.
- Pas de processus permanent : l'hébergement est à décider.

## Validation de bout en bout (phase 0)
`test/breakingSignalE2E.test.ts` : une annonce **fictive** est injectée, horodatée à la réception, la notification 1 sort en simulation sans attendre DETECTIVE, l'enquête ne démarre que si une adresse Solana valide (et un vrai mint) existe, la notification 2 porte résultats et limites, et les latences de détection, de première alerte et d'enquête sont mesurées séparément. Aucun appel réseau ni payant. Les écarts « publication → détection » sont SIMULÉS et ne représentent pas un délai réel sur X.

**La phase 0 n'est pas opérationnelle 24 h/24** : il manque une source d'événements réelle (connexion X autorisée) et un hébergement permanent.

## Configuration Telegram guidée (sur VOTRE machine)
Le jeton ne doit jamais passer par un chat ni par un argument de commande. Depuis un clone du dépôt, dans `solana-scanner/` :
```
npm run telegram -- token       # saisie masquée → vérifié (getMe) → .env.breaking (permissions 600, ignoré par Git), envoi réel DÉSACTIVÉ
npm run telegram -- chat-id     # lit getUpdates, enregistre BREAKING_SIGNAL_TELEGRAM_CHAT_ID (plusieurs conversations: relancer avec --chat-id <id>)
npm run telegram -- check --online
npm run telegram -- test        # notification de test marquée SIMULATION, NON envoyée
```
`npm run breaking -- status` charge automatiquement `.env.breaking` (sans écraser vos variables) et n'affiche que les noms des variables.
Pour autoriser l'envoi réel plus tard : mettre `BREAKING_SIGNAL_TELEGRAM_SEND=yes` dans `.env.breaking`. Un message de test réel exige en plus `npm run telegram -- test --send --confirm-send-test`.
Si vous préférez que la session cloud lise le jeton, ajoutez-le dans les paramètres de l'environnement (variable d'environnement), jamais dans le chat.
