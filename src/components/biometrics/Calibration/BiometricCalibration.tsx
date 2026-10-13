'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button, Card } from '@/src/components/ds'
import { SideTabs } from '@/src/components/Settings/SettingsLayout'
import { SleepStageRules } from '@/src/components/Settings/SleepStageRules'
import { CalibrationOverview } from './CalibrationOverview'
import { CalibrationReferences } from './CalibrationReferences'
import { ReferenceLibrary } from './ReferenceLibrary'
import { ProfileLibrary } from './ProfileLibrary'
import { ProfileRecovery } from './ProfileRecovery'
import { CalibrationBacktests } from './CalibrationBacktests'
import { CalibrationHistory } from './CalibrationHistory'
import { ShadowRuns } from './ShadowRuns'

type Side = 'left' | 'right'
export function BiometricCalibration({ side, onSideChange }: { side: Side, onSideChange: (side: Side) => void }) {
  const { t } = useLingui()
  const [view, setView] = useState<'overview' | 'references' | 'backtests' | 'profiles' | 'history' | 'observations'>('overview')
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <SideTabs side={side} onChange={onSideChange} label={t`Biometric calibration`} />
        <nav aria-label={t`Calibration views`} className="flex flex-wrap gap-2">
          <Button aria-pressed={view === 'overview'} onClick={() => setView('overview')}><Trans>Overview</Trans></Button>
          <Button aria-pressed={view === 'references'} onClick={() => setView('references')}><Trans>References</Trans></Button>
          <Button aria-pressed={view === 'profiles'} onClick={() => setView('profiles')}><Trans>Profiles</Trans></Button>
          <Button aria-pressed={view === 'backtests'} onClick={() => setView('backtests')}><Trans>Backtests</Trans></Button>
          <Button aria-pressed={view === 'history'} onClick={() => setView('history')}><Trans>History</Trans></Button>
          <Button aria-pressed={view === 'observations'} onClick={() => setView('observations')}><Trans>Observations</Trans></Button>
        </nav>
      </Card>
      {view === 'overview'
        ? (
            <div key={side} className="space-y-4">
              <CalibrationOverview side={side} />
              <ProfileRecovery side={side} />
            </div>
          )
        : view === 'references'
          ? (
              <div key={side} className="space-y-4">
                <CalibrationReferences side={side} />
                <ReferenceLibrary side={side} />
              </div>
            )
          : view === 'backtests'
            ? <CalibrationBacktests key={side} side={side} />
            : view === 'observations'
              ? <ShadowRuns key={side} side={side} />
              : view === 'history'
                ? <CalibrationHistory key={side} side={side} />
                : (
                    <>
                      <ProfileLibrary key={side} side={side} />
                      <p className="text-sm text-fg-2"><Trans>Direct sleep-stage changes are unvalidated manual settings. Saving requests a profile change; processor adoption is reported separately in Overview.</Trans></p>
                      <SleepStageRules side={side} onSideChange={onSideChange} />
                    </>
                  )}
    </div>
  )
}
