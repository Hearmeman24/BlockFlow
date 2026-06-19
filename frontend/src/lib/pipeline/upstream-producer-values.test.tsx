import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { PipelineProvider, usePipeline, type UpstreamProducerValue } from './pipeline-context'
import { PipelineTabsProvider } from './tabs-context'
import { PORT_TEXT, registerBlockDef } from './registry'

beforeAll(() => {
  registerBlockDef({
    type: 'contract_text_source',
    label: 'Contract Text Source',
    description: 'Text producer',
    size: 'sm',
    canStart: true,
    inputs: [],
    outputs: [{ name: 'prompt', kind: PORT_TEXT }],
    component: () => null,
  })
  registerBlockDef({
    type: 'contract_text_probe',
    label: 'Contract Text Probe',
    description: 'Text consumer',
    size: 'sm',
    canStart: false,
    inputs: [{ name: 'prompt', kind: PORT_TEXT }],
    outputs: [],
    component: () => null,
  })
})

function Harness({ onValues }: { onValues: (v: UpstreamProducerValue[]) => void }) {
  const api = usePipeline()
  const idsRef = useRef<{ first: string; second: string; probe: string } | null>(null)
  const configuredRef = useRef(false)

  useEffect(() => {
    if (idsRef.current) return
    const first = api.addBlock('contract_text_source')
    const second = api.addBlock('contract_text_source')
    const probe = api.addBlock('contract_text_probe')
    idsRef.current = { first, second, probe }
  }, [api])

  useEffect(() => {
    const ids = idsRef.current
    if (!ids || api.pipeline.blocks.length < 3 || configuredRef.current) return
    configuredRef.current = true
    api.setBlockOutput(ids.first, 'prompt', 'text:first')
    api.setBlockOutput(ids.second, 'prompt', 'text:second')
  }, [api])

  useEffect(() => {
    const ids = idsRef.current
    if (!ids || api.pipeline.blocks.length < 3) return
    onValues(api.getUpstreamProducerValues(ids.probe, PORT_TEXT))
  }, [api, onValues])

  return null
}

describe('getUpstreamProducerValues', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('returns every upstream producer value tagged with its blockId, in upstream order', async () => {
    const onValues = vi.fn()
    render(
      <PipelineTabsProvider>
        <PipelineProvider tabId="upv">
          <Harness onValues={onValues} />
        </PipelineProvider>
      </PipelineTabsProvider>,
    )

    await waitFor(() => {
      const last = onValues.mock.calls.at(-1)?.[0] as UpstreamProducerValue[]
      expect(last?.map((p) => p.value)).toEqual(['text:first', 'text:second'])
    })
    const last = onValues.mock.calls.at(-1)?.[0] as UpstreamProducerValue[]
    // Each value is addressable by the producing block — this is what per-field
    // prompt routing needs (resolved inputs.prompt drops the blockId).
    expect(last[0].blockIndex).toBe(0)
    expect(last[1].blockIndex).toBe(1)
    expect(new Set(last.map((p) => p.blockId)).size).toBe(2)
    expect(last[0].blockLabel).toBe('Contract Text Source')
  })
})
