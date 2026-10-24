from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
import uuid
from services.common import HttpError, LIMITS, redact
from services.runner.policy import identifier


class Storage:
    def __init__(self, root):
        self.root = Path(root)
        if self.root.is_symlink() or self.root.parent.is_symlink():
            raise ValueError("Runner storage must not be a symlink")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.artifacts = self.root / "artifacts"
        if self.artifacts.is_symlink():
            raise ValueError("Artifact root must not be a symlink")
        self.artifacts.mkdir(exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS runs (
                  id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
                  payload TEXT NOT NULL, state TEXT NOT NULL, evidence TEXT, cancel INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS artifacts (
                  id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL, run_id TEXT NOT NULL,
                  bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, truncated INTEGER NOT NULL, stream TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS cancelled_runs (id TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS purged_investigations (id TEXT PRIMARY KEY);
            """)
        os.chmod(self.root / "runner.sqlite3", 0o600)

    @contextmanager
    def connection(self):
        with self.lock:
            db = sqlite3.connect(self.root / "runner.sqlite3", timeout=5)
            db.row_factory = sqlite3.Row
            try:
                with db:
                    yield db
            finally:
                db.close()

    def get(self, run_id):
        identifier(run_id)
        with self.connection() as db:
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            raise HttpError(404, "NOT_FOUND", "Run not found")
        return dict(row)

    def public(self, run_id):
        row = self.get(run_id)
        return {"run_id": row["id"], "state": row["state"], "evidence": json.loads(row["evidence"]) if row["evidence"] else None}

    def reserve(self, payload, request_hash):
        with self.connection() as db:
            if db.execute("SELECT 1 FROM purged_investigations WHERE id=?", (payload["investigation_id"],)).fetchone():
                raise HttpError(409, "INVESTIGATION_PURGED", "This investigation was permanently retired")
            previous = db.execute("SELECT request_hash FROM runs WHERE id=?", (payload["run_id"],)).fetchone()
            if previous:
                if previous["request_hash"] != request_hash:
                    raise HttpError(409, "RUN_CONFLICT", "Run ID already has a different request")
                return False
            if db.execute("SELECT count(*) FROM runs").fetchone()[0] >= 1000:
                raise HttpError(507, "LEDGER_LIMIT", "Runner retention limit reached")
            if db.execute("SELECT count(*) FROM runs WHERE state != 'finished'").fetchone()[0] >= 16:
                raise HttpError(429, "RUNNER_BUSY", "Runner queue is full")
            cancelled = db.execute("SELECT 1 FROM cancelled_runs WHERE id=?", (payload["run_id"],)).fetchone() is not None
            db.execute("INSERT INTO runs (id,investigation_id,request_hash,payload,state,cancel) VALUES (?,?,?,?,'reserved',?)", (payload["run_id"], payload["investigation_id"], request_hash, json.dumps(payload), int(cancelled)))
        return True

    def assert_not_purged(self, investigation_id):
        identifier(investigation_id)
        with self.connection() as db:
            if db.execute("SELECT 1 FROM purged_investigations WHERE id=?", (investigation_id,)).fetchone():
                raise HttpError(409, "INVESTIGATION_PURGED", "This investigation was permanently retired")

    def mark(self, run_id, state, evidence=None):
        with self.connection() as db:
            db.execute("UPDATE runs SET state=?,evidence=? WHERE id=?", (state, json.dumps(evidence) if evidence else None, run_id))

    def cancel(self, run_id):
        identifier(run_id)
        with self.connection() as db:
            if db.execute("SELECT count(*) FROM cancelled_runs").fetchone()[0] >= 10000 and not db.execute("SELECT 1 FROM cancelled_runs WHERE id=?", (run_id,)).fetchone():
                raise HttpError(507, "CANCELLATION_LEDGER_LIMIT", "Cancellation ledger capacity reached; cleanup cannot be acknowledged")
            # Keep even after artifact/data deletion: a delayed HTTP submission
            # must never revive a previously cancelled run ID.
            db.execute("INSERT OR IGNORE INTO cancelled_runs VALUES (?)", (run_id,))
            db.execute("UPDATE runs SET cancel=1 WHERE id=?", (run_id,))

    def unfinished(self):
        with self.connection() as db:
            rows = [dict(row) for row in db.execute("SELECT * FROM runs")]
        return [row for row in rows if row["state"] != "finished" or (row["evidence"] and json.loads(row["evidence"])["cleanup"] == "failed")]

    def put_artifact(self, payload, stream, text, truncated):
        raw = redact(text).encode("utf-8")
        truncated = bool(truncated or len(raw) > LIMITS["output_bytes"])
        raw = raw[:LIMITS["output_bytes"]].decode("utf-8", errors="ignore").encode()
        artifact_id = str(uuid.uuid4())
        checksum = hashlib.sha256(raw).hexdigest()
        with self.connection() as db:
            used = db.execute("SELECT COALESCE(sum(bytes),0) FROM artifacts WHERE investigation_id=?", (payload["investigation_id"],)).fetchone()[0]
            total = db.execute("SELECT COALESCE(sum(bytes),0) FROM artifacts").fetchone()[0]
            if used + len(raw) > LIMITS["artifact_bytes"] or total + len(raw) > 67108864:
                raise HttpError(507, "ARTIFACT_LIMIT", "Artifact storage budget exceeded")
            path = self.artifacts / artifact_id
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "wb") as file:
                    file.write(raw)
                    file.flush()
                    os.fsync(file.fileno())
                db.execute("INSERT INTO artifacts VALUES (?,?,?,?,?,?,?)", (artifact_id, payload["investigation_id"], payload["run_id"], len(raw), checksum, int(truncated), stream))
            except Exception:
                path.unlink(missing_ok=True)
                raise
        return {"id": artifact_id, "bytes": len(raw), "sha256": checksum, "truncated": truncated, "stream": stream}

    def artifact(self, artifact_id):
        identifier(artifact_id)
        with self.connection() as db:
            row = db.execute("SELECT * FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        if row is None:
            raise HttpError(404, "NOT_FOUND", "Artifact not found")
        fd = os.open(self.artifacts / artifact_id, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as file:
            raw = file.read(LIMITS["output_bytes"] + 1)
        if len(raw) != row["bytes"] or hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise HttpError(409, "ARTIFACT_CHANGED", "Artifact integrity check failed")
        return {"id": artifact_id, "content": raw.decode(), "truncated": bool(row["truncated"])}

    def purge(self, investigation_id):
        identifier(investigation_id)
        with self.connection() as db:
            rows = db.execute("SELECT * FROM runs WHERE investigation_id=?", (investigation_id,)).fetchall()
            if any(row["state"] != "finished" or not row["evidence"] or json.loads(row["evidence"])["cleanup"] != "completed" for row in rows):
                raise HttpError(409, "CLEANUP_PENDING", "Cannot delete unresolved runner evidence")
            if db.execute("SELECT count(*) FROM purged_investigations").fetchone()[0] >= 10000 and not db.execute("SELECT 1 FROM purged_investigations WHERE id=?", (investigation_id,)).fetchone():
                raise HttpError(507, "PURGE_LEDGER_LIMIT", "Retirement ledger capacity reached")
            # Covers both replays of known runs and requests still in flight when
            # an otherwise empty investigation is deleted. Keep only the UUID.
            db.execute("INSERT OR IGNORE INTO purged_investigations VALUES (?)", (investigation_id,))
            artifacts = db.execute("SELECT id FROM artifacts WHERE investigation_id=?", (investigation_id,)).fetchall()
            for row in artifacts:
                (self.artifacts / identifier(row["id"])).unlink(missing_ok=True)
            db.execute("DELETE FROM artifacts WHERE investigation_id=?", (investigation_id,))
            db.execute("DELETE FROM runs WHERE investigation_id=?", (investigation_id,))
