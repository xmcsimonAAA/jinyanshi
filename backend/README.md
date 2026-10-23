# GoldenRock API

This is the production backend for the existing static site. It uses Python's
standard library and SQLite, so no Python package installation is required.

The SQLite database must live outside `/usr/share/nginx/html`:

```sh
useradd --system --home-dir /opt/goldenrock --shell /sbin/nologin goldenrock
install -d -o goldenrock -g goldenrock -m 750 /opt/goldenrock/backend /var/lib/goldenrock
cp backend/app.py /opt/goldenrock/backend/app.py
cp backend/goldenrock-api.service /etc/systemd/system/goldenrock-api.service
systemctl daemon-reload
systemctl enable --now goldenrock-api
```

Add `backend/nginx-api.conf` inside the HTTPS `server { ... }` block, then run:

```sh
nginx -t && systemctl reload nginx
curl -fsS http://127.0.0.1:9100/api/health
```

The initial bootstrap password is `admin123` only when the database is created
without `GOLDENROCK_ADMIN_PASSWORD`. Change it immediately from the admin page
after the first login. Set `GOLDENROCK_ADMIN_PASSWORD` before the first start if
a different initial password is required. Never put a real password in Git.

The API stores content, messages, sessions and notification settings in
`/var/lib/goldenrock/goldenrock.sqlite3`. `backup.py` takes a consistent
SQLite snapshot together with the public web root; the cron entry runs daily
and keeps 30 days in `/var/backups/goldenrock`. Copy those archives to another
storage location periodically for disaster recovery. SMTP notification is
disabled until configured in the admin page; messages are still stored while
email is disabled or unavailable.

After deploying, use `https://goldenrock.hk/admin.html`, sign in with the
bootstrap password, then change it under **通知设置**. The admin login protects
content publishing, contact submissions, SMTP credentials, and password
changes. If the login is lost, reset the password by setting
`GOLDENROCK_ADMIN_PASSWORD` in the systemd service before a first database
initialization; for an existing database, use the documented recovery script
provided by the operator rather than deleting the database.
