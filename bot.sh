#!/usr/bin/env bash
# Usage: ./bot.sh start|stop|restart|status|logs
# start/stop also start/stop the local SearXNG container when .env uses it (SEARXNG_URL).
cd "$(dirname "$0")" || exit 1
PID_FILE=.bot.pid
LOG_FILE=bot.log
COMPOSE="docker compose -f searxng/docker-compose.yml --env-file searxng/.env"

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }
uses_searxng() { grep -q '^SEARXNG_URL=' .env 2>/dev/null; }
searxng_up() { curl -s -o /dev/null --max-time 2 http://127.0.0.1:8888/; }

start_searxng() {
  uses_searxng || return 0
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running, opening Docker Desktop..."
    open -a Docker 2>/dev/null
    for _ in $(seq 1 45); do docker info >/dev/null 2>&1 && break; sleep 2; done
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "WARNING: Docker unavailable, starting without search"; return 0
  fi
  ./searxng/setup.sh >/dev/null 2>&1
  for _ in $(seq 1 30); do searxng_up && { echo "searxng: up"; return 0; }; sleep 1; done
  echo "WARNING: searxng did not become ready, search may fail"
}

stop_searxng() {
  uses_searxng || return 0
  docker info >/dev/null 2>&1 && $COMPOSE stop >/dev/null 2>&1 && echo "searxng: stopped"
}

case "$1" in
  start)
    if running; then echo "already running (pid $(cat $PID_FILE))"; exit 0; fi
    start_searxng
    nohup node --env-file=.env src/index.js >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 3
    if running; then echo "started (pid $(cat $PID_FILE))"; tail -n 3 "$LOG_FILE"
    else echo "failed to start:"; tail -n 10 "$LOG_FILE"; rm -f "$PID_FILE"; exit 1; fi ;;
  stop)
    if running; then kill "$(cat $PID_FILE)"; rm -f "$PID_FILE"; echo "bot: stopped"
    else rm -f "$PID_FILE"; echo "bot: not running"; fi
    stop_searxng ;;
  restart) "$0" stop; "$0" start ;;
  status)
    if running; then echo "bot: running (pid $(cat $PID_FILE))"; else echo "bot: stopped"; fi
    if uses_searxng; then if searxng_up; then echo "searxng: up"; else echo "searxng: down"; fi; fi ;;
  logs) tail -f "$LOG_FILE" ;;
  *) echo "usage: $0 start|stop|restart|status|logs"; exit 1 ;;
esac
