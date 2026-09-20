#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
for drive_root in /mnt/[a-z]; do
  candidate="$drive_root$ROOT_DIR"
  if [[ -d "$candidate" && "$(stat -Lc '%d:%i' "$candidate" 2>/dev/null || true)" == "$(stat -Lc '%d:%i' "$ROOT_DIR" 2>/dev/null || true)" ]]; then
    ROOT_DIR="$(cd -- "$candidate" && pwd -P)"
    break
  fi
done
STATE_DIR="$ROOT_DIR/state"
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
ACTION="${1:-start}"

mkdir -p "$STATE_DIR"
exec 9> "$STATE_DIR/deploy.lock"
flock 9

read_running_pid() {
  local pid process_args process_identity root_identity
  [[ -f "$PID_FILE" ]] || return 1
  read -r pid < "$PID_FILE"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  process_args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  process_identity="$(stat -Lc '%d:%i' "/proc/$pid/cwd" 2>/dev/null || true)"
  root_identity="$(stat -Lc '%d:%i' "$ROOT_DIR" 2>/dev/null || true)"
  [[ -n "$process_identity" && "$process_identity" == "$root_identity" && "$process_args" == *"node scripts/start.mjs"* ]] || return 1
  printf '%s\n' "$pid"
}

start_service() {
  local pid
  if pid="$(read_running_pid)"; then
    echo "owner_config is already running (PID $pid)"
    return
  fi

  rm -f "$PID_FILE"
  : > "$LOG_FILE"
  (
    cd "$ROOT_DIR"
    exec env OWNER_CONFIG_ROOT="$ROOT_DIR" setsid node scripts/start.mjs 9>&-
  ) >> "$LOG_FILE" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"

  for ((attempt = 0; attempt < 600; attempt += 1)); do
    if grep -q "owner_config web:" "$LOG_FILE"; then
      echo "owner_config started (PID $pid, log $LOG_FILE)"
      return
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "owner_config failed to start; see $LOG_FILE" >&2
      tail -n 20 "$LOG_FILE" >&2
      return 1
    fi
    sleep 0.1
  done

  echo "owner_config is still starting (PID $pid, log $LOG_FILE)"
}

stop_service() {
  local pid
  if ! pid="$(read_running_pid)"; then
    rm -f "$PID_FILE"
    echo "owner_config is not running"
    return
  fi

  kill "$pid"
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "owner_config stopped"
      return
    fi
    sleep 0.1
  done

  echo "owner_config did not stop within 10 seconds (PID $pid)" >&2
  return 1
}

case "$ACTION" in
  start) start_service ;;
  stop) stop_service ;;
  *)
    echo "usage: ./deploy.sh [start|stop]" >&2
    exit 2
    ;;
esac
