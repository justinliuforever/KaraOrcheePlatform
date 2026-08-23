
def test_every_page_break_becomes_a_line_break_with_its_attributes():
    from pipeline.staff import sb_for_pb
    mei = '<section><pb xml:id="p1"/><measure/><pb n="2" xml:id="p2"/></section>'
    out = sb_for_pb(mei)
    assert out == '<section><sb xml:id="p1"/><measure/><sb n="2" xml:id="p2"/></section>'
    assert "<pb" not in out


def test_the_breaks_mode_is_part_of_the_layout_fingerprint(monkeypatch):
    import importlib
    import pipeline.staff as staff
    base = staff.layout_options_hash()
    monkeypatch.setenv("NOTES_STAFF_BREAKS", "encoded-sb")
    importlib.reload(staff)
    try:
        assert staff.layout_options_hash() != base, \
            "two renders from different modes must never share a render_generation"
        assert staff.COMMON["breaks"] == "encoded"
    finally:
        monkeypatch.delenv("NOTES_STAFF_BREAKS")
        importlib.reload(staff)


def test_expected_systems_counts_only_breaks_after_the_first_measure():
    from pipeline.staff import expected_encoded_systems
    assert expected_encoded_systems('<sb/><measure n="1"/><sb/><measure n="2"/>') == 2
    assert expected_encoded_systems('<measure n="1"/><sb/><measure/><sb n="x"/><measure/>') == 3
    assert expected_encoded_systems('<score>no measures</score>') == 1
