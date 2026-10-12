import { REFERENCE_LIMITS } from './contracts'
import { ReferenceInputError } from './time'

const columns = new Set(['recordKey', 'subjectId', 'metric', 'value', 'unit', 'timestampMs', 'startMs', 'endMs', 'timestamp', 'start', 'end', 'aggregation', 'windowMs', 'quality', 'annotation'])
const numeric = new Set(['timestampMs', 'startMs', 'endMs', 'windowMs', 'quality', 'value'])

/** Text only. Never reads a path/URL, expands an archive or evaluates a cell. */
export function parseReferenceText(format: 'csv' | 'json', text: string): unknown[] {
  if (new TextEncoder().encode(text).byteLength > REFERENCE_LIMITS.bytes) throw new ReferenceInputError('RESOURCE_LIMIT', 'Reference upload exceeds 2 MiB')
  if (format === 'json') {
    let rows: unknown
    try {
      rows = JSON.parse(text)
    }
    catch { throw new ReferenceInputError('INVALID_JSON', 'Expected a JSON array of reference records') }
    if (!Array.isArray(rows) || rows.length > REFERENCE_LIMITS.rows) throw new ReferenceInputError('RESOURCE_LIMIT', 'Expected at most 2000 reference records')
    return rows
  }
  const records: string[][] = []
  let record: string[] = [], cell = '', quoted = false, closed = false
  const input = text.replace(/^\uFEFF/, '')
  function endCell() {
    record.push(cell)
    if (record.length > columns.size) throw new ReferenceInputError('RESOURCE_LIMIT', 'Too many CSV columns')
    cell = ''
    closed = false
  }
  function endRecord() {
    endCell()
    records.push(record)
    record = []
    if (records.length > REFERENCE_LIMITS.rows + 1) throw new ReferenceInputError('RESOURCE_LIMIT', 'Expected at most 2000 reference records')
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"'
          i++
        }
        else {
          quoted = false
          closed = true
        }
      }
      else cell += char
    }
    else if (char === ',') endCell()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++
      endRecord()
    }
    else if (closed) throw new ReferenceInputError('INVALID_CSV', 'Unexpected data after a quoted cell')
    else if (char === '"') {
      if (cell.length) throw new ReferenceInputError('INVALID_CSV', 'A quote must start a CSV cell')
      quoted = true
    }
    else cell += char
  }
  if (quoted) throw new ReferenceInputError('INVALID_CSV', 'Unterminated quoted CSV cell')
  if (cell.length || record.length || closed) endRecord()
  const header = records.shift()
  if (!header || new Set(header).size !== header.length || header.some(name => !columns.has(name))) throw new ReferenceInputError('INVALID_CSV', 'CSV headers must be unique documented field names')
  return records.map((values) => {
    if (values.length !== header.length) throw new ReferenceInputError('INVALID_CSV', 'CSV row has a different number of fields than the header')
    return Object.fromEntries(header.flatMap((key, index) => {
      const value = values[index]
      if (value === '') return []
      return [[key, numeric.has(key) && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ? Number(value) : value]]
    }))
  })
}
