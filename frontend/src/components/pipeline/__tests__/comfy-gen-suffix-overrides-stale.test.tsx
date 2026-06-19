import { describe, expect, test, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'

async function openSection() {
  const header = await screen.findByText('Workflow-Specific Overrides')
  fireEvent.click(header)
}

const pipelineMocks = vi.hoisted(() => ({
  pipeline: { blocks: [] as Array<{ id: string; type: string }> },
}))
const parseResponse = vi.hoisted(() => ({ value: { ok: true } as Record<string, unknown> }))
const runCalls = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[] }))
// pickFiles returns whatever File the test queues for the next "Load JSON" click.
const filePicker = vi.hoisted(() => ({ next: null as File | null }))

vi.mock('@/lib/file-picker', () => ({
  pickFiles: vi.fn(async () => (filePicker.next ? [filePicker.next] : [])),
}))

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

let executeFn: ((inputs: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) | null = null

function renderBlock() {
  const Component = blockDef.component
  return render(
    <Component
      blockId="b1" inputs={{}} setOutput={vi.fn()}
      registerExecute={(fn: typeof executeFn) => { executeFn = fn }}
      setStatusMessage={vi.fn()} setExecutionStatus={vi.fn()} setOutputHint={vi.fn()}
      setHeaderActions={vi.fn()}
    />,
  )
}

function fakeJsonFile(name: string, obj: unknown): File {
  return new File([JSON.stringify(obj)], name, { type: 'application/json' })
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.clearAllMocks()
  executeFn = null
  runCalls.bodies = []
  filePicker.next = null
  // advanced mode → the "Load JSON" button is rendered.
  localStorage.setItem('comfy_gen_advanced_mode', '1')
  pipelineMocks.pipeline.blocks = [{ id: 'b1', type: 'comfyGen' }]
  parseResponse.value = { ok: true }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('parse-workflow')) {
      return new Response(JSON.stringify(parseResponse.value), { status: 200 })
    }
    if (url.includes('/run')) {
      runCalls.bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true, job_id: 'j1' }), { status: 200 })
    }
    if (url.includes('/status')) {
      return new Response(JSON.stringify({
        ok: true, job: { status: 'COMPLETED', local_image_url: 'http://x/out.png', seed: 1 },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }))
})

describe('BREAKER: stale comfygen override values leak across workflow swap', () => {
  test('editing workflow A then loading workflow B re-applies A\'s edit to B\'s same-key field', async () => {
    // --- Workflow A: node 5 is a "Steps" primitive (current 8). User edits to 42. ---
    const aOverrides = [{ node_id: '5', field: 'value', label: 'Steps', type: 'int', current_value: 8 }]
    sessionStorage.setItem(
      'block_b1_workflow',
      JSON.stringify(JSON.stringify({ '5': { class_type: 'PrimitiveInt', inputs: { value: 8 } } })),
    )
    sessionStorage.setItem('block_b1_comfygen_overrides', JSON.stringify(aOverrides))
    parseResponse.value = { ok: true, comfygen_overrides: aOverrides }

    renderBlock()
    await openSection()
    const aLabel = await screen.findByText('Steps')
    const aInput = within(aLabel.closest('div')!.parentElement!).getByRole('spinbutton')
    fireEvent.change(aInput, { target: { value: '42' } })

    // --- Load Workflow B: SAME node id 5 + field value, but it's a totally
    // different knob ("CFG Scale", workflow ships 6). User never touches it. ---
    const bOverrides = [{ node_id: '5', field: 'value', label: 'CFG Scale', type: 'int', current_value: 6 }]
    parseResponse.value = { ok: true, comfygen_overrides: bOverrides }
    filePicker.next = fakeJsonFile('workflow-b.json', { '5': { class_type: 'PrimitiveInt', inputs: { value: 6 } } })

    fireEvent.click(screen.getByText('Load JSON'))

    // After the swap, the new "CFG Scale" field should show the workflow's
    // baked-in value (6) — the user never edited it in workflow B.
    const bLabel = await screen.findByText('CFG Scale')
    const bInput = within(bLabel.closest('div')!.parentElement!).getByRole('spinbutton')

    // EXPECTED: 6 (fresh workflow value, no user edit in B).
    // ACTUAL (bug): 42 — workflow A's stale edit leaked because
    // comfygenOverrideValues is never reset on parse.
    await waitFor(() => {
      expect(bInput).toHaveValue(6)
    })
  })

  test('the stale value is SUBMITTED — workflow B gets workflow A\'s edit at runtime', async () => {
    const aOverrides = [{ node_id: '5', field: 'value', label: 'Steps', type: 'int', current_value: 8 }]
    sessionStorage.setItem(
      'block_b1_workflow',
      JSON.stringify(JSON.stringify({ '5': { class_type: 'PrimitiveInt', inputs: { value: 8 } } })),
    )
    sessionStorage.setItem('block_b1_comfygen_overrides', JSON.stringify(aOverrides))
    parseResponse.value = { ok: true, comfygen_overrides: aOverrides }

    renderBlock()
    await openSection()
    const aLabel = await screen.findByText('Steps')
    const aInput = within(aLabel.closest('div')!.parentElement!).getByRole('spinbutton')
    fireEvent.change(aInput, { target: { value: '42' } })

    const bOverrides = [{ node_id: '5', field: 'value', label: 'CFG Scale', type: 'int', current_value: 6 }]
    parseResponse.value = { ok: true, comfygen_overrides: bOverrides }
    filePicker.next = fakeJsonFile('workflow-b.json', { '5': { class_type: 'PrimitiveInt', inputs: { value: 6 } } })
    fireEvent.click(screen.getByText('Load JSON'))
    await screen.findByText('CFG Scale')

    await executeFn!({}, new AbortController().signal)

    // EXPECTED: no 5.value override (user never edited workflow B's field) →
    //   workflow's baked-in 6 is used.
    // ACTUAL (bug): 5.value = '42' is submitted, silently overriding B's CFG.
    expect(runCalls.bodies.length).toBe(1)
    const ov = (runCalls.bodies[0].overrides ?? {}) as Record<string, string>
    expect(ov['5.value']).toBeUndefined()
  })
})
