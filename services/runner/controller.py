from __future__ import annotations

from datetime import datetime, timezone
import json
import re
import shutil
import subprocess
import threading
import time
from services.common import HttpError, ROOT, digest, redact
from services.runner.harness import BoundedCapture
from services.runner.policy import container_command, container_name, snapshot_hash, validate_request


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Podman:
    """All runtime commands are fixed argv. No shell and no workload on the host."""
    def command(self, argv, timeout=8):
        return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, text=True, check=False)

    def snapshot(self, image):
        if not shutil.which("podman") or not re.fullmatch(r"(?:[^\s]+@)?sha256:[a-f0-9]{64}", image):
            raise HttpError(503, "RUNNER_UNAVAILABLE", "Podman and an immutable local image are required")
        info = self.command(["podman", "info", "--format", "{{.Host.Security.Rootless}}"])
        if info.returncode or info.stdout.strip() != "true":
            raise HttpError(503, "ROOTLESS_REQUIRED", "Rootless Podman must be available")
        inspected = self.command(["podman", "image", "inspect", image])
        if inspected.returncode:
            raise HttpError(503, "IMAGE_UNAVAILABLE", "The pinned local image is unavailable")
        details = json.loads(inspected.stdout)[0]
        checksum = snapshot_hash(ROOT / "fixtures/checkout")
        if details.get("Config", {}).get("Labels", {}).get("org.bugout.fixture.sha256") != checksum:
            raise HttpError(409, "IMAGE_FIXTURE_MISMATCH", "Rebuild the image for the current fixture snapshot")
        if details.get("Config", {}).get("User") != "65532:65532":
            raise HttpError(503, "IMAGE_USER_MISMATCH", "Runner image must use the fixture's unprivileged user")
        commit = None
        # Metadata only, scoped to this registered fixture. Hooks/fsmonitor disabled.
        if shutil.which("git"):
            prefix = ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-optional-locks", "-C", str(ROOT)]
            revision = self.command(prefix + ["rev-parse", "HEAD"])
            dirty = self.command(prefix + ["status", "--porcelain", "--untracked-files=all", "--", "fixtures/checkout"])
            if revision.returncode == 0 and dirty.returncode == 0 and not dirty.stdout.strip() and re.fullmatch(r"[a-f0-9]{40,64}", revision.stdout.strip()):
                commit = revision.stdout.strip()
        image_id = details.get("Id", "")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
            raise HttpError(503, "IMAGE_ID_INVALID", "Runtime did not return an immutable image ID")
        return {"repository_id": "checkout", "commit_sha": commit, "snapshot_sha256": checksum, "image": image_id}

    def cleanup(self, run_id):
        name = container_name(run_id)
        exists = self.command(["podman", "container", "exists", name])
        if exists.returncode == 1:
            return True
        if exists.returncode != 0:
            return False
        label = self.command(["podman", "inspect", "--format", '{{index .Config.Labels "org.bugout.run"}}', name])
        if label.returncode or label.stdout.strip() != run_id:
            return False  # Never remove another user's colliding container.
        # A hung graceful stop must not prevent escalation or the final check.
        for argv in (["podman", "stop", "--time", "1", name], ["podman", "rm", "--force", name]):
            try:
                self.command(argv, timeout=5)
            except (subprocess.SubprocessError, OSError):
                pass
        try:
            return self.command(["podman", "container", "exists", name]).returncode == 1
        except (subprocess.SubprocessError, OSError):
            return False

    def execute(self, payload, image, cancelled, started):
        result = self.command(container_command(payload, image))
        if result.returncode:
            raise HttpError(503, "CONTAINER_CREATE_FAILED", "Container creation failed")
        started()
        process = subprocess.Popen(["podman", "start", "--attach", container_name(payload["run_id"])], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = BoundedCapture(1048576), BoundedCapture(65536)
        readers = [threading.Thread(target=stdout.consume, args=(process.stdout,), daemon=True), threading.Thread(target=stderr.consume, args=(process.stderr,), daemon=True)]
        for reader in readers:
            reader.start()
        deadline = time.monotonic() + payload["plan"]["limits"]["seconds"] + 3
        interrupted = None
        try:
            while process.poll() is None:
                if cancelled() or time.monotonic() >= deadline:
                    interrupted = "cancelled" if cancelled() else "timeout"
                    self.cleanup(payload["run_id"])
                    break
                time.sleep(0.1)
        finally:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()  # CLI process only; container cleanup is separate.
                process.wait(timeout=3)
            for reader in readers:
                reader.join(timeout=3)
        if interrupted:
            return {"classification": interrupted, "selected_test_ran": False, "matched_signal": False, "exit_code": None,
                    "stdout": "", "stderr": stderr.text(), "stdout_truncated": False, "stderr_truncated": stderr.truncated,
                    "environment": {}, "reason": "Independent runner cancellation/deadline terminated the workload"}
        if stdout.truncated or process.returncode != 0:
            raise HttpError(503, "HARNESS_FAILED", "Container harness failed or exceeded its response budget")
        result = json.loads(stdout.text())
        required = {"classification", "selected_test_ran", "matched_signal", "exit_code", "reason", "stdout", "stderr", "stdout_truncated", "stderr_truncated", "environment"}
        if not isinstance(result, dict) or set(result) != required:
            raise ValueError("Malformed harness result")
        if result["classification"] not in {"test_pass", "test_failure", "collection_error", "setup_error", "runner_failure", "unsupported", "inconclusive", "timeout"}:
            raise ValueError("Unknown harness classification")
        for field in ("selected_test_ran", "matched_signal", "stdout_truncated", "stderr_truncated"):
            if type(result[field]) is not bool:
                raise ValueError("Invalid harness flag")
        if type(result["exit_code"]) is not int or not isinstance(result["environment"], dict):
            raise ValueError("Invalid harness process metadata")
        for field in ("stdout", "stderr", "reason"):
            if not isinstance(result[field], str):
                raise ValueError("Invalid harness text")
        return result


class Controller:
    def __init__(self, storage, runtime, image, signing_key, enabled):
        self.storage, self.runtime, self.image, self.signing_key, self.enabled = storage, runtime, image, signing_key, enabled
        self.slot = threading.Semaphore(1)
        self.submit_lock = threading.Lock()

    def ready(self):
        if not self.enabled:
            raise HttpError(503, "EXECUTION_DISABLED", "Local fixture execution is disabled")
        if any(row["evidence"] and json.loads(row["evidence"])["cleanup"] == "failed" for row in self.storage.unfinished()):
            raise HttpError(503, "CLEANUP_UNCONFIRMED", "Inspect unresolved container cleanup before accepting new runs")
        return self.runtime.snapshot(self.image)

    def submit(self, payload):
        # Return an existing run even if the VM is now down; do not reexecute it.
        with self.submit_lock:
            self.storage.assert_not_purged(payload["investigation_id"])
            try:
                previous = self.storage.get(payload["run_id"])
            except HttpError as error:
                if error.status != 404:
                    raise
                previous = None
            if previous:
                if previous["request_hash"] != digest(payload):
                    raise HttpError(409, "RUN_CONFLICT", "Run ID already has a different request")
                return self.storage.public(payload["run_id"])
            snapshot = self.ready()
            validate_request(payload, self.signing_key, snapshot)
            if self.storage.reserve(payload, digest(payload)):
                threading.Thread(target=self.execute, args=(payload,), daemon=True).start()
        return self.storage.public(payload["run_id"])

    def evidence(self, payload, result, started_at, duration, artifacts, cleanup):
        return {"schema_version": 1, "run_id": payload["run_id"], "investigation_id": payload["investigation_id"],
                "plan_hash": payload["plan_hash"], "repository": payload["plan"]["repository"], "argv": payload["plan"]["argv"],
                "classification": result["classification"], "selected_test_ran": result["selected_test_ran"],
                "matched_signal": result["matched_signal"], "exit_code": result["exit_code"], "started_at": started_at,
                "ended_at": now(), "duration_ms": duration, "cleanup": "completed" if cleanup else "failed",
                "environment": {**result.get("environment", {}), "image": payload["plan"]["repository"]["image"], "network": "none", "container": container_name(payload["run_id"])},
                "artifacts": artifacts, "reason": redact(result["reason"])[:2048]}

    def execute(self, payload):
        with self.slot:
            run_id = payload["run_id"]
            started_at = None
            clock = time.monotonic()
            artifacts = []
            result = {"classification": "runner_failure", "selected_test_ran": False, "matched_signal": False, "exit_code": None, "environment": {}, "reason": "Runner did not complete an execution"}
            def started():
                nonlocal started_at
                started_at = now()
                self.storage.mark(run_id, "running")
            try:
                if self.storage.get(run_id)["cancel"]:
                    result.update(classification="cancelled", reason="Cancelled before container creation")
                else:
                    validate_request(payload, self.signing_key, self.ready())
                    self.storage.mark(run_id, "creating")
                    result = self.runtime.execute(payload, payload["plan"]["repository"]["image"], lambda: bool(self.storage.get(run_id)["cancel"]), started)
                    for stream in ("stdout", "stderr"):
                        artifacts.append(self.storage.put_artifact(payload, stream, result[stream], result[stream + "_truncated"]))
            except Exception:
                result = {"classification": "runner_failure", "selected_test_ran": False, "matched_signal": False, "exit_code": None, "environment": {}, "reason": "Runtime, policy, capture or artifact persistence failed; no test conclusion inferred"}
            evidence = self.evidence(payload, result, started_at, int((time.monotonic() - clock) * 1000), artifacts, False)
            # Persist captured evidence before cleanup. Restart recovery never
            # reruns an uncertain execution; it only terminates owned containers.
            try:
                self.storage.mark(run_id, "finishing", evidence)
            except Exception:
                # Persistence failure must never skip runtime termination.
                evidence["classification"] = "runner_failure"
                evidence["selected_test_ran"] = False
                evidence["matched_signal"] = False
                evidence["reason"] = "Evidence persistence failed; no test conclusion inferred"
            try:
                cleaned = self.runtime.cleanup(run_id)
            except Exception:
                cleaned = False
            evidence["cleanup"] = "completed" if cleaned else "failed"
            self.storage.mark(run_id, "finished", evidence)

    def recover(self):
        for row in self.storage.unfinished():
            payload = json.loads(row["payload"])
            try:
                cleaned = self.runtime.cleanup(row["id"])
            except Exception:
                cleaned = False
            if row["evidence"]:
                evidence = json.loads(row["evidence"])
                evidence["cleanup"] = "completed" if cleaned else "failed"
            else:
                result = {"classification": "runner_failure", "selected_test_ran": False, "matched_signal": False, "exit_code": None,
                          "environment": {}, "reason": "Runner restarted during an uncertain execution; no automatic rerun"}
                evidence = self.evidence(payload, result, None, 0, [], cleaned)
            self.storage.mark(row["id"], "finished", evidence)
