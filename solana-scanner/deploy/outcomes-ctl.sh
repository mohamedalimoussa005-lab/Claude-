#!/usr/bin/env bash
# Operator helper for the persistent outcome collection (runs as the service user, reads the persistent dataset).
#   sudo ./deploy/outcomes-ctl.sh status|report|export|backup|disk|logs|follow
# No secret is read or printed: status / report / backup need no API key.
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/solana-scanner/solana-scanner}"
DATA_DIR="${OUTCOMES_DIR:-/var/lib/solana-scanner/outcomes}"
SVC_USER="${SVC_USER:-solana}"
run() { cd "$APP_DIR" && sudo -u "$SVC_USER" env OUTCOMES_DIR="$DATA_DIR" HOME=/var/lib/solana-scanner /usr/bin/node --experimental-strip-types --no-warnings scripts/outcomes.ts "$@"; }
case "${1:-status}" in
  status|report|export|backup) run "$1" ;;
  disk)
    echo "dataset:  $(du -h "$DATA_DIR/observations.json" 2>/dev/null | cut -f1 || echo absent)"
    echo "backups:  $(du -sh "$DATA_DIR/backups" 2>/dev/null | cut -f1 || echo absent) ($(ls "$DATA_DIR/backups" 2>/dev/null | wc -l) fichier(s))"
    df -h "$DATA_DIR"
    ;;
  logs) journalctl -u solana-outcomes --since "-2h" --no-pager ;;
  follow) journalctl -u solana-outcomes -f ;;
  *) echo "usage: $0 status|report|export|backup|disk|logs|follow" >&2; exit 1 ;;
esac
