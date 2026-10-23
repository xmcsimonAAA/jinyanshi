#!/usr/bin/env python3
"""Create a consistent SQLite + website backup and keep the latest 30 days."""

import datetime
import os
import sqlite3
import subprocess
import tempfile


DB = "/var/lib/goldenrock/goldenrock.sqlite3"
WEB_ROOT = "/usr/share/nginx/html"
BACKUP_DIR = "/var/backups/goldenrock"


def main():
    os.umask(0o077)
    os.makedirs(BACKUP_DIR, mode=0o700, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    archive = os.path.join(BACKUP_DIR, "goldenrock-%s.tar.gz" % stamp)
    with tempfile.TemporaryDirectory(prefix="goldenrock-backup-") as temp:
        db_copy = os.path.join(temp, "goldenrock.sqlite3")
        source = sqlite3.connect("file:%s?mode=ro" % DB, uri=True, timeout=30)
        destination = sqlite3.connect(db_copy)
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()
        subprocess.run(
            ["tar", "-czf", archive, "-C", WEB_ROOT, ".", "-C", temp, "goldenrock.sqlite3"],
            check=True,
        )
    os.chmod(archive, 0o600)

    cutoff = datetime.datetime.now().timestamp() - 30 * 86400
    for name in os.listdir(BACKUP_DIR):
        path = os.path.join(BACKUP_DIR, name)
        if name.startswith("goldenrock-") and name.endswith(".tar.gz") and os.path.getmtime(path) < cutoff:
            os.unlink(path)
    print(archive)


if __name__ == "__main__":
    main()
