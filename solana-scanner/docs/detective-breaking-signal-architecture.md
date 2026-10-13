# DETECTIVE — Breaking Signal : comparaison d'architectures (proposition, aucun code)

Date de l'audit : 2026-10-13. Sources officielles lues : docs.x.com (tarifs, filtered stream). Le reste vient de pages tierces, signalées « non confirmé ».
Principe : une alerte dit « une annonce a été publiée » ; elle ne dit jamais « achetez ». Aucun trade automatique. Aucune promesse d'être le premier : les robots on-chain réagissent en secondes, et ce produit informe, il n'exécute pas.

## 1. Faits vérifiés sur les accès

| Sujet | Constat | Confiance |
|---|---|---|
| Tarifs X (pay-per-use) | 0,005 $ par post lu, 0,010 $ par utilisateur lu, comptages 0,005 $, aucun minimum, plafond 3 M lectures/mois, dédoublonnage 24 h UTC | officiel |
| X Filtered Stream | **disponible en pay-per-use** : 1 connexion, 1 000 règles, opérateur `from:compte`, latence « near real-time », **~4-5 s P99** annoncées ; facturation du flux **non précisée** sur la page (des tiers disent qu'il est facturé comme des lectures de posts, d'autres qu'il est absent du pay-per-use) | officiel pour la disponibilité, **à confirmer dans la console** pour le prix |
| X lecture de la chronologie d'un compte | pas de tarif distinct trouvé : chaque post renvoyé = 1 lecture (0,005 $). Les requêtes qui ne renvoient aucun nouveau post ne devraient rien coûter, **non confirmé** ; limites de débit de l'endpoint non lues | tiers |
| Truth Social | aucune API publique ; flux de données sous licence payant (« Truth API », prix non publié, des chiffres à 100 000 $/mois ont été rapportés par la presse) ; le scraping est présenté par TMTG comme une violation de ses conditions | tiers |
| Telegram Bot API | gratuit ; limites non documentées précisément, repères communautaires : ~1 message/s par conversation privée, ~20/min par groupe, ~30/s au total | tiers |
| PumpPortal `subscribeNewToken` | flux websocket de créations de tokens pump.fun/PumpSwap, annoncé gratuit ; une clé figure dans l'URL, charges utiles non documentées sur la page lue ; une seule connexion | officiel partiel |
| Helius | Free 1 M crédits, Developer 49 $, Business 499 $ ; un événement webhook = 1 crédit ; gRPC LaserStream mainnet seulement en Professional (999 $/mois) | tiers |
| Hébergement | cette session tourne dans un **conteneur éphémère** : un guetteur 24/7 exige un hébergement permanent (hors budget X de 5 $) | constat |

Budget X de 5 $ ⇒ environ **1 000 lectures de posts par mois**, soit ~33 posts par jour tous comptes confondus.
Exemple : 2 comptes à 15 posts par jour = 900 lectures = **4,50 $/mois**. Au-delà, le garde-fou coupe la surveillance.

## 2. Les trois architectures

### A. Surveillance ciblée des comptes officiels (X)
- **Fonctionnement** : liste blanche d'identifiants numériques de comptes (pas de pseudos), lus par Filtered Stream (`from:`) ou par interrogation périodique avec `since_id`. Chaque nouveau post : extraction (adresses Solana, tickers, liens, entités), vérification, notification, puis enquête DETECTIVE.
- **Coût** : lectures facturées par post reçu ; 2 comptes peu bavards ≈ 4,5 $/mois ; un compte très actif fait exploser le budget (80 posts/jour ≈ 12 $/mois). Flux ou chronologie à confirmer avant tout achat. Crédits non dépensés tant que vous n'avez pas autorisé.
- **Latence possible** : flux annoncé ~4-5 s P99 côté X ; interrogation toutes les 15 s ≈ 8-10 s en moyenne (demi-intervalle + réseau) ; vérification rapide 2-10 s ; envoi Telegram ~1-2 s. Ordre de grandeur de bout en bout : **10 à 30 s**, **non garanti**.
- **Fiabilité** : élevée pour l'origine (identifiant d'auteur vérifié) ; faible si le compte est piraté ou si l'annonce est publiée ailleurs d'abord.
- **Limites** : Truth Social non couvert (API payante ou scraping exclu) ; coût proportionnel au volume ; une annonce faite uniquement sur Truth Social n'est vue qu'avec retard (via X, si repostée, ou via B).

### B. Actualités et annonces officielles
- **Fonctionnement** : RSS (Google Actualités, presse, sites officiels), GDELT, flux de la Maison-Blanche/entreprises, déjà en place dans le Social Radar étape 1.
- **Coût** : 0 $.
- **Latence mesurée** : lors de nos essais réels, les articles les plus récents avaient 9 à 15 min (Google Actualités, BBC), 2,3 h (Cointelegraph) ; GDELT a répondu 429 ou vide. Ordre de grandeur : **minutes à dizaines de minutes**.
- **Fiabilité** : bonne pour la confirmation (éditeurs identifiés, recoupement entre sources), mauvaise pour la rapidité.
- **Limites** : jamais la source primaire ; l'adresse du contrat est rarement citée ; sujet couvert seulement quand la presse le reprend.

### C. Détection on-chain de nouveaux tokens, puis vérification sociale
- **Fonctionnement** : flux de créations (PumpPortal gratuit pour pump.fun/PumpSwap, ou webhooks Helius), filtre sur nom/ticker, vérification sociale ensuite.
- **Coût** : 0 $ avec le flux PumpPortal gratuit (à tester) ; Helius : 1 crédit par événement, donc le volume de pump.fun épuise 1 M de crédits gratuits très vite ; gRPC temps réel = 999 $/mois (hors budget).
- **Latence** : secondes après la création du token, **avant** toute annonce si le token existe d'abord.
- **Fiabilité** : très faible pour « officiel ou non » : des dizaines de faux « TRUMP » apparaissent (nos essais en ont déjà montré plusieurs homonymes) ; ne distingue pas le vrai du faux sans source sociale.
- **Limites** : ne couvre que les plateformes lues (le lancement de TRUMP n'était, à ma connaissance, pas un lancement pump.fun, **à vérifier**) ; ne répond pas au cas 2 (aucun token n'existe).

## 3. Recommandation : MVP « Breaking Signal »

**A (X, liste blanche stricte) + B (corroboration gratuite) + DETECTIVE en deux temps, avec C seulement comme vérification ponctuelle.**

Chaîne :
1. Garde-fou de budget (compteur en dollars, coupure à 4 $, rapport de coût dans chaque alerte).
2. Un nouveau post d'un compte de la liste blanche (par identifiant numérique) déclenche l'analyse.
3. Extraction : adresses Solana (validées), tickers, liens, entités, mots-clés.
4. Vérification : l'auteur est dans la liste blanche, le post est original (pas une réponse ni une citation d'un tiers), l'adresse figure dans le texte du post ou sur une page officielle liée (domaine autorisé), recoupement éventuel par B, cohérence on-chain (le mint existe, âge, autorités, créateur). Niveaux : CONFIRMÉ, PROBABLE, NON VÉRIFIÉ.
5. **Alerte 1 (immédiate)** : lien du post original, texte, horodatage du post, adresse si présente, niveau de vérification, faits on-chain obtenus en peu d'appels, mention « pas un conseil d'investissement ».
6. **Alerte 2 (quelques minutes)** : enquête DETECTIVE rapide sur le token (profondeur, autorités, premiers acheteurs), car elle prend 1 à 5 min sur RPC public.
7. Cas 2 (aucun token) : alerte « personnalité X parle de Y » avec l'entité extraite et un suivi gratuit (B + recherche DEX Screener) pendant quelques heures.
8. Journal de latences : publication (horodatage dérivé de l'identifiant du post), réception, vérification, envoi, accusé Telegram. Rapport hebdomadaire de ces délais, sans promesse.

Prévention des fausses annonces : identifiants numériques (pas de pseudos), alerte sur tout changement de nom d'utilisateur, comptes imitateurs ignorés, adresse hors du post et hors du domaine officiel = NON VÉRIFIÉ, un compte piraté reste possible donc la cohérence on-chain et la corroboration gardent leur rôle.

## 4. Limites assumées
- **Truth Social** : non couvert dans ce MVP (pas d'accès légitime gratuit). Une annonce sur Truth Social n'arrivera que par X (si repostée) ou par B.
- **Latence** : annoncée par X ~4-5 s (P99, flux) ; le bout en bout reste de l'ordre de la dizaine de secondes, jamais garanti.
- **Hébergement** : il faut un processus permanent (hors conteneur éphémère).
- **Coût** : 5 $/mois ≈ 1 000 lectures ; 2 à 3 comptes peu actifs au maximum.

## 5. Décisions et vérifications avant tout code
1. Autorisez-vous l'ouverture d'un compte développeur X avec un premier crédit limité (par exemple 5 $), seulement après lecture dans la console de la facturation du flux filtré et des limites de la chronologie ?
2. Quels comptes ? Identifiants numériques à fixer (par exemple @realDonaldTrump), plus les domaines officiels autorisés.
3. Canal : bot Telegram (gratuit) vers une conversation privée. Le jeton du bot ne sera jamais affiché ni stocké dans les rapports.
4. Hébergement permanent : acceptez-vous un petit serveur (coût hors budget X) ?
5. Phase 0 à 0 $ avant d'acheter quoi que ce soit : tester PumpPortal gratuit et mesurer le délai de Google Actualités sur un événement connu, puis simuler tout le pipeline sur fixtures.
