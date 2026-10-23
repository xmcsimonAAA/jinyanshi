#!/usr/bin/env python3
"""Small same-origin API for the GoldenRock static site.

The service intentionally uses only Python's standard library so it can run on
Alibaba Cloud Linux without a package build step. Keep DATA_DIR outside the
web root in production.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import sqlite3
import threading
import time
from email.message import EmailMessage
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


HOST = os.environ.get("GOLDENROCK_API_HOST", "127.0.0.1")
PORT = int(os.environ.get("GOLDENROCK_API_PORT", "9100"))
DATA_DIR = os.environ.get("GOLDENROCK_DATA_DIR", "/var/lib/goldenrock")
DB_PATH = os.path.join(DATA_DIR, "goldenrock.sqlite3")
SESSION_SECONDS = 8 * 60 * 60
MAX_BODY = 1_500_000
LANGS = {"zh_CN", "zh_TW", "en"}

_rate_lock = threading.Lock()
_login_failures = {}
_message_submissions = {}


def now_ms():
    return int(time.time() * 1000)


def db():
    os.makedirs(DATA_DIR, mode=0o750, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db():
    conn = db()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS admin (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS configs (
                lang TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                lang TEXT NOT NULL,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                phone TEXT NOT NULL,
                service TEXT NOT NULL,
                message TEXT NOT NULL,
                user_agent TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'new',
                email_status TEXT NOT NULL DEFAULT 'disabled'
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                csrf TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            );
            """
        )
        row = conn.execute("SELECT id FROM admin WHERE id = 1").fetchone()
        if not row:
            password = os.environ.get("GOLDENROCK_ADMIN_PASSWORD", "admin123")
            salt = secrets.token_hex(16)
            conn.execute(
                "INSERT INTO admin(id, salt, password_hash, updated_at) VALUES(1, ?, ?, ?)",
                (salt, password_hash(password, salt), now_ms()),
            )
        conn.commit()
    finally:
        conn.close()


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("ascii"), 210_000
    ).hex()


def verify_password(password):
    conn = db()
    try:
        row = conn.execute("SELECT salt, password_hash FROM admin WHERE id = 1").fetchone()
        return bool(row and hmac.compare_digest(password_hash(password, row["salt"]), row["password_hash"]))
    finally:
        conn.close()


def set_password(password):
    salt = secrets.token_hex(16)
    conn = db()
    try:
        conn.execute(
            "UPDATE admin SET salt = ?, password_hash = ?, updated_at = ? WHERE id = 1",
            (salt, password_hash(password, salt), now_ms()),
        )
        conn.execute("DELETE FROM sessions")
        conn.commit()
    finally:
        conn.close()


def json_load(value, fallback):
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def read_configs():
    conn = db()
    try:
        rows = conn.execute("SELECT lang, content FROM configs").fetchall()
        return {row["lang"]: json_load(row["content"], {}) for row in rows}
    finally:
        conn.close()


def public_configs():
    configs = read_configs()
    for content in configs.values():
        if isinstance(content, dict):
            content.pop("admin", None)
    return configs


def editable_configs():
    configs = read_configs()
    for content in configs.values():
        if isinstance(content, dict):
            content.pop("admin", None)
    return configs


def save_config(lang, content):
    if lang not in LANGS or not isinstance(content, dict):
        raise ValueError("invalid language or config")
    content = clone_without_admin(content)
    raw = json.dumps(content, ensure_ascii=False, separators=(",", ":"))
    if len(raw) > 1_200_000:
        raise ValueError("config is too large")
    conn = db()
    try:
        conn.execute(
            "INSERT INTO configs(lang, content, updated_at) VALUES(?, ?, ?) "
            "ON CONFLICT(lang) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at",
            (lang, raw, now_ms()),
        )
        conn.commit()
    finally:
        conn.close()


def clone_without_admin(content):
    result = json.loads(json.dumps(content, ensure_ascii=False))
    if isinstance(result, dict):
        result.pop("admin", None)
    return result


def get_settings(include_secret=False):
    conn = db()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        result = {row["key"]: row["value"] for row in rows}
    finally:
        conn.close()
    result.setdefault("enabled", "0")
    result.setdefault("smtp_port", "587")
    result.setdefault("smtp_security", "starttls")
    if not include_secret:
        result["smtp_password_configured"] = "1" if result.get("smtp_password") else "0"
        result.pop("smtp_password", None)
    return result


def save_settings(values):
    allowed = {"enabled", "smtp_host", "smtp_port", "smtp_security", "smtp_user", "smtp_password", "recipient_email"}
    conn = db()
    try:
        for key, value in values.items():
            if key not in allowed:
                continue
            if key == "smtp_password" and value == "":
                continue
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)[:5000]),
            )
        conn.commit()
    finally:
        conn.close()


def create_session():
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    expires = int(time.time()) + SESSION_SECONDS
    conn = db()
    try:
        conn.execute("INSERT INTO sessions(token, csrf, expires_at) VALUES(?, ?, ?)", (token, csrf, expires))
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
        conn.commit()
    finally:
        conn.close()
    return token, csrf, expires


def get_session(token):
    if not token:
        return None
    conn = db()
    try:
        row = conn.execute("SELECT token, csrf, expires_at FROM sessions WHERE token = ?", (token,)).fetchone()
        if not row or row["expires_at"] < int(time.time()):
            return None
        return dict(row)
    finally:
        conn.close()


def delete_session(token):
    if not token:
        return
    conn = db()
    try:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
    finally:
        conn.close()


def clean_text(value, limit):
    value = str(value or "").strip()
    return value[:limit]


def valid_email(value):
    return bool(re.match(r"^[^@\s]{1,120}@[^@\s]{1,120}\.[^@\s]{2,80}$", value))


def insert_message(payload, user_agent):
    name = clean_text(payload.get("name"), 160)
    email = clean_text(payload.get("email"), 240)
    phone = clean_text(payload.get("phone"), 80)
    service = clean_text(payload.get("service"), 160)
    message = clean_text(payload.get("message"), 6000)
    lang = payload.get("lang") if payload.get("lang") in LANGS else "zh_CN"
    if not name or not message or not valid_email(email):
        raise ValueError("name, valid email and message are required")
    msg_id = secrets.token_hex(10)
    settings = get_settings(include_secret=True)
    email_status = "disabled"
    if settings.get("enabled") == "1" and settings.get("smtp_host") and settings.get("recipient_email"):
        email_status = "queued"
    conn = db()
    try:
        conn.execute(
            "INSERT INTO messages(id, created_at, lang, name, email, phone, service, message, user_agent, status, email_status) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)",
            (msg_id, now_ms(), lang, name, email, phone, service, message, clean_text(user_agent, 300), email_status),
        )
        conn.commit()
    finally:
        conn.close()
    if email_status == "queued":
        threading.Thread(target=send_notification, args=(msg_id,), daemon=True).start()
    return msg_id


def message_allowed(client_ip):
    now = time.time()
    with _rate_lock:
        stamps = [stamp for stamp in _message_submissions.get(client_ip, []) if now - stamp < 600]
        if len(stamps) >= 20:
            _message_submissions[client_ip] = stamps
            return False
        stamps.append(now)
        _message_submissions[client_ip] = stamps
        return True


def send_email(subject, body, settings):
    port = int(settings.get("smtp_port", "587"))
    email = EmailMessage()
    email["Subject"] = subject
    email["From"] = settings.get("smtp_user") or settings["recipient_email"]
    email["To"] = settings["recipient_email"]
    email.set_content(body)
    security = settings.get("smtp_security", "starttls")
    if security == "ssl":
        smtp = smtplib.SMTP_SSL(settings["smtp_host"], port, timeout=15)
    else:
        smtp = smtplib.SMTP(settings["smtp_host"], port, timeout=15)
    with smtp:
        smtp.ehlo()
        if security == "starttls":
            smtp.starttls()
            smtp.ehlo()
        if settings.get("smtp_user"):
            smtp.login(settings["smtp_user"], settings.get("smtp_password", ""))
        smtp.send_message(email)


def send_notification(msg_id):
    conn = db()
    try:
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (msg_id,)).fetchone()
    finally:
        conn.close()
    settings = get_settings(include_secret=True)
    try:
        send_email(
            "GoldenRock 网站新联系表单",
            "姓名：{name}\n邮箱：{email}\n电话：{phone}\n服务：{service}\n语言：{lang}\n\n{message}".format(**dict(row))
            , settings
        )
        status = "sent"
    except Exception:
        status = "failed"
    conn = db()
    try:
        conn.execute("UPDATE messages SET email_status = ? WHERE id = ?", (status, msg_id))
        conn.commit()
    finally:
        conn.close()


def send_test_notification(settings):
    send_email("GoldenRock 邮件通知测试", "这是一封 GoldenRock 后台发送的测试邮件。", settings)


def list_messages():
    conn = db()
    try:
        rows = conn.execute("SELECT * FROM messages ORDER BY created_at DESC").fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def update_message(msg_id, status):
    if status not in {"new", "read", "replied", "deleted"}:
        raise ValueError("invalid status")
    conn = db()
    try:
        cur = conn.execute("UPDATE messages SET status = ? WHERE id = ?", (status, msg_id))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def purge_message(msg_id):
    conn = db()
    try:
        cur = conn.execute("DELETE FROM messages WHERE id = ?", (msg_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "GoldenRockAPI/1.0"

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args), flush=True)

    def _headers(self, content_type="application/json; charset=utf-8", length=None):
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if length is not None:
            self.send_header("Content-Length", str(length))

    def json_response(self, data, status=HTTPStatus.OK, extra_headers=None):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._headers(length=len(raw))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def error(self, status, message):
        self.json_response({"error": message}, status)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("invalid content length")
        if length <= 0 or length > MAX_BODY:
            raise ValueError("request body is empty or too large")
        raw = self.rfile.read(length)
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("JSON object required")
        return value

    def cookies(self):
        result = {}
        raw = self.headers.get("Cookie", "")
        for item in raw.split(";"):
            if "=" in item:
                key, value = item.strip().split("=", 1)
                result[key] = value
        return result

    def session(self):
        return get_session(self.cookies().get("gr_session"))

    def require_admin(self, csrf=True):
        session = self.session()
        if not session:
            self.error(HTTPStatus.UNAUTHORIZED, "login required")
            return None
        if csrf and self.command in {"POST", "PATCH", "DELETE"}:
            supplied = self.headers.get("X-CSRF-Token", "")
            if not hmac.compare_digest(supplied, session["csrf"]):
                self.error(HTTPStatus.FORBIDDEN, "invalid csrf token")
                return None
        return session

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/health":
                self.json_response({"ok": True, "service": "goldenrock-api"})
            elif path == "/api/config.js":
                # This endpoint is embedded as a script; escape HTML-significant
                # characters so editable text cannot terminate the script tag.
                raw = json.dumps(public_configs(), ensure_ascii=False, separators=(",", ":"))
                raw = raw.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
                script = ("window.GOLDENROCK_SERVER_CONFIGS = " + raw + ";\n").encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self._headers("application/javascript; charset=utf-8", len(script))
                self.end_headers()
                self.wfile.write(script)
            elif path == "/api/config":
                lang = parse_qs(urlparse(self.path).query).get("lang", ["zh_CN"])[0]
                self.json_response({"lang": lang, "config": read_configs().get(lang)})
            elif path == "/api/admin/configs":
                if not self.require_admin(csrf=False): return
                self.json_response({"configs": editable_configs()})
            elif path == "/api/admin/messages":
                if not self.require_admin(csrf=False): return
                self.json_response({"messages": list_messages()})
            elif path == "/api/admin/notifications":
                if not self.require_admin(csrf=False): return
                self.json_response({"settings": get_settings()})
            elif path == "/api/admin/me":
                if not self.require_admin(csrf=False): return
                self.json_response({"ok": True})
            else:
                self.error(HTTPStatus.NOT_FOUND, "not found")
        except Exception as exc:
            print("GET error:", repr(exc), flush=True)
            self.error(HTTPStatus.INTERNAL_SERVER_ERROR, "server error")

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/auth/login":
                self.login()
            elif path == "/api/auth/logout":
                session = self.require_admin(csrf=True)
                if session:
                    delete_session(session["token"])
                    self.json_response({"ok": True}, extra_headers={"Set-Cookie": "gr_session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax"})
            elif path == "/api/messages":
                client_ip = self.headers.get("X-Real-IP", self.client_address[0])
                if not message_allowed(client_ip):
                    self.error(HTTPStatus.TOO_MANY_REQUESTS, "too many messages")
                    return
                payload = self.read_json()
                msg_id = insert_message(payload, self.headers.get("User-Agent", ""))
                self.json_response({"ok": True, "id": msg_id}, HTTPStatus.CREATED)
            elif path == "/api/admin/config":
                if not self.require_admin(): return
                payload = self.read_json()
                save_config(payload.get("lang"), payload.get("config"))
                self.json_response({"ok": True, "updated_at": now_ms()})
            elif path == "/api/admin/notifications":
                if not self.require_admin(): return
                payload = self.read_json()
                save_settings(payload)
                self.json_response({"ok": True, "settings": get_settings()})
            elif path == "/api/admin/notifications/test":
                if not self.require_admin(): return
                settings = get_settings(include_secret=True)
                if settings.get("enabled") != "1" or not settings.get("smtp_host") or not settings.get("recipient_email"):
                    self.error(HTTPStatus.BAD_REQUEST, "save SMTP settings and enable notifications first")
                    return
                send_test_notification(settings)
                self.json_response({"ok": True})
            elif path == "/api/admin/password":
                if not self.require_admin(): return
                payload = self.read_json()
                old = clean_text(payload.get("current"), 300)
                new = clean_text(payload.get("new"), 300)
                if len(new) < 10 or not verify_password(old):
                    self.error(HTTPStatus.BAD_REQUEST, "current password or new password is invalid")
                    return
                set_password(new)
                self.json_response({"ok": True}, extra_headers={"Set-Cookie": "gr_session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax"})
            else:
                self.error(HTTPStatus.NOT_FOUND, "not found")
        except ValueError as exc:
            self.error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:
            print("POST error:", repr(exc), flush=True)
            self.error(HTTPStatus.INTERNAL_SERVER_ERROR, "server error")

    def do_PATCH(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/admin/messages/"):
            self.error(HTTPStatus.NOT_FOUND, "not found")
            return
        if not self.require_admin(): return
        msg_id = path.rsplit("/", 1)[-1]
        try:
            payload = self.read_json()
            if not update_message(msg_id, payload.get("status")):
                self.error(HTTPStatus.NOT_FOUND, "message not found")
                return
            self.json_response({"ok": True})
        except ValueError as exc:
            self.error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception:
            self.error(HTTPStatus.INTERNAL_SERVER_ERROR, "server error")

    def do_DELETE(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/admin/messages/"):
            self.error(HTTPStatus.NOT_FOUND, "not found")
            return
        if not self.require_admin(): return
        msg_id = path.rsplit("/", 1)[-1]
        try:
            if not purge_message(msg_id):
                self.error(HTTPStatus.NOT_FOUND, "message not found")
                return
            self.json_response({"ok": True})
        except Exception:
            self.error(HTTPStatus.INTERNAL_SERVER_ERROR, "server error")

    def login(self):
        ip = self.client_address[0]
        with _rate_lock:
            failures = _login_failures.get(ip, [])
            now = time.time()
            failures = [stamp for stamp in failures if now - stamp < 600]
            if len(failures) >= 8:
                self.error(HTTPStatus.TOO_MANY_REQUESTS, "too many login attempts")
                return
        payload = self.read_json()
        password = clean_text(payload.get("password"), 300)
        if not verify_password(password):
            with _rate_lock:
                _login_failures.setdefault(ip, []).append(time.time())
            self.error(HTTPStatus.UNAUTHORIZED, "invalid password")
            return
        with _rate_lock:
            _login_failures.pop(ip, None)
        token, csrf, expires = create_session()
        cookie = "gr_session=%s; Max-Age=%d; Path=/; Secure; HttpOnly; SameSite=Lax" % (token, SESSION_SECONDS)
        self.json_response({"ok": True, "csrf": csrf, "expires_at": expires}, extra_headers={"Set-Cookie": cookie})


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("GoldenRock API listening on %s:%s" % (HOST, PORT), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
