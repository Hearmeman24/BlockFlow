'use client'

import { usePipeline } from '@/lib/pipeline/pipeline-context'
import { getStarterTypes } from '@/lib/pipeline/registry'
import { PipelineStartDot } from './block-connector'
import { AddBlockButton } from './add-block-button'
import { ChainRenderer } from './chain-renderer'
import { PannableCanvas } from './pannable-canvas'

function EmptyPipelineState({ onAdd }: { onAdd: (type: string) => void }) {
  const starters = getStarterTypes()

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-24 px-8">
      <div className="text-center space-y-2">
        <h2 className="text-lg font-medium text-foreground">Build your pipeline</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Add your first block to get started. Chain blocks together to create generation workflows.
        </p>
      </div>
      <div className="relative">
        <div className="absolute -inset-3 rounded-full bg-blue-500/10 animate-pulse pointer-events-none" />
        <AddBlockButton validTypes={starters} onAdd={onAdd} />
      </div>
    </div>
  )
}

export function PipelineView() {
  const { pipeline, addBlock } = usePipeline()
  const blocks = pipeline.blocks

  if (blocks.length === 0) {
    return (
      <PannableCanvas>
        <EmptyPipelineState onAdd={(type) => addBlock(type)} />
      </PannableCanvas>
    )
  }

  return (
    <PannableCanvas>
      <div className="flex items-center gap-0 px-8 py-8 min-w-max">
        <PipelineStartDot />
        <ChainRenderer
          chain={blocks}
          numberingPrefix=""
          ancestors={[]}
          isTrunk
        />
      </div>
    </PannableCanvas>
  )
}
