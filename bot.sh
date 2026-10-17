#!/usr/bin/env bash
# Usage: ./bot.sh start|stop|restart|status|logs
cd "$(dirname "$0")" || exit 1
PID_FILE=.bot.pid
LOG_FILE=bot.log

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

case "$1" in
  start)
    if running; then echo "already running (pid $(cat $PID_FILE))"; exit 0; fi
    nohup node --env-file=.env src/index.js >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 3
    if running; then echo "started (pid $(cat $PID_FILE))"; tail -n 3 "$LOG_FILE"
    else echo "failed to start:"; tail -n 10 "$LOG_FILE"; rm -f "$PID_FILE"; exit 1; fi ;;
  stop)
    if running; then kill "$(cat $PID_FILE)"; rm -f "$PID_FILE"; echo "stopped"
    else rm -f "$PID_FILE"; echo "not running"; fi ;;
  restart) "$0" stop; "$0" start ;;
  status) if running; then echo "running (pid $(cat $PID_FILE))"; else echo "stopped"; fi ;;
  logs) tail -f "$LOG_FILE" ;;
  *) echo "usage: $0 start|stop|restart|status|logs"; exit 1 ;;
esac
