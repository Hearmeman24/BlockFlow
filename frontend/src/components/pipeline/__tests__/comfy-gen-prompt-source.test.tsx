import { describe, expect, test, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { registerBlockDef } from '@/lib/pipeline/registry'

const pipelineMocks = vi.hoisted(() => ({
  setBlockSource: vi.fn(),
  getUpstreamProducers: vi.fn(() => []),
  getUpstreamProducerValues: vi.fn(() => [] as Array<{ blockId: string; blockIndex: number; blockLabel: string; value: unknown }>),
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
    getUpstreamProducerValues: pipelineMocks.getUpstreamProducerValues,
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
  // Each writer carries its own resolved prompt text, addressable by blockId.
  pipelineMocks.getUpstreamProducerValues.mockReturnValue([
    { blockId: 'w1', blockIndex: 0, blockLabel: 'Prompt Writer (OpenRouter)', value: 'PROMPT FROM WRITER ONE' },
    { blockId: 'w5', blockIndex: 4, blockLabel: 'I2V Prompt Writer (OpenRouter)', value: 'PROMPT FROM WRITER FIVE' },
  ])
  // The parse-workflow effect overwrites text_overrides from its response; echo
  // the segment nodes back so detection keeps both segments (otherwise the empty
  // default response clears them and the panel races to render).
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url.includes('parse-workflow')
      ? { ok: true, text_overrides: TEXT_OVERRIDES }
      : { ok: true }
    return new Response(JSON.stringify(body), { status: 200 })
  }))
  sessionStorage.setItem('block_b1_text_overrides', JSON.stringify(TEXT_OVERRIDES))
  sessionStorage.setItem('block_b1_workflow', JSON.stringify(JSON.stringify({ '1': { class_type: 'SaveImage' } })))
})

describe('ComfyGen segment prompt source selection', () => {
  test('each segment resolves its own chosen writer — two segments, two sources', async () => {
    sessionStorage.setItem('block_b1_text_upstream', JSON.stringify({ '6.text': true, '7.text': true }))
    // Segment 1 ← writer 1, Segment 2 ← writer 5. The bug was that one shared
    // block.sources['prompt'] collapsed both to a single source.
    sessionStorage.setItem('block_b1_text_field_source', JSON.stringify({ '6.text': 'w1', '7.text': 'w5' }))

    renderBlock()

    // Each segment shows a distinct "From X" label AND its own writer's text.
    expect(await screen.findByText(/From 1\. Prompt Writer \(OpenRouter\)/)).toBeInTheDocument()
    expect(screen.getByText(/From 5\. I2V Prompt Writer/)).toBeInTheDocument()
    expect(screen.getByText('PROMPT FROM WRITER ONE')).toBeInTheDocument()
    expect(screen.getByText('PROMPT FROM WRITER FIVE')).toBeInTheDocument()
  })

  test('unset segments default to the closest upstream writer (last producer)', async () => {
    sessionStorage.setItem('block_b1_text_upstream', JSON.stringify({ '6.text': true, '7.text': true }))
    // No per-field source set → both default to the last writer (w5), mirroring
    // pipeline resolveInput. This is the pre-selection baseline, not a collapse.

    renderBlock()

    const fromLabels = await screen.findAllByText(/From 5\. I2V Prompt Writer/)
    expect(fromLabels.length).toBe(2)
    expect(screen.queryByText(/From 1\. Prompt Writer \(OpenRouter\)/)).not.toBeInTheDocument()
  })

  test('selecting a writer for one segment does not change the other', async () => {
    sessionStorage.setItem('block_b1_text_upstream', JSON.stringify({ '6.text': true, '7.text': true }))
    // Segment 1 explicitly w1; Segment 2 left at default (w5).
    sessionStorage.setItem('block_b1_text_field_source', JSON.stringify({ '6.text': 'w1' }))

    renderBlock()

    expect(await screen.findByText(/From 1\. Prompt Writer \(OpenRouter\)/)).toBeInTheDocument()
    expect(screen.getByText(/From 5\. I2V Prompt Writer/)).toBeInTheDocument()
    // The shared block-level source must not be written anymore.
    expect(pipelineMocks.setBlockSource).not.toHaveBeenCalled()
  })
})
