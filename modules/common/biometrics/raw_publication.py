"""Atomic publication of server-prepared waveform datasets and RAW references.

The coordinator validates and hashes the complete snapshot with its shared
TypeScript data-hash contract. This internal publisher never accepts a dataset
row directly from an RPC request. It verifies selected archive identities,
then inserts that exact prepared snapshot and all references in one transaction.
"""
import json
import re
import uuid

from .raw_artifacts import RawArtifact, SOURCE_NAME

HASH = re.compile(r'[a-f0-9]{64}\Z')
MAX_DATASET_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


def _describe(row):
    keys = ('id', 'side', 'subjectId', 'requestHash', 'contentHash', 'manifest',
            'byteLength', 'createdAtMs', 'releasedAtMs')
    result = dict(zip(keys, row))
    result['manifest'] = json.loads(result['manifest'])
    result['available'] = result['releasedAtMs'] is None
    return result


def _existing(connection, key, request_hash):
    row = connection.execute('''SELECT id, side, subject_id, request_hash, content_hash,
        manifest, byte_length, created_at_ms, released_at_ms FROM biometric_datasets
        WHERE idempotency_key = ?''', (key,)).fetchone()
    if row is None:
        return None
    result = _describe(row)
    if result['requestHash'] != request_hash:
        raise ValueError('Dataset idempotency key changed')
    return result


def publish_waveform_dataset(store, connection, archive_directory, selections, prepared):
    """Copy under the file mutex; keep SQLite's write lock out of file I/O."""
    from .retained_replay import RetainedReplayInput, _integer, _keys
    if connection.in_transaction:
        raise ValueError('Waveform publication requires an independent transaction')
    if not connection.execute('PRAGMA foreign_keys').fetchone()[0]:
        raise ValueError('Waveform publication requires foreign keys')
    # Freeze caller-owned dictionaries before copying potentially large files.
    serialized = _json(prepared)
    if len(serialized.encode('utf-8')) > MAX_DATASET_BYTES:
        raise ValueError('Waveform dataset exceeds its byte budget')
    dataset = json.loads(serialized)
    _keys(dataset, 'id side subjectId idempotencyKey requestHash contentHash manifest snapshot createdAtMs')
    if str(uuid.UUID(dataset['id'])) != dataset['id']:
        raise ValueError('Invalid waveform dataset identity')
    if dataset['side'] not in ('left', 'right'):
        raise ValueError('Invalid waveform dataset side')
    for key in ('subjectId', 'idempotencyKey'):
        if not isinstance(dataset[key], str) or not 1 <= len(dataset[key]) <= 200:
            raise ValueError('Invalid waveform dataset key')
    for key in ('requestHash', 'contentHash'):
        if not isinstance(dataset[key], str) or not HASH.fullmatch(dataset[key]):
            raise ValueError('Invalid waveform dataset hash')
    _integer(dataset['createdAtMs'])
    snapshot, manifest = dataset['snapshot'], dataset['manifest']
    if (not isinstance(snapshot, dict) or snapshot.get('version') != 'waveform-dataset-v1'
            or snapshot.get('side') != dataset['side'] or snapshot.get('subjectId') != dataset['subjectId']
            or not isinstance(manifest, dict) or manifest.get('version') != 'waveform-dataset-manifest-v1'):
        raise ValueError('Invalid prepared waveform snapshot')
    cohorts = manifest.get('splitProtocol', {}).get('assignments', [])
    if not isinstance(cohorts, list) or not 1 <= len(cohorts) <= 60:
        raise ValueError('Invalid waveform cohort assignments')
    cohort_map = {item['cohortId']: item for item in cohorts}
    if len(cohort_map) != len(cohorts):
        raise ValueError('Duplicate waveform cohort assignment')
    inputs = snapshot.get('waveformInputs')
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= 60:
        raise ValueError('Invalid waveform dataset inputs')
    artifacts, evidence, selected_cohorts = {}, {}, set()
    for item in inputs:
        _keys(item, 'cohortId input')
        cohort_id = item['cohortId']
        if cohort_id not in cohort_map or cohort_id in selected_cohorts:
            raise ValueError('Waveform inputs must match whole-night cohorts')
        selected_cohorts.add(cohort_id)
        retained = RetainedReplayInput.parse(item['input'])
        cohort = cohort_map[cohort_id]
        if retained.score_start_ms != cohort['startMs'] or retained.score_end_ms != cohort['endMs']:
            raise ValueError('Waveform scoring window must match its whole-night cohort')
        for source in retained.artifacts:
            artifact = source.artifact
            identity = (artifact, source.first_event_ms, source.last_event_ms)
            if artifact.sha256 in evidence and evidence[artifact.sha256] != identity:
                raise ValueError('Conflicting waveform artifact descriptors')
            artifacts[artifact.sha256] = artifact
            evidence[artifact.sha256] = identity
    if len(artifacts) > store.limits.max_artifacts or sum(item.compressed_bytes for item in artifacts.values()) > store.limits.total_bytes:
        raise ValueError('Waveform dataset RAW storage budget exceeded')
    if selected_cohorts != set(cohort_map):
        raise ValueError('Retain waveform inputs for every selected cohort')
    if not isinstance(selections, list) or len(selections) != len(artifacts):
        raise ValueError('Archive selection must match frozen waveform inputs')
    names = {}
    for item in selections:
        _keys(item, 'source_name artifact')
        _keys(item['artifact'], 'name sha256 compressed_bytes expanded_bytes')
        artifact = RawArtifact(**item['artifact'])
        name = item['source_name']
        if not isinstance(name, str) or not SOURCE_NAME.fullmatch(name):
            raise ValueError('Invalid archive selection name')
        if artifact.sha256 in names or artifacts.get(artifact.sha256) != artifact:
            raise ValueError('Archive selection must match frozen waveform inputs')
        names[artifact.sha256] = name
    existing = _existing(connection, dataset['idempotencyKey'], dataset['requestHash'])
    if existing is not None:
        return existing  # Includes released tombstones; never resurrect a retry.
    manifest_json, snapshot_json = _json(manifest), _json(snapshot)
    byte_length = len(manifest_json.encode('utf-8')) + len(snapshot_json.encode('utf-8'))

    def publish(descriptors):
        connection.execute('BEGIN IMMEDIATE')
        try:
            raced = _existing(connection, dataset['idempotencyKey'], dataset['requestHash'])
            if raced is not None:
                connection.commit()
                return raced
            total = connection.execute('SELECT coalesce(sum(byte_length), 0) FROM biometric_datasets').fetchone()[0]
            if total + byte_length > MAX_TOTAL_BYTES:
                raise ValueError('Waveform datasets exceeded the retained storage budget')
            connection.execute('''INSERT INTO biometric_datasets
                (id, side, subject_id, idempotency_key, request_hash, content_hash, manifest,
                 snapshot, byte_length, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (dataset['id'], dataset['side'], dataset['subjectId'], dataset['idempotencyKey'],
                 dataset['requestHash'], dataset['contentHash'], manifest_json, snapshot_json,
                 byte_length, dataset['createdAtMs']))
            for position, descriptor in enumerate(descriptors):
                existing_artifact = connection.execute('''SELECT name, compressed_bytes, expanded_bytes
                    FROM biometric_raw_artifacts WHERE content_hash = ?''', (descriptor.sha256,)).fetchone()
                identity = (descriptor.name, descriptor.compressed_bytes, descriptor.expanded_bytes)
                if existing_artifact is not None and tuple(existing_artifact) != identity:
                    raise ValueError('Conflicting retained artifact metadata')
                connection.execute('''INSERT INTO biometric_raw_artifacts
                    (content_hash, name, compressed_bytes, expanded_bytes, created_at_ms)
                    VALUES (?, ?, ?, ?, ?) ON CONFLICT(content_hash) DO UPDATE SET released_at_ms = NULL''',
                    (descriptor.sha256, *identity, dataset['createdAtMs']))
                connection.execute('''INSERT INTO biometric_dataset_raw_artifacts
                    (id, dataset_id, artifact_hash, position) VALUES (?, ?, ?, ?)''',
                    (str(uuid.uuid4()), dataset['id'], descriptor.sha256, position))
            result = _existing(connection, dataset['idempotencyKey'], dataset['requestHash'])
            connection.commit()
            return result
        except BaseException:
            connection.rollback()
            raise

    return store.retain_batch(archive_directory,
        [(names[digest], artifact) for digest, artifact in artifacts.items()], publish=publish)
