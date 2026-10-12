"""Runtime delivery integrity and boundary regression tests."""
import json
from pathlib import Path
import sqlite3

import pytest

from common.biometrics.config import resolve_config
from common.biometrics.runtime import BoundarySelection, RuntimeSnapshot, read_latest_snapshot


def payload(generation=1, boundary="next_session", **changes):
    config = resolve_config([])
    value = dict(schemaVersion=1, side="left", generation=generation,
                 revisionId=None, manifestHash=config["manifestHash"],
                 resolved=config["resolved"], resolvedHash=config["hash"], boundary=boundary)
    value.update(changes)
    return json.dumps(value)


def test_snapshot_is_deeply_immutable():
    snapshot = RuntimeSnapshot.parse(payload())
    snapshot.resolved["heart_rate"]["trackingToleranceBpm"] = 25
    assert snapshot.resolved["heart_rate"]["trackingToleranceBpm"] == 15


@pytest.mark.parametrize("changes", [
    {"generation": True}, {"generation": 0}, {"generation": 1.5},
    {"schemaVersion": True}, {"revisionId": "bad"}, {"side": "both"},
    {"manifestHash": "old-engine"}, {"resolvedHash": "forged"},
    {"boundary": "whenever"}, {"extra": 1},
])
def test_invalid_projection_is_rejected(changes):
    with pytest.raises(ValueError):
        RuntimeSnapshot.parse(payload(**changes))


def test_duplicate_fields_and_oversized_payload_are_rejected():
    with pytest.raises(ValueError, match="Duplicate"):
        RuntimeSnapshot.parse(payload()[:-1] + ', "generation": 2}')
    with pytest.raises(ValueError, match="resource limit"):
        RuntimeSnapshot.parse(" " * 65537)


def test_actual_migration_projection_envelope_and_latest_generation():
    connection = sqlite3.connect(":memory:")
    connection.execute("CREATE TABLE vitals (id INTEGER)")
    migration = Path(__file__).parents[2] / "src/db/biometrics-migrations/0020_black_patch.sql"
    connection.executescript(migration.read_text())
    assert read_latest_snapshot(connection, "left") is None
    snapshot = RuntimeSnapshot.parse(payload())
    connection.execute("INSERT INTO biometric_runtime_configs VALUES (?, ?, ?, ?, ?, ?)",
                       ("left", 1, snapshot.resolved_hash, payload(), "next_session", 0))
    assert read_latest_snapshot(connection, "left") == snapshot
    connection.execute("INSERT INTO biometric_runtime_configs VALUES (?, ?, ?, ?, ?, ?)",
                       ("left", 2, snapshot.resolved_hash, payload(2), "immediate", 1))
    with pytest.raises(ValueError, match="envelope mismatch"):
        read_latest_snapshot(connection, "left")
    connection.execute("UPDATE biometric_runtime_configs SET payload = ? WHERE generation = 2", (" " * 65537,))
    with pytest.raises(ValueError, match="resource limit"):
        read_latest_snapshot(connection, "left")


def test_missing_schema_is_not_silently_created():
    connection = sqlite3.connect(":memory:")
    with pytest.raises(sqlite3.OperationalError):
        read_latest_snapshot(connection, "left")
    assert connection.execute("SELECT name FROM sqlite_master").fetchall() == []


def test_next_session_waits_through_restart_and_unknown_occupancy():
    selection = BoundarySelection("left")
    snapshot = RuntimeSnapshot.parse(payload())
    selection.offer(snapshot)
    assert selection.ready(True) is None
    assert selection.ready(None) is None
    assert selection.ready(False) == snapshot
    assert selection.applied is None  # selection alone does not acknowledge
    selection.commit(snapshot)
    assert selection.applied == snapshot
    selection.offer(snapshot)
    assert selection.pending is None


def test_newer_request_supersedes_pending_and_fences_late_commit():
    selection = BoundarySelection("left")
    first = RuntimeSnapshot.parse(payload())
    second = RuntimeSnapshot.parse(payload(2, "immediate"))
    selection.offer(first)
    selection.offer(second)
    assert selection.ready(True) == second
    with pytest.raises(ValueError, match="changed"):
        selection.commit(first)
    with pytest.raises(ValueError, match="regression"):
        selection.offer(first)
    with pytest.raises(ValueError, match="conflict"):
        selection.offer(RuntimeSnapshot.parse(payload(2)))
    selection.commit(second)
    assert selection.applied == second


def test_side_mismatch_never_changes_selection():
    selection = BoundarySelection("right")
    with pytest.raises(ValueError, match="side mismatch"):
        selection.offer(RuntimeSnapshot.parse(payload()))
    assert selection.pending is None
