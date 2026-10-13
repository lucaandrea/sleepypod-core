import type { StageObjectivePolicy } from '../../stage-objective'
export const stageObjectiveTestPolicy: StageObjectivePolicy = { version: 'stage-objective-v1', qualificationId: 'test-only', minimumNights: 3,
  minimumPairedDurationMsPerNight: 800, minimumOutputCoverage: 0.9, maximumLostOutputFraction: 0.1,
  minimumAgreementImprovement: 0.125, maximumNightAgreementRegression: 0.125, maximumRegressedNightFraction: 0.34,
  maximumMacroF1Regression: 0.125, maximumStageF1Regression: 0.125, minimumStageReferenceMsPerNight: 200,
  requiredStages: ['wake', 'light', 'deep', 'rem'], operational: { maximumWallMs: 1000, maximumPeakRssBytes: 1000, maximumIngestionAgeMs: 1000 } }
