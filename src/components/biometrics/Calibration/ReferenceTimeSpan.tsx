'use client'

import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'

/** Display the outer extent, never imply uninterrupted coverage between sparse rows. */
export function ReferenceTimeSpan({ startMs, endMs }: { startMs: number | null, endMs: number | null }) {
  const { t, i18n } = useLingui()
  const timeFormat = useTimeFormat()
  const settings = trpc.settings.getAll.useQuery({}, { staleTime: 60000 })
  let timezone = settings.data?.device.timezone ?? 'UTC'
  let dates: Intl.DateTimeFormat
  try {
    dates = new Intl.DateTimeFormat(i18n.locale || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone, hour12: timeFormat !== '24h' })
  }
  catch {
    timezone = 'UTC'
    dates = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone, hour12: timeFormat !== '24h' })
  }
  if (startMs == null || endMs == null) return <p><Trans>No accepted time range.</Trans></p>
  const start = dates.format(startMs), end = dates.format(endMs)
  return (
    <div className="text-sm text-fg-2">
      <p>{t`Reference extent: ${start} to ${end} (${timezone})`}</p>
      <p><Trans>This is the first-to-last record span, not continuous coverage or overlap with pod readings.</Trans></p>
    </div>
  )
}
