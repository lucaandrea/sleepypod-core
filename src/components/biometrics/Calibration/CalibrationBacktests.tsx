'use client'

import { DatasetBuilder } from './DatasetBuilder'

export function CalibrationBacktests({ side }: { side: 'left' | 'right' }) {
  return <DatasetBuilder side={side} />
}
