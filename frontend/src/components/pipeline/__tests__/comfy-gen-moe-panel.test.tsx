import { describe, expect, test, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'

// sgs-ui-8zu: RTL assertions for the MoE Sampler UI slice (Slice C):
//   1. a 4th-position MoE-owned sampler's cfg input still renders despite the
//      first-3 cap (isVisibleSampler relaxes the cap for MoE experts).
//   2. a ClownShark entry's sampler dropdown offers its curated `sampler_options`
//      while a standard KSampler entry offers the global `availableSamplers`.
// Mirrors comfy-gen-prompt-source.test.tsx's mount harness.

const pipelineMocks = vi.hoisted(() => ({
  pipeline: {
    blocks: [] as Array<{ id: string; type: string; sources?: Record<string, string> }>,
  },
}))

vi.mock('@/lib/pipeline/pipeline-context', () => ({
  usePipeline: () => ({
    pipeline: pipelineMocks.pipeline,
    addBlock: vi.fn(),
    resetRuntimeFromBlock: vi.fn(),
    setBlockSource: vi.fn(),
    getUpstreamProducers: vi.fn(() => []),
    setBlockSourceMode: vi.fn(),
    setBlockSourceSelection: vi.fn(),
  }),
}))

vi.mock('@/lib/pipeline/block-bindings', () => ({
  MANUAL_SOURCE: '__manual__',
  useBlockBindings: () => ({
    get: () => ({ sourceOptions: [{ value: '__manual__', label: 'Manual' }], value: '', setValue: vi.fn() }),
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

// Two MoE pairs (4 samplers): T2V pair 401/402 + upscale pair 403/404.
// Sampler #4 (index 3, node 404) is MoE-owned → must stay visible.
const KSAMPLERS = [
  { node_id: '401', class_type: 'KSamplerAdvanced', cfg: 1, steps: 8, denoise: 1, sampler_name: 'euler', scheduler: 'simple' },
  { node_id: '402', class_type: 'KSamplerAdvanced', cfg: 1, steps: 8, denoise: 1, sampler_name: 'euler', scheduler: 'simple' },
  { node_id: '403', class_type: 'KSamplerAdvanced', cfg: 1, steps: 8, denoise: 1, sampler_name: 'euler', scheduler: 'simple' },
  { node_id: '404', class_type: 'KSamplerAdvanced', cfg: 7, steps: 8, denoise: 1, sampler_name: 'euler', scheduler: 'simple' },
]
const MOE_PAIRS = [
  {
    family: 'KSamplerAdvanced', high_node_id: '401', low_node_id: '402',
    label: 'T2V', total: 8, split: 4,
    total_targets: ['401.steps', '402.steps'],
    split_targets: { '401.end_at_step': 'split', '402.start_at_step': 'split' },
    owned_keys: ['401.steps', '402.steps', '401.end_at_step', '402.start_at_step'],
  },
  {
    family: 'KSamplerAdvanced', high_node_id: '403', low_node_id: '404',
    label: 'Upscale', total: 8, split: 4,
    total_targets: ['403.steps', '404.steps'],
    split_targets: { '403.end_at_step': 'split', '404.start_at_step': 'split' },
    owned_keys: ['403.steps', '404.steps', '403.end_at_step', '404.start_at_step'],
  },
]

// One standard KSampler + one ClownShark with curated RES4LYF options.
const CLOWNSHARK_KSAMPLERS = [
  { node_id: '10', class_type: 'KSampler', cfg: 7, steps: 20, denoise: 1, sampler_name: 'euler', scheduler: 'normal' },
  {
    node_id: '20', class_type: 'ClownsharKSampler_Beta', cfg: 1, steps: 16, denoise: 1,
    sampler_name: 'linear/euler', scheduler: 'beta',
    sampler_options: ['linear/euler', 'res_2s', 'multistep/res_3m'],
    scheduler_options: ['beta', 'bong_tangent'],
  },
]

function mockParseFetch(payload: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('parse-workflow')) {
      return new Response(JSON.stringify({ ok: true, ...payload }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }))
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
})

// CollapsibleSection starts collapsed (children unmounted). Click its header
// button (the one wrapping the label span) to reveal the inner controls.
function expandSection(labelText: string) {
  const labels = screen.getAllByText(labelText)
  for (const label of labels) {
    const btn = label.closest('button')
    if (btn) fireEvent.click(btn)
  }
}

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
  // A non-empty workflow triggers the mount re-parse, which reads the
  // detection arrays from the mocked parse-workflow response.
  sessionStorage.setItem('block_b1_workflow', JSON.stringify(JSON.stringify({ '1': { class_type: 'SaveImage' } })))
})

describe('ComfyGen MoE Sampler panel', () => {
  test('renders a MoE Sampler section per detected pair with Total/Split inputs', async () => {
    mockParseFetch({ ksamplers: KSAMPLERS, moe_pairs: MOE_PAIRS })
    sessionStorage.setItem('block_b1_ksamplers', JSON.stringify(KSAMPLERS))
    sessionStorage.setItem('block_b1_moe_pairs', JSON.stringify(MOE_PAIRS))

    renderBlock()

    const sections = await screen.findAllByText('MoE Sampler')
    expect(sections.length).toBe(2)
    // Badges render even while collapsed.
    expect(screen.getByText('T2V · 401→402')).toBeInTheDocument()
    expect(screen.getByText('Upscale · 403→404')).toBeInTheDocument()
    // Per pair: a Total Steps + a Split control (inside the section body).
    expandSection('MoE Sampler')
    expect(screen.getAllByText('Total Steps').length).toBe(2)
    expect(screen.getAllByText('Split (high steps)').length).toBe(2)
  })

  test('Split helper subtext shows live high/low split from detected defaults', async () => {
    mockParseFetch({ ksamplers: KSAMPLERS, moe_pairs: MOE_PAIRS })
    sessionStorage.setItem('block_b1_ksamplers', JSON.stringify(KSAMPLERS))
    sessionStorage.setItem('block_b1_moe_pairs', JSON.stringify(MOE_PAIRS))

    renderBlock()

    await screen.findAllByText('MoE Sampler')
    expandSection('MoE Sampler')
    // total=8, split=4 → high: 4 · low: 4 (one per pair).
    expect(screen.getAllByText('high: 4 · low: 4').length).toBe(2)
  })

  test('4th-position MoE-owned sampler cfg input renders despite the first-3 cap', async () => {
    mockParseFetch({ ksamplers: KSAMPLERS, moe_pairs: MOE_PAIRS })
    sessionStorage.setItem('block_b1_ksamplers', JSON.stringify(KSAMPLERS))
    sessionStorage.setItem('block_b1_moe_pairs', JSON.stringify(MOE_PAIRS))

    renderBlock()

    // Expand the KSampler section to reveal the per-expert panels.
    await screen.findByText('KSamplers')
    expandSection('KSamplers')
    // Sampler #4 = node 404, MoE-owned. Its per-expert panel must render and
    // carry a CFG input pre-populated with its detected cfg (7).
    const label404 = await screen.findByText('#404 KSamplerAdvanced')
    const panel404 = label404.parentElement as HTMLElement
    const cfgInput = within(panel404).getByPlaceholderText('7')
    expect(cfgInput).toBeInTheDocument()
    // Its `steps` input is hidden — owned by the MoE panel. Steps placeholder=8
    // would also match cfg-less, so assert no 'Steps' label inside this panel.
    expect(within(panel404).queryByText('Steps')).not.toBeInTheDocument()
  })
})

describe('ComfyGen ClownShark curated sampler list', () => {
  test('ClownShark panel uses its curated sampler_options; standard uses global cache', async () => {
    mockParseFetch({ ksamplers: CLOWNSHARK_KSAMPLERS })
    sessionStorage.setItem('block_b1_ksamplers', JSON.stringify(CLOWNSHARK_KSAMPLERS))
    // Global cache list (would be wrong for the ClownShark node).
    sessionStorage.setItem('block_b1_ksampler_overrides', JSON.stringify({
      '10': { steps: '', cfg: '', denoise: '', sampler_name: '', scheduler: '' },
      '20': { steps: '', cfg: '', denoise: '', sampler_name: '', scheduler: '' },
    }))

    renderBlock()

    await screen.findByText('KSamplers')
    expandSection('KSamplers')
    // The standard KSampler #10 shows its global-cache fallback value (euler);
    // the ClownShark #20 shows its curated current value (linear/euler). The
    // dropdown trigger renders the selected value as text.
    const std = await screen.findByText('#10 KSampler')
    const stdPanel = std.parentElement as HTMLElement
    expect(within(stdPanel).getByText('euler')).toBeInTheDocument()

    const cs = await screen.findByText('#20 ClownsharKSampler_Beta')
    const csPanel = cs.parentElement as HTMLElement
    // The curated current value 'linear/euler' is RES4LYF-namespaced — it could
    // only appear if the ClownShark panel used sampler_options, not the global
    // availableSamplers cache (which we never set here).
    expect(within(csPanel).getByText('linear/euler')).toBeInTheDocument()
    expect(within(csPanel).getByText('beta')).toBeInTheDocument()
  })
})
