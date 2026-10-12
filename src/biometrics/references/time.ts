import { timestampMsSchema, type timePolicySchema } from './contracts'
import type { z } from 'zod'

type TimePolicy = z.infer<typeof timePolicySchema>
const localPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
const offsetPattern = /(Z|([+-])(\d{2}):(\d{2}))$/

export class ReferenceInputError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function localMilliseconds(text: string): number {
  const parts = localPattern.exec(text)
  if (!parts) throw new ReferenceInputError('INVALID_TIMESTAMP', 'Use ISO date and time with seconds and an explicit offset or time policy')
  const fields = parts.slice(1, 7).map(Number)
  const [year, month, day, hour, minute, second] = fields
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, Number((parts[7] ?? '').padEnd(3, '0')))
  const date = new Date(ms)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new ReferenceInputError('INVALID_TIMESTAMP', 'Invalid calendar date or time')
  }
  return ms
}

/** Per-preview resolver; cache is bounded by the bounded import, not global. */
export function timestampResolver(policy: TimePolicy) {
  let formatter: Intl.DateTimeFormat | undefined
  if (policy.timezone) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: policy.timezone, timeZoneName: 'longOffset' })
    }
    catch { throw new ReferenceInputError('INVALID_TIMEZONE', 'Use a valid IANA timezone') }
  }
  const offsetAt = (ms: number) => {
    const name = formatter?.formatToParts(ms).find(part => part.type === 'timeZoneName')?.value
    if (name === 'GMT') return 0
    const match = name?.match(/^GMT([+-])(\d{2}):(\d{2})$/)
    if (!match) throw new ReferenceInputError('INVALID_TIMEZONE', 'Timezone offset cannot be resolved')
    return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
  }
  const offsetsByDay = new Map<number, number[]>()
  return (value: string | number): number => {
    if (typeof value === 'number') return timestampMsSchema.parse(value)
    const offset = offsetPattern.exec(value)
    const local = localMilliseconds(offset ? value.slice(0, -offset[0].length) : value)
    let explicitOffset = policy.utcOffsetMinutes
    if (offset) {
      if (offset[1] === 'Z') explicitOffset = 0
      else {
        const hours = Number(offset[3]), minutes = Number(offset[4])
        if (hours > 14 || minutes > 59 || (hours === 14 && minutes > 0)) throw new ReferenceInputError('INVALID_TIMESTAMP', 'Offset is outside the supported range')
        explicitOffset = (offset[2] === '-' ? -1 : 1) * (hours * 60 + minutes)
      }
    }
    if (explicitOffset !== undefined) {
      const utc = local - explicitOffset * 60000
      if (formatter && offsetAt(utc) !== explicitOffset) throw new ReferenceInputError('TIMEZONE_OFFSET_MISMATCH', 'The supplied offset does not match this local time in the selected timezone')
      return timestampMsSchema.parse(utc)
    }
    if (!formatter) throw new ReferenceInputError('AMBIGUOUS_TIMESTAMP', 'Local timestamps require a timezone or an explicit UTC offset')
    const day = Math.floor(local / 86400000)
    if (!offsetsByDay.has(day)) {
      // Inspect both sides of local DST changes, including non-hour changes.
      const offsets = new Set<number>()
      for (let hours = -36; hours <= 36; hours += 6) offsets.add(offsetAt(day * 86400000 + hours * 3600000))
      offsetsByDay.set(day, [...offsets])
    }
    const candidates = (offsetsByDay.get(day) ?? []).map(minutes => local - minutes * 60000)
      .filter(utc => utc + offsetAt(utc) * 60000 === local).sort((a, b) => a - b)
    if (!candidates.length) throw new ReferenceInputError('NONEXISTENT_LOCAL_TIME', 'This local time falls in a timezone clock gap; provide the correct timestamp')
    if (candidates.length > 1 && policy.disambiguation === 'reject') throw new ReferenceInputError('AMBIGUOUS_LOCAL_TIME', 'This local time occurs twice; provide an offset or choose earlier/later explicitly')
    return timestampMsSchema.parse(policy.disambiguation === 'later' ? candidates[candidates.length - 1] : candidates[0])
  }
}
