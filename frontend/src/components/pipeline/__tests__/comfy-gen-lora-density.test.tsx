import { describe, expect, test, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Compact LoRAs panel: single-line rows (disabled rows drop the strength slider)
// + per-chain collapse (default-collapse all but the first chain when the panel
// is long, i.e. > 6 total rows).

const pipelineMocks = vi.hoisted(() => ({
  pipeline: { blocks: [] as Array<{ id: string; type: string }> },
}))
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

async function openLorasSection() {
  const header = await screen.findByText('LoRAs')
  const btn = header.closest('button')
  if (btn) fireEvent.click(btn)
  else fireEvent.click(header)
}

const mk = (id: string, name: string, chain: number) => ({
  node_id: id,
  class_type: 'LoraLoaderModelOnly',
  label: `L ${id}`,
  lora_name: name,
  strength_model: 1,
  chain_id: chain,
})

// 7 rows across 3 chains → "dense" (> 6)
const DENSE_NODES = [
  mk('a1', 'la1.safetensors', 0), mk('a2', 'la2.safetensors', 0), mk('a3', 'la3.safetensors', 0),
  mk('b1', 'lb1.safetensors', 1), mk('b2', 'lb2.safetensors', 1),
  mk('c1', 'lc1.safetensors', 2), mk('c2', 'lc2.safetensors', 2),
]

// A power node, lora_1 enabled, lora_2 disabled
const POWER_NODES = [
  { node_id: '1083', lora_key: 'lora_1', class_type: 'Power Lora Loader (rgthree)', label: 'Seg High', lora_name: 'on.safetensors', strength_model: 1, on: true, is_power: true, chain_id: 0 },
  { node_id: '1083', lora_key: 'lora_2', class_type: 'Power Lora Loader (rgthree)', label: 'Seg High', lora_name: 'off.safetensors', strength_model: 1, on: false, is_power: true, chain_id: 0 },
]

const WORKFLOW_JSON = JSON.stringify({ '1': { class_type: 'SaveImage' } })

function setupFetchMock() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('parse-workflow')) {
      return new Response(JSON.stringify(parseResponse.value), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }))
}

function renderBlock() {
  const Component = blockDef.component
  render(
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
  sessionStorage.setItem('block_b1_workflow', JSON.stringify(WORKFLOW_JSON))
})

describe('Compact LoRAs panel — disabled rows drop the slider', () => {
  test('an enabled power row has a strength slider; a disabled one does not', async () => {
    parseResponse.value = { ok: true, lora_nodes: POWER_NODES }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(POWER_NODES))
    setupFetchMock()

    renderBlock()
    await openLorasSection()

    // Both rows present (name inputs render regardless of on/off)
    expect(await screen.findByDisplayValue('on.safetensors')).toBeInTheDocument()
    expect(screen.getByDisplayValue('off.safetensors')).toBeInTheDocument()

    // Only the enabled row contributes a slider (the disabled stub hides it).
    expect(screen.getAllByRole('slider')).toHaveLength(1)
  })
})

describe('Compact LoRAs panel — per-chain collapse when dense', () => {
  test('non-first chains collapse by default and expand on header click', async () => {
    parseResponse.value = { ok: true, lora_nodes: DENSE_NODES }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(DENSE_NODES))
    setupFetchMock()

    renderBlock()
    await openLorasSection()

    // Chain 0 (first) is open by default — its rows render.
    expect(await screen.findByDisplayValue('la1.safetensors')).toBeInTheDocument()
    // Chain 1 / Chain 2 collapsed by default — their rows are NOT in the DOM.
    expect(screen.queryByDisplayValue('lb1.safetensors')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('lc1.safetensors')).not.toBeInTheDocument()

    // Click the "Chain 2" header (chain_id 1) → its rows appear.
    const chain2 = screen.getByText('Chain 2').closest('button')!
    fireEvent.click(chain2)
    await waitFor(() => expect(screen.getByDisplayValue('lb1.safetensors')).toBeInTheDocument())
    // Chain 3 stays collapsed (independent toggle).
    expect(screen.queryByDisplayValue('lc1.safetensors')).not.toBeInTheDocument()
  })

  test('a small panel (<=6 rows) renders all chains expanded', async () => {
    const small = [mk('a1', 'sa.safetensors', 0), mk('b1', 'sb.safetensors', 1)]
    parseResponse.value = { ok: true, lora_nodes: small }
    sessionStorage.setItem('block_b1_lora_nodes', JSON.stringify(small))
    setupFetchMock()

    renderBlock()
    await openLorasSection()

    expect(await screen.findByDisplayValue('sa.safetensors')).toBeInTheDocument()
    // Not dense → second chain open without any click.
    expect(screen.getByDisplayValue('sb.safetensors')).toBeInTheDocument()
  })
})
