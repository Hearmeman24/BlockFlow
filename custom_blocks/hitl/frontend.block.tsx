'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import {
  PORT_TEXT,
  PORT_VIDEO,
  PORT_IMAGE,
  PORT_LORAS,
  PORT_METADATA,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

type PassDecision = 'continue' | 'stop'
type PassKind = typeof PASS_KIND_ORDER[number]

const PASS_KIND_ORDER = [PORT_VIDEO, PORT_IMAGE, PORT_TEXT, PORT_LORAS, PORT_METADATA] as const

function findNearestKind(getUpstreamProducers: ReturnType<typeof usePipeline>['getUpstreamProducers'], blockId: string): PassKind | null {
  let nearest: { kind: PassKind; index: number } | null = null

  for (const kind of PASS_KIND_ORDER) {
    const producers = getUpstreamProducers(blockId, kind)
    const latest = producers[producers.length - 1]
    if (!latest) continue

    if (!nearest || latest.blockIndex > nearest.index) {
      nearest = { kind, index: latest.blockIndex }
    }
  }

  return nearest?.kind ?? null
}

function HumanInTheLoopBlock({ blockId, inputs, setOutput, registerExecute, setStatusMessage }: BlockComponentProps) {
  const { getUpstreamProducers } = usePipeline()
  const [isWaiting, setIsWaiting] = useState(false)
  const [lastDecision, setLastDecision] = useState<PassDecision | null>(null)
  const decisionResolverRef = useRef<((decision: PassDecision) => void) | null>(null)

  const nearestKind = findNearestKind(getUpstreamProducers, blockId)
  const nearestProducer = nearestKind
    ? (() => {
        const producers = getUpstreamProducers(blockId, nearestKind)
        return producers[producers.length - 1]
      })()
    : null

  const resolveDecision = (decision: PassDecision) => {
    if (!decisionResolverRef.current) return
    const resolve = decisionResolverRef.current
    decisionResolverRef.current = null
    resolve(decision)
  }

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const selectedKind = findNearestKind(getUpstreamProducers, blockId)
      if (!selectedKind) throw new Error('No upstream input found for HITL block')

      const value = freshInputs[selectedKind]
      if (value === undefined) {
        throw new Error(`Missing "${selectedKind}" input`)
      }

      setStatusMessage('Waiting for human decision…')
      setIsWaiting(true)

      const decision = await new Promise<PassDecision>((resolve) => {
        decisionResolverRef.current = resolve
      })

      setIsWaiting(false)
      setLastDecision(decision)

      if (decision === 'stop') {
        setStatusMessage('Stopped by human')
        return { terminateChain: true }
      }

      setStatusMessage('Approved by human')
      // Forward all available upstream data (video, image, metadata, etc.)
      for (const kind of PASS_KIND_ORDER) {
        if (freshInputs[kind] !== undefined) {
          setOutput(kind, freshInputs[kind])
        }
      }
    })
  })

  useEffect(() => {
    return () => {
      if (decisionResolverRef.current) {
        const resolve = decisionResolverRef.current
        decisionResolverRef.current = null
        resolve('stop')
      }
    }
  }, [])

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Human decision (runtime)</p>
        <p className="text-[11px] text-muted-foreground">
          {isWaiting ? 'Continue pipeline with this item?' : 'Run the pipeline to request a decision.'}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={() => resolveDecision('continue')}
            className="h-8 text-xs"
            disabled={!isWaiting}
          >
            Continue
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => resolveDecision('stop')}
            className="h-8 text-xs"
            disabled={!isWaiting}
          >
            Stop
          </Button>
        </div>
      </div>

      <div className="rounded border border-border/50 p-2 space-y-1">
        <p className="text-[11px] text-muted-foreground">Detected upstream item</p>
        {nearestKind && nearestProducer ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px]">
              {nearestKind}
            </Badge>
            <span className="text-[11px] text-muted-foreground">
              from {nearestProducer.blockIndex + 1}. {nearestProducer.blockLabel}
            </span>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">No compatible upstream item yet.</p>
        )}
      </div>

      {lastDecision && !isWaiting && (
        <p className="text-[11px] text-muted-foreground">
          Last decision: <span className="font-medium">{lastDecision}</span>
        </p>
      )}

      {nearestKind && inputs[nearestKind] !== undefined && (
        <p className="text-[11px] text-muted-foreground">
          Current input is ready for runtime review.
        </p>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'hitl',
  label: 'Human-in-the-Loop',
  description: 'Manual continue/stop gate for upstream artifacts',
  size: 'sm',
  canStart: false,
  inputs: [
    { name: PORT_VIDEO, kind: PORT_VIDEO, required: false },
    { name: PORT_IMAGE, kind: PORT_IMAGE, required: false },
    { name: PORT_TEXT, kind: PORT_TEXT, required: false },
    { name: PORT_LORAS, kind: PORT_LORAS, required: false },
    { name: PORT_METADATA, kind: PORT_METADATA, required: false },
  ],
  outputs: [
    { name: PORT_VIDEO, kind: PORT_VIDEO },
    { name: PORT_IMAGE, kind: PORT_IMAGE },
    { name: PORT_TEXT, kind: PORT_TEXT },
    { name: PORT_LORAS, kind: PORT_LORAS },
    { name: PORT_METADATA, kind: PORT_METADATA },
  ],
  configKeys: [],
  component: HumanInTheLoopBlock,
}

