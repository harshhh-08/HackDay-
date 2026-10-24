"""Real loopback HTTP tests. Runner execution transport is explicitly simulated."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from services.common import CONTRACT, build_server
from services.worker.server import application as engine_application
from services.runner.controller import Controller
from services.runner.server import application as runner_application
from services.runner.storage import Storage
from test_runner import KEY, SNAPSHOT, SimulatedRuntime, request as runner_request

TOKEN = "local-http-test-token-never-for-production"


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = build_server("http://127.0.0.1:0", TOKEN, engine_application, body_limit=65536)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def send(self, path, payload=None, token=TOKEN, raw=None, headers=None, server=None):
        connection = http.client.HTTPConnection("127.0.0.1", (server or self.server).server_port, timeout=5)
        auth = {"Authorization": "Bearer " + token} if token is not None else {}
        body = json.dumps(payload) if payload is not None else raw
        supplied = {**auth, "Content-Type": "application/json", **(headers or {})}
        try:
            connection.request("POST" if body is not None else "GET", path, body, supplied)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_health_is_public_but_analysis_and_readiness_require_auth(self):
        self.assertEqual(self.send("/health", token=None)[0], 200)
        self.assertEqual(self.send("/ready", token=None)[0], 401)
        self.assertEqual(self.send("/analyze", {"intake": {}, "rounds": []}, token="wrong")[0], 401)
        self.assertEqual(self.send("/ready")[1], {"ready": True, "provider": "disabled"})

    def test_bad_json_content_type_lengths_and_payload_schema(self):
        self.assertEqual(self.send("/analyze", raw="{")[0], 400)
        self.assertEqual(self.send("/analyze", raw="NaN")[0], 400)
        self.assertEqual(self.send("/analyze", raw="{}", headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.send("/analyze", raw="x" * 65537)[0], 413)
        self.assertEqual(self.send("/analyze", {"intake": {"logs": 123}, "rounds": []})[0], 400)
        self.assertEqual(self.send("/analyze", {"intake": {}, "rounds": [], "extra": True})[0], 400)
        self.assertEqual(self.send("/missing")[0], 404)

    def test_duplicate_content_length_rejected(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.putrequest("POST", "/analyze")
            connection.putheader("Authorization", "Bearer " + TOKEN)
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Content-Length", "2")
            connection.putheader("Content-Length", "20")
            connection.endheaders(b"{}")
            self.assertEqual(connection.getresponse().status, 400)
        finally:
            connection.close()

    def test_reporter_exchange_and_blocked_report_over_real_http(self):
        intake = {"title": "Wrong total", "description": "Checkout is wrong", "logs": "password=pretend-private"}
        code, analyzed = self.send("/analyze", {"intake": intake, "rounds": []})
        self.assertEqual(code, 200)
        self.assertEqual(analyzed["questions"][0]["id"], "test_target")
        round_ = {"id": str(uuid.uuid4()), "answers": [{"question_id": "test_target", "answer": CONTRACT["targets"][0]}]}
        code, answered = self.send("/analyze", {"intake": intake, "rounds": [round_]})
        self.assertEqual(code, 200)
        self.assertEqual(answered["questions"], [])
        self.assertEqual(answered["test_target"], CONTRACT["targets"][0])
        inv = {"id": str(uuid.uuid4()), "intake": intake, "analysis": analyzed, "incomplete_reason": "Reporter expired"}
        code, report = self.send("/report", {"investigation": inv, "runs": [], "rounds": [], "approvals": []})
        self.assertEqual(code, 200)
        self.assertEqual(report["outcome"], "blocked")
        self.assertTrue("pretend-private" not in json.dumps(report), "Report leaked synthetic private text")

    def test_runner_http_auth_cancel_tombstone_and_purge(self):
        with tempfile.TemporaryDirectory(prefix="bugout-http-") as folder:
            storage = Storage(Path(folder) / "runner")
            runtime = SimulatedRuntime()
            controller = Controller(storage, runtime, SNAPSHOT["image"], KEY, True)
            server = build_server("http://127.0.0.1:0", TOKEN, runner_application(controller), body_limit=65536)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                self.assertEqual(self.send("/snapshot", server=server)[1], SNAPSHOT)
                payload = runner_request()
                self.assertEqual(self.send("/runs", payload, token="wrong", server=server)[0], 401)
                code, cancelled = self.send(f"/runs/{payload['run_id']}/cancel", {}, server=server)
                self.assertEqual(code, 200)
                self.assertEqual(cancelled, {"run_id": payload["run_id"], "state": "finished", "evidence": None})
                self.assertEqual(self.send("/purge", {"investigation_id": payload["investigation_id"]}, server=server)[0], 200)
                self.assertEqual(self.send("/runs", payload, server=server)[0], 409)
                self.assertEqual(runtime.calls, 0)
                self.assertEqual(self.send("/artifacts/not-a-uuid", server=server)[0], 404)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)

    def test_service_factory_rejects_nonlocal_or_path_urls(self):
        for url in ("http://0.0.0.0:8080", "https://127.0.0.1:8080", "http://127.0.0.1:8080/path"):
            with self.assertRaises(ValueError):
                build_server(url, TOKEN, engine_application)
