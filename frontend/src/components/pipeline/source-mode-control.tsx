'use client'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import { findBlockById } from '@/lib/pipeline/tree-utils'
import type { PortKind } from '@/lib/pipeline/registry'
import type { SourceMode } from '@/lib/pipeline/types'

interface SourceModeControlProps {
  blockId: string
  inputName: string
  inputKind: PortKind
  label: string
}

function kindLabel(kind: PortKind): string {
  return String(kind)
}

function optionLabel(index: number, label: string): string {
  return `${index + 1}. ${label}`
}

export function SourceModeControl({
  blockId,
  inputName,
  inputKind,
  label,
}: SourceModeControlProps) {
  const {
    pipeline,
    getUpstreamProducers,
    setBlockSourceMode,
    setBlockSourceSelection,
  } = usePipeline()
  const block = findBlockById(pipeline.blocks, blockId)
  const producers = getUpstreamProducers(blockId, inputKind)
  if (producers.length === 0) return null

  const mode = block?.sourceModes?.[inputName] ?? 'closest'
  const selectedIds = block?.sourceSelections?.[inputName] ?? []
  const closest = producers[producers.length - 1]
  const kind = kindLabel(inputKind)

  const triggerText = mode === 'all'
    ? `${label}: all upstream`
    : mode === 'custom'
      ? `${label}: custom`
      : `${label}: closest upstream`

  const setMode = (nextMode: SourceMode) => {
    setBlockSourceMode(blockId, inputName, nextMode)
  }

  const toggleCustomSource = (sourceId: string) => {
    const next = selectedIds.includes(sourceId)
      ? selectedIds.filter((id) => id !== sourceId)
      : [...selectedIds, sourceId]
    setBlockSourceSelection(blockId, inputName, next)
  }

  return (
    <div className="rounded border border-border/60 bg-muted/10 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] text-muted-foreground">
            {producers.length} upstream {kind} producer{producers.length === 1 ? '' : 's'} available
          </p>
          {closest && mode === 'closest' && (
            <p className="text-[10px] text-muted-foreground truncate">
              Closest: {optionLabel(closest.blockIndex, closest.blockLabel)}
            </p>
          )}
          {mode === 'custom' && selectedIds.length === 0 && (
            <p className="text-[10px] text-yellow-500">Custom selection is empty.</p>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 px-2 text-[10px]"
              aria-label={`${label} source mode`}
            >
              {triggerText}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-xs">{label} source mode</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={mode} onValueChange={(value) => setMode(value as SourceMode)}>
              <DropdownMenuRadioItem value="closest" className="text-xs">
                Closest upstream
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="all" className="text-xs">
                All upstream
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="custom" className="text-xs">
                Custom selection
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">Custom producers</DropdownMenuLabel>
            {producers.map((producer) => (
              <DropdownMenuCheckboxItem
                key={producer.blockId}
                checked={selectedIds.includes(producer.blockId)}
                onCheckedChange={() => toggleCustomSource(producer.blockId)}
                onSelect={(event) => event.preventDefault()}
                className="text-xs"
              >
                {optionLabel(producer.blockIndex, producer.blockLabel)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
