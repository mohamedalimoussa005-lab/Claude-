# DETECTIVE V2 — Social Radar : audit des sources, architecture, plan MVP

Statut : **proposition, aucun code**. Audit réalisé le 2026-10-12 (pages officielles quand disponibles, sinon blogs tiers, signalés « non confirmé »).
Principe : **buzz social ≠ prédiction de hausse**. Le radar décrit de l'attention observée ; il ne produit ni score d'achat, ni probabilité de hausse, ni verdict de promotion artificielle.

## 1. Audit des sources

| Source | Coût | Quotas / restrictions | Posts X réels ? | Fraîcheur | Recherche mot-clé / adresse | Évolution des mentions |
|---|---|---|---|---|---|---|
| **API officielle X** (pay-per-use) | **Payant**, sans abonnement ni minimum : lecture de post 0,005 $, lecture d'utilisateur 0,010 $, comptage récent 0,005 $/requête, comptage « all-time » 0,010 $/requête (page officielle docs.x.com) ; plus de palier gratuit pour les nouveaux développeurs (blogs tiers, non confirmé) ; plafond 3 M lectures/mois ; dédoublonnage 24 h UTC | Recherche récente sur 7 jours (blogs tiers, non confirmé sur la page officielle) ; règles de cache/redistribution non lues | **Oui** (posts, auteurs, reposts, citations) | Quasi temps réel | **Oui** : mots-clés, `$TICKER`, adresse brute, URL | **Oui, nativement** : endpoint de *comptages* par tranche horaire, beaucoup moins cher que lire les posts |
| **Scraping de x.com / Nitter / XCancel** | Gratuit en apparence | X a envoyé des mises en demeure (24 août 2026) ; les instances ont fermé puis rouvert ; viole les conditions d'accès | Oui, mais instable | Variable | Oui | Non fiable | **EXCLU** : contourne une restriction d'accès |
| **Acteurs Apify / scrapers tiers** | Payant | Revendent un accès non officiel | Oui | Variable | Oui | Oui | **EXCLU** (payant, non autorisé, zone grise) |
| **Google Trends** | API officielle : alpha sur candidature, sans tarif publié, sans date de disponibilité générale ; le site web est gratuit mais sans API ; bibliothèques non officielles cassées/instables | Fenêtre ~1 800 jours, valeurs non normalisées 0-100 (alpha) ; les « tendances du moment » semblent absentes de l'alpha (non confirmé) | **Non** (recherches Google, pas X) | Heures/jours | Mot-clé oui ; adresse de token non pertinente | Oui (intérêt de recherche) |
| **Flux RSS** (presse crypto, Google Actualités RSS, blogs) | Gratuit | Pas de quota central ; politesse (ETag, ≥ 5 min) ; licences de réutilisation variables | **Non** (actualités) | Minutes à heures | Mot-clé : filtre local ; Google Actualités accepte `q=` | Oui, en comptant les articles/jour par sujet |
| **GDELT DOC 2.0** | Gratuit, anonyme | ~1 requête/5 s (source tierce, non confirmé) ; liste d'articles limitée à ~3 mois, séries temporelles depuis 2017 | **Non** (presse mondiale) | ~15 min | Mot-clé oui ; adresse non | **Oui** (mode timeline natif) |
| **DexScreener** (déjà dans le projet) | Gratuit | 60 req/min sur profils/boosts/metas ; `token-profiles`, `community-takeovers`, `metas/trending`, `ads/latest` | Non, mais **liens X/Telegram/site déclarés** par le projet, et signaux d'attention payante (boosts, ads) | Minutes | Par adresse (déjà utilisé) | Oui pour boosts/metas |
| **Bluesky Jetstream** | Gratuit, sans clé | Flux en direct seulement (pas d'historique) ; pas de recherche par mot-clé dans le flux | Non (autre réseau) | Temps réel | Filtre local | Seulement depuis le début de la capture |
| Reddit / Telegram public | Non audité (aucune donnée fiable obtenue) | — | Non | — | — | — |

**Conclusions de l'audit**
1. Les **vrais posts X** ne sont accessibles légitimement que par l'**API officielle, payante** (pay-per-use). Il n'existe pas de voie gratuite légitime. Toute utilisation exige votre autorisation et un plafond en dollars.
2. Le **coût dépend du mode d'appel** : les *comptages* (0,005 $ la requête) donnent l'évolution des mentions sans lire les posts ; la lecture de posts (0,005 $ pièce) ne se fait que sur un échantillon plafonné, pour obtenir comptes distincts, reposts et liens.
3. **Gratuit et légitime pour le MODE 1 (news first)** : RSS + GDELT + Google Actualités RSS + DexScreener (profils, boosts, metas). Ils couvrent l'actualité, pas X.
4. **Google Trends** : à garder comme source optionnelle (candidature à l'alpha), pas comme dépendance.
5. Sans clé X, le radar fonctionne en **mode dégradé** : actualités + liens déclarés ; la partie X est marquée **INCONNUE**.

## 2. Architecture `src/detective/social-radar/`

```
social-radar/
  types.ts            SourceStatus, Post, Article, Topic, Mention, RadarFinding (niveaux FAIT / INDICE / INCONNU)
  budget.ts           plafonds en appels ET en dollars par source; refus avant dépassement; rapport de coût
  NewsCollector.ts    RSS + GDELT + Google Actualités RSS → Article[] (URL, éditeur, date, titre); dédoublonnage par URL canonique et titre normalisé
  XPostCollector.ts   adaptateur API officielle X: comptages (courbe horaire) puis échantillon plafonné de posts; désactivé sans clé → INCONNU
  TrendDetector.ts    séries par sujet, accélération, mise en regard avec la base du sujet
  TopicToTokenMatcher.ts  sujet ↔ token: correspondances explicites seulement, avec ancre et niveau
  SocialEvidenceLedger.ts adaptateur du grand livre 5A existant (ancres URL/ID de post), aucun nouveau format
  SocialRadarReport.ts    sections JSON + Markdown, statut de chaque source, coût, limites
  run.ts              MODE 1 (news first) et MODE 2 (token first), branchés sur runDetective
```

- **Réutilisation** : `EvidenceLedger` (ancres URL), `Meter`/budget (étendu aux dollars), `DexScreenerClient`, rendu Markdown, modes rapide/standard/profond. Le radar n'importe ni les scores existants ni les hypothèses de coordination.
- **Isolation** : comme `detective/`, le radar est une couche d'intégration en lecture seule ; test de garde interdisant tout lien vers les scores Opportunity/Risk/Quality/Confidence.
- **Sources absentes** : chaque collecteur retourne `{status: "ok" | "partial" | "unavailable", reason}` ; `unavailable` produit des lignes INCONNU, jamais « 0 mention ».
- **Intégration** : MODE 1 produit une liste de tokens candidats puis appelle `runDetective` (mode rapide par défaut) ; MODE 2 ajoute au rapport existant une section « Mentions sociales » (8 bis).

## 3. Méthodes

**Accélération des mentions.** Séries horaires de mentions *uniques* par sujet. Mesure descriptive : ratio de la fenêtre récente (ex. 1 h) à la médiane des 24 h précédentes, et dérivée seconde sur 3 fenêtres. Un plancher de volume (ex. ≥ 20 mentions) évite les ratios sur de petits effectifs. Aucune p-value présentée comme probabilité ; l'accélération est toujours accompagnée du volume brut et de l'intervalle de couverture.

**Reposts et doublons.** Un repost ou une citation n'est jamais compté comme mention distincte : on compte les *posts originaux* ; les reposts forment un compteur de diffusion séparé. Dédoublonnage par ID de post, URL canonique, et empreinte du texte normalisé (minuscules, sans URL ni mention, suppression des emojis) avec seuil de quasi-doublon (shingles/Jaccard). Les articles de presse sont dédoublonnés par URL canonique et titre ; les dépêches reprises comptent pour une seule histoire.

**Comptes répétitifs.** Descriptif seulement : part des mentions venant du top 5 de comptes, publications du même texte par plusieurs comptes, cadence très régulière, âge des comptes (si l'API le donne), ratio liens/publications. Chaque indice est un INDICE avec ses explications ordinaires (communauté, bot de veille légitime, annonce officielle).

**Sujet viral ou campagne promotionnelle.** Pas de verdict. On rapporte trois dimensions mesurées : *diversité* (comptes distincts / mentions, entropie des auteurs), *originalité* (part de textes quasi identiques), *incitation* (présence d'adresse de token, de `$TICKER`, de liens vers des plateformes de lancement dans les posts). Un sujet « large, divers, sans adresse de token » se décrit comme attention organique *apparente* ; un sujet « étroit, textes quasi identiques, adresse répétée » se décrit comme *ressemblant à une campagne coordonnée*, avec les explications ordinaires. Les hypothèses de coordination restent désactivées.

**Relier une actualité à un token sans inventer d'affiliation.** Échelle de preuve explicite :
1. FAIT : un post/article contient *l'adresse exacte* du mint (lien d'ancre = URL du post).
2. FAIT déclaré : le profil DexScreener/pump.fun du token déclare ce compte X ou ce site.
3. INDICE : le nom/ticker du token correspond au sujet (homonymie très probable pour les tickers courts) ; toujours accompagné de « aucune affiliation établie ».
4. INCONNU sinon. Une ressemblance de nom n'est jamais présentée comme un lien ; plusieurs tokens du même nom → liste complète, jamais « le » token.

**Fraîcheur et couverture.** Chaque série porte : heure de la dernière donnée, retard de la source, fenêtre couverte, part d'échantillon lu vs total (via les comptages), plafonds atteints. Sources en panne = INCONNU. Rapport de couverture par source dans chaque sortie.

**Interdits permanents.** Pas de prédiction de prix, pas de score de hausse, pas de signal d'achat ; ne pas fusionner avec les scores existants ; formulation « attention observée », jamais « va monter ».

## 4. Plan MVP en deux étapes

**Étape 1 — Sans coût : NEWS FIRST + liens déclarés (aucune API payante)**
- `NewsCollector` (RSS choisis + GDELT timeline + Google Actualités RSS), `TrendDetector`, `TopicToTokenMatcher` (adresse exacte, liens déclarés DexScreener, correspondances de nom marquées INDICE), `SocialEvidenceLedger`, `SocialRadarReport`.
- Commande : `npm run detective -- radar --topics` (sujets en hausse + tokens candidats) et envoi des candidats à `runDetective` en mode rapide.
- Tests sans réseau (fixtures RSS/GDELT figées), garde d'isolation, rapport avec sections INCONNU pour X.
- Coût : 0 $. Livrable : radar de l'actualité (pas de posts X), prêt à brancher.

**Étape 2 — TOKEN FIRST sur X (uniquement après votre autorisation écrite et un plafond en dollars)**
- `XPostCollector` sur l'API officielle : d'abord les *comptages* d'une requête (adresse, `$TICKER`) pour la courbe d'évolution (≈ 0,005 $ par requête), puis un échantillon plafonné de posts (par exemple 100 posts ≈ 0,50 $) pour comptes distincts, reposts, liens vers les posts originaux, indices de répétition.
- Budget en dollars dans `Meter` : arrêt avant dépassement, coût affiché dans « Budget consommé ». Mode `--x-budget 1.00`, désactivé par défaut.
- Test réel unique sur 1 à 3 tokens avec plafond strict (ex. ≤ 2 $), clé jamais affichée ni stockée dans les rapports.
- À vérifier avant : règles officielles de stockage/redistribution des données X et fenêtre de recherche exacte, que je n'ai pas pu lire sur la page officielle.

## 5. Décisions attendues de vous
1. Autorisez-vous l'Étape 1 (0 $) ?
2. Autorisez-vous l'achat de crédits API X, avec quel plafond mensuel (ex. 5 $) ? Sans cela, la partie X reste INCONNUE.
3. Souhaitez-vous candidater à l'alpha de l'API Google Trends (gratuit, résultat incertain) ?

## Sources
- X API, tarification officielle : https://docs.x.com/x-api/getting-started/pricing
- Blogs tiers (non confirmés) : https://www.outstand.so/blog/x-api-pricing ; https://twitterapi.io/blog/x-api-cost-breakdown-2026
- Google Trends API alpha : https://ppc.land/google-opens-alpha-testing-for-new-trends-api-targeting-developers-and-journalists/ ; https://konabayev.com/blog/google-trends-api-landscape-2026/
- GDELT : https://blog.gdeltproject.org/doc-2-0-updates-1-5-year-searching-and-updated-mobile-interface/
- Nitter/X : https://thenextweb.com/news/nitter-xcancel-offline-x-cease-and-desist ; https://alternativeto.net/news/2026/9/open-source-x-front-ends-nitter-and-xcancel-resume-service-after-seeking-legal-advice/
- DexScreener : https://docs.dexscreener.com/api/reference
- Bluesky Jetstream : https://simonwillison.net/2024/Nov/20/bluesky-websocket-firehose

## 6. Statut — étape 1 implémentée (2026-10-13)

Commande : `env -u HELIUS_API_KEY NODE_USE_ENV_PROXY=1 npm run radar -- [--top N] [--detective N] [--min-strength 1-5] [--max-requests N] [--max-seconds N] [--detective-calls N] [--no-gdelt] [--out DIR]`
(`NODE_USE_ENV_PROXY=1` n'est nécessaire que derrière un proxy.) Sorties : `radar.md`, `radar.json`, `ledger.json`.

Sources utilisées (0 $) : flux RSS publics (Google Actualités top/technologie/divertissement, BBC World, Cointelegraph), GDELT (séries de couverture, ≥ 5,5 s entre requêtes), DEX Screener (recherche, profils récents, pools d'un token). Les flux Google Actualités et BBC sont fournis pour une lecture personnelle non commerciale. Aucune publication X n'est lue.

Règles de preuve : adresse citée + pool DEX Screener ou lien déclaré par le projet = FAIT (5/5) ; nom+symbole (4/5), nom exact (3/5), profil (2/5), symbole seul (2/5) = INDICE ; un nom porté par 2 tokens plafonne à 3/5, par 3 tokens ou plus à 2/5 ; seules les associations de force ≥ 3 partent vers DETECTIVE (mode rapide). L'étape 2 (X payant) n'est pas implémentée.
