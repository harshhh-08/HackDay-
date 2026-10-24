"""Intentionally defective, deterministic demo fixture. Not production checkout code."""


def total_cents(subtotal_cents: int, discount_percent: int) -> int:
    # The fixture's deliberate defect subtracts percentage points as cents.
    return subtotal_cents - discount_percent
