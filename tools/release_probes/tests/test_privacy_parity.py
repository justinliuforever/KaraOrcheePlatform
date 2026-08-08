"""[C6]: the check has to fail on the states that would ship two privacy texts that
disagree — a reworded row, a changed number in either direction, and a row whose
phrase vanished so the number check silently stopped guarding anything."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import privacy_parity  # noqa: E402
import retention  # noqa: E402

SWIFT = '''
enum PrivacyDataCopy {
    static let signInDisclosure = "This also removes this email\\u{2019}s sign-in."
    static let retentionTitle = "What we keep, and for how long"
    static let noticeTitle = "How KaraOrchee handles your data"
    static let noticeIntro = "It matches what the software actually does."
    static let retentionRows: [Entry] = [
        Entry(lead: "Account details", rest: " (email): until you delete your account."),
        Entry(lead: "Lesson recordings", rest: " (cloud): deleted 90 days after processing."),
    ]
    static let deletionSection = Entry(
        lead: "Deletion.",
        rest: " Everything goes. \\(signInDisclosure)")
    static let noticeSections: [Entry] = [
        Entry(lead: "What we collect.", rest: " The lesson."),
        deletionSection,
    ]
}
'''


def test_a_document_that_matches_the_compiled_copy_diffs_clean():
    assert privacy_parity.diff(privacy_parity.render_retention(SWIFT),
                               privacy_parity.render_retention(SWIFT), "x") == []


def test_the_disclosure_is_interpolated_into_the_rendered_deletion_paragraph():
    notice = privacy_parity.render_notice(SWIFT)
    assert "This also removes this email’s sign-in." in notice
    assert "\\(signInDisclosure)" not in notice
    assert notice.index("What we collect.") < notice.index("Deletion.")


def test_one_reworded_word_is_a_diff_not_a_pass():
    rendered = privacy_parity.render_retention(SWIFT)
    edited = rendered.replace("Account details", "Account detail")
    lines = privacy_parity.diff(edited, rendered, "retention_policy.md")
    assert lines and any("Account detail" in line for line in lines)


def test_every_number_the_document_prints_is_checked_against_the_probes_constant():
    document = (
        "- **Recovery copies**: deleted files are recoverable by our operators for up to "
        f"{retention.BLOB_SOFT_DELETE_DAYS} days; database backups are kept "
        f"{retention.PG_BACKUP_RETENTION_DAYS} days; overwritten note files up to "
        f"{retention.DELETED_VERSION_RETENTION_DAYS} days.\n"
        f"- **Lesson recordings**: deleted {retention.TRANSCRIPT_RETENTION_DAYS} days after processing.\n"
        f"- **Lesson transcripts**: deleted on the same {retention.TRANSCRIPT_RETENTION_DAYS}-day clock.\n"
    )
    assert privacy_parity.number_mismatches(document) == []

    drifted = document.replace(
        f"database backups are kept {retention.PG_BACKUP_RETENTION_DAYS} days",
        "database backups are kept 35 days")
    mismatches = privacy_parity.number_mismatches(drifted)
    assert len(mismatches) == 1
    assert "35" in mismatches[0] and str(retention.PG_BACKUP_RETENTION_DAYS) in mismatches[0]


def test_a_row_that_disappears_fails_instead_of_falling_silent():
    document = "- **Recovery copies**: nothing in particular.\n"
    mismatches = privacy_parity.number_mismatches(document)
    assert len(mismatches) == len(privacy_parity.NUMBER_CLAIMS)
    assert all("guards nothing" in m for m in mismatches)
