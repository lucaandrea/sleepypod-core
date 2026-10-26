import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

import activate
import activation_checks
import handoff
from service_plan import CORE_UNIT, CORE_UNITS, LEGACY_UNITS
import test_handoff


def idle(core=False):
    side = {'heatingDuration': 0} if core else {'secondsRemaining': 0, 'isOn': False, 'isAlarmVibrating': False}
    return {'isPriming': False, ('leftSide' if core else 'left'): side,
            ('rightSide' if core else 'right'): dict(side)}


def observation():
    return {'controller': {'id': 'sleepypod-core', 'revision': 'aaaaaaa'},
            'device': {'freshness': 'fresh'}, 'temperatureRuntime': 'ready'}


class ActivationTests(unittest.TestCase):
    def setUp(self):
        test_handoff.HandoffTests.setUp(self)
        self.failure = None
        self.elapsed = 0
        self.overlaps = []
        handoff.install(self.directory)
        self.journal = json.loads((self.directory / 'handoff.json').read_text())
        self.journal.update(phase='trial_restored', trialStartedAt=time.time() - 35,
                            trialEndedAt=time.time() - 1, settleSeconds=30, trialSucceeded=True,
                            requireIdle=True, restoredIdleVerified=True, observation=observation())
        self.save_trial()
        replacements = [(handoff, 'prerequisites', lambda _: 'a' * 40),
                        (handoff, 'read_owner_key', lambda _: 'key-never-recorded'),
                        (handoff, 'local_json', lambda path, *_: idle(path == '/api/device/status')),
                        (handoff, 'restored_idle', lambda *_: True),
                        (activation_checks, 'candidate_ready', lambda _: None),
                        (activation_checks, 'unchanged_source', lambda *_: {'settings': 'digest'})]
        for module, name, replacement in replacements:
            context = patch.object(module, name, replacement)
            context.start()
            self.addCleanup(context.stop)

    def save_trial(self):
        (self.directory / 'handoff.json').write_text(json.dumps(self.journal))

    def control(self, *arguments):
        test_handoff.HandoffTests.control(self, *arguments)
        action, *names = arguments
        if action == 'start' and names == [CORE_UNIT]:
            for name in CORE_UNITS:
                self.states[name].update(ActiveState='active', MainPID='456')
        if action in ('enable', 'disable'):
            for name in names:
                self.states[name]['UnitFileState'] = 'enabled' if action == 'enable' else 'disabled'
        if action == 'start':
            if any(self.states[name]['MainPID'] != '0' for name in LEGACY_UNITS) and any(self.states[name]['MainPID'] != '0' for name in CORE_UNITS):
                self.overlaps.append(arguments)
        if arguments == self.failure:
            self.failure = None
            raise OSError('injected partial service operation failure')
        return ''

    def sleep(self, seconds):
        self.elapsed += seconds

    def run_activation(self, observe=None):
        return activate.activate(self.directory, self.root / 'legacy', 60,
                                 observe=observe or (lambda *_: observation()),
                                 sleep=self.sleep, monotonic=lambda: self.elapsed)

    def assert_restored(self):
        activate.assert_boot_selection(core=False)
        activate.assert_ownership(core=False)
        self.assertEqual(self.overlaps, [])

    def test_selects_core_after_stable_window_then_rolls_back_without_demanding_idle(self):
        result = self.run_activation()
        self.assertEqual(result['phase'], 'active')
        self.assertGreaterEqual(self.elapsed, 30)
        activate.assert_boot_selection(core=True)
        self.assertEqual(self.overlaps, [])
        self.assertFalse(result['physicalOperationVerified'])
        text = (self.directory / 'activation.json').read_text()
        self.assertNotIn('key-never-recorded', text)
        self.assertEqual((self.directory / 'activation.json').stat().st_mode & 0o777, 0o600)
        # Rollback after activation must not demand/cancel an idle bed or change data.
        with patch.object(handoff, 'restored_idle', side_effect=AssertionError('live heating is allowed')):
            restored = activate.rollback(self.directory)
            activate.rollback(self.directory)
        self.assertEqual(restored['phase'], 'rolled_back')
        self.assert_restored()

    def test_unqualified_trial_never_mutates_services(self):
        original = dict(self.journal)
        cases = {'phase': 'installed_not_started', 'trialSucceeded': False, 'requireIdle': False,
                 'restoredIdleVerified': False, 'settleSeconds': 0,
                 'trialEndedAt': time.time() - 86401, 'trialStartedAt': float('nan')}
        for field, value in cases.items():
            with self.subTest(field=field):
                self.journal = {**original, field: value}
                self.save_trial()
                with self.assertRaises(ValueError):
                    self.run_activation()
                self.assertEqual(self.calls, [('daemon-reload',)])
                self.assertFalse((self.directory / 'activation.json').exists())

    def test_foreign_units_are_rejected_before_service_changes(self):
        (self.unit_directory / CORE_UNIT).write_text('unrelated service')
        with self.assertRaises(ValueError):
            self.run_activation()
        self.assertEqual(self.calls, [('daemon-reload',)])

    def test_configuration_change_after_stop_restores_without_starting_core(self):
        with patch.object(activation_checks, 'unchanged_source', side_effect=[{'settings': 'digest'}, ValueError('changed')]):
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.run_activation()
        self.assertNotIn(('start', CORE_UNIT), self.calls)
        self.assert_restored()

    def test_failed_core_start_restores(self):
        self.start_failure = True
        with self.assertRaises(OSError):
            self.run_activation()
        self.assert_restored()

    def test_surviving_legacy_process_never_allows_core_start(self):
        self.stop_failure = True
        with self.assertRaises(RuntimeError):
            self.run_activation()
        self.assertNotIn(('start', CORE_UNIT), self.calls)
        self.assert_restored()

    def test_partial_enable_failure_restores_boot_selection(self):
        self.failure = ('enable', CORE_UNIT)
        with self.assertRaises(OSError):
            self.run_activation()
        self.assert_restored()

    def test_partial_disable_failure_restores_boot_selection(self):
        self.failure = ('disable', *LEGACY_UNITS)
        with self.assertRaises(OSError):
            self.run_activation()
        self.assert_restored()

    def test_loss_of_readiness_after_enable_restores_boot_selection(self):
        def observed(*_):
            value = observation()
            if self.states[CORE_UNIT]['UnitFileState'] == 'enabled':
                value['device']['freshness'] = 'stale'
            return value
        with self.assertRaisesRegex(RuntimeError, 'readiness changed'):
            self.run_activation(observed)
        self.assert_restored()

    def test_failed_sensor_withholds_activation(self):
        def observed(*_):
            self.states[CORE_UNITS[1]].update(ActiveState='failed', MainPID='0')
            return observation()
        with self.assertRaisesRegex(RuntimeError, 'not active'):
            self.run_activation(observed)
        self.assert_restored()

    def test_stale_window_resets_the_required_settling_time(self):
        def observed(*_):
            value = observation()
            if self.elapsed == 20:
                value['device']['freshness'] = 'stale'
            return value
        self.run_activation(observed)
        self.assertGreaterEqual(self.elapsed, 52)

    def test_readiness_timeout_restores_without_changing_boot_owner(self):
        with self.assertRaisesRegex(RuntimeError, '30 seconds'):
            self.run_activation(lambda *_: {**observation(), 'temperatureRuntime': 'unavailable'})
        self.assertNotIn(('enable', CORE_UNIT), self.calls)
        self.assert_restored()

    def test_unexpected_heat_after_failed_activation_requires_review(self):
        self.start_failure = True
        with patch.object(handoff, 'restored_idle', side_effect=RuntimeError('heating is active')):
            with self.assertRaisesRegex(RuntimeError, 'heating is active'):
                self.run_activation()
        self.assertEqual(json.loads((self.directory / 'activation.json').read_text())['phase'], 'recovery_required')
        self.assert_restored()

    def test_nonzero_heating_during_activation_restores_without_enabling_core(self):
        def status(path, *_):
            value = idle(path == '/api/device/status')
            if path == '/api/device/status':
                value['leftSide']['heatingDuration'] = 100
            return value
        with patch.object(handoff, 'local_json', status), self.assertRaisesRegex(RuntimeError, 'countdown'):
            self.run_activation()
        self.assertNotIn(('enable', CORE_UNIT), self.calls)
        self.assert_restored()

    def test_interrupt_restores_and_propagates(self):
        with self.assertRaises(KeyboardInterrupt):
            self.run_activation(lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        self.assert_restored()

    def test_foreign_unit_during_restore_leaves_explicit_recovery_record(self):
        self.run_activation()
        (self.unit_directory / LEGACY_UNITS[0]).write_text('unrelated')
        with self.assertRaises(ValueError):
            activate.rollback(self.directory)
        record = json.loads((self.directory / 'activation.json').read_text())
        self.assertEqual(record['phase'], 'recovery_required')
        self.assertEqual(record['bootOwner'], 'unknown')
        self.assertTrue(all(handoff.stopped(self.states[name]) for name in CORE_UNITS))

    def test_existing_activation_prevents_trial_or_duplicate_activation(self):
        self.run_activation()
        calls = list(self.calls)
        with self.assertRaisesRegex(ValueError, 'activation journal'):
            self.run_activation()
        with self.assertRaisesRegex(ValueError, 'activate.py rollback'):
            handoff.trial(self.directory, 60)
        with self.assertRaisesRegex(ValueError, 'activate.py rollback'):
            handoff.require_no_activation(self.directory)
        self.assertEqual(self.calls, calls)


class ReadOnlyChecksTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / 'candidate'
        self.live = self.root / 'live'
        self.data.mkdir()
        for root in (self.data / 'legacy', self.live):
            (root / 'lowdb').mkdir(parents=True)
            (root / 'lowdb/settingsDB.json').write_text('{"value":1}')
            (root / 'lowdb/schedulesDB.json').write_text('{"value":2}')

    def test_source_comparison_detects_edits_additions_removal_and_symlinks(self):
        activation_checks.unchanged_source(self.data, self.live)
        path = self.live / 'lowdb/settingsDB.json'
        path.write_text('changed')
        with self.assertRaisesRegex(ValueError, 'changed since import'):
            activation_checks.unchanged_source(self.data, self.live)
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            activation_checks.unchanged_source(self.data, self.live)
        path.symlink_to(self.data / 'legacy/lowdb/settingsDB.json')
        with self.assertRaisesRegex(ValueError, 'regular file'):
            activation_checks.unchanged_source(self.data, self.live)
        path.unlink()
        path.write_text('{"value":1}')
        (self.live / 'left_cap_baseline.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'changed since import'):
            activation_checks.unchanged_source(self.data, self.live)

    def test_rejects_comparing_retained_candidate_to_itself(self):
        with self.assertRaisesRegex(ValueError, 'separate'):
            activation_checks.unchanged_source(self.data, self.data / 'legacy')

    def test_candidate_guard_uses_real_schema_and_is_read_only(self):
        from scripts.migration import free_sleep as migration
        root = Path(__file__).resolve().parents[2]
        for name, migrations in (('sleepypod.db', 'migrations'), ('biometrics.db', 'biometrics-migrations')):
            migration.create_database(self.data / name, root / 'src/db' / migrations).close()
        (self.data / 'migration-report.json').write_text('{"format":"sleepypod-free-sleep-import/1"}')
        database = sqlite3.connect(self.data / 'sleepypod.db')
        self.addCleanup(database.close)
        database.execute('INSERT INTO device_settings(id,mqtt_enabled) VALUES (1,0)')
        for side in ('left', 'right'):
            database.execute('INSERT INTO side_settings(side,name) VALUES (?,?)', (side, side))
            database.execute('INSERT INTO comfort_states(side,state) VALUES (?,?)', (side, '{"config":{"mode":"preview"}}'))
        database.commit()
        before = (self.data / 'sleepypod.db').read_bytes()
        activation_checks.candidate_ready(self.data)
        self.assertEqual(before, (self.data / 'sleepypod.db').read_bytes())
        for field in ('autopilot_enabled', 'mqtt_enabled', 'homekit_enabled', 'prime_pod_daily', 'reboot_daily', 'pump_stall_protection_enabled', 'pump_stall_auto_recovery_enabled'):
            with self.subTest(field=field):
                database.execute('UPDATE device_settings SET ' + field + '=1')
                database.commit()
                with self.assertRaises(ValueError):
                    activation_checks.candidate_ready(self.data)
                database.execute('UPDATE device_settings SET ' + field + '=0')
                database.commit()
        for field in ('always_on', 'auto_on_enabled', 'auto_off_enabled'):
            with self.subTest(field=field):
                database.execute('UPDATE side_settings SET ' + field + '=1')
                database.commit()
                with self.assertRaisesRegex(ValueError, 'presence-based'):
                    activation_checks.candidate_ready(self.data)
                database.execute('UPDATE side_settings SET ' + field + '=0')
                database.commit()
        cases = [
            ('base_schedules', "INSERT INTO base_schedules(day_of_week,time,head,feet) VALUES ('daily','23:00',5,0)"),
            ('automations', "INSERT INTO automations(name,trigger,conditions,actions) VALUES ('test','{}','{}','[]')"),
            ('run_once_sessions', "INSERT INTO run_once_sessions(side,set_points,wake_time,expires_at) VALUES ('left','[]','09:00',1000000)"),
        ]
        for table, statement in cases:
            with self.subTest(table=table):
                database.execute(statement)
                database.commit()
                with self.assertRaisesRegex(ValueError, 'separate review'):
                    activation_checks.candidate_ready(self.data)
                database.execute('DELETE FROM ' + table)
                database.commit()
        database.execute('UPDATE comfort_states SET state=? WHERE side=?', ('{"config":{"mode":"active"}}', 'left'))
        database.commit()
        with self.assertRaisesRegex(ValueError, 'Off or Preview'):
            activation_checks.candidate_ready(self.data)

    def test_future_receipt_or_different_revision_is_rejected(self):
        journal = {'trialStartedAt': 100, 'trialEndedAt': 140, 'observation': observation()}
        with self.assertRaisesRegex(ValueError, 'dates'):
            activation_checks.require_trial(journal, 'a' * 40, 139)
        with self.assertRaisesRegex(ValueError, 'this release'):
            activation_checks.require_trial(journal, 'b' * 40, 141)


if __name__ == '__main__':
    unittest.main()
