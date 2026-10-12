// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { defaultConfig } from '../../algorithms/registry'
import { DatasetStore } from '../datasets'
import { datasetManifestSchema } from '../contracts'
import { prepareWaveformDataset } from '../waveform-dataset'
import { runWaveformChild } from '../waveform-child'
import type { z } from 'zod'
import type { retainedWaveformInputSchema } from '../waveform-contracts'

type Input = z.infer<typeof retainedWaveformInputSchema>
const python = resolve('modules/piezo-processor/.venv/bin/python')
const environment: NodeJS.ProcessEnv = { PYTHONPATH: resolve('modules'), OPENBLAS_NUM_THREADS: '1', LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test' }

it('publishes, verifies, replays, releases and collects a retained waveform dataset without changing observations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'waveform-publication-integration-'))
  const database = join(directory, 'biometrics.db')
  const archive = join(directory, 'archive')
  const retained = join(directory, 'retained')
  const sqlite = new Database(database)
  try {
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
    const fixture = JSON.parse(execFileSync(python, ['-B', '-c', `
import json, gzip, sys
from dataclasses import asdict
from pathlib import Path
import cbor2
import numpy as np
from common.biometrics.raw_sources import ArchiveSource
root=Path(sys.argv[1]); root.mkdir()
start=1700000000000
records=[{'type':'frzHealth','ts':start/1000,'left':{'pumpRpm':0},'right':{'pumpRpm':0}}]
for second in range(150):
    samples=(np.sin((np.arange(500)+second*500)/500*2*np.pi*1.2)*1000000).astype('<i4').tobytes()
    records.append({'type':'piezo-dual','ts':start/1000+second,'left1':samples,'right1':bytes(2000)})
artifacts=[]; selections=[]
for index, group in enumerate([records[:76],records[76:]]):
    name=str(index)+'.RAW.gz'
    payload=b''.join(cbor2.dumps({'seq':number,'data':cbor2.dumps(record)}) for number,record in enumerate(group))
    (root/name).write_bytes(gzip.compress(payload,mtime=0))
    inspected=ArchiveSource(root,name).inspect()
    descriptor=asdict(inspected['artifact']); inventory=inspected['inventory']
    selections.append({'source_name':name,'artifact':descriptor})
    artifacts.append({'artifact':descriptor,'first_event_ms':inventory['first_event_ms'],'last_event_ms':inventory['last_event_ms']})
print(json.dumps({'start':start,'artifacts':artifacts,'selections':selections}))
`, archive], { env: environment, encoding: 'utf8', timeout: 20000, maxBuffer: 65536 })) as {
      start: number
      artifacts: Input['artifacts']
      selections: Array<{ source_name: string, artifact: Input['artifacts'][number]['artifact'] }>
    }
    const input: Input = { version: 'retained-waveform-input-v1', retained_start_ms: fixture.start,
      score_start_ms: fixture.start + 60000, score_end_ms: fixture.start + 150000, artifacts: fixture.artifacts,
      contexts: [{ start_ms: fixture.start, end_ms: fixture.start + 150000, active_sides: ['left'],
        left_occupied: true, right_occupied: false, pump_context_known: true }] }
    db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(input.score_start_ms),
      leftBedAt: new Date(input.score_end_ms), sleepDurationSeconds: 90, timesExitedBed: 0 }).run()
    db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(input.score_start_ms), heartRate: 65 }).run()
    const now = input.score_end_ms + 10000
    const datasets = new DatasetStore(db, () => now)
    const base = datasets.read(datasets.create({ side: 'left', subjectId: 'fixture', sessionIds: [1],
      referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'processed' }).id)
    const manifest = datasetManifestSchema.parse(base.manifest)
    const prepared = prepareWaveformDataset({ ...base, manifest }, [{ cohortId: manifest.splitProtocol.assignments[0].cohortId, input }], 'waveform', now)
    const publish = () => JSON.parse(execFileSync(python, ['-B', '-m', 'common.biometrics.publication_worker',
      '--database', database, '--archive-directory', archive, '--retained-directory', retained], {
      env: environment, input: JSON.stringify({ version: 'waveform-publication-work-v1', prepared, selections: fixture.selections }),
      encoding: 'utf8', timeout: 20000, maxBuffer: 65536,
    })) as { type: string, id: string, contentHash: string, available: boolean }
    const published = publish()
    expect(published).toEqual({ type: 'result', id: prepared.id, contentHash: prepared.contentHash, available: true })
    const frozen = datasets.read(published.id)
    expect(frozen.snapshot).toEqual(prepared.snapshot) // Includes shared cross-language content-hash verification.
    expect(sqlite.prepare('SELECT count(*) AS count FROM biometric_dataset_raw_artifacts').get()).toEqual({ count: 2 })
    rmSync(archive, { recursive: true })
    expect(publish()).toEqual(published)
    if (frozen.snapshot.version !== 'waveform-dataset-v1') throw new Error('Missing waveform inputs')
    const replay = await runWaveformChild({ pythonPath: python, modulesPath: resolve('modules'), retainedDirectory: retained }, {
      version: 'retained-waveform-work-v1', input: frozen.snapshot.waveformInputs[0].input,
      configs: { left: defaultConfig, right: defaultConfig },
    })
    expect(replay.readings.length).toBeGreaterThan(0)
    expect(replay.run.raw_records).toBe(151)
    expect(sqlite.prepare('SELECT heart_rate FROM vitals').all()).toEqual([{ heart_rate: 65 }])
    datasets.release(published.id)
    expect(publish()).toEqual({ ...published, available: false })
    const collected = JSON.parse(execFileSync(python, ['-B', '-c', `
import json, sqlite3, sys
from common.biometrics.raw_artifacts import RawArtifactStore
connection=sqlite3.connect(sys.argv[1])
print(json.dumps(RawArtifactStore(sys.argv[2]).collect_released(connection,now_ms=int(sys.argv[3]),minimum_age_ms=0)))
connection.close()
`, database, retained, String(now)], { env: environment, encoding: 'utf8', timeout: 20000 })) as string[]
    expect(collected).toHaveLength(2)
    expect(readdirSync(retained).filter(name => name.endsWith('.RAW.gz'))).toEqual([])
    expect(datasets.read(base.id)).toEqual(base)
  }
  finally {
    sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)
