from checkout import total_cents


def test_percentage_discount():
    actual = total_cents(2500, 10)
    assert actual == 2250, f"BUGOUT_CHECKOUT_TOTAL expected=2250 actual={actual}"


def test_no_discount():
    assert total_cents(2500, 0) == 2500
