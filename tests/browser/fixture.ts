import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../src/db/biometrics-schema'
import * as configSchema from '../../src/db/schema'
import { executeNextBacktest } from '../../src/biometrics/backtest/runner'
import { packagedWorkerPath } from '../../src/biometrics/backtest/location'
import { tickBiometricRuntime } from '../../src/biometrics/profiles/runtime-host'
import { consumeStageView } from '../../src/biometrics/profiles/stage-view'

const root = process.env.SLEEPYPOD_BROWSER_FIXTURE
const bioPath = process.env.BIOMETRICS_DATABASE_URL
const configPath = process.env.DATABASE_URL
assert(root && bioPath && configPath && dirname(bioPath) === root && dirname(configPath) === root, 'Isolated browser fixture paths required')
const sqlite = new Database(bioPath, { fileMustExist: true })
const configSqlite = new Database(configPath, { fileMustExist: true })
const db = drizzle(sqlite, { schema })
const config = drizzle(configSqlite, { schema: configSchema })
try {
  if (process.argv[2] === 'seed') {
    const start = Date.parse('2026-10-10T23:00:00Z')
    db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(start + 600_000), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
    for (let minute = 0; minute < 10; minute++) {
      db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(start + minute * 60_000), heartRate: 60, breathingRate: 14, hrv: 30 }).run()
    }
  }
  else if (process.argv[2] === 'replay') {
    const before = sqlite.prepare('SELECT * FROM vitals ORDER BY id').all()
    const result = await executeNextBacktest(db, { owner: 'browser-fixture', workerPath: packagedWorkerPath(), timeoutMs: 30_000,
      // Test-only admission: this does not assert measured pod resource health.
      admit: async () => true })
    assert.equal(result.state, 'succeeded')
    assert.deepEqual(sqlite.prepare('SELECT * FROM vitals ORDER BY id').all(), before)
    console.log(JSON.stringify(result))
  }
  else if (process.argv[2] === 'adopt') {
    assert.deepEqual(tickBiometricRuntime(config, db).errors, [])
    // Run shipped Python consumers on one synthetic empty-bed frame, without
    // starting the daemon, DAC transport, or live hardware services.
    execFileSync(resolve('modules/piezo-processor/.venv/bin/python'), ['-c', `
import sqlite3, sys
sys.path.insert(0, 'modules')
sys.path.insert(0, 'modules/piezo-processor')
import numpy as np
from main import DBHolder, SideProcessor
from runtime_adapter import RuntimeCoordinator
connection = sqlite3.connect(sys.argv[1])
holder = DBHolder(connection)
processors = {side: SideProcessor(side, holder) for side in ('left', 'right')}
runtime = RuntimeCoordinator(holder, processors)
runtime.before_frame(None, lambda side: False, 1791673200000)
assert runtime.enabled and runtime.problem is None
for processor in processors.values():
    processor.ingest(np.zeros(500))
runtime.after_frame(1791673200000)
connection.close()
`, bioPath], { timeout: 15_000, maxBuffer: 65536 })
    consumeStageView(config, db, 'left')
    assert.deepEqual(tickBiometricRuntime(config, db).errors, [])
  }
  else throw new Error('Unknown browser fixture action')
}
finally {
  sqlite.close()
  configSqlite.close()
}
