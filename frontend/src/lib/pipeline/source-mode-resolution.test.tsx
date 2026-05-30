import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { PipelineProvider, usePipeline } from './pipeline-context'
import { PipelineTabsProvider } from './tabs-context'
import { PORT_IMAGE, registerBlockDef } from './registry'

beforeAll(() => {
  registerBlockDef({
    type: 'contract_image_source',
    label: 'Contract Image Source',
    description: 'Source-mode contract image producer',
    size: 'sm',
    canStart: true,
    inputs: [],
    outputs: [{ name: 'image', kind: PORT_IMAGE }],
    component: () => null,
  })
  registerBlockDef({
    type: 'contract_image_probe',
    label: 'Contract Image Probe',
    description: 'Source-mode contract image consumer',
    size: 'sm',
    canStart: false,
    inputs: [{ name: 'image', kind: PORT_IMAGE }],
    outputs: [],
    component: () => null,
  })
})

interface Scenario {
  mode?: 'closest' | 'all' | 'custom'
  select?: 'first' | 'second' | 'third' | 'empty'
}

function SourceModeHarness({
  scenario,
  onInputs,
}: {
  scenario: Scenario
  onInputs: (inputs: Record<string, unknown>) => void
}) {
  const api = usePipeline()
  const idsRef = useRef<{ first: string; second: string; third: string; probe: string } | null>(null)
  const configuredRef = useRef(false)

  useEffect(() => {
    if (idsRef.current) return
    const first = api.addBlock('contract_image_source')
    const second = api.addBlock('contract_image_source')
    const third = api.addBlock('contract_image_source')
    const probe = api.addBlock('contract_image_probe')
    idsRef.current = { first, second, third, probe }
  }, [api])

  useEffect(() => {
    const ids = idsRef.current
    if (!ids || api.pipeline.blocks.length < 4 || configuredRef.current) return
    configuredRef.current = true
    api.setBlockOutput(ids.first, 'image', 'image:first')
    api.setBlockOutput(ids.second, 'image', 'image:second')
    api.setBlockOutput(ids.third, 'image', 'image:third')
    if (scenario.mode) api.setBlockSourceMode(ids.probe, 'image', scenario.mode)
    if (scenario.select && scenario.select !== 'empty') {
      api.setBlockSourceSelection(ids.probe, 'image', [ids[scenario.select]])
    }
    if (scenario.select === 'empty') {
      api.setBlockSourceSelection(ids.probe, 'image', [])
    }
  }, [api, scenario])

  useEffect(() => {
    const ids = idsRef.current
    if (!ids || api.pipeline.blocks.length < 4) return
    onInputs(api.getInputsForBlock(ids.probe))
  }, [api, onInputs])

  return null
}

function renderScenario(scenario: Scenario) {
  const onInputs = vi.fn()
  render(
    <PipelineTabsProvider>
      <PipelineProvider tabId={`source-mode-${JSON.stringify(scenario)}`}>
        <SourceModeHarness scenario={scenario} onInputs={onInputs} />
      </PipelineProvider>
    </PipelineTabsProvider>,
  )
  return onInputs
}

describe('pipeline source-mode resolution', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('defaults to the closest upstream producer', async () => {
    const onInputs = renderScenario({})

    await waitFor(() => {
      expect(onInputs).toHaveBeenLastCalledWith({ image: 'image:third' })
    })
  })

  it('returns all upstream producer outputs in upstream order', async () => {
    const onInputs = renderScenario({ mode: 'all' })

    await waitFor(() => {
      expect(onInputs).toHaveBeenLastCalledWith({ image: ['image:first', 'image:second', 'image:third'] })
    })
  })

  it('returns only custom-selected upstream producer outputs', async () => {
    const onInputs = renderScenario({ mode: 'custom', select: 'second' })

    await waitFor(() => {
      expect(onInputs).toHaveBeenLastCalledWith({ image: ['image:second'] })
    })
  })

  it('treats empty custom selection as no runtime input', async () => {
    const onInputs = renderScenario({ mode: 'custom', select: 'empty' })

    await waitFor(() => {
      expect(onInputs).toHaveBeenLastCalledWith({})
    })
  })
})
