'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  listEndpoints,
  wizardPreflight,
  wizardTeardown,
  type EndpointRecord,
  type WizardPreflight,
  type WizardTeardownResult,
} from '@/lib/settings/client'

import { ComfyGenWizard } from '@/components/wizard/comfygen-wizard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type EndpointType = 'comfygen' | 'aio_trainer'

const ENDPOINT_DEFINITIONS: { type: EndpointType; label: string; description: string }[] = [
  {
    type: 'comfygen',
    label: 'ComfyGen',
    description: 'Serverless ComfyUI worker for all generation flows.',
  },
  {
    type: 'aio_trainer',
    label: 'AIO LoRA Trainer',
    description: 'Serverless LoRA training worker (multi-GPU capable).',
  },
]

export function EndpointsTab() {
  const [byType, setByType] = useState<Map<EndpointType, EndpointRecord>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const [wizardOpen, setWizardOpen] = useState<EndpointType | null>(null)
  const [teardownTarget, setTeardownTarget] = useState<EndpointType | null>(null)
  const [recreateAfterTeardown, setRecreateAfterTeardown] = useState(false)
  // sgs-ui-5nn: gate Set up / Recreate on wizard preflight readiness so
  // users can't launch the wizard when their credentials are missing or
  // unvalidated.
  const [preflight, setPreflight] = useState<WizardPreflight | null>(null)

  const refresh = useCallback(() => {
    listEndpoints()
      .then((records) => {
        const m = new Map<EndpointType, EndpointRecord>()
        for (const r of records) {
          if (r.type === 'comfygen' || r.type === 'aio_trainer') {
            m.set(r.type as EndpointType, r)
          }
        }
        setByType(m)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  const refreshPreflight = useCallback(() => {
    wizardPreflight()
      .then(setPreflight)
      .catch(() => setPreflight({ ready: false, missing: [], services: {} }))
  }, [])

  useEffect(() => {
    refresh()
    refreshPreflight()
  }, [refresh, refreshPreflight])

  return (
    <div className="space-y-4">
      {ENDPOINT_DEFINITIONS.map((def) => (
        <EndpointRow
          key={def.type}
          definition={def}
          record={byType.get(def.type) ?? null}
          loaded={loaded}
          preflight={preflight}
          onSetUp={() => setWizardOpen(def.type)}
          onTearDown={() => {
            setTeardownTarget(def.type)
            setRecreateAfterTeardown(false)
          }}
          onRecreate={() => {
            setTeardownTarget(def.type)
            setRecreateAfterTeardown(true)
          }}
        />
      ))}

      {wizardOpen === 'comfygen' && (
        <ComfyGenWizard
          onClose={() => {
            setWizardOpen(null)
            // Refresh preflight after the wizard closes — the user may have
            // re-validated credentials inside it.
            refreshPreflight()
          }}
          onSuccess={() => {
            refresh()
          }}
        />
      )}

      {wizardOpen === 'aio_trainer' && (
        <TrainerWizardPlaceholder onClose={() => setWizardOpen(null)} />
      )}

      {teardownTarget === 'comfygen' && (
        <TeardownConfirmDialog
          record={byType.get('comfygen') ?? null}
          onClose={() => {
            setTeardownTarget(null)
            setRecreateAfterTeardown(false)
          }}
          onComplete={() => {
            refresh()
            setTeardownTarget(null)
            if (recreateAfterTeardown) {
              setWizardOpen('comfygen')
            }
            setRecreateAfterTeardown(false)
          }}
        />
      )}

      {teardownTarget === 'aio_trainer' && (
        <TrainerTeardownPlaceholder onClose={() => {
          setTeardownTarget(null)
          setRecreateAfterTeardown(false)
        }} />
      )}
    </div>
  )
}

function TeardownConfirmDialog({
  record,
  onClose,
  onComplete,
}: {
  record: EndpointRecord | null
  onClose: () => void
  onComplete: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<WizardTeardownResult | null>(null)

  if (!record) {
    // Defensive — caller only opens this when configured, but guard anyway
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nothing to tear down</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">No ComfyGen endpoint is configured.</p>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Close</Button>
        </DialogContent>
      </Dialog>
    )
  }

  if (result) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onComplete() }}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <DialogTitle>Teardown complete</DialogTitle>
          </DialogHeader>
          <p className="text-sm">Cleaned up:</p>
          <ul className="text-xs font-mono space-y-0.5 pl-3">
            <li>endpoint <span className="text-emerald-400">{result.deleted.endpoint_id}</span></li>
            {result.deleted.template_name && (
              <li>template <span className="text-emerald-400">{result.deleted.template_name}</span></li>
            )}
            {result.deleted.volume_id && (
              <li>volume <span className="text-emerald-400">{result.deleted.volume_id}</span></li>
            )}
          </ul>
          {result.warnings.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-amber-400">Warnings:</p>
              <ul className="text-xs space-y-0.5 pl-3">
                {result.warnings.map((w) => (
                  <li key={w} className="text-amber-300/80">{w}</li>
                ))}
              </ul>
            </div>
          )}
          <Button
            type="button"
            size="sm"
            onClick={onComplete}
          >
            Close teardown
          </Button>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Tear down ComfyGen endpoint?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This will drain workers and delete the following RunPod resources:
        </p>
        <ul className="text-xs font-mono space-y-0.5 pl-3">
          <li>endpoint <span className="text-destructive">{record.endpoint_id}</span></li>
          {record.template_name && (
            <li>template <span className="text-destructive">{record.template_name}</span></li>
          )}
          {record.volume_id && (
            <li>volume <span className="text-destructive">{record.volume_id}</span> ({record.volume_size_gb ?? '?'} GB)</li>
          )}
        </ul>
        <p className="text-xs text-muted-foreground">
          Any models or LoRAs stored on the volume will be permanently lost. The Settings record is removed too.
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                const r = await wizardTeardown()
                setResult(r)
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            }}
            disabled={busy}
          >
            {busy ? 'Tearing down…' : 'Tear down'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TrainerTeardownPlaceholder({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Trainer teardown</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Trainer endpoint teardown ships alongside sgs-ui-wisp-las.5 (trainer image publish).
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </DialogContent>
    </Dialog>
  )
}

function TrainerWizardPlaceholder({ onClose }: { onClose: () => void }) {
  // Trainer wizard scaffolding — deferred per .2 scope narrowing.
  // Mounts the same modal shell so the Set Up button feels live, but tells
  // the user the trainer flow ships alongside .5 (trainer image publish).
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>AIO Trainer wizard</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Trainer setup ships alongside sgs-ui-wisp-las.5 (trainer image publish).
          For now, the ComfyGen wizard is the only working setup flow.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </DialogContent>
    </Dialog>
  )
}

interface RowProps {
  definition: { type: EndpointType; label: string; description: string }
  record: EndpointRecord | null
  loaded: boolean
  preflight: WizardPreflight | null
  onSetUp: () => void
  onTearDown: () => void
  onRecreate: () => void
}

function EndpointRow({ definition, record, loaded, preflight, onSetUp, onTearDown, onRecreate }: RowProps) {
  const configured = record !== null
  const preflightReady = preflight?.ready === true
  const gateOnPreflight = definition.type === 'comfygen'
  const setUpBlocked = configured
  const setUpTitle = configured
    ? 'Already configured — tear down to reset'
    : gateOnPreflight && preflight && !preflightReady
    ? 'Open the setup wizard to review missing credentials'
    : 'Launch the setup wizard'
  const recreateBlocked = !configured || (gateOnPreflight && !preflightReady)
  const recreateTitle = !configured
    ? 'Nothing to recreate'
    : gateOnPreflight && !preflightReady
    ? 'Validate credentials in Settings → Credentials first'
    : 'Tear down + re-launch setup wizard'

  return (
    <article className="rounded-lg border border-border/50 bg-card/40 p-5 space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">{definition.label}</h3>
          <p className="text-xs text-muted-foreground">{definition.description}</p>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            configured ? 'bg-emerald-500/15 text-emerald-400' : 'bg-muted/50 text-muted-foreground'
          }`}
        >
          {loaded ? (configured ? 'Configured' : 'Not configured') : 'Loading…'}
        </span>
      </header>

      {configured && record && (
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <Detail label="Endpoint ID" value={record.endpoint_id} />
          <Detail label="GPU tier" value={record.gpu_tier ?? '—'} />
          <Detail
            label="Volume size"
            value={record.volume_size_gb !== null ? `${record.volume_size_gb} GB` : '—'}
          />
          <Detail
            label="Max workers"
            value={record.max_workers !== null ? String(record.max_workers) : '—'}
          />
          {record.volume_id && <Detail label="Volume ID" value={record.volume_id} />}
          {record.template_id && <Detail label="Template ID" value={record.template_id} />}
          {record.provisioned_at && (
            <Detail
              label="Provisioned"
              value={record.provisioned_at.replace('T', ' ').replace('Z', ' UTC')}
            />
          )}
        </dl>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          onClick={onSetUp}
          disabled={setUpBlocked}
          title={setUpTitle}
        >
          Set up
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onTearDown}
          disabled={!configured}
          title={
            configured
              ? 'Drain workers, delete endpoint + template + volume'
              : 'Nothing to tear down'
          }
          className="border-destructive/50 text-destructive hover:bg-destructive/10"
        >
          Tear down
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRecreate}
          disabled={recreateBlocked}
          title={recreateTitle}
        >
          Recreate
        </Button>
      </div>
    </article>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono break-all">{value}</dd>
    </div>
  )
}
