"""Offline importer acceptance tests; all data is synthetic and temporary."""
import copy
from contextlib import closing
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import free_sleep as migration

NOW = 1792958400000


def encoded(value):
    return json.dumps(value, allow_nan=False).encode()


def fixture_documents():
    taps = {
        'doubleTap': {'type': 'temperature', 'change': 'increment', 'amount': 1},
        'tripleTap': {'type': 'temperature', 'change': 'decrement', 'amount': 2},
        'quadTap': {'type': 'alarm', 'behavior': 'snooze', 'snoozeDuration': 300, 'inactiveAlarmBehavior': 'none'},
    }
    preference = {'name': 'Sleeper', 'awayMode': False, 'taps': taps, 'scheduleOverrides': {}}
    settings = {'id': 'synthetic', 'timeZone': 'America/Los_Angeles', 'temperatureFormat': 'celsius',
                'primePodDaily': {'enabled': False, 'time': '00:15'}, 'rebootDaily': True,
                'left': copy.deepcopy(preference), 'right': copy.deepcopy(preference)}
    routine = {'power': {'enabled': False, 'on': '22:00', 'off': '07:00', 'onTemperature': 75},
               'temperatures': {}, 'alarm': {'enabled': False, 'time': '06:30', 'vibrationIntensity': 50,
                                            'duration': 0, 'vibrationPattern': 'rise', 'alarmTemperature': 80}}
    schedules = {side: {day: copy.deepcopy(routine) for day in migration.DAYS} for side in migration.SIDES}
    night = schedules['left']['saturday']
    night['power']['enabled'] = True
    night['temperatures'] = {'23:00': 74, '01:00': 73, '12:00': 80, '22:00': 90, '07:00': 90}
    night['alarm']['enabled'] = True
    state = {'config': {'mode': 'active', 'minimumF': 70, 'maximumF': 95, 'sensorAware': True, 'followBedtime': True},
             'offsetF': -1, 'feedbackThrough': '2026-10-24', 'learnedSession': 'legacy-session',
             'pausedUntil': NOW + 21600000, 'lastAppliedAt': NOW - 3600000, 'lastTargetF': 74,
             'lastSegment': 'legacy-segment', 'timingSession': 'legacy-session', 'phaseShiftMinutes': 15,
             'history': [{'at': NOW - 3600000, 'message': 'Synthetic comfort action', 'targetF': 74}]}
    journal = [{'date': '2026-10-24', 'side': 'left', 'restfulness': 4, 'comfort': 'warm',
                'caffeine': False, 'alcohol': False, 'exercise': True, 'notes': 'Synthetic private note'}]
    return settings, schedules, {side: copy.deepcopy(state) for side in migration.SIDES}, journal


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.backup = self.root / 'backup'
        self.backup.mkdir()
        self.output = self.root / 'candidate'
        self.settings, self.schedules, self.comfort, self.journal = fixture_documents()
        legacy = self.root / 'legacy.db'
        with closing(sqlite3.connect(legacy)) as database:
            database.executescript('''
                CREATE TABLE vitals (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER, heart_rate REAL, hrv REAL, breathing_rate REAL);
                CREATE TABLE movement (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER, total_movement INTEGER);
                CREATE TABLE sleep_records (id INTEGER PRIMARY KEY, side TEXT, entered_bed_at INTEGER, left_bed_at INTEGER,
                  sleep_period_seconds INTEGER, times_exited_bed INTEGER, present_intervals TEXT, not_present_intervals TEXT);
                INSERT INTO vitals VALUES (1, 'left', 1792890000, 55, 35, 14);
                INSERT INTO movement VALUES (1, 'left', 1792890000, 3);
                INSERT INTO sleep_records VALUES (1, 'left', 1792861200, 1792890000, 28000, 1, '[]', '[]');
            ''')
        self.database_bytes = legacy.read_bytes()
        self.extra = []

    def build_backup(self):
        members = {
            'data/lowdb/settingsDB.json': encoded(self.settings),
            'data/lowdb/schedulesDB.json': encoded(self.schedules),
            'data/analytics/comfort.json': encoded(self.comfort),
            'data/analytics/journal.json': encoded(self.journal),
            'data/free-sleep.db': self.database_bytes,
            'private/features.env': b'SYNTHETIC_KEY=fixture-only-not-real',
        }
        for side in migration.SIDES:
            members[f'data/{side}_cap_baseline.json'] = encoded({f'{side}_{channel}': {'mean': 1000, 'std': 10} for channel in ('out', 'cen', 'in')})
        manifest = {'format': 'free-sleep-migration/1', 'files': {}, 'archives': {}}
        for category in ('data', 'private'):
            archive_path = self.backup / (category + '.tar.gz')
            with tarfile.open(archive_path, 'w:gz') as archive:
                for name, value in members.items():
                    if not name.startswith(category + '/'):
                        continue
                    member = tarfile.TarInfo(name)
                    member.size = len(value)
                    archive.addfile(member, io.BytesIO(value))
                    manifest['files'][name] = hashlib.sha256(value).hexdigest()
                for member, value in self.extra:
                    if member.name.startswith(category + '/'):
                        archive.addfile(member, io.BytesIO(value))
                        manifest['files'][member.name] = hashlib.sha256(value).hexdigest()
            manifest['archives'][archive_path.name] = migration.checksum(archive_path)
        migration.write_private(self.backup / 'manifest.json', manifest)
        return manifest

    def stage(self):
        self.build_backup()
        return migration.stage_backup(self.backup, self.output, NOW)

    def assert_clean_failure(self):
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob('.free-sleep-import-*')))

    def test_event_times_learning_and_history_round_trip(self):
        report = self.stage()
        self.assertFalse(report['readyForCutover'])
        self.assertFalse(report['controllersChanged'])
        with closing(sqlite3.connect(self.output / 'sleepypod.db')) as database:
            self.assertEqual(database.execute("SELECT day_of_week,on_time,off_time,off_day_offset FROM power_schedules WHERE enabled=1").fetchall(), [('saturday', '22:00', '07:00', 1)])
            self.assertEqual(database.execute('SELECT day_of_week,time,temperature FROM temperature_schedules WHERE enabled=1 ORDER BY time').fetchall(), [('sunday', '01:00', 73), ('saturday', '23:00', 74)])
            self.assertEqual(database.execute('SELECT day_of_week,time,duration,wake_window FROM alarm_schedules WHERE enabled=1').fetchall(), [('sunday', '06:30', 10, 0)])
            self.assertEqual(database.execute('SELECT timezone,temperature_unit,reboot_daily,reboot_time,autopilot_enabled,homekit_enabled,mqtt_enabled FROM device_settings').fetchone(), ('America/Los_Angeles', 'C', 0, '23:15', 0, 0, 0))
            state = json.loads(database.execute("SELECT state FROM comfort_states WHERE side='left'").fetchone()[0])
            self.assertEqual(state['config'], {'mode': 'off', 'minimumF': 70, 'maximumF': 95, 'sensorAware': False, 'followBedtime': False})
            for field in ('feedbackThrough', 'learnedSession', 'pausedUntil', 'offsetF', 'lastAppliedAt', 'lastTargetF', 'lastSegment'):
                self.assertEqual(state[field], self.comfort['left'][field])
            self.assertEqual(database.execute('SELECT local_date,comfort FROM comfort_feedback').fetchall(), [('2026-10-24', 'warm')])
            self.assertEqual(database.execute('SELECT COUNT(*) FROM comfort_events').fetchone()[0], 0)
            self.assertEqual(database.execute('SELECT SUM(is_powered) FROM device_state').fetchone()[0], 0)
        with closing(sqlite3.connect(self.output / 'biometrics.db')) as database:
            self.assertEqual(database.execute('SELECT COUNT(*) FROM vitals').fetchone()[0], 0)
            self.assertEqual(database.execute('SELECT status,quality_score FROM calibration_profiles').fetchall(), [('pending', None), ('pending', None)])
        self.assertEqual(report['legacyMetricRows'], {'vitals': 1, 'movement': 1, 'sleep_records': 1})
        self.assertEqual((self.output / 'legacy/free-sleep.db').read_bytes(), self.database_bytes)
        self.assertEqual(migration.read_json(self.output / 'legacy/analytics/journal.json'), self.journal)
        self.assertEqual(migration.read_json(self.output / 'legacy/analytics/comfort.json'), self.comfort)
        self.assertIn('warm-up', '\n'.join(report['reviewRequired']))

    def test_source_is_untouched_and_credentials_are_only_in_private_archive(self):
        self.build_backup()
        before = {item.name: item.read_bytes() for item in self.backup.iterdir()}
        report = migration.stage_backup(self.backup, self.output, NOW)
        self.assertEqual(before, {item.name: item.read_bytes() for item in self.backup.iterdir()})
        for name, content in before.items():
            self.assertEqual((self.output / 'source' / name).read_bytes(), content)
        self.assertFalse((self.output / 'legacy/features.env').exists())
        self.assertNotIn('fixture-only-not-real', json.dumps(report))
        for item in [self.output, *self.output.rglob('*')]:
            self.assertEqual(item.stat().st_mode & 0o777, 0o700 if item.is_dir() else 0o600)

    def test_drizzle_resumes_both_generated_migration_ledgers_without_reapplying(self):
        self.stage()
        script = '''import Database from 'better-sqlite3';
        import {drizzle} from 'drizzle-orm/better-sqlite3';
        import {migrate} from 'drizzle-orm/better-sqlite3/migrator';
        import {readFileSync} from 'node:fs';
        const [directory, root] = process.argv.slice(1);
        for (const [filename, folder] of [['sleepypod.db','migrations'],['biometrics.db','biometrics-migrations']]) {
          const sqlite = new Database(`${directory}/${filename}`);
          const before = sqlite.prepare('SELECT * FROM __drizzle_migrations').all();
          const expected = JSON.parse(readFileSync(`${root}/src/db/${folder}/meta/_journal.json`)).entries.length;
          if (before.length !== expected) throw Error('Missing ledger entries');
          migrate(drizzle(sqlite), {migrationsFolder: `${root}/src/db/${folder}`});
          if (JSON.stringify(before) !== JSON.stringify(sqlite.prepare('SELECT * FROM __drizzle_migrations').all())) throw Error('Migrations reapplied');
          sqlite.close();
        }'''
        subprocess.run(['node', '--input-type=module', '-e', script, str(self.output), str(migration.ROOT)], cwd=migration.ROOT, check=True, capture_output=True)

    def test_existing_core_power_rows_keep_calendar_default_after_upgrade(self):
        with closing(sqlite3.connect(':memory:')) as database:
            entries = migration.read_json(migration.ROOT / 'src/db/migrations/meta/_journal.json')['entries']
            for entry in entries[:-1]:
                database.executescript((migration.ROOT / 'src/db/migrations' / (entry['tag'] + '.sql')).read_text())
            database.execute("INSERT INTO power_schedules(side,day_of_week,on_time,off_time,on_temperature) VALUES ('left','saturday','22:00','07:00',75)")
            database.executescript((migration.ROOT / 'src/db/migrations' / (entries[-1]['tag'] + '.sql')).read_text())
            self.assertEqual(database.execute('SELECT off_day_offset FROM power_schedules').fetchone()[0], 0)

    def test_reboot_runs_only_when_prime_and_reboot_are_enabled(self):
        self.settings['primePodDaily']['enabled'] = True
        self.stage()
        with closing(sqlite3.connect(self.output / 'sleepypod.db')) as database:
            self.assertEqual(database.execute('SELECT reboot_daily,reboot_time FROM device_settings').fetchone(), (1, '23:15'))

    def test_same_day_power_and_disabled_routine_targets(self):
        routine = self.schedules['left']['saturday']
        routine['power'].update(on='06:00', off='08:00', enabled=False)
        routine['temperatures'] = {'07:00': 75}
        self.stage()
        with closing(sqlite3.connect(self.output / 'sleepypod.db')) as database:
            self.assertEqual(database.execute("SELECT off_day_offset FROM power_schedules WHERE side='left' AND day_of_week='saturday'").fetchone()[0], 0)
            self.assertEqual(database.execute('SELECT SUM(enabled) FROM temperature_schedules').fetchone()[0], 0)
            self.assertEqual(database.execute('SELECT SUM(enabled) FROM alarm_schedules').fetchone()[0], 0)

    def test_rejects_hash_mismatch_and_cleans_temporary_output(self):
        self.build_backup()
        with (self.backup / 'data.tar.gz').open('ab') as stream:
            stream.write(b'tampered')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            migration.stage_backup(self.backup, self.output, NOW)
        self.assert_clean_failure()

    def test_rejects_manifest_member_mismatch(self):
        manifest = self.build_backup()
        manifest['files']['data/missing'] = '0' * 64
        migration.write_private(self.backup / 'manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'membership'):
            migration.stage_backup(self.backup, self.output, NOW)
        self.assert_clean_failure()

    def test_rejects_traversal_symlinks_duplicates_and_noncanonical_members(self):
        cases = [('data/../../escape', tarfile.REGTYPE), ('data/link', tarfile.SYMTYPE),
                 ('data/free-sleep.db', tarfile.REGTYPE), ('data//alias', tarfile.REGTYPE)]
        for name, kind in cases:
            with self.subTest(name=name):
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = '../../escape' if kind == tarfile.SYMTYPE else ''
                self.extra = [(member, b'')]
                self.build_backup()
                with self.assertRaises(ValueError):
                    migration.stage_backup(self.backup, self.output, NOW)
                self.assert_clean_failure()
        self.assertFalse((self.root / 'escape').exists())

    def test_rejects_existing_output_and_output_inside_backup_through_symlink(self):
        self.build_backup()
        self.output.mkdir()
        (self.output / 'keep').write_text('retained')
        with self.assertRaisesRegex(ValueError, 'new directory'):
            migration.stage_backup(self.backup, self.output, NOW)
        self.assertEqual((self.output / 'keep').read_text(), 'retained')
        alias = self.root / 'alias'
        alias.symlink_to(self.backup, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'outside'):
            migration.stage_backup(self.backup, alias / 'nested', NOW)
        self.assertFalse((self.backup / 'nested').exists())

    def test_rejects_corrupt_settings_without_publishing_candidate(self):
        self.settings['timeZone'] = 'not-a-timezone'
        self.build_backup()
        with self.assertRaises(Exception):
            migration.stage_backup(self.backup, self.output, NOW)
        self.assert_clean_failure()

    def test_rejects_duplicate_feedback_and_out_of_range_learning_state(self):
        self.journal.append(copy.deepcopy(self.journal[0]))
        self.build_backup()
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            migration.stage_backup(self.backup, self.output, NOW)
        self.assert_clean_failure()
        self.journal.pop()
        self.comfort['left']['offsetF'] = 4
        self.build_backup()
        with self.assertRaisesRegex(ValueError, 'offset'):
            migration.stage_backup(self.backup, self.output, NOW)
        self.assert_clean_failure()

    def test_rejects_nonfinite_and_duplicate_json_fields(self):
        filename = self.root / 'invalid.json'
        for content in ('{"offsetF":NaN}', '{"offsetF":Infinity}', '{"mode":"off","mode":"active"}'):
            filename.write_text(content)
            with self.assertRaises(ValueError):
                migration.read_json(filename)

    def test_rejects_archive_change_between_validation_and_preservation(self):
        self.build_backup()
        original_copy = migration.shutil.copyfile
        def changed_copy(source, destination):
            result = original_copy(source, destination)
            if Path(source).name == 'private.tar.gz':
                Path(destination).write_bytes(b'changed')
            return result
        with patch.object(migration.shutil, 'copyfile', side_effect=changed_copy):
            with self.assertRaisesRegex(ValueError, 'changed during staging'):
                migration.stage_backup(self.backup, self.output, NOW)
        self.assert_clean_failure()


if __name__ == '__main__':
    unittest.main()
