import json
import re
from services.common import CONTRACT, redact
from services.worker.verdict import verdict


def assemble(payload):
    inv = payload["investigation"]
    attempts = payload["runs"]
    evidence = [run["evidence"] for run in attempts if run.get("evidence")]
    for run in evidence:
        if run["investigation_id"] != inv["id"] or run["plan_hash"] != inv.get("plan_hash"):
            raise ValueError("Foreign or stale run evidence")
    result = verdict(evidence)
    limitations = [
        "This investigation supports only the registered local checkout fixture.",
        "A passing test does not prove that the reported bug is absent.",
        "A reproduced signal is not a proven root cause.",
        "No model was called; extraction and questions were deterministic.",
    ]
    repository = (inv.get("plan") or {}).get("repository")
    if not repository or repository.get("commit_sha") is None:
        limitations.append("Git commit is unknown; when available, the recorded SHA-256 identifies the fixture snapshot instead.")
    if any(artifact.get("truncated") for run in evidence for artifact in run.get("artifacts", [])):
        limitations.append("One or more output artifacts were truncated at the configured limit.")
    report = {
        "schema_version": CONTRACT["schema_version"], "investigation_id": inv["id"],
        "summary": f"Deterministic investigation outcome: {result['outcome']}.",
        "original_report": inv["intake"], "redactions": inv.get("redactions", []),
        "facts": inv.get("analysis", {}).get("facts", []),
        "follow_up_rounds": payload["rounds"], "missing_fields": inv.get("analysis", {}).get("missing_fields", []),
        "repository": repository, "plan": inv.get("plan"), "plan_hash": inv.get("plan_hash"),
        "approvals": payload["approvals"], "execution_attempts": attempts, "verdict": result,
        "observations": [{"provenance": "observed", "source": {"run_id": run["run_id"]},
                          "classification": run["classification"], "exit_code": run["exit_code"]} for run in evidence],
        "hypotheses": ([{"provenance": "hypothesis", "text": inv["plan"]["hypothesis"], "verified": False}] if inv.get("plan") else []),
        "incomplete_reason": inv.get("incomplete_reason"), "limitations": limitations,
        "cancellation": {"requested_at": inv.get("cancel_requested_at"), "cleanup": inv.get("cleanup_status")},
        "delivery_status": "not_requested",
        "next_experiment": {"kind": "recommendation", "text": "Review the recorded inputs and conditions, then propose a separately approved test for any remaining uncertainty."},
    }
    report = redact(report)
    # Choose a fence longer than any untrusted run of backticks; raw HTML remains
    # inside a fenced JSON block instead of becoming active Markdown content.
    rendered = json.dumps(report, indent=2, ensure_ascii=False)
    longest = max((len(match.group()) for match in re.finditer(r"`+", rendered)), default=0)
    fence = "`" * max(3, longest + 1)
    markdown = f"# bug.out investigation\n\n**Outcome:** {result['outcome']}\n\nRule: {CONTRACT['rule_version']}\n\n{fence}json\n{rendered}\n{fence}\n"
    return {"outcome": result["outcome"], "json": report, "markdown": markdown}
