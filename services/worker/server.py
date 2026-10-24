import os
from services.common import HttpError, load_environment, require_object, secret, serve
from services.worker.engine import analyze
from services.worker.reports import assemble


def application(method, path, body):
    if method == "GET" and path == "/ready":
        return {"ready": True, "provider": "disabled"}
    if method == "POST" and path == "/analyze":
        require_object(body, {"intake", "rounds"})
        return analyze(body)
    if method == "POST" and path == "/report":
        require_object(body, {"investigation", "rounds", "approvals", "runs"})
        return assemble(body)
    raise HttpError(404, "NOT_FOUND", "Unknown engine operation")


if __name__ == "__main__":
    load_environment()
    if os.environ.get("MODEL_PROVIDER") != "disabled":
        raise ValueError("Only the disabled model provider is implemented")
    serve(os.environ["ENGINE_URL"], secret("ENGINE_TOKEN"), application)
