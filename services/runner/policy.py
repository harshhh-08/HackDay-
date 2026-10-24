from __future__ import annotations

import hashlib
import hmac
from pathlib import Path
import re
import uuid
from services.common import CONTRACT, LIMITS, HttpError, canonical, digest, require_object

FIXTURE_FILES = ("README.md", "checkout.py", "pytest.ini", "tests/test_checkout.py")


def identifier(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Invalid identifier")
    return value


def snapshot_hash(root):
    root = Path(root)
    if root.is_symlink():
        raise ValueError("Fixture root must not be a symlink")
    root = root.resolve()
    records = []
    for name in FIXTURE_FILES:
        path = root / name
        if any(part.is_symlink() for part in [path, *path.parents] if part != root.parent):
            raise ValueError("Fixture symlinks are unsupported")
        with path.open("rb") as file:
            content = file.read(65537)
        if len(content) > 65536:
            raise ValueError("Fixture file too large")
        records.append({"path": name, "sha256": hashlib.sha256(content).hexdigest()})
    return digest(records)


def pytest_argv(target):
    return ["python", "-m", "pytest", "-q", target, "-p", "no:cacheprovider", "-o", "junit_family=xunit1", "--junitxml=/tmp/bugout-results.xml"]


def validate_request(payload, signing_key, snapshot):
    require_object(payload, {"schema_version", "run_id", "investigation_id", "plan", "plan_hash", "approval"})
    identifier(payload["run_id"])
    identifier(payload["investigation_id"])
    if payload["schema_version"] != 1 or isinstance(payload["schema_version"], bool):
        raise ValueError("Unsupported schema version")
    plan = payload["plan"]
    require_object(plan, {"schema_version", "repository", "adapter", "target", "argv", "script", "hypothesis", "expected_signal", "limits", "repeats", "network"})
    if type(plan["schema_version"]) is not int or plan["schema_version"] != 1 or plan["adapter"] != "pytest" or plan["script"] is not None or plan["network"] != "none":
        raise ValueError("Unsupported operation")
    if plan["target"] not in CONTRACT["targets"] or plan["argv"] != pytest_argv(plan["target"]):
        raise ValueError("Only fixed fixture argv is permitted")
    if canonical(plan["limits"]) != canonical(LIMITS) or type(plan["repeats"]) is not int or not 1 <= plan["repeats"] <= LIMITS["repeats"]:
        raise ValueError("Invalid resource/repeat policy")
    if plan["expected_signal"] != CONTRACT["failure_marker"] or not isinstance(plan["hypothesis"], str) or len(plan["hypothesis"]) > 1024:
        raise ValueError("Invalid expected signal or hypothesis")
    if plan["repository"] != snapshot:
        raise HttpError(409, "SNAPSHOT_CHANGED", "The approved snapshot or image changed")
    if digest(plan) != payload["plan_hash"]:
        raise HttpError(409, "PLAN_CHANGED", "The approved plan hash changed")
    require_object(payload["approval"], {"actor", "signature"})
    message = f"{payload['investigation_id']}\n{payload['run_id']}\n{payload['plan_hash']}".encode()
    expected = hmac.new(signing_key.encode(), message, hashlib.sha256).hexdigest()
    signature = payload["approval"]["signature"]
    if payload["approval"]["actor"] != "local-maintainer" or not isinstance(signature, str) or not hmac.compare_digest(expected, signature):
        raise HttpError(403, "APPROVAL_REQUIRED", "Exact authorized plan approval is required")
    return payload


def container_name(run_id):
    return "bugout-run-" + identifier(run_id)


def container_command(payload, image):
    if not re.fullmatch(r"(?:[^\s]+@)?sha256:[a-f0-9]{64}", image):
        raise ValueError("An immutable image is required")
    return [
        "podman", "create", "--name", container_name(payload["run_id"]),
        "--label", f"org.bugout.run={payload['run_id']}", "--pull", "never",
        "--network", "none", "--http-proxy=false", "--read-only", "--read-only-tmpfs=false",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", "65532:65532", "--cpus", "1", "--memory", "512m", "--memory-swap", "512m",
        "--pids-limit", "64", "--timeout", "35", "--ulimit", "fsize=131072:131072", "--log-driver", "none",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=134217728,mode=1777",
        "--workdir", "/fixture", "--env", "HOME=/tmp", "--env", "PYTHONDONTWRITEBYTECODE=1",
        "--env", "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1", "--entrypoint", "python",
        image, "/opt/bugout/harness.py", payload["plan"]["target"],
    ]
