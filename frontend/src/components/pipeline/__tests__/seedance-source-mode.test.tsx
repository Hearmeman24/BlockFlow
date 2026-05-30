import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { registerBlockDef } from '@/lib/pipeline/registry'
import { blockDef as seedanceBlockDef } from '../custom_blocks/generated/seedance'

type ExecuteFn = (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

beforeAll(() => {
  registerBlockDef({
    type: 'seedance_source_o1q',
    label: 'Upload Image',
    description: 'test image source',
    size: 'sm',
    inputs: [],
    outputs: [{ name: 'image', kind: 'image' }],
    canStart: true,
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
})

function Harness() {
  const api = usePipeline()
  const [seedanceId, setSeedanceId] = useState('')

  useEffect(() => {
    if (api.pipeline.blocks.length > 0 || seedanceId) return
    api.addBlock('seedance_source_o1q')
    const nextSeedanceId = api.addBlock('seedance')
    sessionStorage.setItem(`block_${nextSeedanceId}_mode`, JSON.stringify('omni_reference'))
    setSeedanceId(nextSeedanceId)
  }, [api, seedanceId])

  if (!seedanceId) return null

  const Seedance = seedanceBlockDef.component
  return (
    <Seedance
      blockId={seedanceId}
      inputs={{}}
      setOutput={() => {}}
      registerExecute={() => {}}
      setStatusMessage={() => {}}
    />
  )
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ piapi_key_present: true }), { status: 200 }),
  )
})

describe('Seedance source mode UI', () => {
  it('shows upstream image producer candidates before runtime images exist', async () => {
    render(
      <PipelineTabsProvider>
        <PipelineProvider tabId="seedance-source-mode-test">
          <Harness />
        </PipelineProvider>
      </PipelineTabsProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('1 upstream image producer available')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /images source mode/i })).toHaveTextContent(
      'Images: closest upstream',
    )
  })

  it('submits a local upstream image path instead of treating it as absent', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/blocks/seedance/health') {
        return Promise.resolve(new Response(JSON.stringify({ piapi_key_present: true }), { status: 200 }))
      }
      if (url === '/api/blocks/seedance/run') {
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'stop after submit' }), { status: 200 }))
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    sessionStorage.setItem('block_seedance-local_mode', JSON.stringify('omni_reference'))
    sessionStorage.setItem('block_seedance-local_prompt', JSON.stringify('make this move'))
    let execute: ExecuteFn | null = null
    const Seedance = seedanceBlockDef.component

    render(
      <PipelineTabsProvider>
        <PipelineProvider tabId="seedance-local-ref-test">
          <Seedance
            blockId="seedance-local"
            inputs={{ image: '/outputs/gpt_image_piapi/frame.png' }}
            setOutput={() => {}}
            registerExecute={(fn) => { execute = fn as ExecuteFn }}
            setStatusMessage={() => {}}
          />
        </PipelineProvider>
      </PipelineTabsProvider>,
    )
    await waitFor(() => expect(execute).toBeTruthy())

    await expect(execute!({ image: '/outputs/gpt_image_piapi/frame.png' }, new AbortController().signal))
      .rejects.toThrow('stop after submit')

    expect(fetchMock).toHaveBeenCalledWith('/api/blocks/seedance/run', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"/outputs/gpt_image_piapi/frame.png"'),
    }))
  })
})
