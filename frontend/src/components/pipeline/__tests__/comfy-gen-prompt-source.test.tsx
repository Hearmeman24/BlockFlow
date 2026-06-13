import { describe, expect, test, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { registerBlockDef } from '@/lib/pipeline/registry'

const pipelineMocks = vi.hoisted(() => ({
  setBlockSource: vi.fn(),
  getUpstreamProducers: vi.fn(() => []),
  pipeline: {
    blocks: [] as Array<{ id: string; type: string; sources?: Record<string, string> }>,
  },
}))

const bindingMocks = vi.hoisted(() => ({
  sourceOptions: [] as Array<{ value: string; label: string }>,
}))

vi.mock('@/lib/pipeline/pipeline-context', () => ({
  usePipeline: () => ({
    pipeline: pipelineMocks.pipeline,
    addBlock: vi.fn(),
    resetRuntimeFromBlock: vi.fn(),
    setBlockSource: pipelineMocks.setBlockSource,
    getUpstreamProducers: pipelineMocks.getUpstreamProducers,
    setBlockSourceMode: vi.fn(),
    setBlockSourceSelection: vi.fn(),
  }),
}))

vi.mock('@/lib/pipeline/block-bindings', () => ({
  MANUAL_SOURCE: '__manual__',
  useBlockBindings: () => ({
    get: () => ({ sourceOptions: bindingMocks.sourceOptions, value: '', setValue: vi.fn() }),
  }),
}))

vi.mock('@/lib/settings/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings/client')>()
  return {
    ...actual,
    getEndpoint: vi.fn(async () => ({ endpoint_id: 'ep' })),
    listInstalledPresets: vi.fn(async () => []),
    getInstalledPreset: vi.fn(async () => null),
  }
})

import { blockDef } from '../custom_blocks/generated/comfy_gen'

const WRITER_1 = { value: 'w1', label: '1. Prompt Writer (OpenRouter)' }
const WRITER_5 = { value: 'w5', label: '5. I2V Prompt Writer (OpenRouter)' }

const TEXT_OVERRIDES = [
  { node_id: '6', input_name: 'text', current_value: '', label: 'Segment 1 Prompt' },
  { node_id: '7', input_name: 'text', current_value: '', label: 'Segment 2 Prompt' },
]

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
  registerBlockDef({
    type: 'promptWriter', label: 'Prompt Writer (OpenRouter)', description: 'p', size: 'sm',
    inputs: [], outputs: [{ name: 'prompt', kind: 'text' }], canStart: true, component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
  registerBlockDef({
    type: 'i2vPromptWriter', label: 'I2V Prompt Writer (OpenRouter)', description: 'p', size: 'sm',
    inputs: [], outputs: [{ name: 'prompt', kind: 'text' }], canStart: true, component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
})

function renderBlock() {
  const Component = blockDef.component
  return render(
    <Component
      blockId="b1" inputs={{}} setOutput={vi.fn()} registerExecute={vi.fn()}
      setStatusMessage={vi.fn()} setExecutionStatus={vi.fn()} setOutputHint={vi.fn()}
      setHeaderActions={vi.fn()}
    />,
  )
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.clearAllMocks()
  bindingMocks.sourceOptions = [{ value: '__manual__', label: 'Manual' }, WRITER_1, WRITER_5]
  pipelineMocks.pipeline.blocks = [
    { id: 'w1', type: 'promptWriter' },
    { id: 'w5', type: 'i2vPromptWriter' },
    { id: 'b1', type: 'comfyGen' },
  ]
  pipelineMocks.getUpstreamProducers.mockReturnValue([])
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })))
  sessionStorage.setItem('block_b1_text_overrides', JSON.stringify(TEXT_OVERRIDES))
  sessionStorage.setItem('block_b1_workflow', JSON.stringify(JSON.stringify({ '1': { class_type: 'SaveImage' } })))
})

describe('ComfyGen segment prompt source selection', () => {
  test('reflects the explicitly chosen writer (not always the first) for upstream segments', async () => {
    // Both segments upstream-bound; block source = the SECOND writer.
    sessionStorage.setItem('block_b1_text_upstream', JSON.stringify({ '6.text': true, '7.text': true }))
    pipelineMocks.pipeline.blocks = [
      { id: 'w1', type: 'promptWriter' },
      { id: 'w5', type: 'i2vPromptWriter' },
      { id: 'b1', type: 'comfyGen', sources: { prompt: 'w5' } },
    ]

    renderBlock()

    const fromLabels = await screen.findAllByText(/From .*I2V Prompt Writer/)
    expect(fromLabels.length).toBe(2)
    // The buggy version hardcoded the first writer's label.
    expect(screen.queryByText(/From 1\. Prompt Writer \(OpenRouter\)/)).not.toBeInTheDocument()
  })

  test('reflects the first writer when it is the chosen source (writers are independently selectable)', async () => {
    // Mirror case: block source = the FIRST writer. Before the fix both writers
    // collapsed to one value, so the second could never be distinguished from
    // the first; now each resolves to its own label.
    sessionStorage.setItem('block_b1_text_upstream', JSON.stringify({ '6.text': true, '7.text': true }))
    pipelineMocks.pipeline.blocks = [
      { id: 'w1', type: 'promptWriter' },
      { id: 'w5', type: 'i2vPromptWriter' },
      { id: 'b1', type: 'comfyGen', sources: { prompt: 'w1' } },
    ]

    renderBlock()

    const fromLabels = await screen.findAllByText(/From 1\. Prompt Writer \(OpenRouter\)/)
    expect(fromLabels.length).toBe(2)
    expect(screen.queryByText(/From .*I2V Prompt Writer/)).not.toBeInTheDocument()
  })

})
