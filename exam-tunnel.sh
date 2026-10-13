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
ENV_FILE=/home/bassem/exam-platform/backend/.env
URL_FILE=/home/bassem/exam-platform/PUBLIC_URL.txt

rm -f "$LOG"
/usr/local/bin/cloudflared tunnel --url http://localhost:4000 >"$LOG" 2>&1 &
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
sed -i "s|^BETTER_AUTH_URL=.*|BETTER_AUTH_URL=$URL|; s|^FRONTEND_URL=.*|FRONTEND_URL=$URL,http://localhost:4000,http://localhost:5173,http://localhost:5174|" "$ENV_FILE"
/bin/systemctl restart exam-backend.service || true
wait "$CF_PID"
