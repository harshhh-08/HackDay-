"""Opt-in real Podman verification; never installs, pulls, or builds anything.

These fixed diagnostic programs are trusted runner tests, not an API feature or
model-generated code. They execute only inside the pinned registered image.
"""
import json
import os
import subprocess
import threading
import time
import uuid
from services.common import CONTRACT, HttpError, load_environment
from services.runner.controller import Podman, now
from services.runner.harness import BoundedCapture
from services.runner.policy import container_command, container_name

BASELINE = r'''
import errno, json, os, pathlib, socket, subprocess
status = dict(line.split(':', 1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert os.getuid() == 65532
assert int(status['CapEff'].strip(), 16) == 0
assert status['NoNewPrivs'].strip() == '1'
assert set(os.listdir('/sys/class/net')) == {'lo'}
try:
    socket.create_connection(('1.1.1.1', 53), timeout=0.5)
except OSError:
    pass
else:
    raise AssertionError('Unexpected outbound network connectivity')
for name in ('BUGOUT_TOKEN', 'RUNNER_TOKEN', 'ENGINE_TOKEN', 'APPROVAL_SIGNING_KEY', 'POSTGRES_PASSWORD', 'http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY'):
    assert name not in os.environ, 'Unexpected inherited environment variable'
for name in ('/Users', '/root/.ssh', '/var/run/docker.sock', '/run/podman/podman.sock'):
    assert not pathlib.Path(name).exists(), 'Unexpected host mount or credential path'
mounts = [line.split() for line in pathlib.Path('/proc/mounts').read_text().splitlines()]
assert any(row[1] == '/' and 'ro' in row[3].split(',') for row in mounts)
assert any(row[1] == '/tmp' and {'noexec', 'nosuid', 'nodev'} <= set(row[3].split(',')) for row in mounts)
scratch = os.statvfs('/tmp')
assert scratch.f_blocks * scratch.f_frsize <= 128 * 1024 * 1024
test = pathlib.Path('/tmp/noexec-test')
test.write_text('#!/bin/sh\nexit 0\n')
test.chmod(0o700)
try:
    subprocess.run([str(test)], check=True)
except OSError as error:
    assert error.errno == errno.EACCES
else:
    raise AssertionError('Scratch executable unexpectedly ran')
def cgroup(name):
    return pathlib.Path('/sys/fs/cgroup', name).read_text().strip()
assert int(cgroup('memory.max')) <= 512 * 1024 * 1024
assert cgroup('memory.swap.max') == '0'
assert int(cgroup('pids.max')) <= 64
quota, period = cgroup('cpu.max').split()
assert quota != 'max' and int(quota) / int(period) <= 1
print(json.dumps({'uid': os.getuid(), 'memory_max': cgroup('memory.max'), 'pids_max': cgroup('pids.max'), 'cpu_max': cgroup('cpu.max'), 'scratch_bytes': scratch.f_blocks * scratch.f_frsize}))
'''
PIDS = r'''
import errno, json, os, signal, time
children = []
blocked = False
try:
    for _ in range(100):
        try:
            pid = os.fork()
        except OSError as error:
            assert error.errno == errno.EAGAIN
            blocked = True
            break
        if pid == 0:
            time.sleep(20)
            os._exit(0)
        children.append(pid)
finally:
    for pid in children:
        os.kill(pid, signal.SIGKILL)
    for pid in children:
        os.waitpid(pid, 0)
assert blocked, 'Process cap not enforced'
print(json.dumps({'children_before_limit': len(children)}))
'''
DISK = r'''
import errno, json, pathlib
written = 0
blocked = False
for index in range(2200):
    try:
        with pathlib.Path('/tmp', str(index)).open('wb') as file:
            file.write(b'x' * 65536)
        written += 65536
    except OSError as error:
        assert error.errno == errno.ENOSPC
        blocked = True
        break
assert blocked, 'Scratch capacity was not enforced'
print(json.dumps({'bytes_written_before_enospc': written}))
'''
MEMORY = "items=[]\nwhile True:\n items.append(bytearray(8 * 1024 * 1024))"
OUTPUT = "import os\nfor _ in range(64):\n os.write(1,b'x'*4096); os.write(2,b'y'*4096)"


def probe(runtime, image, name, code, mode="json"):
    run_id = str(uuid.uuid4())
    payload = {"run_id": run_id, "plan": {"target": CONTRACT["targets"][0]}}
    argv = container_command(payload, image)
    argv[2:2] = ["--label", "org.bugout.probe=true"]
    argv[-2:] = ["-c", code]
    if mode == "timeout":
        argv[argv.index("--timeout") + 1] = "2"  # Same runtime mechanism, accelerated probe.
    started = time.monotonic()
    process = None
    try:
        created = runtime.command(argv)
        if created.returncode:
            raise RuntimeError(f"{name}: container creation failed")
        inspected = runtime.command(["podman", "inspect", container_name(run_id)])
        if inspected.returncode:
            raise RuntimeError(f"{name}: could not inspect created container")
        configuration = json.loads(inspected.stdout)[0]
        if any(mount.get("Type") == "bind" for mount in configuration.get("Mounts", [])):
            raise RuntimeError(f"{name}: unexpected host bind mount")
        if configuration.get("HostConfig", {}).get("Privileged"):
            raise RuntimeError(f"{name}: privileged execution unexpectedly enabled")
        process = subprocess.Popen(["podman", "start", "--attach", container_name(run_id)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = BoundedCapture(65536), BoundedCapture(65536)
        readers = [threading.Thread(target=out.consume, args=(process.stdout,), daemon=True), threading.Thread(target=err.consume, args=(process.stderr,), daemon=True)]
        for reader in readers:
            reader.start()
        if mode == "cancel":
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                inspected = runtime.command(["podman", "inspect", "--format", "{{.State.Running}}", container_name(run_id)])
                if inspected.returncode == 0 and inspected.stdout.strip() == "true":
                    break
                time.sleep(0.05)
            else:
                raise RuntimeError("Cancellation probe did not enter running state")
            if not runtime.cleanup(run_id):
                raise RuntimeError("Cancellation cleanup was not confirmed")
        process.wait(timeout=15)
        for reader in readers:
            reader.join(timeout=2)
        elapsed = time.monotonic() - started
        result = {"probe": name, "run_id": run_id, "duration_ms": int(elapsed * 1000), "exit_code": process.returncode}
        if mode == "cancel":
            result["cleanup"] = "completed"
        elif mode == "oom":
            inspected = runtime.command(["podman", "inspect", container_name(run_id)])
            if inspected.returncode or not json.loads(inspected.stdout)[0]["State"]["OOMKilled"] or process.returncode == 0:
                raise RuntimeError("Memory probe did not produce a recorded cgroup OOM kill")
            result["oom_killed"] = True
        elif mode == "timeout":
            if process.returncode == 0 or not 1 <= elapsed <= 10:
                raise RuntimeError("Independent two-second container timeout was not observed")
            result["probe_timeout_seconds"] = 2
        elif mode == "output":
            if process.returncode or len(out.data) != 65536 or len(err.data) != 65536 or not out.truncated or not err.truncated:
                raise RuntimeError("Real output streams were not bounded and drained")
            result["captured_bytes"] = {"stdout": len(out.data), "stderr": len(err.data)}
        else:
            if process.returncode or out.truncated or err.truncated:
                raise RuntimeError(f"{name}: diagnostic assertions failed")
            result["measurements"] = json.loads(out.text())
        return result
    finally:
        try:
            if not runtime.cleanup(run_id):
                raise RuntimeError(f"Cleanup unconfirmed for owned probe {container_name(run_id)}")
        finally:
            if process and process.poll() is None:
                process.kill()
                process.wait(timeout=3)


def main():
    load_environment()
    runtime = Podman()
    try:
        snapshot = runtime.snapshot(os.environ.get("RUNNER_IMAGE", ""))
    except (HttpError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "blocked", "reason": getattr(error, "message", "Podman preflight failed"), "executed_probes": 0}))
        return 2
    results = []
    try:
        for name, code, mode in [
            ("identity-network-filesystem-cgroups", BASELINE, "json"),
            ("pids-limit", PIDS, "json"), ("scratch-capacity", DISK, "json"),
            ("memory-oom", MEMORY, "oom"), ("bounded-output", OUTPUT, "output"),
            ("independent-runtime-timeout", "import time; time.sleep(60)", "timeout"),
            ("explicit-cancellation-cleanup", "import time; time.sleep(60)", "cancel"),
        ]:
            results.append(probe(runtime, snapshot["image"], name, code, mode))
    except Exception as error:
        print(json.dumps({"status": "failed", "reason": str(error), "completed_probes": results}, indent=2))
        return 1
    print(json.dumps({"status": "passed", "recorded_at": now(), "snapshot": snapshot,
                      "podman": runtime.command(["podman", "--version"]).stdout.strip(), "probes": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
