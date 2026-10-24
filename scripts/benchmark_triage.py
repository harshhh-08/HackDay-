"""Small deterministic triage benchmark; no model or repository workload executes."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from services.common import ROOT, redact
from services.worker.engine import analyze

cases = json.loads((ROOT / "benchmarks/triage.json").read_text())
matched = 0
questions = 0
useful = 0
facts = 0
unsupported = 0
results = []
for case in cases:
    analysis = analyze({"intake": case["intake"], "rounds": []})
    correct = (bool(analysis["questions"]) == case["missing_target"] and bool(analysis["block_reason"]) == case["blocked"])
    matched += correct
    questions += len(analysis["questions"])
    useful += sum(question["field"] == "test_target_or_command" and case["missing_target"] for question in analysis["questions"])
    source = redact(case["intake"])
    for fact in analysis["facts"]:
        facts += 1
        field = fact["source"]["field"].removeprefix("intake.")
        text = source.get(field, "")
        if "line" in fact["source"]:
            lines = text.splitlines()
            index = fact["source"]["line"] - 1
            text = lines[index] if 0 <= index < len(lines) else ""
        if fact["provenance"] not in ("reported", "extracted") or fact["value"] not in text:
            unsupported += 1
    results.append({"id": case["id"], "correct": correct})
summary = {"provider": "disabled", "cases": len(cases), "correct_gap_and_block_decisions": matched,
           "questions": questions, "questions_targeting_real_blockers": useful,
           "facts": facts, "facts_without_source_support": unsupported, "results": results,
           "scope": "seven authored fixture-report variations; not a model or execution benchmark"}
print(json.dumps(summary, indent=2))
if matched != len(cases) or useful != questions or unsupported:
    raise SystemExit(1)
