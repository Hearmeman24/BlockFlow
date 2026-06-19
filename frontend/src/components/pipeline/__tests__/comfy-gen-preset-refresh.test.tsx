import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const settingsMocks = vi.hoisted(() => ({
  getEndpoint: vi.fn(),
  listInstalledPresets: vi.fn(),
  getInstalledPreset: vi.fn(),
}))

const pipelineMocks = vi.hoisted(() => ({
  resetRuntimeFromBlock: vi.fn(),
  getUpstreamProducers: vi.fn(),
  setBlockSourceMode: vi.fn(),
  setBlockSourceSelection: vi.fn(),
  pipeline: { blocks: [] as Array<{ id: string; type: string; sourceModes?: Record<string, string>; sourceSelections?: Record<string, string[]> }> },
}))

vi.mock('@/lib/settings/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings/client')>()
  return {
    ...actual,
    getEndpoint: settingsMocks.getEndpoint,
    listInstalledPresets: settingsMocks.listInstalledPresets,
    getInstalledPreset: settingsMocks.getInstalledPreset,
  }
})

vi.mock('@/lib/pipeline/pipeline-context', () => ({
  usePipeline: () => ({
    pipeline: pipelineMocks.pipeline,
    addBlock: vi.fn(),
    resetRuntimeFromBlock: pipelineMocks.resetRuntimeFromBlock,
    getUpstreamProducers: pipelineMocks.getUpstreamProducers,
    getUpstreamProducerValues: vi.fn(() => []),
    setBlockSourceMode: pipelineMocks.setBlockSourceMode,
    setBlockSourceSelection: pipelineMocks.setBlockSourceSelection,
  }),
}))

vi.mock('@/lib/pipeline/block-bindings', () => ({
  MANUAL_SOURCE: '__manual__',
  useBlockBindings: () => ({
    get: () => ({
      sourceOptions: [{ value: '__manual__', label: 'Manual' }],
      value: '',
      setValue: vi.fn(),
    }),
  }),
}))

import { blockDef } from '../custom_blocks/generated/comfy_gen'

function makeStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => { data.delete(key) },
    setItem: (key: string, value: string) => { data.set(key, String(value)) },
  }
}

function renderBlock() {
  const Component = blockDef.component
  return render(
    <Component
      blockId="b1"
      inputs={{}}
      setOutput={vi.fn()}
      registerExecute={vi.fn()}
      setStatusMessage={vi.fn()}
      setExecutionStatus={vi.fn()}
      setOutputHint={vi.fn()}
      setHeaderActions={vi.fn()}
    />,
  )
}

function fetchUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage())
  vi.stubGlobal('sessionStorage', makeStorage())
  sessionStorage.clear()
  localStorage.clear()
  vi.clearAllMocks()
  pipelineMocks.pipeline.blocks = []
  pipelineMocks.getUpstreamProducers.mockReturnValue([])
  settingsMocks.getEndpoint.mockResolvedValue(null)
  settingsMocks.listInstalledPresets.mockResolvedValue([
    {
      preset_id: 'preset-a',
      version: '0.2.0',
      disk_size_gb: 1,
      installed_at: '2026-05-27T05:00:00+00:00',
      updated_at: '2026-05-27T06:00:00+00:00',
      workflows: [{ name: 'Default' }],
    },
  ])
  settingsMocks.getInstalledPreset.mockResolvedValue({
    preset_id: 'preset-a',
    version: '0.2.0',
    disk_size_gb: 1,
    installed_at: '2026-05-27T05:00:00+00:00',
    updated_at: '2026-05-27T06:00:00+00:00',
    workflows: [{ name: 'Default' }],
    workflow_json: [
      {
        name: 'Default',
        json: { '2': { class_type: 'FreshNode', inputs: {} } },
      },
    ],
    recommendations: { global: [], workflows: {} },
  })
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = fetchUrl(input)
    if (url.includes('/health')) return { json: async () => ({ ok: true }) }
    if (url.includes('/cache')) return { json: async () => ({ ok: true }) }
    if (url.includes('/parse-workflow')) {
      return {
        json: async () => ({
          ok: true,
          load_nodes: [],
          ksamplers: [],
          text_overrides: [],
          resolution_nodes: [],
          frame_counts: [],
          ref_video: [],
          lora_nodes: [],
          output_type: 'image',
        }),
      }
    }
    return { json: async () => ({ ok: true }) }
  }))
})

describe('ComfyGen preset refresh state', () => {
  test('hides the resolved comfy-gen CLI mode when health is ok', async () => {
    vi.mocked(fetch).mockImplementation(async (input: string | URL | Request) => {
      const url = fetchUrl(input)
      if (url.includes('/health')) {
        return { json: async () => ({ ok: true, mode: 'sidecar', path: '/tmp/blockflow/venv/bin/comfy-gen' }) } as Response
      }
      if (url.includes('/cache')) return { json: async () => ({ ok: true }) } as Response
      return { json: async () => ({ ok: true }) } as Response
    })

    renderBlock()

    await waitFor(() => {
      expect(fetch).toHaveBeenCalled()
    })
    expect(screen.queryByText(/CLI: sidecar/i)).not.toBeInTheDocument()
  })

  test('shows upstream media source controls from workflow mappings before runtime media exists', async () => {
    settingsMocks.getEndpoint.mockResolvedValue({ endpoint_id: 'test-endpoint' })
    pipelineMocks.pipeline.blocks = [
      { id: 'image-1', type: 'imageSource' },
      { id: 'image-2', type: 'imageSource' },
      { id: 'video-1', type: 'videoSource' },
      { id: 'b1', type: 'comfyGen' },
    ]
    pipelineMocks.getUpstreamProducers.mockImplementation((_blockId: string, kind: string) => {
      if (kind === 'image') {
        return [
          { blockId: 'image-1', blockIndex: 0, blockLabel: 'Image Source' },
          { blockId: 'image-2', blockIndex: 1, blockLabel: 'Image Source' },
        ]
      }
      if (kind === 'video') {
        return [{ blockId: 'video-1', blockIndex: 2, blockLabel: 'Video Source' }]
      }
      return []
    })
    sessionStorage.setItem(
      'block_b1_mappings',
      JSON.stringify([
        { node_id: '10', field: 'image', portKind: 'image' },
        { node_id: '11', field: 'video', portKind: 'video' },
      ]),
    )
    sessionStorage.setItem('block_b1_workflow', JSON.stringify('{"1":{"class_type":"SaveImage"}}'))

    renderBlock()

    expect(await screen.findByText('2 upstream image producers available')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /images source mode/i })).toHaveTextContent(
      'Images: closest upstream',
    )
    expect(screen.getByText('1 upstream video producer available')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /videos source mode/i })).toHaveTextContent(
      'Videos: closest upstream',
    )
    expect(screen.getByText(/workflow mappings still decide/i)).toBeInTheDocument()
  })

  test('missing endpoint guides users to the ComfyGen setup wizard', async () => {
    const openWizard = vi.fn()
    window.addEventListener('blockflow:open-comfygen-wizard', openWizard)

    const user = userEvent.setup()
    renderBlock()

    expect(await screen.findByText(/ComfyGen endpoint is not set up/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /set up comfygen/i }))

    expect(openWizard).toHaveBeenCalledTimes(1)
    window.removeEventListener('blockflow:open-comfygen-wizard', openWizard)
  })

  test('empty presets explain advanced workflow loading and reveal loaders', async () => {
    settingsMocks.listInstalledPresets.mockResolvedValue([])

    const user = userEvent.setup()
    renderBlock()

    expect(await screen.findByText(/No presets installed yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /enable advanced/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /enable advanced/i }))

    expect(await screen.findByRole('button', { name: /load json/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /from png/i })).toBeInTheDocument()
  })

  test('shows reload control when installed preset metadata is newer and reapplies current preset', async () => {
    sessionStorage.setItem('block_b1_selected_preset', JSON.stringify('preset-a::0'))
    sessionStorage.setItem('block_b1_preset_applied_updated_at', JSON.stringify('2026-05-27T05:00:00+00:00'))
    sessionStorage.setItem('block_b1_workflow', JSON.stringify(JSON.stringify({ '1': { class_type: 'OldNode', inputs: {} } })))

    const user = userEvent.setup()
    renderBlock()

    const reload = await screen.findByRole('button', { name: /reload preset/i })
    expect(screen.getByText(/preset updated/i)).toBeInTheDocument()

    await user.click(reload)

    await waitFor(() => {
      expect(settingsMocks.getInstalledPreset).toHaveBeenCalledWith('preset-a')
    })
    await waitFor(() => {
      expect(sessionStorage.getItem('block_b1_preset_applied_updated_at')).toBe(JSON.stringify('2026-05-27T06:00:00+00:00'))
    })
    expect(sessionStorage.getItem('block_b1_workflow')).toContain('FreshNode')
  })

  test('reloading a preset preserves user override values for surviving nodes', async () => {
    // User has edited the prompt + resolution on an applied preset.
    sessionStorage.setItem('block_b1_selected_preset', JSON.stringify('preset-a::0'))
    sessionStorage.setItem('block_b1_preset_applied_updated_at', JSON.stringify('2026-05-27T05:00:00+00:00'))
    sessionStorage.setItem('block_b1_workflow', JSON.stringify(JSON.stringify({ '1': { class_type: 'OldNode', inputs: {} } })))
    sessionStorage.setItem('block_b1_text_values', JSON.stringify({ '6.text': 'MY EDITED PROMPT' }))
    sessionStorage.setItem('block_b1_resolution_overrides', JSON.stringify({ '5': { width: '768', height: '512' } }))

    // The refreshed preset's parse surfaces the same nodes (6, 5) with the
    // preset's OWN defaults, plus a brand-new node (9) the user never touched.
    vi.mocked(fetch).mockImplementation(async (input: string | URL | Request) => {
      const url = fetchUrl(input)
      if (url.includes('/parse-workflow')) {
        return {
          json: async () => ({
            ok: true,
            load_nodes: [],
            ksamplers: [],
            text_overrides: [{ node_id: '6', input_name: 'text', current_value: 'PRESET DEFAULT PROMPT' }],
            resolution_nodes: [{ node_id: '5', class_type: 'EmptyLatent', label: 'res', category: 'latent', width: 1024, height: 1024 }],
            frame_counts: [{ node_id: '9', class_type: 'Frames', label: 'frames', value: 81 }],
            ref_video: [],
            lora_nodes: [],
            output_type: 'image',
          }),
        } as Response
      }
      return { json: async () => ({ ok: true }) } as Response
    })

    const user = userEvent.setup()
    renderBlock()

    const reload = await screen.findByRole('button', { name: /reload preset/i })
    await user.click(reload)

    await waitFor(() => {
      expect(settingsMocks.getInstalledPreset).toHaveBeenCalledWith('preset-a')
    })

    // Surviving nodes keep the USER's values, not the preset's defaults.
    await waitFor(() => {
      const text = JSON.parse(sessionStorage.getItem('block_b1_text_values') as string)
      expect(text['6.text']).toBe('MY EDITED PROMPT')
    })
    const res = JSON.parse(sessionStorage.getItem('block_b1_resolution_overrides') as string)
    expect(res['5']).toEqual({ width: '768', height: '512' })

    // A node the user never overrode adopts the preset default.
    const frames = JSON.parse(sessionStorage.getItem('block_b1_frame_overrides') as string)
    expect(frames['9']).toBe('81')
  })

  test('shows neutral reload control without stale messaging when the selected preset is already current', async () => {
    sessionStorage.setItem('block_b1_selected_preset', JSON.stringify('preset-a::0'))
    sessionStorage.setItem('block_b1_preset_applied_updated_at', JSON.stringify('2026-05-27T06:00:00+00:00'))
    sessionStorage.setItem('block_b1_workflow', JSON.stringify(JSON.stringify({ '1': { class_type: 'CurrentNode', inputs: {} } })))

    renderBlock()

    await waitFor(() => {
      expect(settingsMocks.listInstalledPresets).toHaveBeenCalled()
    })
    expect(screen.getByRole('button', { name: /reload preset/i })).toBeInTheDocument()
    expect(screen.getByText('Reload')).toBeInTheDocument()
    expect(screen.queryByText(/preset updated/i)).not.toBeInTheDocument()
  })
})
