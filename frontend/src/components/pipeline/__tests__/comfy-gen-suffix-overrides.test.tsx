import { describe, expect, test, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'

// The section is a CollapsibleSection (closed by default) — open it to assert fields.
async function openSection() {
  const header = await screen.findByText('Workflow-Specific Overrides')
  fireEvent.click(header)
}

const pipelineMocks = vi.hoisted(() => ({
  pipeline: { blocks: [] as Array<{ id: string; type: string }> },
}))

// Mutable parse-workflow response — each test sets the detection arrays the
// block's mount-time parse will populate state from.
const parseResponse = vi.hoisted(() => ({ value: { ok: true } as Record<string, unknown> }))

vi.mock('@/lib/pipeline/pipeline-context', () => ({
  usePipeline: () => ({
    pipeline: pipelineMocks.pipeline,
    addBlock: vi.fn(),
    resetRuntimeFromBlock: vi.fn(),
    setBlockSource: vi.fn(),
    getUpstreamProducers: vi.fn(() => []),
    getUpstreamProducerValues: vi.fn(() => []),
    setBlockSourceMode: vi.fn(),
    setBlockSourceSelection: vi.fn(),
  }),
}))

vi.mock('@/lib/pipeline/block-bindings', () => ({
  MANUAL_SOURCE: '__manual__',
  useBlockBindings: () => ({ get: () => ({ sourceOptions: [], value: '', setValue: vi.fn() }) }),
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

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
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
  pipelineMocks.pipeline.blocks = [{ id: 'b1', type: 'comfyGen' }]
  parseResponse.value = { ok: true }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url.includes('parse-workflow') ? parseResponse.value : { ok: true }
    return new Response(JSON.stringify(body), { status: 200 })
  }))
  sessionStorage.setItem('block_b1_workflow', JSON.stringify(JSON.stringify({ '1': { class_type: 'SaveImage' } })))
})

describe('ComfyGen _ComfyGen suffix overrides', () => {
  test('renders a Workflow-Specific Overrides field per detected entry, type-correct', async () => {
    const overrides = [
      { node_id: '5', field: 'value', label: 'Steps', type: 'int', current_value: 8 },
      { node_id: '6', field: 'value', label: 'Caption', type: 'string', current_value: 'hi' },
    ]
    // Seed state + echo through the parse mock so the mount-parse doesn't wipe it.
    sessionStorage.setItem('block_b1_comfygen_overrides', JSON.stringify(overrides))
    parseResponse.value = { ok: true, comfygen_overrides: overrides }

    renderBlock()
    await openSection()

    const stepsLabel = await screen.findByText('Steps')
    const intInput = within(stepsLabel.closest('div')!.parentElement!).getByRole('spinbutton')
    expect(intInput).toHaveValue(8)
    expect(screen.getByDisplayValue('hi')).toBeInTheDocument()
  })

  test('float field allows decimals (step=any); int restricts to whole (step=1)', async () => {
    const overrides = [
      // a whole-number float (e.g. ModelSamplingSD3.shift=5) must still accept decimals
      { node_id: '7', field: 'shift', label: 'LowShift', type: 'float', current_value: 5 },
      { node_id: '8', field: 'value', label: 'Steps', type: 'int', current_value: 20 },
    ]
    sessionStorage.setItem('block_b1_comfygen_overrides', JSON.stringify(overrides))
    parseResponse.value = { ok: true, comfygen_overrides: overrides }

    renderBlock()
    await openSection()

    const floatInput = within((await screen.findByText('LowShift')).closest('div')!.parentElement!).getByRole('spinbutton')
    expect(floatInput).toHaveAttribute('step', 'any')
    const intInput = within((await screen.findByText('Steps')).closest('div')!.parentElement!).getByRole('spinbutton')
    expect(intInput).toHaveAttribute('step', '1')
  })

  test('refreshes a stale persisted int type to float from the backend on mount', async () => {
    // User's exact situation: the block was detected BEFORE the typing fix, so
    // sessionStorage holds type:int; the backend now returns type:float. The
    // mount re-parse must overwrite the stale persisted type.
    const stale = [{ node_id: '7', field: 'shift', label: 'LowShift', type: 'int', current_value: 5 }]
    const fresh = [{ node_id: '7', field: 'shift', label: 'LowShift', type: 'float', current_value: 5 }]
    sessionStorage.setItem('block_b1_comfygen_overrides', JSON.stringify(stale))
    parseResponse.value = { ok: true, comfygen_overrides: fresh }

    renderBlock()
    await openSection()

    const input = within((await screen.findByText('LowShift')).closest('div')!.parentElement!).getByRole('spinbutton')
    await waitFor(() => expect(input).toHaveAttribute('step', 'any'))
  })

  test('hides a field already driven by another panel (KSampler steps), keeps siblings', async () => {
    const ksamplers = [{ node_id: '9', class_type: 'KSampler' }]
    const overrides = [
      { node_id: '9', field: 'steps', label: 'Sampler · steps', type: 'int', current_value: 20 },
      { node_id: '9', field: 'custom_knob', label: 'Sampler · custom_knob', type: 'int', current_value: 3 },
    ]
    sessionStorage.setItem('block_b1_ksamplers', JSON.stringify(ksamplers))
    sessionStorage.setItem('block_b1_comfygen_overrides', JSON.stringify(overrides))
    parseResponse.value = { ok: true, ksamplers, comfygen_overrides: overrides }

    renderBlock()
    await openSection()

    expect(await screen.findByText('Sampler · custom_knob')).toBeInTheDocument()
    expect(screen.queryByText('Sampler · steps')).not.toBeInTheDocument()
  })

  test('no section when there are no detected overrides', async () => {
    renderBlock()
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.queryByText('Workflow-Specific Overrides')).not.toBeInTheDocument()
  })
})
