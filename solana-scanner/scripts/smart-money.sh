#!/usr/bin/env bash
# SMART MONEY TRACKER — start / stop the (offline, simulated) agent. Independent of the Breaking Signal watcher:
# its own pid file and log, never touches .breaking-* files.
#
#   ./scripts/smart-money.sh start | stop | status | logs [N] | restart
#
# Files (git-ignored, in solana-scanner/): .smart-money.pid, .smart-money.log; memory in data/smart-money/.
set -u
cd "$(dirname "$0")/.."
PID_FILE=".smart-money.pid"
LOG_FILE=".smart-money.log"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null
}

case "${1:-help}" in
  start)
    shift
    if is_running; then echo "Déjà en cours (pid $(cat "$PID_FILE"))."; exit 0; fi
    rm -f "$PID_FILE"
    nohup node --experimental-strip-types --no-warnings scripts/smart-money.ts run "$@" >>"$LOG_FILE" 2>&1 &
    PID=$!
    echo "$PID" >"$PID_FILE"
    sleep 1
    if is_running; then
      echo "SMART MONEY TRACKER démarré (pid $PID), mode hors-ligne simulé : aucun appel réseau."
      echo "Journal: $LOG_FILE · arrêt: ./scripts/smart-money.sh stop"
    else
      echo "Échec du démarrage, dernières lignes du journal:"; tail -n 15 "$LOG_FILE"; rm -f "$PID_FILE"; exit 1
    fi
    ;;
  stop)
    if ! is_running; then echo "Aucun agent en cours."; rm -f "$PID_FILE"; exit 0; fi
    PID="$(cat "$PID_FILE")"
    kill -TERM "$PID"
    for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
    if kill -0 "$PID" 2>/dev/null; then echo "Arrêt demandé, encore en cours (pid $PID). Relancez 'stop' dans un instant."; exit 1; fi
    rm -f "$PID_FILE"
    echo "Agent arrêté."
    ;;
  status)
    if is_running; then echo "En cours (pid $(cat "$PID_FILE"))."; else echo "À l'arrêt."; fi
    node --experimental-strip-types --no-warnings scripts/smart-money.ts status
    ;;
  logs)
    tail -n "${2:-40}" "$LOG_FILE" 2>/dev/null || echo "Pas de journal."
    ;;
  restart)
    "$0" stop && shift && "$0" start "$@"
    ;;
  *)
    echo "usage: $0 start | stop | status | logs [N] | restart"
    ;;
esac
