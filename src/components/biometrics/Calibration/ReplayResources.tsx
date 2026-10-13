'use client'

import type { jobOperationsSchema } from '@/src/biometrics/backtest/job-operations'
import type { z } from 'zod'
import { Trans, useLingui } from '@lingui/react/macro'
import type { waveformResourceSummarySchema } from '@/src/biometrics/backtest/waveform-resources'

export function ReplayResources({ resources, operations }: { resources?: z.infer<typeof waveformResourceSummarySchema>, operations?: z.infer<typeof jobOperationsSchema> }) {
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
      {operations
        ? (
            <div className="space-y-2">
              <h5><Trans>Job health observations</Trans></h5>
              {operations.memory
                ? (
                    <div>
                      <p>{t`Observed process-group peak RSS: ${display(operations.memory.peakObservedRssBytes, 1024 * 1024)} MiB`}</p>
                      <p>{t`Memory samples: ${operations.memory.samples} of ${operations.memory.attempts}; largest gap: ${display(operations.memory.maximumObservationGapMs, 1000)} seconds`}</p>
                      <p><Trans>This is sampled summed RSS for the replay coordinator and its workers. Shared pages may be counted more than once; short peaks between observations may be missed.</Trans></p>
                    </div>
                  )
                : null}
              <p>{t`Job time through publication preparation: ${display(operations.wallMs, 1000)} seconds`}</p>
              <p>{t`Ingestion samples: ${operations.ingestion.samples} of ${operations.ingestion.checks} admission checks`}</p>
              <p>{t`Largest observed ingestion age: ${display(operations.ingestion.maximumObservedAgeMs, 1000)} seconds`}</p>
              <p>{t`Largest observation gap: ${display(operations.ingestion.maximumObservationGapMs, 1000)} seconds`}</p>
              {!operations.ingestion.allChecksMeasured ? <p><Trans>Some health evidence is unavailable or changed qualification during execution.</Trans></p> : null}
              <p><Trans>Health was sampled at admission checks, normally five seconds apart. Unobserved intervals are not continuous health measurements.</Trans></p>
            </div>
          )
        : null}
    </section>
  )
}
