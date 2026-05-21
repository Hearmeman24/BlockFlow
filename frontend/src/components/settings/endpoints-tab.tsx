'use client'

import { useCallback, useEffect, useState } from 'react'

import { listEndpoints, wizardTeardown, type EndpointRecord, type WizardTeardownResult } from '@/lib/settings/client'

import { ComfyGenWizard } from '@/components/wizard/comfygen-wizard'

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

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <div className="space-y-4">
      {ENDPOINT_DEFINITIONS.map((def) => (
        <EndpointRow
          key={def.type}
          definition={def}
          record={byType.get(def.type) ?? null}
          loaded={loaded}
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
          onClose={() => setWizardOpen(null)}
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
      <Modal title="Nothing to tear down" onClose={onClose}>
        <p className="text-sm text-muted-foreground">No ComfyGen endpoint is configured.</p>
      </Modal>
    )
  }

  if (result) {
    return (
      <Modal title="Teardown complete" onClose={onComplete}>
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
        <button
          type="button"
          onClick={onComplete}
          className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground"
        >
          Done
        </button>
      </Modal>
    )
  }

  return (
    <Modal title="Tear down ComfyGen endpoint?" onClose={busy ? () => {} : onClose}>
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
        <button
          type="button"
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
          className="px-3 py-1.5 text-xs rounded bg-destructive text-destructive-foreground disabled:opacity-50"
        >
          {busy ? 'Tearing down…' : 'Tear down'}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="px-3 py-1.5 text-xs rounded border border-border disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </Modal>
  )
}

function TrainerTeardownPlaceholder({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Trainer teardown" onClose={onClose}>
      <p className="text-sm text-muted-foreground">
        Trainer endpoint teardown ships alongside sgs-ui-wisp-las.5 (trainer image publish).
      </p>
      <button
        type="button"
        onClick={onClose}
        className="px-3 py-1.5 text-xs rounded border border-border"
      >
        Close
      </button>
    </Modal>
  )
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border/50 rounded-lg shadow-xl max-w-md w-full">
        <header className="flex items-center justify-between p-4 border-b border-border/50">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </header>
        <div className="p-5 space-y-3">{children}</div>
      </div>
    </div>
  )
}

function TrainerWizardPlaceholder({ onClose }: { onClose: () => void }) {
  // Trainer wizard scaffolding — deferred per .2 scope narrowing.
  // Mounts the same modal shell so the Set Up button feels live, but tells
  // the user the trainer flow ships alongside .5 (trainer image publish).
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border/50 rounded-lg shadow-xl max-w-md w-full p-6 space-y-3">
        <h2 className="text-lg font-semibold">AIO Trainer wizard</h2>
        <p className="text-sm text-muted-foreground">
          Trainer setup ships alongside sgs-ui-wisp-las.5 (trainer image publish).
          For now, the ComfyGen wizard is the only working setup flow.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-xs rounded border border-border"
        >
          Close
        </button>
      </div>
    </div>
  )
}

interface RowProps {
  definition: { type: EndpointType; label: string; description: string }
  record: EndpointRecord | null
  loaded: boolean
  onSetUp: () => void
  onTearDown: () => void
  onRecreate: () => void
}

function EndpointRow({ definition, record, loaded, onSetUp, onTearDown, onRecreate }: RowProps) {
  const configured = record !== null

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
        <button
          type="button"
          onClick={onSetUp}
          disabled={configured}
          title={configured ? 'Already configured — tear down to reset' : 'Launch the setup wizard'}
          className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Set up
        </button>
        <button
          type="button"
          onClick={onTearDown}
          disabled={!configured}
          title={
            configured
              ? 'Drain workers, delete endpoint + template + volume'
              : 'Nothing to tear down'
          }
          className="px-3 py-1.5 text-xs rounded border border-destructive/50 text-destructive hover:bg-destructive/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Tear down
        </button>
        <button
          type="button"
          onClick={onRecreate}
          disabled={!configured}
          title={
            configured
              ? 'Tear down + re-launch setup wizard'
              : 'Nothing to recreate'
          }
          className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Recreate
        </button>
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
