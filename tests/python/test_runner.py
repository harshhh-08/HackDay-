import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import io
import json
from pathlib import Path
import tempfile
import subprocess
import time
import unittest
import uuid
from unittest.mock import Mock
from services.common import CONTRACT, LIMITS, HttpError, ROOT, digest
from services.runner.controller import Controller, Podman
from services.runner.harness import BoundedCapture, parse_result, TARGETS, MARKER
from services.runner.policy import container_command, pytest_argv, snapshot_hash, validate_request
from services.runner.storage import Storage

KEY = "test-only-signing-key-not-for-production"
SNAPSHOT = {"repository_id": "checkout", "commit_sha": None, "snapshot_sha256": "a" * 64, "image": "sha256:" + "b" * 64}


def request():
    plan = {"schema_version": 1, "repository": copy.deepcopy(SNAPSHOT), "adapter": "pytest", "target": CONTRACT["targets"][0],
            "argv": pytest_argv(CONTRACT["targets"][0]), "script": None, "hypothesis": "Unverified test hypothesis",
            "expected_signal": CONTRACT["failure_marker"], "limits": copy.deepcopy(LIMITS), "repeats": 1, "network": "none"}
    payload = {"schema_version": 1, "run_id": str(uuid.uuid4()), "investigation_id": str(uuid.uuid4()), "plan": plan, "plan_hash": digest(plan)}
    message = f"{payload['investigation_id']}\n{payload['run_id']}\n{payload['plan_hash']}".encode()
    payload["approval"] = {"actor": "local-maintainer", "signature": hmac.new(KEY.encode(), message, hashlib.sha256).hexdigest()}
    return payload


class SimulatedRuntime:
    """Synthetic transport only. These tests never invoke Podman or pytest."""
    def __init__(self, cleanup=True, wait=False):
        self.calls = 0
        self.cleanup_calls = 0
        self.cleaned = cleanup
        self.wait = wait

    def snapshot(self, _image):
        return SNAPSHOT

    def cleanup(self, _run_id):
        self.cleanup_calls += 1
        return self.cleaned

    def execute(self, _payload, _image, cancelled, started):
        self.calls += 1
        started()
        if self.wait:
            deadline = time.monotonic() + 2
            while not cancelled() and time.monotonic() < deadline:
                time.sleep(0.01)
        was_cancelled = cancelled()
        return {"classification": "cancelled" if was_cancelled else "test_pass", "selected_test_ran": not was_cancelled,
                "matched_signal": False, "exit_code": None if was_cancelled else 0, "reason": "Synthetic test result",
                "stdout": "simulated output", "stderr": "", "stdout_truncated": False, "stderr_truncated": False, "environment": {}}


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bugout-unit-")
        self.addCleanup(self.temp.cleanup)
        self.storage = Storage(Path(self.temp.name) / "runner")

    def finish(self, controller, run_id):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = controller.storage.public(run_id)
            if result["state"] == "finished":
                return result
            time.sleep(0.01)
        self.fail("Simulated runner did not finish")

    def test_approval_signature_and_mutation(self):
        payload = request()
        validate_request(payload, KEY, SNAPSHOT)
        for field, value in [("run_id", str(uuid.uuid4())), ("investigation_id", str(uuid.uuid4()))]:
            changed = copy.deepcopy(payload)
            changed[field] = value
            with self.assertRaises(HttpError):
                validate_request(changed, KEY, SNAPSHOT)
        changed = copy.deepcopy(payload)
        changed["plan"]["argv"].append("; rm -rf /")
        with self.assertRaises(ValueError):
            validate_request(changed, KEY, SNAPSHOT)
        changed = copy.deepcopy(payload)
        changed["plan"]["repeats"] = 2
        changed["plan_hash"] = digest(changed["plan"])
        with self.assertRaises(HttpError):
            validate_request(changed, KEY, SNAPSHOT)

    def test_network_budget_and_script_changes_blocked(self):
        for field, value in [("network", "host"), ("script", "print('unapproved')"), ("repeats", 4), ("target", "../../etc/passwd")]:
            payload = request()
            payload["plan"][field] = value
            with self.assertRaises((ValueError, HttpError)):
                validate_request(payload, KEY, SNAPSHOT)

    def test_container_command_has_restrictions_and_no_host_mounts(self):
        argv = container_command(request(), SNAPSHOT["image"])
        self.assertIn("--read-only", argv)
        self.assertIn("--read-only-tmpfs=false", argv)
        self.assertIn("--http-proxy=false", argv)
        self.assertEqual(argv[argv.index("--network") + 1], "none")
        self.assertEqual(argv[argv.index("--cap-drop") + 1], "ALL")
        self.assertEqual(argv[argv.index("--user") + 1], "65532:65532")
        self.assertIn("--pids-limit", argv)
        self.assertIn("--memory", argv)
        self.assertEqual(argv[argv.index("--timeout") + 1], "35")
        self.assertNotIn("--privileged", argv)
        self.assertNotIn("--volume", argv)
        self.assertNotIn("--mount", argv)

    def test_idempotent_submission_never_reexecutes(self):
        runtime = SimulatedRuntime()
        controller = Controller(self.storage, runtime, SNAPSHOT["image"], KEY, True)
        payload = request()
        controller.submit(payload)
        self.finish(controller, payload["run_id"])
        controller.submit(payload)
        self.assertEqual(runtime.calls, 1)
        changed = copy.deepcopy(payload)
        changed["plan"]["repeats"] = 2
        with self.assertRaises(HttpError):
            controller.submit(changed)

    def test_concurrent_duplicate_submissions_launch_one_simulated_execution(self):
        runtime = SimulatedRuntime()
        controller = Controller(self.storage, runtime, SNAPSHOT["image"], KEY, True)
        payload = request()
        with ThreadPoolExecutor(max_workers=8) as callers:
            results = list(callers.map(lambda _: controller.submit(payload), range(8)))
        self.finish(controller, payload["run_id"])
        self.assertTrue(all(result["run_id"] == payload["run_id"] for result in results))
        self.assertEqual(runtime.calls, 1)

    def test_cancellation_records_cleanup(self):
        runtime = SimulatedRuntime(wait=True)
        controller = Controller(self.storage, runtime, SNAPSHOT["image"], KEY, True)
        payload = request()
        controller.submit(payload)
        self.storage.cancel(payload["run_id"])
        result = self.finish(controller, payload["run_id"])
        self.assertEqual(result["evidence"]["classification"], "cancelled")
        self.assertEqual(result["evidence"]["cleanup"], "completed")

    def test_cancellation_tombstone_prevents_late_submission(self):
        runtime = SimulatedRuntime()
        controller = Controller(self.storage, runtime, SNAPSHOT["image"], KEY, True)
        payload = request()
        self.storage.cancel(payload["run_id"])
        # Purging an investigation with no run must not remove its cancellation
        # protection while an earlier HTTP submit may still arrive.
        self.storage.purge(payload["investigation_id"])
        with self.assertRaises(HttpError) as rejected:
            controller.submit(payload)
        self.assertEqual(rejected.exception.code, "INVESTIGATION_PURGED")
        self.assertEqual(runtime.calls, 0)

    def test_crash_recovery_records_uncertainty_without_rerun(self):
        payload = request()
        self.storage.reserve(payload, digest(payload))
        self.storage.mark(payload["run_id"], "running")
        runtime = SimulatedRuntime()
        Controller(self.storage, runtime, SNAPSHOT["image"], KEY, True).recover()
        result = self.storage.public(payload["run_id"])
        self.assertEqual(result["evidence"]["classification"], "runner_failure")
        self.assertEqual(runtime.calls, 0)

    def test_failed_cleanup_blocks_readiness_and_deletion(self):
        controller = Controller(self.storage, SimulatedRuntime(cleanup=False), SNAPSHOT["image"], KEY, True)
        payload = request()
        controller.submit(payload)
        result = self.finish(controller, payload["run_id"])
        self.assertEqual(result["evidence"]["cleanup"], "failed")
        with self.assertRaises(HttpError):
            controller.ready()
        with self.assertRaises(HttpError):
            self.storage.purge(payload["investigation_id"])

    def test_disabled_runner_never_submits(self):
        runtime = SimulatedRuntime()
        controller = Controller(self.storage, runtime, SNAPSHOT["image"], KEY, False)
        with self.assertRaises(HttpError):
            controller.submit(request())
        self.assertEqual(runtime.calls, 0)

    def test_deleted_investigation_cannot_replay_an_approved_run(self):
        runtime = SimulatedRuntime()
        controller = Controller(self.storage, runtime, SNAPSHOT["image"], KEY, True)
        payload = request()
        controller.submit(payload)
        self.finish(controller, payload["run_id"])
        self.storage.purge(payload["investigation_id"])
        error = None
        try:
            controller.submit(payload)
            self.finish(controller, payload["run_id"])
        except HttpError as caught:
            error = caught
        self.assertIsNotNone(error, "A deleted investigation accepted a replayed execution")
        self.assertEqual(error.code, "INVESTIGATION_PURGED")
        self.assertEqual(runtime.calls, 1)

    def test_purge_blocks_a_submission_that_has_not_arrived_yet(self):
        runtime = SimulatedRuntime()
        controller = Controller(self.storage, runtime, SNAPSHOT["image"], KEY, True)
        payload = request()
        self.storage.purge(payload["investigation_id"])
        error = None
        try:
            controller.submit(payload)
            self.finish(controller, payload["run_id"])
        except HttpError as caught:
            error = caught
        self.assertIsNotNone(error, "A late submission revived a purged investigation")
        self.assertEqual(runtime.calls, 0)

    def test_podman_cleanup_escalates_after_stop_timeout(self):
        runtime = Podman()
        run_id = str(uuid.uuid4())
        runtime.command = Mock(side_effect=[
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 0, run_id, ""),
            subprocess.TimeoutExpired(["podman", "stop"], 5),
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 1, "", ""),
        ])
        self.assertTrue(runtime.cleanup(run_id))
        self.assertIn("rm", runtime.command.call_args_list[3].args[0])

    def test_cleanup_runs_even_if_intermediate_persistence_fails(self):
        runtime = SimulatedRuntime()
        controller = Controller(self.storage, runtime, SNAPSHOT["image"], KEY, True)
        original_mark = self.storage.mark
        def failing_mark(run_id, state, evidence=None):
            if state == "finishing":
                raise OSError("Simulated persistence failure")
            original_mark(run_id, state, evidence)
        self.storage.mark = failing_mark
        payload = request()
        controller.submit(payload)
        result = self.finish(controller, payload["run_id"])
        self.assertEqual(runtime.cleanup_calls, 1)
        self.assertEqual(result["evidence"]["cleanup"], "completed")
        self.assertEqual(result["evidence"]["classification"], "runner_failure")

    def test_recovery_preserves_already_saved_evidence(self):
        runtime = SimulatedRuntime()
        controller = Controller(self.storage, runtime, SNAPSHOT["image"], KEY, True)
        payload = request()
        self.storage.reserve(payload, digest(payload))
        result = {"classification": "test_pass", "selected_test_ran": True, "matched_signal": False,
                  "exit_code": 0, "environment": {}, "reason": "Synthetic saved result"}
        saved = controller.evidence(payload, result, "2026-10-25T00:00:00.000Z", 100, [], False)
        self.storage.mark(payload["run_id"], "finishing", saved)
        controller.recover()
        recovered = self.storage.public(payload["run_id"])["evidence"]
        self.assertEqual(recovered["classification"], "test_pass")
        self.assertEqual(recovered["cleanup"], "completed")
        self.assertEqual(runtime.calls, 0)

    def test_artifacts_are_redacted_bounded_and_integrity_checked(self):
        payload = request()
        artifact = self.storage.put_artifact(payload, "stdout", "password=pretend-secret\n" + "x" * 70000, False)
        output = self.storage.artifact(artifact["id"])
        self.assertTrue("pretend-secret" not in output["content"], "Secret value leaked")
        self.assertLessEqual(artifact["bytes"], 65536)
        self.assertTrue(artifact["truncated"])
        (self.storage.artifacts / artifact["id"]).write_text("tampered")
        with self.assertRaises(HttpError):
            self.storage.artifact(artifact["id"])
        with self.assertRaises(ValueError):
            self.storage.artifact("../../etc/passwd")

    def test_artifact_symlink_escape_rejected(self):
        payload = request()
        artifact = self.storage.put_artifact(payload, "stderr", "safe", False)
        path = self.storage.artifacts / artifact["id"]
        path.unlink()
        path.symlink_to(Path(self.temp.name) / "outside")
        with self.assertRaises(OSError):
            self.storage.artifact(artifact["id"])

    def test_capture_drains_without_unbounded_storage(self):
        capture = BoundedCapture(10)
        capture.consume(io.BytesIO(b"x" * 100000))
        self.assertEqual(len(capture.data), 10)
        self.assertTrue(capture.truncated)

    def test_fixture_hash_is_content_addressed_and_harness_constants_match(self):
        checksum = snapshot_hash(ROOT / "fixtures/checkout")
        self.assertEqual(len(checksum), 64)
        self.assertEqual(list(TARGETS), CONTRACT["targets"])
        self.assertEqual(MARKER, CONTRACT["failure_marker"])

    def test_junit_failure_requires_exact_test_and_assertion(self):
        xml = f'<testsuites><testsuite><testcase name="test_percentage_discount" file="tests/test_checkout.py"><failure>AssertionError: {MARKER}</failure></testcase></testsuite></testsuites>'
        result = parse_result(1, xml, TARGETS[0])
        self.assertTrue(result["matched_signal"])
        self.assertFalse(parse_result(1, xml.replace("test_percentage_discount", "other_test"), TARGETS[0])["matched_signal"])
        self.assertFalse(parse_result(2, xml, TARGETS[0])["matched_signal"])
        self.assertEqual(parse_result(1, xml.replace("failure", "error"), TARGETS[0])["classification"], "setup_error")

    def test_pass_skip_missing_and_entity_results(self):
        xml = '<testsuites><testsuite><testcase name="test_no_discount" file="tests/test_checkout.py"/></testsuite></testsuites>'
        self.assertEqual(parse_result(0, xml, TARGETS[1])["classification"], "test_pass")
        self.assertEqual(parse_result(0, "", TARGETS[1])["classification"], "inconclusive")
        self.assertEqual(parse_result(0, '<!DOCTYPE x>' + xml, TARGETS[1])["classification"], "inconclusive")
        self.assertEqual(parse_result(-9, "", TARGETS[1], True)["classification"], "timeout")


if __name__ == "__main__":
    unittest.main()
