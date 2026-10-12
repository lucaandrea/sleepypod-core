"""Validated runtime projections and sample-boundary selection.

This module never changes desired bindings or fabricates applied receipts.
Callers install a selected snapshot in their estimator before acknowledging it.
Unknown occupancy is deliberately not an empty-bed boundary.
"""
from dataclasses import dataclass
import json
from uuid import UUID

from .config import canonical_json, config_hash, manifest, validate_config

_MAX_PAYLOAD_BYTES = 65536
_FIELDS = {"schemaVersion", "side", "generation", "revisionId", "manifestHash",
           "resolved", "resolvedHash", "boundary"}


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate runtime payload field")
        result[key] = value
    return result


@dataclass(frozen=True)
class RuntimeSnapshot:
    """Deep immutability: mutable configuration is decoded afresh on access."""
    side: str
    generation: int
    resolved_hash: str
    manifest_hash: str
    boundary: str
    revision_id: object
    _resolved_json: str

    @property
    def resolved(self):
        return json.loads(self._resolved_json)

    @classmethod
    def parse(cls, payload):
        if not isinstance(payload, str) or len(payload.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
            raise ValueError("Runtime payload exceeds resource limit")
        try:
            value = json.loads(payload, object_pairs_hook=_unique_object)
        except (RecursionError, json.JSONDecodeError) as error:
            raise ValueError("Invalid runtime payload JSON") from error
        if not isinstance(value, dict) or set(value) != _FIELDS:
            raise ValueError("Invalid runtime payload fields")
        if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
            raise ValueError("Unsupported runtime schema")
        if value["side"] not in ("left", "right"):
            raise ValueError("Invalid runtime side")
        generation = value["generation"]
        if type(generation) is not int or not 0 < generation <= 9007199254740991:
            raise ValueError("Invalid runtime generation")
        if value["boundary"] not in ("immediate", "next_session"):
            raise ValueError("Invalid runtime boundary")
        revision = value["revisionId"]
        if revision is not None:
            if not isinstance(revision, str):
                raise ValueError("Invalid runtime revision")
            try:
                if str(UUID(revision)) != revision.lower():
                    raise ValueError("Invalid runtime revision")
            except (ValueError, AttributeError) as error:
                raise ValueError("Invalid runtime revision") from error
        if value["manifestHash"] != config_hash(manifest()):
            raise ValueError("PROFILE_INCOMPATIBLE: unknown runtime manifest")
        resolved = validate_config(value["resolved"])
        if config_hash(resolved) != value["resolvedHash"]:
            raise ValueError("Runtime configuration hash mismatch")
        return cls(value["side"], generation, value["resolvedHash"],
                   value["manifestHash"], value["boundary"], revision,
                   canonical_json(resolved))


def read_latest_snapshot(connection, side):
    """Read one bounded projection. Missing schema is surfaced, never migrated.

    An unavailable/corrupt newest generation must not silently select an older
    generation. The daemon decides its explicit fallback and reports the error.
    """
    if side not in ("left", "right"):
        raise ValueError("Invalid runtime side")
    # Do not materialize an oversized SQLite TEXT into the daemon process.
    row = connection.execute(
        "SELECT side, generation, resolved_hash, boundary, "
        "CASE WHEN length(CAST(payload AS BLOB)) <= ? THEN payload ELSE NULL END "
        "FROM biometric_runtime_configs WHERE side = ? "
        "ORDER BY generation DESC LIMIT 1", (_MAX_PAYLOAD_BYTES, side)).fetchone()
    if row is None:
        return None
    snapshot = RuntimeSnapshot.parse(row[4])
    if (snapshot.side, snapshot.generation, snapshot.resolved_hash, snapshot.boundary) != tuple(row[:4]):
        raise ValueError("Runtime projection envelope mismatch")
    return snapshot


class BoundarySelection:
    """Two-phase selection: no application claim until the consumer commits.

    Supply a previously applied snapshot only after restoring its estimator.
    A restart with no restored snapshot and an occupied/unknown bed waits for
    the next empty boundary for next-session requests.
    """
    def __init__(self, side, applied=None):
        if side not in ("left", "right") or (applied is not None and applied.side != side):
            raise ValueError("Runtime side mismatch")
        self.side = side
        self.applied = applied
        self.pending = None

    def offer(self, snapshot):
        if snapshot.side != self.side:
            raise ValueError("Runtime side mismatch")
        current = self.pending or self.applied
        if current is not None:
            if snapshot.generation < current.generation:
                raise ValueError("Runtime generation regression")
            if snapshot.generation == current.generation:
                if snapshot != current:
                    raise ValueError("Runtime generation conflict")
                return
        self.pending = snapshot

    def ready(self, occupied):
        if self.pending is None:
            return None
        if self.pending.boundary == "immediate" or occupied is False:
            return self.pending
        return None

    def commit(self, snapshot):
        if self.pending != snapshot:
            raise ValueError("Runtime selection changed before adoption")
        self.applied, self.pending = snapshot, None
