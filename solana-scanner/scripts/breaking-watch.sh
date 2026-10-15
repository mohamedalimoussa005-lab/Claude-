#!/usr/bin/env bash
# DETECTIVE Breaking Signal — start / stop the free watcher on your Mac (or any Unix).
#
#   ./scripts/breaking-watch.sh start            watch in SIMULATED-notification mode (nothing is sent to Telegram)
#   ./scripts/breaking-watch.sh start --send     real Telegram alerts: requires BREAKING_SIGNAL_TELEGRAM_SEND=yes in .env.breaking
#   ./scripts/breaking-watch.sh stop | status | logs | restart
#
# Files (git-ignored, in solana-scanner/): .breaking-watch.pid, .breaking-watch.log, .breaking-state.json, .breaking-events.jsonl
# On macOS, `caffeinate` keeps the Mac awake while the watcher runs. Closing the lid or shutting down stops it.
set -u
cd "$(dirname "$0")/.."
PID_FILE=".breaking-watch.pid"
LOG_FILE=".breaking-watch.log"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null
}

case "${1:-help}" in
  start)
    shift
    if is_running; then echo "Déjà en cours (pid $(cat "$PID_FILE"))."; exit 0; fi
    rm -f "$PID_FILE" .breaking-watch.lock
    nohup node --experimental-strip-types --no-warnings scripts/breaking-signal.ts watch "$@" >>"$LOG_FILE" 2>&1 &
    PID=$!
    echo "$PID" >"$PID_FILE"
    if command -v caffeinate >/dev/null 2>&1; then nohup caffeinate -i -w "$PID" >/dev/null 2>&1 & fi
    sleep 2
    if is_running; then
      echo "Surveillance démarrée (pid $PID)."
      case " $* " in *" --send "*) echo "Mode: ALERTES RÉELLES si BREAKING_SIGNAL_TELEGRAM_SEND=yes (sinon simulation).";; *) echo "Mode: notifications SIMULÉES (rien n'est envoyé).";; esac
      echo "Journal: $LOG_FILE · arrêt: ./scripts/breaking-watch.sh stop"
    else
      echo "Échec du démarrage, dernières lignes du journal:"; tail -n 15 "$LOG_FILE"; rm -f "$PID_FILE"; exit 1
    fi
    ;;
  stop)
    if ! is_running; then echo "Aucune surveillance en cours."; rm -f "$PID_FILE"; exit 0; fi
    PID="$(cat "$PID_FILE")"
    kill -TERM "$PID"
    for _ in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
    if kill -0 "$PID" 2>/dev/null; then echo "Arrêt demandé, une enquête est peut-être encore en cours (pid $PID). Relancez 'stop' dans un instant."; exit 1; fi
    rm -f "$PID_FILE" .breaking-watch.lock
    echo "Surveillance arrêtée."
    ;;
  status)
    if is_running; then echo "En cours (pid $(cat "$PID_FILE"))."; tail -n 5 "$LOG_FILE" 2>/dev/null; else echo "À l'arrêt."; fi
    ;;
  logs)
    tail -n "${2:-40}" "$LOG_FILE" 2>/dev/null || echo "Pas de journal."
    ;;
  restart)
    "$0" stop && shift && "$0" start "$@"
    ;;
  *)
    echo "usage: $0 start [--send] [--interval 60] | stop | status | logs [N] | restart"
    ;;
esac
