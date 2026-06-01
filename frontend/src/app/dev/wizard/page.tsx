/**
 * sgs-ui-5nn: hidden dev-only wizard preview.
 *
 * Renders <ComfyGenWizard> with optional window.fetch scenario handlers.
 * The live-backend scenario passes through to the real backend; mocked
 * scenarios let the wizard's failure paths be exercised without touching
 * real RunPod / R2 / preset registry.
 *
 * Gated to NODE_ENV !== 'production' — a prod build returns 404.
 */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { notFound, useRouter, useSearchParams } from 'next/navigation'

import { ComfyGenWizard } from '@/components/wizard/comfygen-wizard'
import {
  buildHandler,
  SCENARIO_LABELS,
  type Scenario,
} from '@/lib/dev-wizard-mocks/scenarios'

const SCENARIO_IDS = Object.keys(SCENARIO_LABELS) as Scenario[]

export default function DevWizardPage() {
  if (process.env.NODE_ENV === 'production') notFound()

  const router = useRouter()
  const params = useSearchParams()
  const initialScenario = (params.get('scenario') as Scenario | null) ?? 'live-backend'
  const [scenario, setScenario] = useState<Scenario>(
    SCENARIO_IDS.includes(initialScenario as Scenario) ? initialScenario : 'live-backend',
  )
  const [wizardKey, setWizardKey] = useState(0)
  const [wizardOpen, setWizardOpen] = useState(true)

  // Install the fetch interceptor whenever the scenario changes.
  useEffect(() => {
    const original = window.fetch
    const handler = buildHandler(scenario)
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input.toString(), init)
      const url = new URL(req.url, window.location.origin)
      try {
        const handled = await handler(req, url)
        if (handled) return handled
      } catch (err) {
        console.error('[dev-wizard] mock handler threw', err)
      }
      return original(input, init)
    }) as typeof window.fetch

    return () => {
      window.fetch = original
    }
  }, [scenario])

  const onScenarioChange = (next: Scenario) => {
    setScenario(next)
    router.replace(`/dev/wizard?scenario=${encodeURIComponent(next)}`, { scroll: false })
    setWizardKey((k) => k + 1) // remount wizard for fresh state
    setWizardOpen(true)
  }

  const heading = useMemo(() => SCENARIO_LABELS[scenario], [scenario])

  return (
    <main className="p-6 max-w-3xl mx-auto space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Dev wizard preview</h1>
        <p className="text-xs text-muted-foreground">
          Hidden dev-only route (404 in production builds). Live backend uses
          your real Settings credentials and live RunPod / R2 / preset registry
          calls. Mocked scenarios remain available for failure-path testing.
        </p>
      </header>

      <section className="rounded-lg border border-border/50 p-4 space-y-3 bg-card/40">
        <label htmlFor="scenario" className="block text-sm font-medium">
          Scenario
        </label>
        <select
          id="scenario"
          value={scenario}
          onChange={(e) => onScenarioChange(e.target.value as Scenario)}
          className="rounded border border-border bg-background px-3 py-1.5 text-sm w-full"
        >
          {SCENARIO_IDS.map((id) => (
            <option key={id} value={id}>
              {SCENARIO_LABELS[id]}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{heading}</p>
        {scenario === 'live-backend' && (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
            Live mode calls the real backend. Loading recommendations is read-only,
            but continuing through Provision creates real RunPod resources.
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setWizardKey((k) => k + 1)
              setWizardOpen(true)
            }}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground"
          >
            Reset wizard
          </button>
          {!wizardOpen && (
            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              className="px-3 py-1.5 text-xs rounded border border-border"
            >
              Open wizard
            </button>
          )}
        </div>
      </section>

      {wizardOpen && (
        <ComfyGenWizard
          key={wizardKey}
          onClose={() => setWizardOpen(false)}
        />
      )}

      <section className="rounded-lg border border-border/50 p-4 text-xs text-muted-foreground space-y-1 bg-card/40">
        <div className="font-medium text-foreground">Notes</div>
        <div>
          The supply-constraint scenario triggers the GPU fallback prompt after a
          short delay; choose Use GPU fallback to see the happy path resume.
        </div>
        <div>
          Reset wizard re-mounts the modal with fresh state (clears tier selection,
          install progress, etc.) without reloading the page.
        </div>
      </section>
    </main>
  )
}
