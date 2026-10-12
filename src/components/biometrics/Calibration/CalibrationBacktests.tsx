'use client'

import { useState } from 'react'
import { ReplaySessionPicker } from './ReplaySessionPicker'

export function CalibrationBacktests({ side }: { side: 'left' | 'right' }) {
  const [sessions, setSessions] = useState<number[]>([])
  return <ReplaySessionPicker side={side} selected={sessions} onChange={setSessions} />
}
