'use client'

import type { z } from 'zod'
import { Trans, useLingui } from '@lingui/react/macro'
import type { waveformResourceSummarySchema } from '@/src/biometrics/backtest/waveform-resources'

export function ReplayResources({ resources }: { resources?: z.infer<typeof waveformResourceSummarySchema> }) {
  const { t, i18n } = useLingui()
  const number = new Intl.NumberFormat(i18n.locale || 'en', { maximumFractionDigits: 2 })
  const display = (value: number | null, scale: number) => value === null ? t`Unavailable` : number.format(value / scale)
  return (
    <section className="space-y-2">
      <h4><Trans>Replay processing costs</Trans></h4>
      {!resources
        ? <p><Trans>This report predates replay process measurements.</Trans></p>
        : (
            <>
              <p>{t`Measured Python processes: ${resources.measuredProcesses} of ${resources.expectedProcesses}`}</p>
              <dl>
                <dt><Trans>Total Python wall time (seconds)</Trans></dt>
                <dd>{display(resources.totalWallMs, 1000)}</dd>
                <dt><Trans>Total Python CPU time (seconds)</Trans></dt>
                <dd>{display(resources.totalCpuMs, 1000)}</dd>
                <dt><Trans>Largest Python process peak memory (MiB)</Trans></dt>
                <dd>{display(resources.largestProcessPeakRssBytes, 1024 * 1024)}</dd>
              </dl>
              <p><Trans>Durations cover sequential Python work through result generation. Memory is the largest process lifetime peak. These measurements exclude coordinator and scoring costs and do not establish live ingestion health.</Trans></p>
            </>
          )}
    </section>
  )
}
