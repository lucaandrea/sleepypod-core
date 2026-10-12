'use client'

import { useState } from 'react'
import { z } from 'zod'
import { Trans, useLingui } from '@lingui/react/macro'
import { stageClassifierSchema, type StageRuleset } from '@/src/lib/sleep-stage-rules'
import { CandidateStageFields } from './CandidateStageFields'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, Skeleton } from '@/src/components/ds'

const parameterSchema = z.object({ type: z.enum(['number', 'integer']), minimum: z.number(), maximum: z.number(), default: z.number(), unit: z.string(), description: z.string() })
const numericManifestSchema = z.object({ defaults: z.object({ sleep_stages: stageClassifierSchema }), parameters: z.object({ properties: z.object({
  heart_rate: z.object({ properties: z.record(z.string(), parameterSchema) }),
  breathing_rate: z.object({ properties: z.record(z.string(), parameterSchema) }),
  hrv_index: z.object({ properties: z.record(z.string(), parameterSchema) }),
}) }) })
type Overrides = { path: string, value: unknown }[]
type Parameter = z.infer<typeof parameterSchema> & { path: string }

export function ProfileCandidateEditor({ side, revisionId }: { side: 'left' | 'right', revisionId?: string }) {
  const manifest = trpc.biometricTuning.getManifest.useQuery({})
  const overview = trpc.biometricTuning.getProfileOverview.useQuery({ side })
  const parentId = revisionId ?? overview.data?.desired.binding.desiredRevisionId
  const parent = trpc.biometricTuning.getProfileRevision.useQuery({ id: parentId ?? '00000000-0000-0000-0000-000000000000' }, { enabled: Boolean(parentId) })
  const error = manifest.error ?? overview.error ?? (parentId ? parent.error : null)
  if (error) return <InlineError>{error.message}</InlineError>
  if (!manifest.data || !overview.data || (parentId && !parent.data)) return <Skeleton className="h-48" />
  const parsed = numericManifestSchema.safeParse(manifest.data.manifest)
  const overrides = z.array(z.object({ path: z.string(), value: z.unknown() })).safeParse(parentId ? parent.data?.overrides : [])
  if (!parsed.success || !overrides.success || (!revisionId && overview.data.desired.warning) || (parentId && (parent.data?.side !== side || parent.data.baseManifestHash !== manifest.data.manifestHash))) return <InlineError><Trans>The saved profile or parameter definitions are incompatible with this editor.</Trans></InlineError>
  const parameters = Object.entries(parsed.data.parameters.properties).flatMap(([component, group]) => Object.entries(group.properties).map(([name, spec]) => ({ ...spec, path: `${component}.${name}` })))
  return <CandidateForm key={`${side}:${manifest.data.manifestHash}:${parentId ?? 'default'}`} side={side} manifestHash={manifest.data.manifestHash} parentId={parentId ?? undefined} initial={overrides.data} parameters={parameters} stageDefaults={parsed.data.defaults.sleep_stages.ruleset} />
}

function CandidateForm({ side, manifestHash, parentId, initial, parameters, stageDefaults }: { side: 'left' | 'right', manifestHash: string, parentId?: string, initial: Overrides, parameters: Parameter[], stageDefaults: StageRuleset }) {
  const { t } = useLingui()
  const [overrides, setOverrides] = useState<Overrides>(initial)
  const [preview, setPreview] = useState<{ hash: string, overrides: Overrides, key: string }>()
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState<string>()
  const resolve = trpc.biometricTuning.resolveProfile.useMutation()
  const create = trpc.biometricTuning.createProfileRevision.useMutation()
  const utils = trpc.useUtils()
  const busy = resolve.isPending || create.isPending
  function change(path: string, value: unknown) {
    setOverrides(current => [...current.filter(item => item.path !== path), ...(value === undefined ? [] : [{ path, value }])])
    setPreview(undefined)
    setSaved(undefined)
    setError(undefined)
  }
  const stageDraft = structuredClone(stageDefaults)
  stageOverrides: for (const override of overrides) {
    if (!override.path.startsWith('sleep_stages.ruleset.')) continue
    const parts = override.path.slice('sleep_stages.ruleset.'.length).split('.')
    let node = stageDraft as unknown as Record<string, unknown>
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(node, part) || node[part] === null || typeof node[part] !== 'object' || Array.isArray(node[part])) continue stageOverrides
      node = node[part] as Record<string, unknown>
    }
    const leaf = parts[parts.length - 1]
    if (Object.hasOwn(node, leaf)) node[leaf] = override.value
  }
  async function inspect() {
    setError(undefined)
    try {
      const result = await resolve.mutateAsync({ overrides, baseManifestHash: manifestHash })
      setPreview({ hash: result.hash, overrides: result.overrides, key: Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('') })
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : t`Profile resolution failed.`) }
  }
  async function save() {
    if (!preview) return
    setError(undefined)
    try {
      const result = await create.mutateAsync({ side, baseManifestHash: manifestHash, ...(parentId === undefined ? {} : { parentRevisionId: parentId }), overrides: preview.overrides, origin: 'manual', requester: 'web-calibration', idempotencyKey: preview.key })
      setSaved(result.id)
      setPreview(undefined)
      void utils.biometricTuning.listProfileRevisions.invalidate()
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : t`Candidate save failed.`) }
  }
  return (
    <Card className="space-y-4">
      <CardHeader title={<Trans>Candidate parameters</Trans>} subtitle={<Trans>Save a candidate for evaluation. This does not change live processing.</Trans>} />
      <p className="text-sm text-fg-2"><Trans>Start from the saved profile. Existing sleep-stage overrides are preserved. Removing a numerical override follows the shipped default.</Trans></p>
      <fieldset disabled={busy} className="space-y-4">
        {parameters.map((parameter) => {
          const override = overrides.find(item => item.path === parameter.path)
          const original = initial.find(item => item.path === parameter.path)?.value ?? parameter.default
          return (
            <div key={parameter.path} className="space-y-1">
              <label className="block">
                <span className="font-medium">{parameter.path}</span>
                <input className="ml-2 rounded border p-2" type="number" min={parameter.minimum} max={parameter.maximum} step={parameter.type === 'integer' ? 1 : 'any'} value={typeof override?.value === 'number' ? Number.isFinite(override.value) ? override.value : '' : parameter.default} onChange={event => change(parameter.path, event.target.value === '' ? Number.NaN : Number(event.target.value))} />
              </label>
              <p className="text-sm">{parameter.description}</p>
              <p className="text-sm text-fg-2">{t`Unit: ${parameter.unit}; range: ${parameter.minimum}–${parameter.maximum}; default: ${parameter.default}; original: ${String(original)}`}</p>
              <p>{override ? <Trans>Overridden</Trans> : <Trans>Inherited default</Trans>}</p>
              {override ? <Button onClick={() => change(parameter.path, undefined)}><Trans>Remove override</Trans></Button> : null}
            </div>
          )
        })}
        <CandidateStageFields ruleset={stageDraft} overrides={overrides} onChange={change} />
      </fieldset>
      <Button disabled={busy || overrides.some(item => typeof item.value === 'number' && !Number.isFinite(item.value))} onClick={() => void inspect()}><Trans>Review candidate</Trans></Button>
      {preview
        ? (
            <div className="space-y-2">
              <p><Trans>Schema checks passed. Agreement with reference measurements has not been evaluated.</Trans></p>
              <p className="break-all font-mono text-xs">{preview.hash}</p>
              <Button disabled={busy} onClick={() => void save()}><Trans>Save candidate without applying</Trans></Button>
            </div>
          )
        : null}
      {error ? <InlineError>{error}</InlineError> : null}
      {saved ? <p role="status">{t`Candidate saved: ${saved}`}</p> : null}
    </Card>
  )
}
