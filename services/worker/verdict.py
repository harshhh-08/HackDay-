"""Versioned rules over recorded evidence. Hypotheses are never inputs."""
from services.common import CONTRACT


def verdict(runs):
    pass_ids, fail_ids, uncertain_ids, blocked_ids = [], [], [], []
    seen = set()
    for run in runs:
        run_id = run["run_id"]
        if run_id in seen:
            raise ValueError("Duplicate run evidence")
        seen.add(run_id)
        classification = run["classification"]
        if classification not in CONTRACT["classifications"]:
            raise ValueError("Unknown run classification")
        if run.get("cleanup") != "completed":
            uncertain_ids.append(run_id)
        elif classification == "test_failure" and run.get("exit_code") == 1 and run.get("selected_test_ran") is True and run.get("matched_signal") is True:
            fail_ids.append(run_id)
        elif classification == "test_pass" and run.get("exit_code") == 0 and run.get("selected_test_ran") is True and run.get("matched_signal") is False:
            pass_ids.append(run_id)
        elif classification in ("test_pass", "test_failure", "inconclusive"):
            uncertain_ids.append(run_id)
        else:
            blocked_ids.append(run_id)
    if pass_ids and fail_ids:
        outcome = "intermittent"
    elif fail_ids:
        outcome = "reproduced"
    elif uncertain_ids or (pass_ids and blocked_ids):
        outcome = "inconclusive"
    elif pass_ids:
        outcome = "not_reproduced"
    else:
        outcome = "blocked"
    return {"outcome": outcome, "rule_version": CONTRACT["rule_version"], "input_run_ids": sorted(seen),
            "counts": {"pass": len(pass_ids), "matching_fail": len(fail_ids), "ambiguous": len(uncertain_ids), "blocked": len(blocked_ids)},
            "supporting_run_ids": {"pass": pass_ids, "matching_fail": fail_ids, "ambiguous": uncertain_ids, "blocked": blocked_ids}}
