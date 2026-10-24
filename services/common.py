"""Standard-library-only shared configuration, redaction and local HTTP boundary."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = json.loads((ROOT / "packages/contracts/constants.json").read_text())
LIMITS = CONTRACT["limits"]


def canonical(value):
    def validate(item):
        if item is None or isinstance(item, (str, bool)):
            return
        if isinstance(item, int) and abs(item) <= 9007199254740991:
            return
        if isinstance(item, list):
            for child in item:
                validate(child)
            return
        if isinstance(item, dict) and all(isinstance(key, str) for key in item):
            for child in item.values():
                validate(child)
            return
        raise ValueError("Only JSON values and safe integers are supported")
    validate(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


PATTERNS = [
    ("private_key", re.compile(r"-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+)?PRIVATE KEY-----|$)")),
    ("token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b")),
    ("authorization", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*", re.I)),
    ("credential", re.compile(r"\b(?:api[_-]?key|access[_-]?token|password|secret|token)\s*[:=]\s*(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;]+)", re.I)),
    ("url_credentials", re.compile(r"://[^\s/:@]+:[^\s/@]+@")),
]


def redact(value):
    if isinstance(value, str):
        for kind, pattern in PATTERNS:
            value = pattern.sub("://[REDACTED]@" if kind == "url_credentials" else "[REDACTED]", value)
        return value
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    return value


def load_environment():
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
                raise ValueError("Invalid .env entry")
            os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def secret(name):
    value = os.environ.get(name, "")
    if len(value) < 32 or "GENERATE_ME" in value:
        raise ValueError(f"{name} must be a generated secret of at least 32 characters")
    return value


class HttpError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def require_object(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise HttpError(400, "INVALID_SCHEMA", "Unexpected or missing fields")


def build_server(url, token, application, body_limit=1048576):
    """Construct the real HTTP server; port zero supports isolated integration tests."""
    parsed = urlsplit(url)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.username is not None
            or parsed.port is None or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("Internal services must bind loopback HTTP with an explicit port")

    class Handler(BaseHTTPRequestHandler):
        server_version = "bug.out"
        sys_version = ""

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass  # Never log user paths, tokens, request bodies or repository output.

        def do_GET(self):
            self.handle_request("GET")

        def do_POST(self):
            self.handle_request("POST")

        def handle_request(self, method):
            try:
                if method == "GET" and self.path == "/health":
                    return self.reply(200, {"status": "ok"})
                if not hmac.compare_digest(self.headers.get("Authorization", "").encode("utf-8"), ("Bearer " + token).encode("utf-8")):
                    raise HttpError(401, "UNAUTHORIZED", "Service authentication required")
                body = None
                if method == "POST":
                    if self.headers.get_content_type() != "application/json":
                        raise HttpError(415, "JSON_REQUIRED", "Content-Type must be application/json")
                    if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1 or not self.headers.get("Content-Length", "").isdigit():
                        raise HttpError(400, "INVALID_LENGTH", "A bounded Content-Length is required")
                    length = int(self.headers["Content-Length"])
                    if length > body_limit:
                        raise HttpError(413, "BODY_TOO_LARGE", "Service body limit exceeded")
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise HttpError(400, "INCOMPLETE_BODY", "Incomplete request body")
                    def reject_constant(_value):
                        raise ValueError("Non-finite JSON number")
                    body = json.loads(raw, parse_constant=reject_constant)
                self.reply(200, application(method, self.path, body))
            except HttpError as error:
                self.reply(error.status, {"error": {"code": error.code, "message": error.message}})
            except (ValueError, TypeError, KeyError, RecursionError):
                self.reply(400, {"error": {"code": "INVALID_SCHEMA", "message": "Invalid service request"}})
            except Exception:
                self.reply(500, {"error": {"code": "INTERNAL_ERROR", "message": "Service operation failed"}})

        def reply(self, status, body):
            output = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(output)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(output)

    server = ThreadingHTTPServer((parsed.hostname, parsed.port), Handler)
    server.daemon_threads = True
    return server


def serve(url, token, application, body_limit=1048576):
    server = build_server(url, token, application, body_limit)
    print(f"bug.out service listening at http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
