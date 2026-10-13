import { createHash } from 'node:crypto'

export function packageFixture() {
  const files = new Map([['engine.py', Buffer.from('raise RuntimeError("must never execute during intake")')], ['uv.lock', Buffer.from('version = 1')]])
  const manifest = {
    schema: 'biometric-algorithm-package-v1', canonicalization: 'finite-binary64-json-v1', engine: { id: 'test.hr', version: '1.0.0' },
    runtime: 'python-frame-v1', entrypoint: 'engine.py', dependencyLock: 'uv.lock',
    inputSchema: 'biometric-signal-frame-v1', outputSchema: 'biometric-metric-frame-v1',
    metrics: [{ id: 'heart_rate', definition: 'Heart beats per minute', unit: 'bpm', minimum: 20, maximum: 240 }],
    hardware: [{ id: 'pod4', sampleRatesHz: [500] }], temporal: { mode: 'causal', lookaheadMs: 0 },
    state: { schemaId: 'test.hr.state.v1', initialization: 'explicit_seed_and_config', reset: 'reset_before_each_independent_run', serialization: 'json', maximumBytes: 10000 },
    resources: { cpuMs: 1000, wallMs: 2000, memoryBytes: 100000000, processes: 1, outputBytes: 10000 },
    artifacts: [...files].map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })),
  }
  return { files, manifest }
}

