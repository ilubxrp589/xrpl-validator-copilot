#!/bin/bash
# mute.sh on | off | <minutes> — silence the copilot's Telegram pages (MUTE file beside config.local.json; watchdog checks it every tick, no restart needed).
D=$(cd "$(dirname "$0")" && pwd); F=$D/MUTE
case "${1:-status}" in
  on)  : > "$F"; echo "alerts MUTED until 'mute.sh off'";;
  off) rm -f "$F"; echo "alerts LIVE";;
  status) if [ -f "$F" ]; then u=$(head -1 "$F"); echo "MUTED${u:+ until $u}"; else echo "LIVE"; fi;;
  *) if [[ "$1" =~ ^[0-9]+$ ]]; then date -u -d "+$1 minutes" +%Y-%m-%dT%H:%M:%SZ > "$F"; echo "alerts MUTED until $(cat "$F")"; else echo "usage: mute.sh on|off|status|<minutes>"; exit 1; fi;;
esac
