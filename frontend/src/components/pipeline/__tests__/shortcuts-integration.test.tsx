import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, act, screen, waitFor, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { ShortcutPrefsProvider } from '@/lib/settings/shortcuts-client'
import { BlockLayoutProvider } from '@/lib/pipeline/block-layout-context'
import { registerBlockDef } from '@/lib/pipeline/registry'
import { PipelineView } from '../pipeline-view'

beforeAll(() => {
  // Two stub block types: a "source" with output, and a "sink" that accepts it.
  registerBlockDef({
    type: 'src_77x',
    label: 'Source',
    description: 'Source stub',
    size: 'sm',
    inputs: [],
    outputs: [{ name: 'out', kind: 'image' }],
    canStart: true,
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])

  registerBlockDef({
    type: 'sink_77x',
    label: 'Sink',
    description: 'Sink stub',
    size: 'sm',
    inputs: [{ name: 'in', kind: 'image', required: true }],
    outputs: [],
    canStart: false,
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
})

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', { status: 200 }),
  )
})

const TAB_ID = 'integration-test-77x'

function Seeder({ ids }: { ids: string[] }) {
  // Imperatively seed blocks on mount via the real provider API.
  const { pipeline, addBlock } = usePipeline()
  if (pipeline.blocks.length === 0) {
    for (const _ of ids) addBlock('src_77x')
  }
  return null
}

function Probe({ onReady }: { onReady: (api: ReturnType<typeof usePipeline>) => void }) {
  const api = usePipeline()
  onReady(api)
  return null
}

function renderApp(probeRef: (api: ReturnType<typeof usePipeline>) => void) {
  return render(
    <PipelineTabsProvider>
      <PipelineProvider tabId={TAB_ID}>
        <ShortcutPrefsProvider>
          <BlockLayoutProvider>
            <Seeder ids={['a', 'b']} />
            <Probe onReady={probeRef} />
            <PipelineView />
          </BlockLayoutProvider>
        </ShortcutPrefsProvider>
      </PipelineProvider>
    </PipelineTabsProvider>,
  )
}

describe('Shortcuts integration (sgs-ui-77x)', () => {
  it('select → A → picker opens → Enter → block inserted → selection follows', async () => {
    let api!: ReturnType<typeof usePipeline>
    renderApp((next) => {
      api = next
    })

    // Wait for seeded blocks to settle.
    await waitFor(() => expect(api.pipeline.blocks.length).toBeGreaterThan(0))
    const firstBlockId = api.pipeline.blocks[0].id

    // Select first block.
    act(() => api.setSelectedBlockId(firstBlockId))
    expect(api.selectedBlockId).toBe(firstBlockId)

    // Press 'A' on document — opens picker.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A' }))
    })

    await waitFor(() => expect(screen.getByLabelText('Search blocks')).toBeTruthy())

    // Enter selects the highlighted (first) item.
    const input = screen.getByLabelText('Search blocks') as HTMLInputElement
    const blocksBefore = api.pipeline.blocks.length
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    await waitFor(() => expect(api.pipeline.blocks.length).toBe(blocksBefore + 1))
    // Newly-inserted block should be selected.
    const newBlock = api.pipeline.blocks[1]
    expect(api.selectedBlockId).toBe(newBlock.id)
  })

  it('Escape clears selection at the canvas level', async () => {
    let api!: ReturnType<typeof usePipeline>
    renderApp((next) => {
      api = next
    })
    await waitFor(() => expect(api.pipeline.blocks.length).toBeGreaterThan(0))
    act(() => api.setSelectedBlockId(api.pipeline.blocks[0].id))
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    )
    await waitFor(() => expect(api.selectedBlockId).toBeNull())
  })
})
