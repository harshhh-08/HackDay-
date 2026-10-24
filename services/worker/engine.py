from __future__ import annotations

import re
from services.common import CONTRACT, LIMITS, redact


class DisabledProvider:
    """Typed provider boundary. No model is loaded and no remote API is called."""
    name = "disabled"

    def suggest(self, _sanitized_record):
        return {"hypotheses": [], "provider": self.name}


def analyze(payload):
    intake = redact(payload["intake"])
    rounds = redact(payload["rounds"])
    if not isinstance(intake, dict) or not isinstance(rounds, list) or len(rounds) > LIMITS["rounds"]:
        raise ValueError("Invalid analysis payload")
    caps = {"title": 800, "description": 16384, "expected_behavior": 4096, "actual_behavior": 4096,
            "environment": 2048, "repository_revision": 64, "test_target": 2048, "logs": 32768}
    for field, cap in caps.items():
        if field in intake and (not isinstance(intake[field], str) or len(intake[field].encode("utf-8")) > cap):
            raise ValueError("Invalid intake field")
    for round_ in rounds:
        if not isinstance(round_, dict) or not isinstance(round_.get("id"), str) or len(round_["id"]) > 128:
            raise ValueError("Invalid follow-up round")
        answers = round_.get("answers")
        if answers is not None:
            if not isinstance(answers, list) or len(answers) > LIMITS["questions"]:
                raise ValueError("Invalid follow-up answers")
            for answer in answers:
                if (not isinstance(answer, dict) or answer.get("question_id") != "test_target"
                        or not isinstance(answer.get("answer"), str) or not answer["answer"].strip()
                        or len(answer["answer"].encode("utf-8")) > 2048):
                    raise ValueError("Invalid target answer")
    facts = []
    for field in ("title", "description", "expected_behavior", "actual_behavior", "environment", "repository_revision", "test_target"):
        value = intake.get(field)
        if value:
            if not isinstance(value, str):
                raise ValueError("Invalid fact value")
            facts.append({"field": field, "value": value, "provenance": "reported", "source": {"field": f"intake.{field}"}})
    for number, line in enumerate(intake.get("logs", "").splitlines(), 1):
        if len(facts) >= 90:
            break
        match = re.search(r"\b([A-Za-z_][A-Za-z0-9_]*(?:Error|Exception))\b(?::\s*(.{0,500}))?", line)
        if match:
            facts.append({"field": "logs_and_errors", "value": match.group(0), "provenance": "extracted", "source": {"field": "intake.logs", "line": number}})
        match = re.search(r"\b(?:Python|pytest)\s+\d+\.\d+(?:\.\d+)?\b", line)
        if match:
            facts.append({"field": "reported_runtime_version", "value": match.group(0), "provenance": "extracted", "source": {"field": "intake.logs", "line": number}})
    target = intake.get("test_target")
    for round_ in rounds:
        for answer in round_.get("answers") or []:
            if answer["question_id"] == "test_target":
                target = answer["answer"].strip()
                facts.append({"field": "test_target", "value": target, "provenance": "reported", "source": {"field": f"rounds.{round_['id']}.test_target"}})
    if not target:
        candidates = {}
        for field in ("description", "logs"):
            for line_number, line in enumerate(intake.get(field, "").splitlines(), 1):
                for known in CONTRACT["targets"]:
                    if re.search(r"(?<![\w./:])" + re.escape(known) + r"(?![\w:/.\[])", line):
                        candidates.setdefault(known, {"field": f"intake.{field}", "line": line_number})
        # Multiple mentioned targets are an uncertainty, not permission to guess.
        if len(candidates) == 1:
            target, source = next(iter(candidates.items()))
            facts.append({"field": "test_target", "value": target, "provenance": "extracted", "source": source})
    questions = []
    block = None
    if not target:
        questions.append({
            "id": "test_target", "field": "test_target_or_command",
            "question": "Which documented Pytest target demonstrates the wrong total? Supply the exact target from the fixture README.",
            "why": "A selected test lets us check the reported failure instead of an unrelated checkout test.",
        })
    elif target not in CONTRACT["targets"]:
        block = "The supplied target is unsupported. Only documented checkout fixture tests can execute."
    return {"facts": facts[:100], "questions": questions, "missing_fields": ["test_target_or_command"] if questions else [],
            "test_target": target, "block_reason": block, **DisabledProvider().suggest(intake)}
