"""The probe has to fail on the states that would ship a false retention promise:
a policy that never got the transcript rule, a replace-all that dropped the live-only
version action, a purge age that drifted, a shrunken soft-delete window, and a
Postgres backup retention that does not match the number the notice prints.

Fixtures are shaped like real `az … -o json` output: floats, nulls, wrapper key.
"""
import copy
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import retention  # noqa: E402


def az_rule(name, definition, enabled=True):
    return {"name": name, "enabled": enabled, "type": "Lifecycle", "definition": definition}


LIVE_AUDIO = az_rule("lesson-audio-cool-then-delete", {
    "actions": {
        "baseBlob": {"delete": {"daysAfterCreationGreaterThan": None,
                                "daysAfterLastAccessTimeGreaterThan": None,
                                "daysAfterLastTierChangeGreaterThan": None,
                                "daysAfterModificationGreaterThan": 90.0},
                     "enableAutoTierToHotFromCool": None, "tierToArchive": None,
                     "tierToCold": None,
                     "tierToCool": {"daysAfterCreationGreaterThan": None,
                                    "daysAfterLastAccessTimeGreaterThan": None,
                                    "daysAfterLastTierChangeGreaterThan": None,
                                    "daysAfterModificationGreaterThan": 30.0},
                     "tierToHot": None},
        "snapshot": None,
        "version": {"delete": {"daysAfterCreationGreaterThan": 7.0,
                               "daysAfterLastTierChangeGreaterThan": None},
                    "tierToArchive": None, "tierToCold": None, "tierToCool": None,
                    "tierToHot": None}},
    "filters": {"blobIndexMatch": None, "blobTypes": ["blockBlob"],
                "prefixMatch": ["lesson-audio/"]}})

LIVE_VERSIONS = az_rule("notes-assets-purge-deleted-versions", {
    "actions": {"baseBlob": None, "snapshot": None,
                "version": {"delete": {"daysAfterCreationGreaterThan": 30.0,
                                       "daysAfterLastTierChangeGreaterThan": None},
                            "tierToArchive": None, "tierToCold": None,
                            "tierToCool": None, "tierToHot": None}},
    "filters": {"blobIndexMatch": None, "blobTypes": ["blockBlob"],
                "prefixMatch": ["notes-assets/"]}})

LIVE_TRANSCRIPTS = az_rule("notes-transcripts-delete", {
    "actions": {"baseBlob": {"delete": {"daysAfterCreationGreaterThan": None,
                                        "daysAfterLastAccessTimeGreaterThan": None,
                                        "daysAfterLastTierChangeGreaterThan": None,
                                        "daysAfterModificationGreaterThan": 90.0},
                             "tierToArchive": None, "tierToCold": None,
                             "tierToCool": None, "tierToHot": None},
                "snapshot": None, "version": None},
    "filters": {"blobIndexMatch": None, "blobTypes": ["blockBlob"],
                "prefixMatch": ["notes-assets/transcripts/"]}})

LIVE_NARRATION = az_rule("notes-narration-cool", {
    "actions": {"baseBlob": {"tierToCool": {"daysAfterCreationGreaterThan": None,
                                            "daysAfterLastAccessTimeGreaterThan": None,
                                            "daysAfterLastTierChangeGreaterThan": None,
                                            "daysAfterModificationGreaterThan": 30.0},
                             "delete": None, "tierToArchive": None, "tierToCold": None,
                             "tierToHot": None},
                "snapshot": None, "version": None},
    "filters": {"blobIndexMatch": None, "blobTypes": ["blockBlob"],
                "prefixMatch": ["notes-assets/narration/"]}}, enabled=False)


LIVE_SCAN_INCOMING = az_rule("score-scans-incoming-delete", {
    "actions": {"baseBlob": {"delete": {"daysAfterCreationGreaterThan": None,
                                        "daysAfterLastAccessTimeGreaterThan": None,
                                        "daysAfterLastTierChangeGreaterThan": None,
                                        "daysAfterModificationGreaterThan": 1.0},
                             "tierToArchive": None, "tierToCold": None,
                             "tierToCool": None, "tierToHot": None},
                "snapshot": None, "version": None},
    "filters": {"blobIndexMatch": None, "blobTypes": ["blockBlob"],
                "prefixMatch": ["score-scans/incoming/"]}})

LIVE_SCAN_VERSIONS = az_rule("score-scans-purge-deleted-versions", {
    "actions": {"baseBlob": None, "snapshot": None,
                "version": {"delete": {"daysAfterCreationGreaterThan": 7.0,
                                       "daysAfterLastTierChangeGreaterThan": None},
                            "tierToArchive": None, "tierToCold": None,
                            "tierToCool": None, "tierToHot": None}},
    "filters": {"blobIndexMatch": None, "blobTypes": ["blockBlob"],
                "prefixMatch": ["score-scans/"]}})

LIVE_SCAN_COOL = az_rule("score-scans-cool", {
    "actions": {"baseBlob": {"tierToCool": {"daysAfterCreationGreaterThan": None,
                                            "daysAfterLastAccessTimeGreaterThan": None,
                                            "daysAfterLastTierChangeGreaterThan": None,
                                            "daysAfterModificationGreaterThan": 30.0},
                             "delete": None, "tierToArchive": None, "tierToCold": None,
                             "tierToHot": None},
                "snapshot": None, "version": None},
    "filters": {"blobIndexMatch": None, "blobTypes": ["blockBlob"],
                "prefixMatch": ["score-scans/"]}})

LIVE_SCAN_DELETE = az_rule("score-scans-delete", {
    "actions": {"baseBlob": {"delete": {"daysAfterCreationGreaterThan": None,
                                        "daysAfterLastAccessTimeGreaterThan": None,
                                        "daysAfterLastTierChangeGreaterThan": None,
                                        "daysAfterModificationGreaterThan": 365.0},
                             "tierToArchive": None, "tierToCold": None,
                             "tierToCool": None, "tierToHot": None},
                "snapshot": None, "version": None},
    "filters": {"blobIndexMatch": None, "blobTypes": ["blockBlob"],
                "prefixMatch": ["score-scans/"]}}, enabled=False)


def flipped(rules):
    return {"policy": {"rules": copy.deepcopy(rules)},
            "name": "DefaultManagementPolicy"}


AFTER_FLIP = [LIVE_AUDIO, LIVE_VERSIONS, LIVE_TRANSCRIPTS, LIVE_NARRATION,
              LIVE_SCAN_INCOMING, LIVE_SCAN_VERSIONS, LIVE_SCAN_COOL, LIVE_SCAN_DELETE]
BEFORE_FLIP = [LIVE_AUDIO, LIVE_VERSIONS]

BLOB_PROPS = {"deleteRetentionPolicy": {"allowPermanentDelete": False, "days": 7,
                                        "enabled": True},
              "containerDeleteRetentionPolicy": {"days": 30, "enabled": True},
              "isVersioningEnabled": True}

PG_SERVER = {"backup": {"backupRetentionDays": 35, "geoRedundantBackup": "Disabled"}}

WORKSPACE = {"retentionInDays": 30, "sku": {"name": "PerGB2018"}}
TABLES = [{"name": "ContainerAppConsoleLogs_CL", "retentionInDays": 30},
          {"name": "ContainerAppSystemLogs_CL", "retentionInDays": 30},
          {"name": "ContainerAppHTTPLogs", "retentionInDays": 30},
          {"name": "AppTraces", "retentionInDays": 90},
          {"name": "AzureActivity", "retentionInDays": 90}]


def failures(checks):
    return [c.name for c in checks if not c.ok]


def test_the_flipped_policy_satisfies_every_assertion():
    assert failures(retention.check_management_policy(flipped(AFTER_FLIP))) == []
    assert failures(retention.check_blob_service(BLOB_PROPS)) == []
    assert failures(retention.check_pg_backup(PG_SERVER)) == []
    assert failures(retention.check_log_retention(WORKSPACE, TABLES)) == []


def test_today_s_live_policy_fails_because_transcripts_never_expire():
    names = failures(retention.check_management_policy(flipped(BEFORE_FLIP)))
    assert "policy rule notes-transcripts-delete" in names
    assert "notes-transcripts-delete deletes transcripts" in names


def test_a_replace_all_that_drops_the_live_only_version_action_is_caught():
    dropped = copy.deepcopy(AFTER_FLIP)
    del dropped[0]["definition"]["actions"]["version"]
    names = failures(retention.check_management_policy(flipped(dropped)))
    assert "lesson-audio-cool-then-delete keeps its version action" in names
    assert "policy rule lesson-audio-cool-then-delete" in names


def test_a_transcript_rule_present_but_disabled_does_not_pass():
    off = copy.deepcopy(AFTER_FLIP)
    off[2]["enabled"] = False
    assert "notes-transcripts-delete deletes transcripts" in failures(
        retention.check_management_policy(flipped(off)))


def test_a_transcript_rule_rescoped_off_the_prefix_does_not_pass():
    wrong = copy.deepcopy(AFTER_FLIP)
    wrong[2]["definition"]["filters"]["prefixMatch"] = ["notes-assets/"]
    assert "notes-transcripts-delete deletes transcripts" in failures(
        retention.check_management_policy(flipped(wrong)))


def test_a_drifted_purge_age_is_caught():
    drifted = copy.deepcopy(AFTER_FLIP)
    drifted[1]["definition"]["actions"]["version"]["delete"]["daysAfterCreationGreaterThan"] = 7.0
    assert "notes-assets-purge-deleted-versions purge age" in failures(
        retention.check_management_policy(flipped(drifted)))


def test_a_rule_nobody_declared_is_reported_not_ignored():
    extra = AFTER_FLIP + [az_rule("someone-s-experiment", LIVE_TRANSCRIPTS["definition"])]
    assert "no live rule outside retention_policy.json" in failures(
        retention.check_management_policy(flipped(extra)))


def test_a_shrunken_soft_delete_window_is_caught():
    shrunk = {**BLOB_PROPS, "deleteRetentionPolicy": {"days": 3, "enabled": True}}
    assert "blob soft-delete retention" in failures(retention.check_blob_service(shrunk))
    off = {**BLOB_PROPS, "deleteRetentionPolicy": {"days": 7, "enabled": False}}
    assert "blob soft-delete retention" in failures(retention.check_blob_service(off))


def test_the_recovery_window_is_the_slowest_purge_plus_soft_delete():
    assert retention.operator_recovery_days(flipped(AFTER_FLIP)) == 37
    assert retention.operator_recovery_days(
        flipped([LIVE_AUDIO, LIVE_SCAN_VERSIONS])) == 14


def test_a_disabled_purge_rule_cannot_stretch_the_recovery_window():
    slow = copy.deepcopy(LIVE_VERSIONS)
    slow["enabled"] = False
    assert retention.operator_recovery_days(flipped([LIVE_AUDIO, slow])) == 14


def test_a_purge_age_raised_stretches_the_number_the_notice_must_print():
    slower = copy.deepcopy(LIVE_VERSIONS)
    slower["definition"]["actions"]["version"]["delete"]["daysAfterCreationGreaterThan"] = 90.0
    assert retention.operator_recovery_days(flipped([LIVE_AUDIO, slower])) == 97


def test_a_postgres_shrunk_below_the_printed_number_is_caught():
    checks = retention.check_pg_backup({"backup": {"backupRetentionDays": 7}})
    assert failures(checks) == ["postgres backup retention"]
    assert checks[0].actual == "7 days" and checks[0].expected == "35 days"


def test_a_workspace_kept_past_the_printed_30_days_is_caught():
    checks = retention.check_log_retention({"retentionInDays": 90}, TABLES)
    assert failures(checks) == ["service log retention (workspace default)"]
    assert checks[0].actual == "90 days"


def test_a_service_log_table_overridden_past_30_days_is_named():
    stretched = TABLES + [{"name": "ContainerAppConsoleLogs", "retentionInDays": 90}]
    checks = retention.check_log_retention(WORKSPACE, stretched)
    assert failures(checks) == ["no service log table kept longer"]
    assert checks[1].actual == "ContainerAppConsoleLogs"


def test_the_checked_in_policy_is_the_one_the_document_describes():
    assert failures(retention.check_management_policy(retention.load_intended_policy())) == []
    rules = retention.rules_by_name(retention.load_intended_policy())
    assert rules["notes-narration-cool"]["enabled"] is False
    assert rules["score-scans-delete"]["enabled"] is False
    assert set(rules) == {"lesson-audio-cool-then-delete",
                          "notes-assets-purge-deleted-versions",
                          "notes-transcripts-delete", "notes-narration-cool",
                          "score-scans-incoming-delete", "score-scans-purge-deleted-versions",
                          "score-scans-cool", "score-scans-delete"}


def test_az_renderings_compare_equal_to_the_hand_written_file():
    assert retention.normalize({"a": 90.0, "b": None, "c": {"d": None, "e": 7.0}}) == {
        "a": 90, "c": {"e": 7}}
    assert json.dumps(retention.normalize(LIVE_AUDIO), sort_keys=True) == json.dumps(
        retention.rules_by_name(retention.load_intended_policy())["lesson-audio-cool-then-delete"],
        sort_keys=True)


def test_the_signature_count_is_what_the_rule_would_delete_on_its_first_pass():
    now = dt.datetime(2026, 8, 7, tzinfo=dt.timezone.utc)
    blobs = [{"name": "transcripts/new.json", "mod": "2026-08-01T18:47:47+00:00"},
             {"name": "transcripts/old.json", "mod": "2026-01-01T00:00:00+00:00"},
             {"name": "transcripts/model-output/old.json", "mod": "2026-02-01T00:00:00+00:00"},
             {"name": "transcripts/edge.json", "mod": "2026-05-09T00:00:00+00:00"}]
    report = retention.transcript_age_report(blobs, now)
    assert report["total"] == 4
    assert report["over_retention"] == 2
    assert report["names"] == ["transcripts/model-output/old.json", "transcripts/old.json"]
    assert report["oldest_days"] == 218
    assert retention.transcript_age_report(
        [{"name": "t", "mod": "2026-05-09T00:00:00+00:00"}], now)["over_retention"] == 0


def test_az_property_shape_is_accepted_as_well_as_the_projected_one():
    now = dt.datetime(2026, 8, 7, tzinfo=dt.timezone.utc)
    blobs = [{"name": "transcripts/a.json",
              "properties": {"lastModified": "2026-01-01T00:00:00+00:00"}}]
    assert retention.transcript_age_report(blobs, now)["over_retention"] == 1
