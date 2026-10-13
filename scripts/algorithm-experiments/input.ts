import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { canonicalJson } from '../../src/biometrics/algorithms/canonical'
import { signalFrameSchema } from '../../src/biometrics/packages/protocol'

const domain = 'biometric-package-input-v1\n'
/** Streaming identity; canonical frame JSON followed by LF, prefixed by domain.
 * These are actual experiment frames, not a user-supplied dataset name/hash. */
export function packageInputHash(frames: Iterable<unknown>) {
  const hash = createHash('sha256').update(domain)
  for (const frame of frames) hash.update(canonicalJson(signalFrameSchema.parse(frame)) + '\n')
  return hash.digest('hex')
}

/** Freeze bounded input before any candidate starts. The owned file is never
 * mounted into the container: the executor sends one frame at a time. */
export async function freezePackageInput(path: string, frames: Iterable<unknown>, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error('Invalid input byte limit')
  const file = await open(path, 'wx', 0o600)
  let bytes = 0, frameCount = 0
  const hash = createHash('sha256').update(domain)
  try {
    for (const frame of frames) {
      const encoded = canonicalJson(signalFrameSchema.parse(frame)) + '\n'
      bytes += Buffer.byteLength(encoded)
      if (bytes > maximumBytes) throw new Error('Frozen input byte limit exceeded')
      hash.update(encoded)
      await file.writeFile(encoded)
      frameCount++
    }
    if (!frameCount) throw new Error('Experiment requires at least one frame')
  }
  finally {
    await file.close()
  }
  return { schema: 'biometric-package-input-v1' as const, hash: hash.digest('hex'), bytes, frameCount }
}

export async function* readFrozenPackageInput(path: string) {
  const stream = createReadStream(path)
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) yield JSON.parse(line) as unknown
  }
  finally {
    lines.close()
    stream.destroy()
  }
}
