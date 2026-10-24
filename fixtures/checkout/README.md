# Registered checkout fixture

This is intentionally broken example code. The percentage-discount input is
2500 cents with a 10 percent discount. Expected total: 2250 cents. The defective
function returns 2490. There is no randomness; “sometimes” in a vague report
does not imply a flaky test.

Documented targets:

- `tests/test_checkout.py::test_percentage_discount` — expected assertion failure
  containing `BUGOUT_CHECKOUT_TOTAL expected=2250 actual=2490`.
- `tests/test_checkout.py::test_no_discount` — passing control.

The approved operation is `python -m pytest -q <target>` with fixed cache/JUnit
options displayed in the plan. Run only through the restricted runner image.
Dependency: Pytest 9.0.3; base Python 3.14 image, pinned/recorded at image build.
The application never assumes an expected result was actually observed.

Fixture source is hashed before planning; the built image must carry the same
snapshot label. Rebuild and reapprove after any fixture edit. A Git commit is
recorded only when the checkout actually supplies a clean fixture revision.
