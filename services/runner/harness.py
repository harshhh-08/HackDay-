"""Trusted image entrypoint. Only this module launches pytest, inside the container.

Do not run this module on the host. Tests import only parse_result/BoundedCapture.
"""
from __future__ import annotations

import importlib.metadata
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import xml.etree.ElementTree as ET

OUTPUT_LIMIT = 65536
TARGETS = ("tests/test_checkout.py::test_percentage_discount", "tests/test_checkout.py::test_no_discount")
MARKER = "BUGOUT_CHECKOUT_TOTAL expected=2250 actual=2490"


class BoundedCapture:
    def __init__(self, limit):
        self.limit = limit
        self.data = bytearray()
        self.truncated = False

    def consume(self, stream):
        while chunk := stream.read(4096):
            remaining = self.limit - len(self.data)
            self.data.extend(chunk[:remaining])
            self.truncated |= len(chunk) > remaining

    def text(self):
        return self.data.decode("utf-8", errors="replace")


def parse_result(exit_code, xml_text, target, timed_out=False):
    result = {"classification": "inconclusive", "selected_test_ran": False, "matched_signal": False, "reason": "Ambiguous or missing selected test evidence"}
    if timed_out:
        return {**result, "classification": "timeout", "reason": "Pytest wall-clock budget exhausted"}
    if exit_code in (2, 3, 4, 5):
        return {**result, "classification": {2: "collection_error", 3: "runner_failure", 4: "setup_error", 5: "unsupported"}[exit_code], "reason": "Pytest did not complete a selected test"}
    if not isinstance(xml_text, str) or len(xml_text.encode()) > 65536 or "<!DOCTYPE" in xml_text.upper() or "<!ENTITY" in xml_text.upper():
        return result
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return result
    tests = root.findall(".//testcase")
    file, name = target.split("::")
    if len(tests) != 1 or tests[0].get("name") != name or tests[0].get("file") != file:
        return result
    test = tests[0]
    if test.find("error") is not None:
        return {**result, "classification": "setup_error", "reason": "Selected test setup/teardown error"}
    if test.find("skipped") is not None:
        return {**result, "reason": "Selected test skipped"}
    result["selected_test_ran"] = True
    failure = test.find("failure")
    if exit_code == 0 and failure is None:
        return {**result, "classification": "test_pass", "reason": "Selected test passed under recorded conditions"}
    if exit_code == 1 and failure is not None:
        text = (failure.text or "") + failure.get("message", "")
        # The marker must be attached to the exact selected failing test; merely
        # printing it in stdout/setup cannot establish a reproduced signal.
        matched = MARKER in text and "AssertionError" in text
        return {**result, "classification": "test_failure", "matched_signal": matched,
                "reason": "Expected assertion observed" if matched else "Selected test failed with a different signal"}
    return result


def main():
    if not Path("/run/.containerenv").exists() and not Path("/.dockerenv").exists():
        raise SystemExit("Refusing host execution: this entrypoint belongs inside the runner image")
    target = sys.argv[1] if len(sys.argv) == 2 else ""
    if target not in TARGETS:
        raise SystemExit("Unsupported fixture target")
    argv = ["python", "-m", "pytest", "-q", target, "-p", "no:cacheprovider", "-o", "junit_family=xunit1", "--junitxml=/tmp/bugout-results.xml"]
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    stdout, stderr = BoundedCapture(OUTPUT_LIMIT), BoundedCapture(OUTPUT_LIMIT)
    readers = [threading.Thread(target=stdout.consume, args=(process.stdout,)), threading.Thread(target=stderr.consume, args=(process.stderr,))]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
    finally:
        # Reap background descendants that retained stdout/stderr after pytest
        # returned. Podman's independent timeout also bounds the whole container.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for reader in readers:
        reader.join(timeout=3)
    xml_path = Path("/tmp/bugout-results.xml")
    xml_text = xml_path.read_text(errors="replace") if xml_path.exists() and xml_path.stat().st_size <= 65536 else ""
    result = parse_result(process.returncode, xml_text, target, timed_out)
    result.update({"exit_code": process.returncode, "stdout": stdout.text(), "stderr": stderr.text(),
                   "stdout_truncated": stdout.truncated, "stderr_truncated": stderr.truncated,
                   "environment": {"python": sys.version.split()[0], "pytest": importlib.metadata.version("pytest")}})
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
