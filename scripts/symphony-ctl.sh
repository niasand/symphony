#!/usr/bin/env bash
# Symphony Orchestrator service control.
# Usage: symphony-ctl.sh {start|stop|restart|status|logs}
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.symphony.orchestrator.plist"
LABEL="com.symphony.orchestrator"
LOG_DIR="$(cd "$(dirname "$0")/../elixir/logs" && pwd)"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

status() {
  local pid
  pid=$(launchctl list 2>/dev/null | grep "$LABEL" | awk '{print $1}')
  if [[ -n "$pid" && "$pid" != "-" ]]; then
    green "● Running (PID $pid)"
  elif [[ -n "$pid" ]]; then
    yellow "○ Loaded but not running (exited / crashed)"
  else
    red "○ Not loaded"
  fi
}

start() {
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    yellow "Already loaded. Use 'restart' to reload."
    status
    return 0
  fi
  launchctl load "$PLIST"
  sleep 1
  green "Loaded."
  status
}

stop() {
  if ! launchctl list 2>/dev/null | grep -q "$LABEL"; then
    yellow "Not loaded."
    return 0
  fi
  launchctl unload "$PLIST"
  green "Stopped."
}

restart() {
  stop
  sleep 1
  start
}

logs() {
  local which="${1:-both}"
  case "$which" in
    out|stdout) tail -f "$LOG_DIR/launchd-stdout.log" ;;
    err|stderr) tail -f "$LOG_DIR/launchd-stderr.log" ;;
    *) tail -f "$LOG_DIR/launchd-stdout.log" "$LOG_DIR/launchd-stderr.log" ;;
  esac
}

case "${1:-help}" in
  start)   start ;;
  stop)    stop ;;
  restart) restart ;;
  status)  status ;;
  logs)    logs "${2:-both}" ;;
  help|--help|-h)
    echo "Usage: $(basename "$0") {start|stop|restart|status|logs [out|err]}"
    ;;
  *)
    red "Unknown command: $1"
    exit 1
    ;;
esac
