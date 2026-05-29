import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { BlockLayoutProvider } from '@/lib/pipeline/block-layout-context'
import { registerBlockDef } from '@/lib/pipeline/registry'
import { BlockCard } from '../block-card'
import type { PipelineBlock } from '@/lib/pipeline/types'
import { useEffect } from 'react'

beforeAll(() => {
  // Registry is normally populated by predev codegen — seed a minimal stub for tests.
  registerBlockDef({
    type: 'stub_block_77x',
    label: 'Stub',
    description: '',
    size: 'sm',
    inputs: [],
    outputs: [],
    canStart: true,
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
})

const TAB_ID = 'block-card-selection-test'

// Drives selectedBlockId via the same context the card consumes, exposing a
// programmatic way to assert + mutate selection from tests.
function Harness({ block, selectedId }: { block: PipelineBlock; selectedId: string | null }) {
  const { setSelectedBlockId } = usePipeline()
  useEffect(() => {
    setSelectedBlockId(selectedId)
  }, [selectedId, setSelectedBlockId])
  return <BlockCard block={block} displayNumber="1" />
}

function renderWithProviders(block: PipelineBlock, selectedId: string | null) {
  return render(
    <PipelineTabsProvider>
      <PipelineProvider tabId={TAB_ID}>
        <BlockLayoutProvider>
          <Harness block={block} selectedId={selectedId} />
        </BlockLayoutProvider>
      </PipelineProvider>
    </PipelineTabsProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
})

describe('BlockCard selection ring + click-to-select (sgs-ui-77x)', () => {
  const block: PipelineBlock = { id: 'b1', type: 'stub_block_77x' }

  it('renders the selection ring when its id matches selectedBlockId', () => {
    const { container } = renderWithProviders(block, 'b1')
    const ringed = container.querySelector('.ring-2')
    expect(ringed).not.toBeNull()
  })

  it('does NOT render the ring when a different block is selected', () => {
    const { container } = renderWithProviders(block, 'other')
    const ringed = container.querySelector('.ring-2')
    expect(ringed).toBeNull()
  })

  it('clicking the block number badge sets the block as selected', () => {
    const { container } = renderWithProviders(block, null)
    expect(container.querySelector('.ring-2')).toBeNull()
    const badge = screen.getByTestId('block-card-select')
    act(() => {
      badge.click()
    })
    expect(container.querySelector('.ring-2')).not.toBeNull()
  })
})
