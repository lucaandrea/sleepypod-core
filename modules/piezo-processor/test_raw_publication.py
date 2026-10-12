"""Real migration/SQLite tests for complete-batch waveform publication."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import gzip
import json
from pathlib import Path
import sqlite3
import sys
from threading import Event
import uuid

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common.biometrics.raw_artifacts import RawArtifactStore
from common.biometrics.raw_publication import publish_waveform_dataset
from test_retained_replay import fixture


def prepare(tmp_path):
    source, inputs, _ = fixture(tmp_path)
    archive = tmp_path / 'archive'
    selections = []
    for index, item in enumerate(inputs['artifacts']):
        name = f'{index}.RAW.gz'
        (archive / name).write_bytes((source.directory / item['artifact']['name']).read_bytes())
        selections.append({'source_name': name, 'artifact': item['artifact']})
    store = RawArtifactStore(tmp_path / 'published', source.limits)
    database = tmp_path / 'biometrics.db'
    db = sqlite3.connect(database)
    db.execute('PRAGMA foreign_keys = ON')
    migrations = Path(__file__).resolve().parents[2] / 'src/db/biometrics-migrations'
    for migration in sorted(migrations.glob('*.sql')):
        db.executescript(migration.read_text())
    prepared = {'id': str(uuid.uuid4()), 'side': 'left', 'subjectId': 'fixture', 'idempotencyKey': 'waveform-one',
        'requestHash': 'a' * 64, 'contentHash': 'b' * 64, 'createdAtMs': 1000,
        'manifest': {'version': 'waveform-dataset-manifest-v1', 'splitProtocol': {'assignments': [
            {'cohortId': 'night', 'startMs': inputs['score_start_ms'], 'endMs': inputs['score_end_ms']}]}},
        'snapshot': {'version': 'waveform-dataset-v1', 'side': 'left', 'subjectId': 'fixture',
            'sessions': [], 'references': [], 'processingRuns': [], 'waveformInputs': [{'cohortId': 'night', 'input': inputs}]}}
    return store, db, database, archive, selections, prepared


def counts(db):
    return [db.execute(f'SELECT count(*) FROM {name}').fetchone()[0] for name in
            ('biometric_datasets', 'biometric_raw_artifacts', 'biometric_dataset_raw_artifacts', 'vitals')]


def test_publishes_exact_snapshot_with_all_ordered_references_and_idempotent_retry(tmp_path):
    store, db, _, archive, selections, prepared = prepare(tmp_path)
    try:
        result = publish_waveform_dataset(store, db, archive, selections, prepared)
        assert result['id'] == prepared['id'] and result['available']
        assert counts(db) == [1, 2, 2, 0]
        snapshot = db.execute('SELECT snapshot FROM biometric_datasets').fetchone()[0]
        assert json.loads(snapshot) == prepared['snapshot']
        assert [row[0] for row in db.execute('SELECT artifact_hash FROM biometric_dataset_raw_artifacts ORDER BY position')] == [item['artifact']['sha256'] for item in selections]
        for name in archive.iterdir():
            name.unlink()
        retry = {**prepared, 'id': str(uuid.uuid4()), 'createdAtMs': 2000}
        assert publish_waveform_dataset(store, db, archive, selections, retry) == result
        with pytest.raises(ValueError, match='idempotency key changed'):
            publish_waveform_dataset(store, db, archive, selections, {**retry, 'requestHash': 'c' * 64})
        assert counts(db) == [1, 2, 2, 0]
    finally:
        db.close()


def test_failure_on_last_reference_rolls_back_every_database_write(tmp_path):
    store, db, _, archive, selections, prepared = prepare(tmp_path)
    try:
        db.executescript("CREATE TRIGGER fail_last BEFORE INSERT ON biometric_dataset_raw_artifacts WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;")
        with pytest.raises(sqlite3.IntegrityError, match='injected failure'):
            publish_waveform_dataset(store, db, archive, selections, prepared)
        assert counts(db) == [0, 0, 0, 0]
        assert len(list(store.directory.glob('*.RAW.gz'))) == 2
        assert not db.in_transaction
        db.execute('DROP TRIGGER fail_last')
        assert publish_waveform_dataset(store, db, archive, selections, prepared)['available']
        assert counts(db) == [1, 2, 2, 0]
    finally:
        db.close()


def test_changed_second_archive_never_publishes_a_partial_dataset(tmp_path):
    store, db, _, archive, selections, prepared = prepare(tmp_path)
    try:
        (archive / selections[1]['source_name']).write_bytes(gzip.compress(b'changed archive'))
        with pytest.raises(ValueError, match='changed since inspection'):
            publish_waveform_dataset(store, db, archive, selections, prepared)
        assert counts(db) == [0, 0, 0, 0]
        assert len(list(store.directory.glob('*.RAW.gz'))) == 1
        assert not list(store.directory.glob('.part-*'))
    finally:
        db.close()


def test_released_retry_stays_released_and_a_new_dataset_can_retain_shared_bytes(tmp_path):
    store, db, _, archive, selections, prepared = prepare(tmp_path)
    try:
        first = publish_waveform_dataset(store, db, archive, selections, prepared)
        with db:
            db.execute('UPDATE biometric_datasets SET released_at_ms = 2000, snapshot = ?', ('{"released":true}',))
            db.execute('UPDATE biometric_dataset_raw_artifacts SET released_at_ms = 2000')
            db.execute('UPDATE biometric_raw_artifacts SET released_at_ms = 2000')
        assert not publish_waveform_dataset(store, db, archive, selections, prepared)['available']
        assert db.execute('SELECT count(*) FROM biometric_raw_artifacts WHERE released_at_ms IS NULL').fetchone()[0] == 0
        for file in archive.iterdir():
            file.unlink()
        archive.rmdir()
        second = publish_waveform_dataset(store, db, archive, selections, {**prepared,
            'id': str(uuid.uuid4()), 'idempotencyKey': 'waveform-two', 'createdAtMs': 3000})
        assert second['id'] != first['id'] and second['available']
        assert counts(db) == [2, 2, 4, 0]
        assert db.execute('SELECT count(*) FROM biometric_raw_artifacts WHERE released_at_ms IS NULL AND created_at_ms = 1000').fetchone()[0] == 2
        assert db.execute('SELECT count(*) FROM biometric_dataset_raw_artifacts WHERE released_at_ms = 2000').fetchone()[0] == 2
    finally:
        db.close()


def test_rejects_mismatched_cohorts_and_sources_without_copies(tmp_path):
    store, db, _, archive, selections, prepared = prepare(tmp_path)
    try:
        bad = deepcopy(prepared)
        bad['snapshot']['waveformInputs'][0]['input']['score_start_ms'] += 1
        with pytest.raises(ValueError, match='whole-night cohort'):
            publish_waveform_dataset(store, db, archive, selections, bad)
        with pytest.raises(ValueError, match='match frozen'):
            publish_waveform_dataset(store, db, archive, selections[:1], prepared)
        db.execute('BEGIN')
        with pytest.raises(ValueError, match='independent transaction'):
            publish_waveform_dataset(store, db, archive, selections, prepared)
        db.rollback()
        assert counts(db) == [0, 0, 0, 0]
        assert not list(store.directory.glob('*.RAW.gz'))
    finally:
        db.close()


def test_copying_does_not_hold_sqlite_write_lock_or_expose_partial_rows(tmp_path, monkeypatch):
    store, db, database, archive, selections, prepared = prepare(tmp_path)
    reached, proceed = Event(), Event()
    original = store._retain_locked

    def delayed(root, name, expected):
        if name == selections[1]['source_name']:
            reached.set()
            assert proceed.wait(5)
        return original(root, name, expected)

    monkeypatch.setattr(store, '_retain_locked', delayed)

    def publish():
        connection = sqlite3.connect(database)
        try:
            connection.execute('PRAGMA foreign_keys = ON')
            return publish_waveform_dataset(store, connection, archive, selections, prepared)
        finally:
            connection.close()

    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(publish)
            try:
                assert reached.wait(5)
                assert counts(db) == [0, 0, 0, 0]
                db.execute('BEGIN IMMEDIATE')
                db.rollback()
            finally:
                proceed.set()
            assert future.result(timeout=5)['available']
        assert counts(db) == [1, 2, 2, 0]
    finally:
        db.close()


def test_real_publication_entrypoint_commits_and_recovers_a_lost_reply_by_retry(tmp_path):
    import subprocess
    store, db, database, archive, selections, prepared = prepare(tmp_path)
    payload = json.dumps({'version': 'waveform-publication-work-v1', 'prepared': prepared, 'selections': selections}).encode()
    command = [sys.executable, '-B', '-m', 'common.biometrics.publication_worker', '--database', str(database),
               '--archive-directory', str(archive), '--retained-directory', str(store.directory)]
    env = {'PYTHONPATH': str(Path(__file__).resolve().parent.parent), 'LANG': 'C.UTF-8', 'TZ': 'UTC'}
    try:
        first = subprocess.run(command, input=payload, capture_output=True, env=env, cwd=tmp_path, timeout=20)
        assert first.returncode == 0, first.stderr
        assert first.stderr == b''
        assert json.loads(first.stdout) == {'type': 'result', 'id': prepared['id'], 'contentHash': prepared['contentHash'], 'available': True}
        assert counts(db) == [1, 2, 2, 0]
        for file in archive.iterdir():
            file.unlink()
        retry = subprocess.run(command, input=payload, capture_output=True, env=env, cwd=tmp_path, timeout=20)
        assert retry.returncode == 0 and retry.stdout == first.stdout
        assert counts(db) == [1, 2, 2, 0]
    finally:
        db.close()


def test_sigkill_inside_reference_transaction_recovers_without_partial_publication(tmp_path):
    import select
    import subprocess
    store, db, database, archive, selections, prepared = prepare(tmp_path)
    request = tmp_path / 'request.json'
    request.write_text(json.dumps({'prepared': prepared, 'selections': selections}))
    db.executescript('CREATE TRIGGER pause_publication BEFORE INSERT ON biometric_dataset_raw_artifacts BEGIN SELECT pause_ref(); END;')
    script = '''
import json, sqlite3, sys, time
from common.biometrics.raw_artifacts import RawArtifactStore
from common.biometrics.raw_publication import publish_waveform_dataset
work=json.load(open(sys.argv[1]))
db=sqlite3.connect(sys.argv[2]); db.execute('PRAGMA foreign_keys = ON')
def pause():
    print('transaction-open', flush=True)
    time.sleep(60)
    return 0
db.create_function('pause_ref', 0, pause)
publish_waveform_dataset(RawArtifactStore(sys.argv[4]), db, sys.argv[3], work['selections'], work['prepared'])
'''
    child = subprocess.Popen([sys.executable, '-B', '-c', script, str(request), str(database), str(archive), str(store.directory)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={'PYTHONPATH': str(Path(__file__).resolve().parent.parent), 'OPENBLAS_NUM_THREADS': '1'})
    try:
        assert select.select([child.stdout], [], [], 10)[0]
        assert child.stdout.readline() == b'transaction-open\n'
        assert counts(db) == [0, 0, 0, 0]
        child.kill()
        child.communicate(timeout=5)
        assert child.returncode < 0
        assert counts(db) == [0, 0, 0, 0]
        assert len(list(store.directory.glob('*.RAW.gz'))) == 2
        db.execute('DROP TRIGGER pause_publication')
        assert publish_waveform_dataset(store, db, archive, selections, prepared)['available']
        assert counts(db) == [1, 2, 2, 0]
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=5)
        db.close()
