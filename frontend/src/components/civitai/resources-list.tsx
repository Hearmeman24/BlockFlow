'use client'

import type { GateResolvedRow, GateManualResource } from './approval-gate'

/**
 * Grouped, categorised view of "what resources will be linked on this
 * CivitAI post". Used by both the live pipeline block's gate and the
 * artifacts-page modal so they look identical.
 *
 * Grouping is by CivitAI `model.type` ("Checkpoint" / "LORA" / "Workflows" /
 * etc). LoRA-family types (LORA, LoCon, LyCORIS) collapse into one
 * "LoRAs" bucket because that's how the user thinks of them. Resources
 * whose hash didn't resolve to anything on CivitAI fall into an "Unknown"
 * bucket so they don't silently disappear.
 *
 * Manual links are always grouped together as "Manual links" regardless of
 * type — they came from a different place (user paste), and lumping them
 * with auto-detected entries would obscure their origin.
 */

interface ResourcesListProps {
  resolved: GateResolvedRow[]
  manualResources: GateManualResource[]
}

interface Group {
  label: string
  /** Sort key — used to keep checkpoint above LoRAs above workflows. */
  order: number
}

const TYPE_GROUPS: Record<string, Group> = {
  checkpoint: { label: 'Checkpoints', order: 0 },
  lora: { label: 'LoRAs', order: 1 },
  locon: { label: 'LoRAs', order: 1 },
  lycoris: { label: 'LoRAs', order: 1 },
  textualinversion: { label: 'Textual Inversions', order: 2 },
  hypernetwork: { label: 'Hypernetworks', order: 3 },
  controlnet: { label: 'ControlNets', order: 4 },
  vae: { label: 'VAEs', order: 5 },
  workflows: { label: 'Workflows', order: 6 },
  poses: { label: 'Poses', order: 7 },
  aestheticgradient: { label: 'Aesthetic Gradients', order: 8 },
}

const UNKNOWN_GROUP: Group = { label: 'Unknown', order: 99 }

function groupOf(row: GateResolvedRow): Group {
  if (!row.resolved) return UNKNOWN_GROUP
  const key = (row.type || '').toLowerCase()
  return TYPE_GROUPS[key] ?? { label: row.type || 'Other', order: 50 }
}

function ResourceRow({ row }: { row: GateResolvedRow }) {
  const baseType = (row.type || '').toLowerCase()
  const isLoraFamily = baseType === 'lora' || baseType === 'locon' || baseType === 'lycoris'
  // The right-side label is just the strength for LoRA-family entries —
  // the type is already shown as the section header above, no need to
  // repeat it on every row.
  const trailing = isLoraFamily && row.strength !== undefined ? `@ ${row.strength}` : null

  return (
    <div className="flex items-center justify-between rounded border border-border/40 px-1.5 py-0.5">
      <span
        className={`text-[10px] flex-1 min-w-0 break-all ${
          row.resolved ? 'text-foreground' : 'text-yellow-500 italic'
        }`}
      >
        {row.resolved ? (
          <>
            {row.name}
            {row.versionName && row.versionName !== row.name && (
              <span className="text-muted-foreground"> ({row.versionName})</span>
            )}
          </>
        ) : (
          `${row.filename} — Unknown, not on CivitAI`
        )}
      </span>
      {trailing && (
        <span className="text-[9px] text-muted-foreground ml-2 shrink-0">{trailing}</span>
      )}
    </div>
  )
}

function ManualRow({ row }: { row: GateManualResource }) {
  return (
    <div className="flex items-center justify-between rounded border border-border/40 px-1.5 py-0.5">
      <span className="text-[10px] flex-1 min-w-0 break-all">
        {row.name || `v${row.modelVersionId}`}
        {row.versionName && row.versionName !== row.name && (
          <span className="text-muted-foreground"> ({row.versionName})</span>
        )}
      </span>
      {row.type && (
        <span className="text-[9px] text-muted-foreground ml-2 shrink-0">{row.type}</span>
      )}
    </div>
  )
}

export function ResourcesList({ resolved, manualResources }: ResourcesListProps) {
  if (resolved.length === 0 && manualResources.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground italic">No resources detected</p>
    )
  }

  // Bucket resolved rows by category. Preserves the order rows came in
  // within each bucket — caller has already sorted by detection order,
  // which matches the user's mental model (the base checkpoint first,
  // then LoRAs in the order they appeared on the load chain).
  const buckets = new Map<string, { group: Group; rows: GateResolvedRow[] }>()
  for (const row of resolved) {
    const group = groupOf(row)
    const existing = buckets.get(group.label)
    if (existing) existing.rows.push(row)
    else buckets.set(group.label, { group, rows: [row] })
  }

  const ordered = Array.from(buckets.values()).sort((a, b) => a.group.order - b.group.order)

  return (
    <div className="space-y-1.5">
      {ordered.map(({ group, rows }) => (
        <div key={group.label} className="space-y-0.5">
          <p className="text-[10px] font-medium text-muted-foreground">{group.label}</p>
          {rows.map((row, i) => (
            <ResourceRow key={`${row.sha256}-${i}`} row={row} />
          ))}
        </div>
      ))}
      {manualResources.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[10px] font-medium text-muted-foreground">Manual links</p>
          {manualResources.map((row) => (
            <ManualRow key={row.modelVersionId} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}
