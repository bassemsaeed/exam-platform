#!/bin/bash
# Self-healing public tunnel for the exam platform.
# Quick-tunnel URLs rotate on every (re)start, so this wrapper:
#   1. starts cloudflared and waits for the fresh public URL,
#   2. publishes it to PUBLIC_URL.txt,
#   3. points the backend at it (CORS + auth) and restarts the backend.
# systemd (exam-tunnel.service) keeps this running forever: reboots, crashes,
# and Cloudflare-side drops all come back automatically with a fresh URL.
set -u
LOG=/tmp/cf4000.log
# Paths resolve to THIS checkout (the review tree is the working tree; the old
# exam-platform paths are retired). Override via env for custom layouts.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/backend/.env}"
URL_FILE="${URL_FILE:-$ROOT/PUBLIC_URL.txt}"
PORT="${PORT:-4000}"

rm -f "$LOG"
/usr/local/bin/cloudflared tunnel --url "http://localhost:$PORT" >"$LOG" 2>&1 &
CF_PID=$!
URL=""
for _ in $(seq 1 40); do
  sleep 2
  if ! kill -0 "$CF_PID" 2>/dev/null; then
    echo "cloudflared exited early; see $LOG"
    exit 1
  fi
  URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
done
if [ -z "$URL" ]; then
  echo "no tunnel URL appeared in $LOG"
  kill "$CF_PID" 2>/dev/null
  exit 1
fi
echo "$URL" > "$URL_FILE"
echo "public URL: $URL"
# Point the backend at the fresh URL (append-or-set: a missing line must not
# silently leave stale localhost URLs in place).
set_kv() {
  local key="$1" val="$2" file="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}
set_kv BETTER_AUTH_URL "$URL" "$ENV_FILE"
set_kv FRONTEND_URL "$URL,http://localhost:4000,http://localhost:5173,http://localhost:5174" "$ENV_FILE"
/bin/systemctl restart exam-backend.service || true
wait "$CF_PID"
