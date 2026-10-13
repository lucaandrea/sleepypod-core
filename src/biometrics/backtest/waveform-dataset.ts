import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { configHash, dataHash } from '../algorithms/canonical'
import { datasetManifestSchema, datasetSnapshotSchema } from './contracts'
import { waveformDatasetInputsSchema } from './waveform-contracts'

const sourceSchema = z.object({ id: z.string().uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  manifest: datasetManifestSchema, snapshot: datasetSnapshotSchema })

/** Server-internal preparation. Sources and context must come from retained evidence. */
export function prepareWaveformDataset(source: z.input<typeof sourceSchema>, rawInputs: unknown, idempotencyKey: string, now = Date.now()) {
  const base = sourceSchema.parse(structuredClone(source))
  if (base.snapshot.version !== 'processed-dataset-v1' || base.manifest.version !== 'processed-dataset-manifest-v1') throw new Error('Select a processed source dataset')
  if (dataHash({ manifest: base.manifest, snapshot: base.snapshot }) !== base.contentHash) throw new Error('Source dataset integrity mismatch')
  z.string().min(1).max(200).parse(idempotencyKey)
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(now)
  const inputs = waveformDatasetInputsSchema.parse(rawInputs)
  const cohorts = new Map(base.manifest.splitProtocol.assignments.map(item => [item.cohortId, item]))
  if (cohorts.size !== base.manifest.splitProtocol.assignments.length || inputs.length !== cohorts.size) throw new Error('Retain waveform inputs for every whole-night cohort')
  for (const item of inputs) {
    const cohort = cohorts.get(item.cohortId)
    if (!cohort || item.input.score_start_ms !== cohort.startMs || item.input.score_end_ms !== cohort.endMs) throw new Error('Waveform input must match its whole-night cohort')
  }
  // Follow the immutable split assignment order, independent of selection UI order.
  const order = [...cohorts.keys()]
  inputs.sort((a, b) => order.indexOf(a.cohortId) - order.indexOf(b.cohortId))
  const snapshot = datasetSnapshotSchema.parse({ ...base.snapshot, version: 'waveform-dataset-v1', waveformInputs: inputs })
  const manifest = datasetManifestSchema.parse({ ...base.manifest, version: 'waveform-dataset-manifest-v1',
    parentDataset: { id: base.id, contentHash: base.contentHash },
    capabilities: { ...base.manifest.capabilities, signalReplay: true },
    limitations: ['Waveform files and supplied context intervals are frozen; execution requires configured deployment admission and current resource health.',
      'Event bounds do not establish continuous waveform coverage; gaps in historical context remain unknown.',
      'Replay uses event time and a cold start with retained pre-roll, not serialized historical processor state.',
      'Measured calibration is not reconstructed from current calibration settings.',
      'Historical stage replay must declare its calibration quality assumption when original calibration is unavailable.',
      'Reference deletion does not erase this separately retained dataset.',
      'Historical occupant identity is asserted by the dataset creator, not measured by the pod.'],
  })
  const contentHash = dataHash({ manifest, snapshot })
  const prepared = { id: randomUUID(), side: snapshot.side, subjectId: snapshot.subjectId,
    idempotencyKey, requestHash: configHash({ version: 'waveform-dataset-request-v1', parentId: base.id,
      parentHash: base.contentHash, inputsHash: dataHash(inputs), idempotencyKey }), contentHash, manifest, snapshot, createdAtMs: now }
  if (Buffer.byteLength(JSON.stringify(prepared)) > 8 * 1024 * 1024) throw new Error('Waveform dataset exceeds its byte budget')
  return prepared
}
