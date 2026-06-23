import { describe, expect, test, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// sgs-ui-67rq: Power Lora Loader (rgthree) support.
// Tests assert the ACTUAL submitted run-body (intercept fetch to /run), not just render.

type ExecuteFn = (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

const pipelineMocks = vi.hoisted(() => ({
  pipeline: {
    blocks: [] as Array<{ id: string; type: string }>,
  },
}))

// Mutable parse-workflow response.
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

// The LoRAs section is a CollapsibleSection — click its header to expand.
async function openLorasSection() {
  const header = await screen.findByText('LoRAs')
  const btn = header.closest('button')
  if (btn) fireEvent.click(btn)
  else fireEvent.click(header)
}

// Fixture: a Power Lora Loader node with lora_1 + lora_2
const POWER_LORA_NODES = [
  {
    node_id: '1083',
    lora_key: 'lora_1',
    class_type: 'Power Lora Loader (rgthree)',
    label: 'Segment 3 High LoRAs',
    lora_name: 'oral-insertion-high.safetensors',
    strength_model: 1,
    on: true,
    is_power: true,
    chain_id: 0,
  },
  {
    node_id: '1083',
    lora_key: 'lora_2',
    class_type: 'Power Lora Loader (rgthree)',
    label: 'Segment 3 High LoRAs',
    lora_name: 'smash-cut.safetensors',
    strength_model: 1,
    on: false,
    is_power: true,
    chain_id: 0,
  },
]

// Fixture: a regular LoRA node alongside the power node
const REGULAR_LORA_NODE = {
  node_id: '881',
  class_type: 'LoraLoaderModelOnly',
  label: 'Base Distill',
  lora_name: 'base_distill.safetensors',
  strength_model: 1,
  chain_id: 1,
}

// Minimal workflow that parses OK (just a non-empty dict)
const WORKFLOW_JSON = JSON.stringify({ '1': { class_type: 'SaveImage' } })

function setupFetchMock() {
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    if (typeof url === 'string' && url.includes('parse-workflow')) {
      return new Response(JSON.stringify(parseResponse.value), { status: 200 })
    }
    if (typeof url === 'string' && url.includes('/run')) {
      return new Response(JSON.stringify({ ok: true, job_id: 'job-123' }), { status: 200 })
    }
    if (typeof url === 'string' && url.includes('/status/')) {
      return new Response(JSON.stringify({
        job: { job_id: 'job-123', status: 'COMPLETED', local_image_url: '/outputs/out.png' },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderBlock() {
  const Component = blockDef.component
  let capturedExecute: ExecuteFn | null = null
  render(
    <Component
      blockId="b1" inputs={{}} setOutput={vi.fn()} registerExecute={(fn: ExecuteFn) => { capturedExecute = fn }}
      setStatusMessage={vi.fn()} setExecutionStatus={vi.fn()} setOutputHint={vi.fn()}
      setHeaderActions={vi.fn()}
    />,
  )
  return { getExecute: () => capturedExecute }
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.clearAllMocks()
  pipelineMocks.pipeline.blocks = [{ id: 'b1', type: 'comfyGen' }]
  parseResponse.value = { ok: true }
  sessionStorage.setItem('block_b1_workflow', JSON.stringify(WORKFLOW_JSON))
})

describe('ComfyGen Power Lora Loader — render', () => {
  test('power node with lora_1 + lora_2 renders two rows under LoRAs section', async () => {
    parseResponse.value = { ok: true, lora_nodes: POWER_LORA_NODES }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(POWER_LORA_NODES))
    setupFetchMock()

    renderBlock()
    await openLorasSection()

    // Both lora names appear as row labels / inputs
    expect(await screen.findByDisplayValue('oral-insertion-high.safetensors')).toBeInTheDocument()
    expect(screen.getByDisplayValue('smash-cut.safetensors')).toBeInTheDocument()
  })

  test('regular LoRA row renders alongside power rows', async () => {
    const loraNodes = [REGULAR_LORA_NODE, ...POWER_LORA_NODES]
    parseResponse.value = { ok: true, lora_nodes: loraNodes }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(loraNodes))
    setupFetchMock()

    renderBlock()
    await openLorasSection()

    expect(await screen.findByDisplayValue('base_distill.safetensors')).toBeInTheDocument()
    expect(screen.getByDisplayValue('oral-insertion-high.safetensors')).toBeInTheDocument()
  })
})

describe('ComfyGen Power Lora Loader — run-body wiring', () => {
  test('submitted run body includes power_lora_overrides for power rows', async () => {
    parseResponse.value = { ok: true, lora_nodes: POWER_LORA_NODES }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(POWER_LORA_NODES))
    const fetchMock = setupFetchMock()

    const { getExecute } = renderBlock()
    await waitFor(() => expect(getExecute()).toBeTypeOf('function'))

    const execute = getExecute()!
    await execute({}, new AbortController().signal)

    const runCall = fetchMock.mock.calls.find((args) => String(args[0]).includes('/run'))
    expect(runCall).toBeTruthy()
    const body = JSON.parse((runCall![1] as RequestInit).body as string)
    expect(body.power_lora_overrides).toBeDefined()
    expect(Array.isArray(body.power_lora_overrides)).toBe(true)
    expect(body.power_lora_overrides.length).toBe(2)
  })

  test('power_lora_overrides entries include node_id, lora_key, on, lora, strength', async () => {
    parseResponse.value = { ok: true, lora_nodes: POWER_LORA_NODES }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(POWER_LORA_NODES))
    const fetchMock = setupFetchMock()

    const { getExecute } = renderBlock()
    await waitFor(() => expect(getExecute()).toBeTypeOf('function'))

    await getExecute()!({}, new AbortController().signal)

    const runCall = fetchMock.mock.calls.find((args) => String(args[0]).includes('/run'))!
    const body = JSON.parse(runCall[1]!.body as string)
    const entry1 = body.power_lora_overrides.find((e: { lora_key: string }) => e.lora_key === 'lora_1')
    expect(entry1).toBeDefined()
    expect(entry1.node_id).toBe('1083')
    expect(entry1.lora_key).toBe('lora_1')
    expect(entry1.on).toBe(true)
    expect(entry1.lora).toBe('oral-insertion-high.safetensors')
    expect(typeof entry1.strength).toBe('number')
  })

  test('power row on:false in detection → on:false in submitted power_lora_overrides', async () => {
    parseResponse.value = { ok: true, lora_nodes: POWER_LORA_NODES }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(POWER_LORA_NODES))
    const fetchMock = setupFetchMock()

    const { getExecute } = renderBlock()
    await waitFor(() => expect(getExecute()).toBeTypeOf('function'))

    await getExecute()!({}, new AbortController().signal)

    const runCall = fetchMock.mock.calls.find((args) => String(args[0]).includes('/run'))!
    const body = JSON.parse(runCall[1]!.body as string)
    const entry2 = body.power_lora_overrides.find((e: { lora_key: string }) => e.lora_key === 'lora_2')
    expect(entry2.on).toBe(false)
  })

  test('disabling a power row submits on:false in power_lora_overrides, NOT in bypass_loras', async () => {
    // lora_1 starts on:true; user toggles it off.
    const loraNodes = [POWER_LORA_NODES[0]]  // just lora_1, on:true
    parseResponse.value = { ok: true, lora_nodes: loraNodes }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(loraNodes))
    const fetchMock = setupFetchMock()

    const { getExecute } = renderBlock()
    await openLorasSection()

    // Find and click the enable toggle for lora_1
    const toggles = await screen.findAllByRole('button', { name: /disable lora/i })
    expect(toggles.length).toBeGreaterThan(0)
    fireEvent.click(toggles[0])

    await waitFor(() => expect(getExecute()).toBeTypeOf('function'))
    await getExecute()!({}, new AbortController().signal)

    const runCall = fetchMock.mock.calls.find((args) => String(args[0]).includes('/run'))!
    const body = JSON.parse(runCall[1]!.body as string)

    // Must NOT be in bypass_loras
    expect(body.bypass_loras ?? []).not.toContain('1083')
    // Must be in power_lora_overrides with on:false
    const entry = body.power_lora_overrides?.find((e: { lora_key: string }) => e.lora_key === 'lora_1')
    expect(entry?.on).toBe(false)
  })

  test('power rows are NOT routed through the overrides map', async () => {
    parseResponse.value = { ok: true, lora_nodes: POWER_LORA_NODES }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(POWER_LORA_NODES))
    const fetchMock = setupFetchMock()

    const { getExecute } = renderBlock()
    await waitFor(() => expect(getExecute()).toBeTypeOf('function'))

    await getExecute()!({}, new AbortController().signal)

    const runCall = fetchMock.mock.calls.find((args) => String(args[0]).includes('/run'))!
    const body = JSON.parse(runCall[1]!.body as string)
    const overrides: Record<string, string> = body.overrides ?? {}
    // No key should reference a power lora node via the flat override path
    const powerKeys = Object.keys(overrides).filter((k) => k.startsWith('1083.'))
    expect(powerKeys).toHaveLength(0)
  })

  test('regular LoRA row still wires through overrides/bypass_loras, not power_lora_overrides', async () => {
    const loraNodes = [REGULAR_LORA_NODE]
    parseResponse.value = { ok: true, lora_nodes: loraNodes }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(loraNodes))
    const fetchMock = setupFetchMock()

    const { getExecute } = renderBlock()
    await waitFor(() => expect(getExecute()).toBeTypeOf('function'))

    await getExecute()!({}, new AbortController().signal)

    const runCall = fetchMock.mock.calls.find((args) => String(args[0]).includes('/run'))!
    const body = JSON.parse(runCall[1]!.body as string)
    // Regular lora goes through the overrides map (lora_name key)
    const overrides: Record<string, string> = body.overrides ?? {}
    expect(overrides['881.lora_name']).toBe('base_distill.safetensors')
    // power_lora_overrides should be empty or absent for purely regular nodes
    expect((body.power_lora_overrides ?? []).length).toBe(0)
  })
})

describe('ComfyGen Power Lora Loader — add LoRA', () => {
  test('Add LoRA on a power node appends a row with add:true in the run body', async () => {
    const loraNodes = [POWER_LORA_NODES[0]]  // just lora_1
    parseResponse.value = { ok: true, lora_nodes: loraNodes }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(loraNodes))
    const fetchMock = setupFetchMock()

    const { getExecute } = renderBlock()
    await openLorasSection()

    // Click the "Add LoRA" button
    const addBtn = await screen.findByText(/add lora/i, { selector: 'button, [role="button"], span' })
    // Click the button ancestor if we got a span
    const addTarget = addBtn.closest('button') ?? addBtn
    fireEvent.click(addTarget)

    await waitFor(() => expect(getExecute()).toBeTypeOf('function'))
    await getExecute()!({}, new AbortController().signal)

    const runCall = fetchMock.mock.calls.find((args) => String(args[0]).includes('/run'))!
    const body = JSON.parse(runCall[1]!.body as string)
    const addedEntry = body.power_lora_overrides?.find((e: { add?: boolean }) => e.add === true)
    expect(addedEntry).toBeDefined()
    expect(addedEntry.node_id).toBe('1083')
  })

  // Bug: the added power row rendered a free-text <Input> instead of the LoRA
  // dropdown the existing power rows use. With LoRAs available, the new row must
  // be a combobox, never a free-text field.
  test('added power LoRA row renders the LoRA dropdown, not a free-text input', async () => {
    const loraNodes = [POWER_LORA_NODES[0]]  // just lora_1
    parseResponse.value = { ok: true, lora_nodes: loraNodes }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(loraNodes))
    // Make availableLoras non-empty so the dropdown branch is exercised.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('parse-workflow')) {
        return new Response(JSON.stringify(parseResponse.value), { status: 200 })
      }
      if (typeof url === 'string' && url.includes('/api/blocks/comfy_gen/cache')) {
        return new Response(JSON.stringify({ ok: true, loras: ['alpha.safetensors', 'beta.safetensors'] }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))

    renderBlock()
    await openLorasSection()

    // Existing power row becomes a combobox once availableLoras loads.
    await waitFor(() => expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(1))
    const before = screen.getAllByRole('combobox').length

    const addBtn = await screen.findByText(/add lora/i, { selector: 'button, [role="button"], span' })
    fireEvent.click(addBtn.closest('button') ?? addBtn)

    // The added row must be a dropdown (one more combobox), not a free-text input.
    await waitFor(() => expect(screen.getAllByRole('combobox').length).toBe(before + 1))
    expect(screen.queryByPlaceholderText('Pick a LoRA...')).toBeNull()
  })
})
