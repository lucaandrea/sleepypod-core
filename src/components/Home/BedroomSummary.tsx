'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { bedroomReadingCurrent } from '@/src/bedroom/presentation'

/** Shared context for the temperature and routine screens; it never rewrites a saved routine. */
export function BedroomSummary() {
  const query = trpc.bedroom.status.useQuery({}, { refetchInterval: 5000, refetchIntervalInBackground: false, retry: false })
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const data = query.data
  if (!data?.config.sources.length) return null
  const current = (expiresAt: number | null) => bedroomReadingCurrent(data.generatedAt, query.dataUpdatedAt, expiresAt, now, query.isError)
  const temperature = data.aggregates.find(item => item.metric === 'temperature')
  const humidity = data.aggregates.find(item => item.metric === 'humidity')
  return (
    <aside aria-label="Bedroom context for your routine" className="mb-4 rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="font-medium">{data.config.roomName}</span>
        <span className="text-fg-2">
          {temperature?.status === 'ready' && temperature.value !== null && current(temperature.expiresAt) ? `${temperature.value.toFixed(1)}°F` : 'Temperature unavailable'}
          {' · '}
          {humidity?.status === 'ready' && humidity.value !== null && current(humidity.expiresAt) ? `${Math.round(humidity.value)}% humidity` : 'Humidity unavailable'}
        </span>
        <Link href="/home" className="text-cool underline">Devices and readings</Link>
      </div>
      <p className="mt-2 text-xs text-fg-2">
        {query.isError
          ? 'Room connection unavailable. Room-dependent adjustments are withheld.'
          : data.guidance.state === 'ready' && !current(data.guidance.expiresAt) ? 'Waiting for fresh bedroom readings.' : data.guidance.reason}
        {' '}
        Room-informed comfort must be selected in Autopilot. Saved routines and wake alarms keep priority.
      </p>
    </aside>
  )
}
