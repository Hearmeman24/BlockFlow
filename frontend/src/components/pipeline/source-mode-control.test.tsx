import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { registerBlockDef } from '@/lib/pipeline/registry'
import { SourceModeControl } from './source-mode-control'

beforeAll(() => {
  registerBlockDef({
    type: 'src_o1q_control',
    label: 'Image Source',
    description: 'test image source',
    size: 'sm',
    inputs: [],
    outputs: [{ name: 'image', kind: 'image' }],
    canStart: true,
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])

  registerBlockDef({
    type: 'sink_o1q_control',
    label: 'Image Consumer',
    description: 'test image consumer',
    size: 'sm',
    inputs: [{ name: 'image', kind: 'image', required: false }],
    outputs: [],
    canStart: false,
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
})

let currentApi: ReturnType<typeof usePipeline> | null = null

function Probe() {
  currentApi = usePipeline()
  return null
}

function Harness() {
  const api = usePipeline()
  if (api.pipeline.blocks.length === 0) {
    api.addBlock('src_o1q_control')
    api.addBlock('src_o1q_control')
    api.addBlock('sink_o1q_control')
    return null
  }

  const sink = api.pipeline.blocks[2]
  return (
    <SourceModeControl
      blockId={sink.id}
      inputName="image"
      inputKind="image"
      label="Images"
    />
  )
}

function renderControl() {
  return render(
    <PipelineTabsProvider>
      <PipelineProvider tabId="source-mode-control-test">
        <Probe />
        <Harness />
      </PipelineProvider>
    </PipelineTabsProvider>,
  )
}

beforeEach(() => {
  currentApi = null
  sessionStorage.clear()
  localStorage.clear()
})

describe('SourceModeControl', () => {
  async function openMenu() {
    const trigger = await screen.findByRole('button', { name: /images source mode/i })
    fireEvent.pointerDown(trigger)
  }

  it('shows potential upstream producers before runtime outputs exist', async () => {
    renderControl()

    expect(await screen.findByRole('button', { name: /images source mode/i })).toHaveTextContent(
      'Images: closest upstream',
    )
    expect(screen.getByText('2 upstream image producers available')).toBeInTheDocument()
    expect(screen.getByText(/closest: 2\. image source/i)).toBeInTheDocument()
  })

  it('switches to all-upstream mode', async () => {
    renderControl()

    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /all upstream/i }))

    expect(currentApi!.pipeline.blocks[2].sourceModes?.image).toBe('all')
  })

  it('stores custom checkbox selections independently from the closest default', async () => {
    renderControl()

    const sink = currentApi!.pipeline.blocks[2]
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /custom selection/i }))
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /1\. image source/i }))

    expect(currentApi!.pipeline.blocks.find((block) => block.id === sink.id)?.sourceModes?.image).toBe('custom')
    expect(currentApi!.pipeline.blocks.find((block) => block.id === sink.id)?.sourceSelections?.image).toEqual([
      currentApi!.pipeline.blocks[0].id,
    ])

    act(() => {
      currentApi!.setBlockSourceMode(sink.id, 'image', 'closest')
    })
    expect(currentApi!.pipeline.blocks.find((block) => block.id === sink.id)?.sourceSelections?.image).toEqual([
      currentApi!.pipeline.blocks[0].id,
    ])
  })
})
