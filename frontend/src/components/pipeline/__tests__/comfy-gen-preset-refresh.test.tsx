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
    pipeline: { blocks: [] },
    addBlock: vi.fn(),
    resetRuntimeFromBlock: pipelineMocks.resetRuntimeFromBlock,
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

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage())
  vi.stubGlobal('sessionStorage', makeStorage())
  sessionStorage.clear()
  localStorage.clear()
  vi.clearAllMocks()
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
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
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
