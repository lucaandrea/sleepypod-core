'use client'

import { Trans, useLingui } from '@lingui/react/macro'
import { trpc } from '@/src/utils/trpc'
import { Card, CardHeader, InlineError, SettingRow, Skeleton } from '@/src/components/ds'
import { SectionColumns } from '@/src/components/Settings/SettingsLayout'

export function CalibrationOverview({ side }: { side: 'left' | 'right' }) {
  const { t } = useLingui()
  const overview = trpc.biometricTuning.getProfileOverview.useQuery({ side }, { refetchInterval: 5000 })
  const activation = trpc.biometricTuning.getActivationStatus.useQuery({ side }, { refetchInterval: 5000 })
  if (overview.error) return <InlineError>{overview.error.message}</InlineError>
  if (!overview.data) return <Skeleton className="h-64" />
  const data = overview.data
  const states: Record<string, string> = { unreported: t`Not reported`, current: t`Current`, stale: t`Stale`, failed: t`Failed`,
    mixed_generations: t`Different versions reported`, clock_skew: t`Clock mismatch`, pending_delivery: t`Waiting for delivery`,
    pending_boundary: t`Waiting for a processing boundary`, applied: t`Applied` }
  const components: Record<string, string> = { heart_rate: t`Heart rate`, breathing_rate: t`Breathing rate`, hrv_index: t`HRV index` }
  return (
    <SectionColumns
      left={(
        <>
          <Card className="space-y-3">
            <CardHeader title={<Trans>Profile and processor</Trans>} subtitle={<Trans>Saved settings and processor reports are separate.</Trans>} />
            <SettingRow label={<Trans>Saved profile</Trans>}><span>{data.desired.isDefault ? <Trans>System defaults</Trans> : <Trans>Personalized profile</Trans>}</span></SettingRow>
            <SettingRow label={<Trans>Requested change</Trans>}><span>{activation.data ? states[activation.data.observedState] : t`Not reported`}</span></SettingRow>
            <SettingRow label={<Trans>Processor health</Trans>}><span>{states[data.runtimeHealth.state]}</span></SettingRow>
            {activation.error ? <InlineError>{activation.error.message}</InlineError> : null}
            {data.desired.warning ? <p role="status" className="text-sm text-fg-2">{data.desired.warning}</p> : null}
            {data.runtimeHealth.components.map(component => (
              <SettingRow key={component.component} label={components[component.component] ?? component.component}>
                <span>{states[component.state]}</span>
              </SettingRow>
            ))}
            <details className="text-sm">
              <summary className="cursor-pointer"><Trans>Configuration identity</Trans></summary>
              <p className="mt-2 break-all font-mono text-xs">{data.desired.hash}</p>
              <p>
                {t`Generation ${data.desired.binding.generation}`}
              </p>
            </details>
          </Card>
          <Card className="space-y-3">
            <CardHeader title={<Trans>What these metrics mean</Trans>} />
            <p className="text-sm text-fg-2"><Trans>The HRV index measures window IBI variability. It is not clinical beat-to-beat RMSSD, and incompatible reference metrics cannot validate it.</Trans></p>
            <p className="text-sm text-fg-2"><Trans>Historical sleep stages are recomputed with the current classifier. Original stored vitals remain separate from replay results.</Trans></p>
            {data.stageView.provenance.warning ? <p role="status" className="text-sm">{data.stageView.provenance.warning}</p> : null}
          </Card>
        </>
      )}
      right={(
        <Card className="space-y-3">
          <CardHeader title={<Trans>Measured sensor calibration</Trans>} subtitle={<Trans>Sensor measurements are separate from algorithm personalization.</Trans>} />
          {data.sensorCalibration.length === 0
            ? <p className="text-sm text-fg-2"><Trans>No sensor calibration has been reported for this side.</Trans></p>
            : data.sensorCalibration.map(sensor => (
                <SettingRow key={sensor.id} label={sensor.sensorType} sub={sensor.status}>
                  <span>{sensor.freshness === 'current' ? t`Current` : sensor.freshness === 'expired' ? t`Expired` : t`Freshness unknown`}</span>
                </SettingRow>
              ))}
          {data.limitations.map(limitation => <p key={limitation} className="text-sm text-fg-2">{limitation}</p>)}
        </Card>
      )}
    />
  )
}
