# Déploiement persistant de la collecte d'outcomes (Linux / systemd)

But : faire tourner `npm run outcomes:collect` 24 h/24 (UPDATE toutes les 5 min, CAPTURE toutes les 30 min)
pendant des jours, en survivant aux déconnexions SSH, aux crashs Node, aux redémarrages et aux erreurs
DexScreener / Helius. Testé pour Debian 12 / Ubuntu 22.04+ (amd64 ou arm64).

Fichiers fournis (templates, aucun secret) :

| Fichier | Rôle |
|---|---|
| `deploy/systemd/solana-outcomes.service` | service de collecte (= `npm run outcomes:collect`) |
| `deploy/systemd/solana-outcomes-backup.service` + `.timer` | backup local quotidien (~03:17) |
| `deploy/solana-scanner.env.example` | modèle de `/etc/solana-scanner.env` |
| `deploy/outcomes-ctl.sh` | status / report / backup / disk / logs |

Chemins utilisés : code dans `/opt/solana-scanner`, dataset dans **`/var/lib/solana-scanner/outcomes`**
(`observations.json`, `observations.lock`, `backups/`), utilisateur système `solana`.

## 1. Installer Node 22 (≥ 22.6)

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v            # v22.x, ≥ 22.6
command -v node    # doit afficher /usr/bin/node (sinon adapter ExecStart dans les .service)
```

## 2. Utilisateur système et clone du dépôt

```bash
sudo useradd --system --home-dir /var/lib/solana-scanner --shell /usr/sbin/nologin solana
sudo git clone https://github.com/mohamedalimoussa005-lab/Claude-.git /opt/solana-scanner
```

## 3. Branche / commit

```bash
cd /opt/solana-scanner
sudo git checkout claude/tender-rubin-svbjq3
git log --oneline -1          # noter le commit déployé
sudo chown -R solana:solana /opt/solana-scanner
```

## 4. Dépendances

```bash
cd /opt/solana-scanner/solana-scanner
sudo -u solana env HOME=/tmp npm ci
```

## 5. Tests

```bash
cd /opt/solana-scanner/solana-scanner
sudo -u solana env HOME=/tmp npm test
```

Les tests sont hors ligne et doivent tous passer avant de continuer.

## 6. Dossier persistant

```bash
sudo install -d -o solana -g solana -m 0750 /var/lib/solana-scanner /var/lib/solana-scanner/outcomes
```

## 7. Fichier d'environnement (secret)

```bash
sudo install -m 600 -o root -g root /opt/solana-scanner/solana-scanner/deploy/solana-scanner.env.example /etc/solana-scanner.env
sudo nano /etc/solana-scanner.env      # remplacer REPLACE_ME par la vraie clé Helius
sudo ls -l /etc/solana-scanner.env     # -rw------- root root
```

La clé n'est lue que par systemd (fichier `root:root 600`) et transmise au processus ; elle n'est jamais
écrite dans le dépôt, les logs ou le dataset. Sans clé, la collecte utilise le RPC public seul (plus lent).

## 8. Installer les services systemd

```bash
sudo cp /opt/solana-scanner/solana-scanner/deploy/systemd/solana-outcomes.service /etc/systemd/system/
sudo cp /opt/solana-scanner/solana-scanner/deploy/systemd/solana-outcomes-backup.service /etc/systemd/system/
sudo cp /opt/solana-scanner/solana-scanner/deploy/systemd/solana-outcomes-backup.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/solana-outcomes.service /etc/systemd/system/solana-outcomes-backup.service /etc/systemd/system/solana-outcomes-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable solana-outcomes.service solana-outcomes-backup.timer
```

`enable` = démarrage automatique au boot. `Restart=on-failure` (après 30 s, sans limite de tentatives).

## 9. Démarrer

```bash
sudo systemctl start solana-outcomes.service solana-outcomes-backup.timer
```

## 10. Vérifier les logs

```bash
systemctl status solana-outcomes --no-pager
journalctl -u solana-outcomes -n 50 --no-pager
journalctl -u solana-outcomes -f                 # suivi en direct (Ctrl+C quitte l'affichage, pas le service)
```

Attendu : `[RUNNER] … démarrage`, puis `[UPDATE] …`, puis après quelques minutes `[CAPTURE] … durée …`
et `[DATASET] … observation(s)`. Ni clé ni URL authentifiée n'apparaissent dans les logs.

## 11. Vérifier `outcomes:status`

```bash
sudo /opt/solana-scanner/solana-scanner/deploy/outcomes-ctl.sh status
```

Affiche : total, nouvelles 24 h, dernière capture et sa durée, latence de décision (médiane / p95 / max par
profondeur d'analyse), décisions, couverture des checkpoints, MISSED, erreurs fournisseur, taille du dataset.
`report` et `export` fonctionnent de la même façon (`outcomes-ctl.sh report`).

## 12. Vérifier le backup

```bash
systemctl list-timers solana-outcomes-backup.timer --no-pager
sudo systemctl start solana-outcomes-backup.service          # backup immédiat (test)
journalctl -u solana-outcomes-backup -n 5 --no-pager         # [BACKUP] …/backups/observations-YYYYMMDD-HHMMSS.json
sudo ls -l /var/lib/solana-scanner/outcomes/backups/
```

Un backup n'écrase jamais un backup existant et ne modifie pas le dataset.

## Exploitation

```bash
sudo systemctl status solana-outcomes --no-pager     # état
sudo systemctl restart solana-outcomes               # redémarrer
sudo systemctl stop solana-outcomes                  # arrêter (propre : verrou libéré)
sudo systemctl start solana-outcomes                 # démarrer
journalctl -u solana-outcomes --since "-1h" --no-pager
journalctl -u solana-outcomes -p warning --since today --no-pager   # erreurs / redémarrages
sudo /opt/solana-scanner/solana-scanner/deploy/outcomes-ctl.sh disk # taille dataset + backups + espace disque
```

Commande disque équivalente sans le script :

```bash
sudo du -h /var/lib/solana-scanner/outcomes/observations.json
sudo du -sh /var/lib/solana-scanner/outcomes/backups
df -h /var/lib/solana-scanner
```

**Volume attendu** : ~25 Mo de dataset par jour (≈ 7,5 Ko par observation, ~65 tokens par capture,
48 captures / jour). Les backups quotidiens sont des copies complètes : après 7 jours, ≈ 175 Mo de dataset et
≈ 700 Mo de backups au total. Prévoir au moins 2 Go libres pour une semaine. Pas de rotation automatique :
supprimer manuellement les anciens backups si besoin (`sudo ls -lt …/backups`).

## Garanties au redémarrage (crash, reboot, `restart`)

- Le dataset est relu tel quel : aucune observation perdue, aucun snapshot modifié (hash vérifié au chargement).
- Une capture déjà enregistrée n'est pas dupliquée (identifiant `mint:paire:T0`) ; un checkpoint OK n'est jamais
  réécrit ; le runner lance d'abord un UPDATE qui reprend les checkpoints dus (ceux dont la fenêtre est passée
  pendant l'arrêt deviennent MISSED, jamais une valeur inventée).
- Verrou : `systemctl stop` / `restart` envoie SIGTERM à tous les processus du service, qui libèrent le verrou.
  Après un crash ou un reboot, un verrou dont le processus n'existe plus est repris ; s'il porte un pid réutilisé
  par un autre processus, il est repris au plus tard 15 min après sa création (une opération concurrente échoue
  proprement entre-temps et est retentée au tour suivant).
- Une erreur DexScreener / Helius n'arrête pas la collecte : le run est loggé en échec et le calendrier continue.

## Mettre à jour le code

```bash
sudo systemctl stop solana-outcomes
cd /opt/solana-scanner && sudo -u solana git pull && cd solana-scanner && sudo -u solana env HOME=/tmp npm ci && sudo -u solana env HOME=/tmp npm test
sudo systemctl start solana-outcomes
```

Le dataset (`/var/lib/solana-scanner/outcomes`) n'est jamais touché par une mise à jour du code. Un dataset d'un
ancien schéma est refusé au chargement : voir `npm run outcomes:archive-legacy` dans le README.

## Coût réseau indicatif

Par capture : ~⌈tokens / 30⌉ + candidats appels DexScreener (≈ 8) + Step 3 / Step 4 sur ≤ 5 candidats
(≈ 50–110 appels RPC et 2–25 lectures d'historique Helius chacun). Par update : 1 appel DexScreener par lot de
30 paires dues. Vérifier que le plan Helius couvre ~48 captures / jour.
