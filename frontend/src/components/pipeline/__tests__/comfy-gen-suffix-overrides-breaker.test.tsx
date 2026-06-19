import { describe, expect, test, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'

async function openSection() {
  const header = await screen.findByText('Workflow-Specific Overrides')
  fireEvent.click(header)
}

const pipelineMocks = vi.hoisted(() => ({
  pipeline: { blocks: [] as Array<{ id: string; type: string }> },
}))
const parseResponse = vi.hoisted(() => ({ value: { ok: true } as Record<string, unknown> }))

// Capture every POST to the run endpoint so we can assert the override payload.
const runCalls = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[] }))

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

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.clearAllMocks()
  executeFn = null
  runCalls.bodies = []
  pipelineMocks.pipeline.blocks = [{ id: 'b1', type: 'comfyGen' }]
  parseResponse.value = { ok: true }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('parse-workflow')) {
      return new Response(JSON.stringify(parseResponse.value), { status: 200 })
    }
    if (url.includes('/run')) {
      runCalls.bodies.push(JSON.parse(String(init?.body)))
      // Return a completed job so the execute path resolves.
      return new Response(JSON.stringify({
        ok: true, job_id: 'j1',
      }), { status: 200 })
    }
    if (url.includes('/status/')) {
      return new Response(JSON.stringify({
        ok: true,
        job: { status: 'COMPLETED', local_image_url: 'http://x/out.png', seed: 1 },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }))
  // A real workflow body so JSON.parse(workflowJson) succeeds in execute.
  sessionStorage.setItem(
    'block_b1_workflow',
    JSON.stringify(JSON.stringify({ '5': { class_type: 'PrimitiveInt', inputs: { value: 8 } } })),
  )
})

async function run() {
  expect(executeFn).toBeTruthy()
  await executeFn!({}, new AbortController().signal)
}

describe('BREAKER: _ComfyGen apply path', () => {
  test('an EDITED field is sent as <node_id>.<field> in submit overrides', async () => {
    const overrides = [
      { node_id: '5', field: 'value', label: 'Steps', type: 'int', current_value: 8 },
    ]
    sessionStorage.setItem('block_b1_comfygen_overrides', JSON.stringify(overrides))
    parseResponse.value = { ok: true, comfygen_overrides: overrides }

    renderBlock()
    await openSection()

    const label = await screen.findByText('Steps')
    const input = within(label.closest('div')!.parentElement!).getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '42' } })

    await run()

    expect(runCalls.bodies.length).toBe(1)
    expect(runCalls.bodies[0].overrides).toMatchObject({ '5.value': '42' })
  })

  test('an UNEDITED field sends NOTHING (workflow baked-in value is used)', async () => {
    const overrides = [
      { node_id: '5', field: 'value', label: 'Steps', type: 'int', current_value: 8 },
    ]
    sessionStorage.setItem('block_b1_comfygen_overrides', JSON.stringify(overrides))
    parseResponse.value = { ok: true, comfygen_overrides: overrides }

    renderBlock()
    await openSection()
    await run()

    expect(runCalls.bodies.length).toBe(1)
    const ov = (runCalls.bodies[0].overrides ?? {}) as Record<string, string>
    expect(ov['5.value']).toBeUndefined()
  })
})
