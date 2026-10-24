import fcntl
import os
import re
from services.common import HttpError, ROOT, load_environment, require_object, secret, serve
from services.runner.controller import Controller, Podman
from services.runner.policy import identifier
from services.runner.storage import Storage


def application(controller):
    def handle(method, path, body):
        if method == "GET" and path in ("/ready", "/snapshot"):
            snapshot = controller.ready()
            return snapshot if path == "/snapshot" else {"ready": True, "scope": "registered-local-fixture"}
        if method == "POST" and path == "/runs":
            return controller.submit(body)
        match = re.fullmatch(r"/runs/([a-f0-9-]+)(/cancel)?", path)
        if match:
            run_id = identifier(match[1])
            if method == "POST" and match[2]:
                require_object(body, set())
                controller.storage.cancel(run_id)
                try:
                    return controller.storage.public(run_id)
                except HttpError as error:
                    if error.status != 404:
                        raise
                    # Durable tombstone precedes this acknowledgement. A delayed
                    # submit with this ID will be cancelled before container create.
                    return {"run_id": run_id, "state": "finished", "evidence": None}
            if method == "GET" and not match[2]:
                return controller.storage.public(run_id)
        match = re.fullmatch(r"/artifacts/([a-f0-9-]+)", path)
        if method == "GET" and match:
            return controller.storage.artifact(identifier(match[1]))
        if method == "POST" and path == "/purge":
            require_object(body, {"investigation_id"})
            controller.storage.purge(identifier(body["investigation_id"]))
            return {"deleted": True}
        raise HttpError(404, "NOT_FOUND", "Unknown runner operation")
    return handle


if __name__ == "__main__":
    load_environment()
    storage = Storage(ROOT / ".local/runner")
    # Acquire before recovery, so a second process cannot kill the first runner's
    # active containers merely by attempting to start on the same port.
    instance_lock = (storage.root / "instance.lock").open("a")
    fcntl.flock(instance_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    controller = Controller(storage, Podman(), os.environ.get("RUNNER_IMAGE", ""), secret("APPROVAL_SIGNING_KEY"), os.environ.get("RUNNER_ENABLED") == "true")
    controller.recover()
    serve(os.environ["RUNNER_URL"], secret("RUNNER_TOKEN"), application(controller), body_limit=65536)
