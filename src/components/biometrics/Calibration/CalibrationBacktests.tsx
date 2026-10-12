'use client'

import { BacktestJobs } from './BacktestJobs'
import { ExperimentLibrary } from './ExperimentLibrary'
import { DatasetLibrary } from './DatasetLibrary'
import { DatasetBuilder } from './DatasetBuilder'

export function CalibrationBacktests({ side }: { side: 'left' | 'right' }) {
  return (
    <div className="space-y-4">
      <DatasetBuilder side={side} />
      <DatasetLibrary side={side} />
      <ExperimentLibrary side={side} />
      <BacktestJobs side={side} />
    </div>
  )
}
