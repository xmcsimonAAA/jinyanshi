#!/bin/bash
set -euo pipefail

RELEASE_DIR="${1:-/opt/goldenrock/release}"
WEB_ROOT="/usr/share/nginx/html"
APP_ROOT="/opt/goldenrock"
DATA_DIR="/var/lib/goldenrock"

id goldenrock >/dev/null 2>&1 || useradd --system --home-dir "$APP_ROOT" --shell /sbin/nologin goldenrock
install -d -o goldenrock -g goldenrock -m 750 "$APP_ROOT/backend" "$DATA_DIR"

BACKUP="/root/nginx-html-before-backend-$(date +%Y%m%d-%H%M%S)"
cp -a "$WEB_ROOT" "$BACKUP"

install -o goldenrock -g goldenrock -m 750 "$RELEASE_DIR/backend/app.py" "$APP_ROOT/backend/app.py"
install -m 644 "$RELEASE_DIR/backend/goldenrock-api.service" /etc/systemd/system/goldenrock-api.service
install -m 644 "$RELEASE_DIR/backend/nginx-api.conf" /etc/nginx/default.d/goldenrock-api.conf
install -m 750 "$RELEASE_DIR/backend/backup.py" /usr/local/sbin/goldenrock-backup
install -m 644 "$RELEASE_DIR/backend/goldenrock-backup.cron" /etc/cron.d/goldenrock-backup
install -d -o root -g root -m 700 /var/backups/goldenrock

cp -r "$RELEASE_DIR/assets" "$RELEASE_DIR/css" "$RELEASE_DIR/js" "$RELEASE_DIR/api" "$WEB_ROOT/"
cp -f "$RELEASE_DIR"/*.html "$RELEASE_DIR"/config.js "$RELEASE_DIR"/*.png "$WEB_ROOT/"
chown -R nginx:nginx "$WEB_ROOT"

systemctl daemon-reload
systemctl enable --now goldenrock-api
nginx -t
systemctl reload nginx

for attempt in $(seq 1 15); do
    if curl -fsS http://127.0.0.1:9100/api/health >/dev/null; then break; fi
    if [ "$attempt" -eq 15 ]; then
        systemctl status goldenrock-api --no-pager || true
        exit 1
    fi
    sleep 1
done
curl -fsS --resolve goldenrock.hk:443:127.0.0.1 https://goldenrock.hk/api/health >/dev/null
echo "GoldenRock backend deployed; web backup: $BACKUP"
