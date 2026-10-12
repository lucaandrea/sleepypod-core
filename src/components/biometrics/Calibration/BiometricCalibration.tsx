'use client'

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button, Card } from '@/src/components/ds'
import { SideTabs } from '@/src/components/Settings/SettingsLayout'
import { SleepStageRules } from '@/src/components/Settings/SleepStageRules'
import { CalibrationOverview } from './CalibrationOverview'
import { CalibrationHistory } from './CalibrationHistory'

type Side = 'left' | 'right'
export function BiometricCalibration({ side, onSideChange }: { side: Side, onSideChange: (side: Side) => void }) {
  const { t } = useLingui()
  const [view, setView] = useState<'overview' | 'profiles' | 'history'>('overview')
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <SideTabs side={side} onChange={onSideChange} label={t`Biometric calibration`} />
        <nav aria-label={t`Calibration views`} className="flex flex-wrap gap-2">
          <Button aria-pressed={view === 'overview'} onClick={() => setView('overview')}><Trans>Overview</Trans></Button>
          <Button aria-pressed={view === 'profiles'} onClick={() => setView('profiles')}><Trans>Profiles</Trans></Button>
          <Button aria-pressed={view === 'history'} onClick={() => setView('history')}><Trans>History</Trans></Button>
        </nav>
      </Card>
      {view === 'overview'
        ? <CalibrationOverview side={side} />
        : view === 'history'
          ? <CalibrationHistory key={side} side={side} />
          : (
              <>
                <p className="text-sm text-fg-2"><Trans>Direct sleep-stage changes are unvalidated manual settings. Saving requests a profile change; processor adoption is reported separately in Overview.</Trans></p>
                <SleepStageRules side={side} onSideChange={onSideChange} />
              </>
            )}
    </div>
  )
}
