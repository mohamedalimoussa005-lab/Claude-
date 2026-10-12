# DETECTIVE — rapport du token 47fwKU1UvbtatYoFYp7ThLkYjqBudAv8UbuhBLf2CK4G

_Généré le 2026-10-12T15:05:13.806Z · mode **rapide** · lecture seule (aucun trade, aucune écriture)_

> Ce rapport décrit des données observées et des mesures; il ne prédit ni le prix ni une fraude et ne constitue pas un conseil.
> Les simulations de vente sont des calculs sur l'état du pool à un instant donné, pas une garantie d'exécution.
> Aucune hypothèse de coordination n'est produite; un groupe de wallets décrit une ressemblance de comportement ou de financement, jamais un propriétaire commun.
> Les scores expérimentaux (brouillons) ne sont ni additionnés ni comparés aux scores Opportunity, Risk, Quality, Confidence existants.
> INCONNU signifie que la donnée n'a pas pu être établie avec le budget et les sources disponibles, pas qu'il n'y a rien.

| Niveau | Sens |
|---|---|
| FAIT | lu directement (signature, slot, compte) ou arithmétique exacte dessus |
| INDICE | règle explicite ou déclaration d'un tiers : suggestif, jamais une preuve |
| INCONNU | non établi avec le budget et les sources disponibles |
| NON SIMULÉ | venue non prise en charge par le moteur de liquidité (raison indiquée) |
| HYPOTHÈSE | **désactivée** : ce produit n'en émet aucune |

## Synthèse
- **[INCONNU]** Limites atteintes pendant l'analyse: budget de temps atteint (300 s) ; lecture des transactions du mint interrompue (budget de temps atteint (300 s)) ; financement non lu pour 5 wallet(s) de la cohorte (budget). Les sections concernées sont partielles.
- **[INCONNU]** Sections partielles ou inconnues: Identité du token, Premiers acheteurs, Financements et wallets liés, Transactions répétitives, Signaux sociaux disponibles.
- **[FAIT]** Aucune autorité de mint ou de gel active, aucun délégué permanent, hook ni frais de transfert natifs détectés.
- **[FAIT]** Concentration: les 10 plus gros détenteurs (hors comptes techniques) en ont 99.9 % de l'offre; le premier en a 94.9 %.
- **[INDICE]** Le wallet associé au déploiement (non prouvé comme développeur) détient 0.0 % de l'offre.
- **[FAIT]** À l'instant lu, 922 096 $ d'achats font monter le prix de 1 %; côté vente, le prix ne peut pas baisser de 1 % (au plus 1.19 $ récupérables avant épuisement de la liquidité de vente).
- **[FAIT]** La liquidité de vente est épuisée avant −5 %: la sortie de grosses positions peut être impossible au prix affiché.
- **[FAIT]** Aller-retour immédiat de 1 000 $ : perte de 0.02 % (frais et taxes inclus).
- **[FAIT]** Vendre 5 % de l'offre n'est pas exécutable dans l'état du pool (capacité 1.19 $).
- **[FAIT]** Premiers acheteurs lus: 5; ils détiennent encore 0.0 % de l'offre à la fin de la fenêtre lue; top 5 = 100.0 % des achats de la cohorte.
- **[INCONNU]** Groupes de wallets: test non exécutable (financement connu pour 0 wallet(s) sur 5 (seuil: 12 wallets et 50 %): l'absence de lien n'est pas établie); les groupes sont décrits sans p-value.
- **[INDICE]** Volume lu: 0.0 % d'aller-retours rapides; mesures descriptives, sans verdict.
- **[INDICE]** Aucun verdict n'est émis: ni fraude, ni probabilité, ni conseil. Les hypothèses de coordination sont désactivées; les groupes décrits sont des ressemblances de comportement ou de financement.

## 1. Identité du token

> Section PARTIELLE — voir les limites et inconnues ci-dessous.

- **[INDICE]** Nom déclaré par DEX Screener: Gensyn (AI).
- **[FAIT]** Supply 999 998 295,23 (6 décimales), programme SPL Token. _(ancres: 47fwKU…f2CK4G)_
- **[FAIT]** Autorité de mint: révoquée (aucune adresse ne peut créer de nouveaux tokens). _(ancres: 47fwKU…f2CK4G)_
- **[FAIT]** Autorité de gel: révoquée (aucune adresse ne peut geler des comptes). _(ancres: 47fwKU…f2CK4G)_
- **[FAIT]** Programme SPL Token classique: aucune taxe de transfert native (pas d'extension Token-2022). _(ancres: 47fwKU…f2CK4G)_
- **[FAIT]** 27 détenteurs (45 comptes). Concentration brute top 1/5/10: 99.39 % / 100.00 % / 100.00 %; hors comptes techniques (pools, burn…) 94.88 % / 99.77 % / 99.87 %. _(ancres: 47fwKU…f2CK4G)_
- **[INDICE]** Règle existante du scanner: Un compte non technique (3QG3…QoLc, wallet) détient 94.88 % de l'offre hors pools / bonding curve / burn. Un gros holder n'est pas forcément malveillant, mais il peut peser fortement sur le prix.
- **[INDICE]** Règle existante du scanner: Top 10 très concentré : 99.87 % (ajusté).
- **[INDICE]** Règle existante du scanner: Seulement 27 holders avec un solde non nul.

**Inconnu :**
- Activité du deployment-associated wallet : 6 transaction(s) récente(s) analysée(s) sur 25 récupérées ; des ventes plus anciennes ne sont pas vérifiées.

**Limites :**
- une taxe appliquée par un programme tiers (hook) ou par la logique du pool n'est pas détectée ici; les frais de pool sont lus dans la section Liquidité

## 2. Créateur et autorités
- **[INDICE]** Wallet associé au déploiement: E3UoKyex8msmNMNH1yd2X6w1Z6zQ9uaqGwxtqp2XQpZT (méthode: fee payer de la transaction de création du mint). Ce n'est pas prouvé comme étant le développeur réel. transaction 5ZLXyacTujDFPcy11g3acMVEC4myeSen7xDYyDBXzMu2uFanSArSEihAi4tT93PVWfF6MH2Dk1tQcVBGCNvGHrSq _(ancres: E3UoKy…2XQpZT)_
- **[FAIT]** Solde du wallet: 0.232 SOL; détient 0.00 % de l'offre; 6 transaction(s) récente(s) analysée(s) sur 25 signature(s) lues. _(ancres: E3UoKy…2XQpZT)_

**Limites :**
- le créateur est une heuristique (courbe pump.fun, pool PumpSwap, premier signataire): jamais une identité

## 3. Premiers acheteurs

> Section PARTIELLE — voir les limites et inconnues ci-dessous.

- **[FAIT]** Lecture: 18 transaction(s) lue(s) sur 1399 signature(s) listée(s); 9 swap(s) décodé(s), quote SOL. _(ancres: 47fwKU…f2CK4G)_
- **[FAIT]** 5 acheteur(s) distinct(s) dans la fenêtre de lancement (5 swaps, premier slot 430107562); 1 au premier slot, 1 dans les 5 premiers. L'ordre dans un même slot est inconnu. _(ancres: TzMSDU…b9GzPj, 2N3ZFi…vHZLsk, 3KzW8v…EsFahe)_
- **[FAIT]** Part de l'offre encore détenue par ces acheteurs à la fin de la fenêtre lue (achats moins ventes): 0.0 %; achats bruts cumulés: 0.0 % de l'offre (peut dépasser 100 % si des wallets rachètent).
- **[FAIT]** Concentration des achats de la cohorte: les 5 plus gros représentent 100.0 % des tokens achetés; HHI 0.200, Gini 0.00 (sur les montants payés).
- **[INDICE]** Synchronie des premiers achats: 0 paire(s) d'acheteurs à ≤ 1 slot d'écart contre 0.5 attendues d'après le rythme d'arrivée du lancement lui-même (rapport 0.00). Mesure descriptive: aucune p-value, aucun verdict (un lancement populaire concentre naturellement les achats).

**Inconnu :**
- 32 transaction(s) listée(s) mais non lue(s)

**Limites :**
- 18 transaction(s) lue(s) sur 1399 signature(s) listée(s)
- lecture limitée aux transactions les plus anciennes du mint: l'activité plus récente n'est pas vue

## 4. Financements et wallets liés

> Section PARTIELLE — voir les limites et inconnues ci-dessous.

- **[FAIT]** Financement tracé pour 5 wallet(s) de la cohorte (0 avec un premier financeur observé ou un historique complet sans financement, 5 INCONNU); 0 non tracé(s) faute de plafond.
- **[INCONNU]** Liens de financement avec le créateur: INCONNUS (historique du créateur partiel ou indisponible).
- **[INCONNU]** Test statistique des groupes: UNKNOWN — financement connu pour 0 wallet(s) sur 5 (seuil: 12 wallets et 50 %): l'absence de lien n'est pas établie
- **[FAIT]** Aucun groupe de wallets à signaux multiples détecté dans les données lues.
- **[INDICE]** Hypothèses de coordination: DÉSACTIVÉES. Ce rapport décrit des liens observés et des mesures, il n'affirme aucune coordination.

**Inconnu :**
- 5 wallet(s) dont l'historique n'a pas été lu (budget)
- financement de 5 wallet(s): historique absent ou partiel, l'absence de lien n'est PAS établie
- historique du créateur indisponible: ses financeurs ne sont pas connus
- 5 wallet(s) avec historique partiel: le premier financement observé n'est peut-être pas le premier
- 5 wallet(s) sans historique disponible

**Limites :**
- 12 wallets et 1 saut(s) au plus (mode rapide); 1 page(s) de signatures et 6 plus anciennes transactions lues par wallet
- seuls les virements SOL système sont vus; les dépôts via jetons enveloppés ou intermédiaires ne le sont pas

## 5. Liquidité réelle
- **[FAIT]** Pool analysé: Raydium CLMM 57rXsAM2DAoyzbbcwHqGMxsjxC2X4EjBEhJ6oWJ4yL1P (état lu au slot ≈ 456089848, époque 1055). _(ancres: 57rXsA…J4yL1P)_
- **[FAIT]** Frais: frais de trade 0.01 % (100/1 000 000) prélevés sur le token d'entrée. _(ancres: 57rXsA…J4yL1P)_
- **[INDICE]** Liquidité déclarée par DEX Screener (tiers): 33 901 063 $; volume 24 h 99 558 $. Ces chiffres ne sont pas la liquidité réellement exécutable ci-dessous. _(ancres: 57rXsA…J4yL1P)_
- **[INDICE]** Hypothèse du calcul: liquidity changes only at the loaded initialized ticks.
- **[INDICE]** Hypothèse du calcul: pool state frozen at the snapshot slot.
- **[INDICE]** Hypothèse du calcul: no concurrent trades, no slippage limit, no priority fee or tip.
- **[FAIT]** Profondeur d'achat — +0,5 % de prix: 461 622 $ d'achats (reçoit 460 426 $ de tokens). _(ancres: 57rXsA…J4yL1P)_
- **[FAIT]** Profondeur d'achat — +1 % de prix: 922 096 $ d'achats (reçoit 917 428 $ de tokens). _(ancres: 57rXsA…J4yL1P)_
- **[FAIT]** Profondeur d'achat — +5 % de prix: 4 565 604 $ d'achats (reçoit 4 455 128 $ de tokens). _(ancres: 57rXsA…J4yL1P)_
- **[FAIT]** Profondeur d'achat — +10 % de prix: 9 023 737 $ d'achats (reçoit 8 602 936 $ de tokens). _(ancres: 57rXsA…J4yL1P)_
- **[FAIT]** Profondeur de vente — −0,5 % de prix: non atteignable — au plus 1.19 $ de tokens vendables pour 1.19 $ (la liquidité s'épuise avant (liquidité épuisée: plus aucun tick initialisé après avoir consommé 34992361 sur 67108864)). _(ancres: 57rXsA…J4yL1P)_
- **[FAIT]** Profondeur de vente — −1 % de prix: non atteignable — au plus 1.19 $ de tokens vendables pour 1.19 $ (la liquidité s'épuise avant (liquidité épuisée: plus aucun tick initialisé après avoir consommé 34992361 sur 67108864)). _(ancres: 57rXsA…J4yL1P)_
- **[FAIT]** Profondeur de vente — −5 % de prix: non atteignable — au plus 1.19 $ de tokens vendables pour 1.19 $ (la liquidité s'épuise avant (liquidité épuisée: plus aucun tick initialisé après avoir consommé 34992361 sur 67108864)). _(ancres: 57rXsA…J4yL1P)_
- **[FAIT]** Profondeur de vente — −10 % de prix: non atteignable — au plus 1.19 $ de tokens vendables pour 1.19 $ (la liquidité s'épuise avant (liquidité épuisée: plus aucun tick initialisé après avoir consommé 34992361 sur 67108864)). _(ancres: 57rXsA…J4yL1P)_
- **[FAIT]** Rapport sortie/entrée à ±1 %: 0.00000129 (1 = symétrique, proche de 0 = pool à sens unique).

**Limites :**
- instantané unique: l'état du pool change à chaque transaction
- les autres pools du token ne sont pas inclus
- priorité, pourboires, MEV et restrictions de compte (gel, hooks) ne sont pas modélisés

## 6. Simulations de sortie
- **[INDICE]** Simulation sur un état figé du pool: ni une cotation ni une garantie d'exécution. Ignore frais de priorité, pourboires, MEV, autres pools, restrictions du programme de token (gel, hooks) et tout changement après l'instantané.
- **[FAIT]** Achat — achat de 50 $: reçoit 50 $ pour 50 $; impact d'exécution 0.01 %.
- **[FAIT]** Achat — achat de 100 $: reçoit 100 $ pour 100 $; impact d'exécution 0.01 %.
- **[FAIT]** Achat — achat de 500 $: reçoit 500 $ pour 500 $; impact d'exécution 0.01 %.
- **[FAIT]** Achat — achat de 1000 $: reçoit 1 000 $ pour 1 000 $; impact d'exécution 0.01 %.
- **[FAIT]** Achat — achat de 10000 $: reçoit 9 998 $ pour 10 000 $; impact d'exécution 0.02 %.
- **[FAIT]** Vente — vente de 1 % de l'offre: IMPOSSIBLE (liquidité épuisée: plus aucun tick initialisé après avoir consommé 34992361 sur 9999982952323); capacité maximale 1.19 $.
- **[FAIT]** Vente — vente de 5 % de l'offre: IMPOSSIBLE (liquidité épuisée: plus aucun tick initialisé après avoir consommé 34992361 sur 49999914761617); capacité maximale 1.19 $.
- **[FAIT]** Aller-retour immédiat de 50 $: récupère 50 $, perte 0.02 % (frais et taxes inclus).
- **[FAIT]** Aller-retour immédiat de 100 $: récupère 100 $, perte 0.02 % (frais et taxes inclus).
- **[FAIT]** Aller-retour immédiat de 500 $: récupère 500 $, perte 0.02 % (frais et taxes inclus).
- **[FAIT]** Aller-retour immédiat de 1 000 $: récupère 1 000 $, perte 0.02 % (frais et taxes inclus).
- **[FAIT]** Aller-retour immédiat de 10 000 $: récupère 9 998 $, perte 0.02 % (frais et taxes inclus).

**Limites :**
- Simulation sur un état figé du pool: ni une cotation ni une garantie d'exécution. Ignore frais de priorité, pourboires, MEV, autres pools, restrictions du programme de token (gel, hooks) et tout changement après l'instantané.

## 7. Transactions répétitives

> Section PARTIELLE — voir les limites et inconnues ci-dessous.

- **[FAIT]** 9 swap(s) lus, 9 wallet(s) distinct(s) jugés; les 5 plus gros wallets font 55.6 % du volume jugé; le wallet associé au déploiement 0.0 %.
- **[INDICE]** Aller-retours (achat puis vente du même wallet en ≤ 10 min): 0.0 % du volume jugé. Mesure descriptive, sans test: acheter puis vendre est un comportement ordinaire.

**Inconnu :**
- activité postérieure à la fenêtre lue (volume, ventes, nouveaux acheteurs)

**Limites :**
- 18 transaction(s) lue(s) sur 1399 signature(s) listée(s)
- analyse limitée aux 18 transactions les plus anciennes sur 1399 listées: l'activité plus récente (sorties, volume) n'est pas vue
- les montants de cotation sont approximatifs (en SOL: frais, loyers de comptes et pourboires retirés)

## 8. Signaux sociaux disponibles

> Section INCONNUE — données non établies.

- **[INCONNU]** Aucun lien public (site, X, Telegram…) déclaré sur DEX Screener pour ce token.

**Inconnu :**
- activité, ancienneté et authenticité des comptes sociaux (aucune collecte X en direct: elle exigerait un service payant)
- contenu des publications

**Limites :**
- seuls les liens déclarés sur DEX Screener sont lus; aucun contenu social n'est analysé

## 9. Preuves et données inconnues
- **[FAIT]** Grand livre de preuves: 14 entrée(s) (6 FACT, 6 UNVERIFIED, 2 INDICATION); 1 ancrée(s) sur une signature de transaction. Écrit dans ledger.json avec le rapport.
- **[FAIT]** Lacune enregistrée: Analyse limitée aux 18 transactions les plus anciennes sur 1399 listées — manque: activité postérieure du token (ventes, volume, nouveaux acheteurs).
- **[FAIT]** Lacune enregistrée: 32 transaction(s) listée(s) mais non obtenue(s) — manque: contenu de ces transactions (erreur RPC ou historique élagué).
- **[FAIT]** Lacune enregistrée: 5 wallet(s) sans historique de financement disponible — manque: historique de ces wallets.
- **[FAIT]** Lacune enregistrée: Inférence sur les groupes impossible: financement connu pour 0 wallet(s) sur 5 (seuil: 12 wallets et 50 %): l'absence de lien n'est pas établie — manque: financement connu (historiques complets) pour assez de wallets.
- **[FAIT]** Lacune enregistrée: Financement du créateur non établi: historique du créateur indisponible: ses financeurs ne sont pas connus — manque: premier financement du créateur; financeurs du créateur.
- **[FAIT]** Lacune enregistrée: 5 wallet(s) avec historique partiel — manque: premier financement réel de ces wallets (le premier observé peut ne pas être le premier).

**Inconnu :**
- lecture limitée aux plus anciennes transactions du mint

**Limites :**
- les statuts HYPOTHÈSE n'existent pas dans ce produit (désactivés)

## Budget consommé

- Mode **rapide** : 44 appel(s) RPC sur 150 autorisés; 80 tentative(s) HTTP dont 39 reprise(s).
- Temps écoulé : 305.0 s (plafond 300 s).
- Appels par méthode : getAccountInfo 1, getProgramAccounts 2, getMultipleAccounts 4, getSignaturesForAddress 5, getTransaction 30, getBalance 1, getEpochInfo 1.
- Limites atteintes : budget de temps atteint (300 s) ; lecture des transactions du mint interrompue (budget de temps atteint (300 s)) ; financement non lu pour 5 wallet(s) de la cohorte (budget).
