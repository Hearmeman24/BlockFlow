import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { PipelineProvider, usePipeline } from './pipeline-context'
import { PipelineTabsProvider } from './tabs-context'
import { exportFlow, importFlow } from './flow-io'
import { registerBlockDef } from './registry'
import type { Pipeline } from './types'

beforeAll(() => {
  registerBlockDef({
    type: 'src_o1q_image',
    label: 'Image Producer',
    description: 'test image producer',
    size: 'sm',
    inputs: [],
    outputs: [{ name: 'image', kind: 'image' }],
    canStart: true,
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])

  registerBlockDef({
    type: 'sink_o1q_image',
    label: 'Image Sink',
    description: 'test image sink',
    size: 'sm',
    inputs: [{ name: 'image', kind: 'image', required: false }],
    outputs: [],
    canStart: false,
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
})

function wrapper({ children }: { children: ReactNode }) {
  return (
    <PipelineTabsProvider>
      <PipelineProvider tabId="source-modes-test">{children}</PipelineProvider>
    </PipelineTabsProvider>
  )
}

function seedThreeBlockPipeline() {
  const { result } = renderHook(() => usePipeline(), { wrapper })
  let first = ''
  let second = ''
  let sink = ''

  act(() => {
    first = result.current.addBlock('src_o1q_image')
    second = result.current.addBlock('src_o1q_image')
    sink = result.current.addBlock('sink_o1q_image')
    result.current.setBlockOutput(first, 'image', 'first.png')
    result.current.setBlockOutput(second, 'image', 'second.png')
  })

  return { result, first, second, sink }
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('pipeline source modes', () => {
  it('resolves the closest upstream producer by default', () => {
    const { result, sink } = seedThreeBlockPipeline()

    expect(result.current.getInputsForBlock(sink).image).toBe('second.png')
  })

  it('resolves all upstream producer values in pipeline order when source mode is all', () => {
    const { result, sink } = seedThreeBlockPipeline()

    act(() => {
      result.current.setBlockSourceMode(sink, 'image', 'all')
    })

    expect(result.current.getInputsForBlock(sink).image).toEqual(['first.png', 'second.png'])
  })

  it('resolves custom selections in selected producer order', () => {
    const { result, first, second, sink } = seedThreeBlockPipeline()

    act(() => {
      result.current.setBlockSourceMode(sink, 'image', 'custom')
      result.current.setBlockSourceSelection(sink, 'image', [second, first])
    })

    expect(result.current.getInputsForBlock(sink).image).toEqual(['second.png', 'first.png'])
  })

  it('does not fall back when a custom-selected producer has not emitted yet', () => {
    const { result, first, second, sink } = seedThreeBlockPipeline()

    act(() => {
      result.current.setBlockOutput(second, 'image', undefined)
      result.current.setBlockSourceMode(sink, 'image', 'custom')
      result.current.setBlockSourceSelection(sink, 'image', [first, second])
    })

    expect(result.current.getInputsForBlock(sink).image).toBeUndefined()
  })

  it('round-trips source modes and source selections through flow IO', () => {
    const pipeline: Pipeline = {
      id: 'source-mode-flow',
      blocks: [
        { id: 'a', type: 'src_o1q_image' },
        { id: 'b', type: 'src_o1q_image' },
        {
          id: 'sink',
          type: 'sink_o1q_image',
          sourceModes: { image: 'custom' },
          sourceSelections: { image: ['a', 'b'] },
        },
      ],
    }

    const saved = exportFlow(pipeline, 'Source Mode Flow')
    expect(saved.blocks[2].source_modes).toEqual({ image: 'custom' })
    expect(saved.blocks[2].source_selections).toEqual({ image: [0, 1] })

    const imported = importFlow(JSON.stringify(saved))
    expect(imported.blocks[2].sourceModes).toEqual({ image: 'custom' })
    expect(imported.blocks[2].sourceSelections?.image).toEqual([
      imported.blocks[0].id,
      imported.blocks[1].id,
    ])
  })
})
