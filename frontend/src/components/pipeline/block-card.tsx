'use client'

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { BlockStatusBadge } from './block-status-badge'
import {
  bindingRequiresUpstream,
  canonicalizePortKind,
  getBlockComponent,
  getBlockDef,
  getNodeType,
  type NodeSize,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import { useBlockLayout } from '@/lib/pipeline/block-layout-context'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import type { PipelineBlock, IterationState } from '@/lib/pipeline/types'
import type { ComponentType } from 'react'

const SIZE_CLASSES: Record<NodeSize, { width: string; minHeight: string; reducedHeight: string }> = {
  sm:   { width: 'w-[280px]', minHeight: 'min-h-[220px]', reducedHeight: 'h-[220px]' },
  md:   { width: 'w-[360px]', minHeight: 'min-h-[320px]', reducedHeight: 'h-[320px]' },
  lg:   { width: 'w-[440px]', minHeight: 'min-h-[460px]', reducedHeight: 'h-[460px]' },
  huge: { width: 'w-[540px]', minHeight: 'min-h-[580px]', reducedHeight: 'h-[580px]' },
}

const SIZE_BORDER_COLORS: Record<NodeSize, string> = {
  sm:   'border-blue-500/25',
  md:   'border-emerald-500/25',
  lg:   'border-violet-500/25',
  huge: 'border-amber-500/25',
}

interface BlockCardProps {
  block: PipelineBlock
  /** Display number string: "1", "2", "3" for trunk; "3.1.1" for branches. */
  displayNumber: string
}

/**
 * Wrapper that resolves a dynamic component from the registry and renders it.
 * Isolated so the static-components lint rule doesn't flag the parent.
 */
function DynamicBlockContent({
  blockType,
  ...props
}: { blockType: string } & BlockComponentProps) {
  const Comp: ComponentType<BlockComponentProps> | undefined = getBlockComponent(blockType)
  if (!Comp) {
    return <p className="text-sm text-muted-foreground">No component for &quot;{blockType}&quot;</p>
  }
  // eslint-disable-next-line react-hooks/static-components -- intentional dynamic component registry
  return <Comp {...props} />
}

export function BlockCard({ block, displayNumber }: BlockCardProps) {
  const {
    blockStates,
    removeBlock,
    setBlockLabel,
    getInputsForBlock,
    setBlockOutput,
    setBlockStatus,
    setBlockStatusMessage,
    registerBlockExecute,
    isRunning,
    setBlockSource,
    getUpstreamProducers,
    toggleBlockDisabled,
    iterationState,
    setOutputHint,
  } = usePipeline()
  const { mode: blockLayoutMode } = useBlockLayout()

  const def = getNodeType(block.type)
  if (!def) return null
  const blockDef = getBlockDef(block.type)

  const isDisabled = !!block.disabled
  const state = blockStates.get(block.id)
  const status = state?.status ?? 'idle'
  const inputs = getInputsForBlock(block.id)
  const blockIterState = iterationState?.blockId === block.id ? iterationState : null
  const sizeClass = SIZE_CLASSES[def.size]
  const borderColor = SIZE_BORDER_COLORS[def.size]
  const displayLabel = block.label || def.label

  const requiredInputNames = new Set(
    def.inputs
      .filter((port) => port.required !== false)
      .map((port) => port.name),
  )
  for (const binding of blockDef?.bindings ?? []) {
    if (bindingRequiresUpstream(binding)) {
      requiredInputNames.add(binding.input)
    }
  }

  // Build input source info for each port
  const inputSourceInfo = def.inputs.map((port) => {
    const producers = getUpstreamProducers(block.id, canonicalizePortKind(port.kind))
    const isRequired = requiredInputNames.has(port.name)
    const selectedSource = block.sources?.[port.name]
    const isFieldBound = Boolean(blockDef?.bindings?.some((binding) => binding.input === port.name))
    return { port, producers, isRequired, selectedSource, isFieldBound }
  })

  // Hide all source selectors when the block has no required inputs (pass-through pattern like HITL)
  const allInputsOptional = requiredInputNames.size === 0 && def.inputs.length > 0
  const hasSourceUI = !isDisabled && !allInputsOptional && inputSourceInfo.some(
    (info) => !info.isFieldBound && (info.producers.length > 1 || (info.producers.length === 0 && info.isRequired)),
  )

  const isReducedLayout = blockLayoutMode === 'reduced'
  const isExpandedLayout = blockLayoutMode === 'expanded'

  const handleSetOutput = useCallback(
    (portName: string, value: unknown) => {
      setBlockOutput(block.id, portName, value)
    },
    [block.id, setBlockOutput],
  )

  const handleRegisterExecute = useCallback(
    (fn: Parameters<BlockComponentProps['registerExecute']>[0]) => {
      registerBlockExecute(block.id, fn)
    },
    [block.id, registerBlockExecute],
  )

  const handleSetStatusMessage = useCallback(
    (msg: string | undefined) => {
      setBlockStatusMessage(block.id, msg)
    },
    [block.id, setBlockStatusMessage],
  )

  const handleSetExecutionStatus = useCallback(
    (nextStatus: 'idle' | 'running' | 'completed' | 'error' | 'skipped', error?: string) => {
      setBlockStatus(block.id, nextStatus, error)
    },
    [block.id, setBlockStatus],
  )

  const handleSetOutputHint = useCallback(
    (activePortName: string) => {
      setOutputHint(block.id, activePortName)
    },
    [block.id, setOutputHint],
  )

  const [headerActions, setHeaderActions] = useState<ReactNode>(null)

  const cardClasses = isDisabled
    ? `flex flex-col shrink-0 overflow-hidden border-2 border-dashed ${sizeClass.width} ${sizeClass.minHeight} opacity-50 ${borderColor} panningDisabled wheelDisabled`
    : [
        'flex flex-col shrink-0 border-2',
        sizeClass.width,
        sizeClass.minHeight,
        borderColor,
        'panningDisabled wheelDisabled',
        isReducedLayout ? `${sizeClass.reducedHeight} overflow-hidden` : '',
        blockLayoutMode === 'auto' ? 'max-h-[85vh] overflow-hidden' : '',
        isExpandedLayout ? 'overflow-visible' : '',
      ].join(' ')

  const cardContentClasses = isExpandedLayout
    ? 'px-4 pb-3 pt-0 overflow-visible [&_[data-slot=select-trigger]]:w-full [&_[data-slot=select-trigger]]:min-w-0 [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate'
    : 'flex-1 overflow-y-auto overflow-x-hidden px-4 pb-3 pt-0 [&_[data-slot=select-trigger]]:w-full [&_[data-slot=select-trigger]]:min-w-0 [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate'

  return (
    <Card className={cardClasses}>
      <CardHeader className="flex flex-row items-center justify-between py-2.5 px-4 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-muted-foreground font-mono shrink-0">{displayNumber}</span>
          <EditableTitle
            value={displayLabel}
            onChange={(v) => setBlockLabel(block.id, v === def.label ? '' : v)}
            disabled={isRunning || isDisabled}
          />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isDisabled
            ? <BlockStatusBadge status="skipped" />
            : <BlockStatusBadge status={status} statusMessage={state?.statusMessage} />
          }
          {blockIterState && (
            <span className="inline-flex items-center gap-1 rounded bg-purple-500/20 border border-purple-500/30 px-1.5 py-0 text-[10px] text-purple-400 font-medium">
              <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="8" cy="8" r="6" strokeOpacity="0.3" />
                <path d="M8 2a6 6 0 0 1 6 6" strokeLinecap="round" />
              </svg>
              {blockIterState.currentIndex + 1}/{blockIterState.totalCount}
            </span>
          )}
          {headerActions}
          {/* Toggle disable/enable */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => toggleBlockDisabled(block.id)}
            disabled={isRunning}
            title={isDisabled ? 'Enable block' : 'Disable block'}
          >
            {isDisabled ? (
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 8s3-5 6-5 6 5 6 5-3 5-6 5-6-5-6-5z" />
                <circle cx="8" cy="8" r="2" />
                <line x1="2" y1="14" x2="14" y2="2" />
              </svg>
            ) : (
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 8s3-5 6-5 6 5 6 5-3 5-6 5-6-5-6-5z" />
                <circle cx="8" cy="8" r="2" />
              </svg>
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => removeBlock(block.id)}
            disabled={isRunning}
          >
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </Button>
        </div>
      </CardHeader>

      {/* Disabled blocks show nothing below the header */}
      {isDisabled ? (
        <div className="px-4 pb-3">
          <p className="text-xs text-muted-foreground/60 italic">Block disabled — will be skipped during execution</p>
        </div>
      ) : (
        <>
          {/* Input source selectors / missing badges */}
          {hasSourceUI && (
            <div className="mx-4 mb-2 flex flex-wrap gap-1.5">
              {inputSourceInfo.map((info) => {
                if (info.isFieldBound) return null
                // Hide metadata port — always auto-resolves to latest producer
                if (info.port.kind === 'metadata') return null
                // Hide optional ports with only one producer — no choice to make
                if (!info.isRequired && info.producers.length <= 1) return null

                // No producers + required → missing badge
                if (info.producers.length === 0 && info.isRequired) {
                  return (
                    <span
                      key={info.port.name}
                      className="inline-flex items-center gap-1 rounded bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 text-[10px] text-yellow-400"
                    >
                      Missing: {info.port.name}
                    </span>
                  )
                }

                // Multiple producers → dropdown selector
                if (info.producers.length > 1) {
                  const currentValue = info.selectedSource ?? info.producers[info.producers.length - 1].blockId
                  return (
                    <div key={info.port.name} className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">{info.port.name}:</span>
                      <Select
                        value={currentValue}
                        onValueChange={(v) => setBlockSource(block.id, info.port.name, v)}
                      >
                        <SelectTrigger className="h-5 w-auto min-w-[120px] text-[10px] px-2 py-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {info.producers.map((p) => (
                            <SelectItem key={p.blockId} value={p.blockId} className="text-xs">
                              {p.blockIndex + 1}. {p.blockLabel}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )
                }

                return null
              })}
            </div>
          )}

          {status === 'error' && state?.error && (
            <div className="mx-4 mb-2 rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2">
              <p className="text-xs text-red-400">{state.error}</p>
            </div>
          )}

          {blockIterState && <IterationProgressPanel iterState={blockIterState} />}

          <CardContent className={cardContentClasses}>
            <DynamicBlockContent
              blockType={block.type}
              blockId={block.id}
              inputs={inputs}
              setOutput={handleSetOutput}
              registerExecute={handleRegisterExecute}
              setStatusMessage={handleSetStatusMessage}
              setExecutionStatus={handleSetExecutionStatus}
              setOutputHint={handleSetOutputHint}
              setHeaderActions={setHeaderActions}
            />
          </CardContent>
        </>
      )}
    </Card>
  )
}

// ---- Iteration progress panel ----

const ITER_STATUS_ICON: Record<string, { color: string; icon: string }> = {
  pending:   { color: 'text-muted-foreground/50', icon: '○' },
  running:   { color: 'text-blue-400',            icon: '◉' },
  completed: { color: 'text-green-400',           icon: '●' },
  error:     { color: 'text-red-400',             icon: '●' },
  skipped:   { color: 'text-muted-foreground/40', icon: '○' },
}

function IterationProgressPanel({ iterState }: { iterState: IterationState }) {
  const [expanded, setExpanded] = useState(false)
  const completedCount = iterState.items.filter((i) => i.status === 'completed').length
  const errorCount = iterState.items.filter((i) => i.status === 'error').length
  const visibleCount = iterState.currentIndex >= 0
    ? Math.min(iterState.currentIndex + 1, iterState.totalCount)
    : 0
  const progress = Math.round((visibleCount / iterState.totalCount) * 100)

  return (
    <div className="mx-4 mb-2 rounded-md border border-purple-500/20 bg-purple-500/5 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] hover:bg-purple-500/10 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-purple-300 font-medium">
          Iterating: {visibleCount}/{iterState.totalCount}
          {errorCount > 0 && <span className="text-red-400 ml-1">({errorCount} failed)</span>}
        </span>
        <div className="flex items-center gap-2">
          <div className="w-16 h-1 bg-purple-500/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-400 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-muted-foreground">{expanded ? '▾' : '▸'}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-2 max-h-[120px] overflow-y-auto space-y-0.5">
          {iterState.items.map((item) => {
            const cfg = ITER_STATUS_ICON[item.status] ?? ITER_STATUS_ICON.pending
            return (
              <div
                key={item.index}
                className={`flex items-center gap-1.5 text-[10px] ${
                  item.index === iterState.currentIndex ? 'font-medium' : ''
                }`}
              >
                <span className={`${cfg.color} ${item.status === 'running' ? 'animate-pulse' : ''}`}>
                  {cfg.icon}
                </span>
                <span className="truncate flex-1 text-muted-foreground">{item.label}</span>
                {item.error && (
                  <span className="text-red-400 truncate max-w-[120px]" title={item.error}>
                    {item.error}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---- Inline editable title ----

function EditableTitle({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus and select when entering edit mode
  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, [editing])

  const startEditing = useCallback(() => {
    setDraft(value)
    setEditing(true)
  }, [value])

  const commit = useCallback(() => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) {
      onChange(trimmed)
    }
  }, [draft, value, onChange])

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="text-sm font-semibold bg-transparent border-b border-muted-foreground/40 outline-none min-w-0 w-full"
      />
    )
  }

  return (
    <CardTitle
      className="text-sm truncate cursor-pointer hover:text-muted-foreground transition-colors"
      onDoubleClick={() => !disabled && startEditing()}
      title="Double-click to rename"
    >
      {value}
    </CardTitle>
  )
}
