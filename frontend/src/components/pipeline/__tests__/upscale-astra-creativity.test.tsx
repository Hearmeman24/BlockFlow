import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { blockDef as upscaleBlockDef } from '../custom_blocks/generated/upscale'

type ExecuteFn = (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

function Harness({
  model,
  creativity,
  onExecute,
}: {
  model: string
  creativity?: string
  onExecute?: (fn: ExecuteFn) => void
}) {
  const api = usePipeline()
  const [upscaleId, setUpscaleId] = useState('')
  const added = useRef(false)

  useEffect(() => {
    if (added.current) return
    added.current = true
    const id = api.addBlock('upscale')
    sessionStorage.setItem(`block_${id}_model`, JSON.stringify(model))
    if (creativity !== undefined) {
      sessionStorage.setItem(`block_${id}_creativity`, JSON.stringify(creativity))
    }
    setUpscaleId(id)
  }, [api, model, creativity])

  if (!upscaleId) return null

  const Upscale = upscaleBlockDef.component
  return (
    <Upscale
      blockId={upscaleId}
      inputs={{}}
      setOutput={() => {}}
      registerExecute={(fn: ExecuteFn) => onExecute?.(fn)}
      setStatusMessage={() => {}}
    />
  )
}

function renderUpscale(props: Parameters<typeof Harness>[0], tabId: string) {
  return render(
    <PipelineTabsProvider>
      <PipelineProvider tabId={tabId}>
        <Harness {...props} />
      </PipelineProvider>
    </PipelineTabsProvider>,
  )
}

function mockTopazFetch(submitResponses: Array<Record<string, unknown>>) {
  const submitBodies: Array<Record<string, unknown>> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/blocks/upscale/settings') {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, has_api_key: true, has_env_api_key: true }), { status: 200 }),
      )
    }
    if (url === '/api/blocks/upscale/upscale') {
      submitBodies.push(JSON.parse(String(init?.body)))
      const body = submitResponses.shift() ?? { ok: false, error: 'no more mock responses' }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
  })
  return submitBodies
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('Topaz upscale block — Astra creativity', () => {
  it('hides the creativity control for non-Astra models', async () => {
    mockTopazFetch([])
    renderUpscale({ model: 'ahq-12' }, 'upscale-astra-test-1')

    await waitFor(() => {
      expect(screen.getByText('Model')).toBeInTheDocument()
    })
    expect(screen.queryByText('Creativity')).not.toBeInTheDocument()
  })

  it('shows the creativity control when Astra 2 is selected', async () => {
    mockTopazFetch([])
    renderUpscale({ model: 'ast-2' }, 'upscale-astra-test-2')

    await waitFor(() => {
      expect(screen.getByText('Creativity')).toBeInTheDocument()
    })
  })

  it('submits creativity as a number for Astra 2', async () => {
    const submitBodies = mockTopazFetch([{ ok: false, error: 'stop-test' }])
    let execute: ExecuteFn | null = null
    renderUpscale(
      { model: 'ast-2', creativity: '0.7', onExecute: (fn) => { execute = fn } },
      'upscale-astra-test-3',
    )

    await waitFor(() => expect(execute).not.toBeNull())
    await expect(
      execute!({ video: ['/outputs/in.mp4'] }, new AbortController().signal),
    ).rejects.toThrow('stop-test')

    expect(submitBodies).toHaveLength(1)
    expect(submitBodies[0].enhancement_model).toBe('ast-2')
    expect(submitBodies[0].creativity).toBe(0.7)
  })

  it('omits creativity for non-Astra models', async () => {
    const submitBodies = mockTopazFetch([{ ok: false, error: 'stop-test' }])
    let execute: ExecuteFn | null = null
    renderUpscale(
      { model: 'slhq-1', creativity: '0.7', onExecute: (fn) => { execute = fn } },
      'upscale-astra-test-4',
    )

    await waitFor(() => expect(execute).not.toBeNull())
    await expect(
      execute!({ video: ['/outputs/in.mp4'] }, new AbortController().signal),
    ).rejects.toThrow('stop-test')

    expect(submitBodies).toHaveLength(1)
    expect(submitBodies[0].enhancement_model).toBe('slhq-1')
    expect(submitBodies[0].creativity).toBeNull()
  })
})
