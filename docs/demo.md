# Demo contract — checkout discount total

Status: **fixture source is authored but has not been executed**. No fixture
existed during the initial audit. The no-install generation pass created it at
`fixtures/checkout/`; actual container execution remains an integration gate.

## Scripted user journey

1. Submit title `Checkout total is wrong` and description
   `Checkout sometimes gives the wrong total.` Select the registered local
   checkout fixture. The submitted text supplies neither a target nor exact input.
2. Record both strings as `reported`. Resolve actual repository identity/SHA
   through the fixture registry as system evidence. Do not guess a SHA, command,
   version, frequency or root cause.
3. Ask one question targeting `test_target_or_command` and the concrete example:
   **“Which existing test or exact input shows the wrong total, and what total
   did you expect? This lets us check the reported failure rather than an
   unrelated checkout test.”** Do not ask for known fixture metadata again.
4. Reporter supplies the fixture's documented target and example below. Persist
   this reply on the same investigation and preserve its provenance.
5. Show the resolved revision, exact argv, expected signal, image/environment,
   budget and plan hash. Require explicit maintainer approval before execution.
6. Execute through the restricted runner, persist a run and bounded artifacts,
   derive the verdict from parsed evidence, then save JSON and Markdown reports.

## Fixture to author in M0-FIXTURE

Use integer cents and one intentionally incorrect percentage-discount calculation:
subtotal **2500** cents, discount **10** percent, expected **2250**, faulty result
**2490**. An input-dependent arithmetic defect is deterministic; the word
“sometimes” in the original report does not establish flakiness.

Proposed fixture-owned target:

```text
tests/test_checkout.py::test_percentage_discount
```

Proposed documented argv, inside the fixture snapshot and pinned runner image:

```json
["python", "-m", "pytest", "-q", "tests/test_checkout.py::test_percentage_discount"]
```

These are authored fixture commands, documented in its README. The actual plan
also displays fixed cache/JUnit options. The runner path must be validated before
a live demonstration claims that the expected result occurred.

The selected test must fail an assertion with a stable marker such as
`BUGOUT_CHECKOUT_TOTAL expected=2250 actual=2490`. The adapter must verify the
selected test actually ran, failed with the expected assertion/signal and had a
test-failure exit classification. A marker printed by setup/collection, an
unrelated failure, or an incomplete/truncated result is insufficient by itself.

Create a passing control in the same fixture to validate `not_reproduced`;
scripted pass/fail evidence for rule unit tests must be labeled synthetic, never
shown as a live intermittent execution. Additional timeout/setup/resource cases
are runner acceptance fixtures, not separate showcase stories.

## Report and success conditions

The report includes sanitized original text, facts/source references, the exact
question/reply, repository SHA/snapshot and environment, approved plan/hash,
run command/timestamps/duration/exit/classification/output references, versioned
verdict and run IDs, hypotheses, missing details and recommended next experiment.

- Same investigation ID across submit, reply, approval and retrieval.
- No workload before approval; altered hash rejected.
- A real, matching failed assertion gives `reproduced`, with exact run counts.
- Any missing/unsupported precondition ends with an honest blocked/incomplete
  report; unrelated setup failures never produce `reproduced`.
- JSON and Markdown saved before readiness is published; model-off throughout.
- Both run evidence and approval visible through CLI. No mock run is called live.
- A clean Git checkout records its actual commit. An archive records an observed
  snapshot SHA-256 and an explicitly unknown commit (ADR-0006). Neither mode
  permits a fabricated revision.
- Full demo must be rehearsed twice from documented setup before release.
