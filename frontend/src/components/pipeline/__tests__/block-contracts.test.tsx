import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

const settingsMocks = vi.hoisted(() => ({
  getCredential: vi.fn(),
  getEndpoint: vi.fn(),
  getInstalledPreset: vi.fn(),
  listInstalledPresets: vi.fn(),
}))

vi.mock('@/lib/settings/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings/client')>()
  return {
    ...actual,
    getCredential: settingsMocks.getCredential,
    getEndpoint: settingsMocks.getEndpoint,
    getInstalledPreset: settingsMocks.getInstalledPreset,
    listInstalledPresets: settingsMocks.listInstalledPresets,
  }
})

import '@/components/pipeline/custom_blocks/_register'
import { PipelineProvider } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import {
  listBlockDefs,
  type BlockComponentProps,
  type BlockDef,
} from '@/lib/pipeline/registry'

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
}

function mockFetch() {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/health')) {
      return jsonResponse({
        ok: true,
        has_api_key: true,
        has_env_api_key: true,
        runpod_key_present: true,
        piapi_key_present: true,
        elevenlabs_key_present: true,
      })
    }
    if (url.includes('/settings')) {
      return jsonResponse({
        ok: true,
        has_api_key: true,
        has_env_api_key: true,
        settings: {},
      })
    }
    if (url.includes('/models')) {
      return jsonResponse({ ok: true, models: [], total: 0, matched: 0 })
    }
    if (url.includes('/prompt-library')) {
      return jsonResponse({ ok: true, prompts: [] })
    }
    if (url.includes('/prompt-packs')) {
      return jsonResponse({ ok: true, packs: [], prompts: [] })
    }
    if (url.includes('/datasets')) {
      return jsonResponse({ ok: true, datasets: [] })
    }
    if (url.includes('/comfygen-config')) {
      return jsonResponse({ ok: true, configured: true, endpoint_id: 'mock-endpoint' })
    }
    if (url.includes('/cache') || url.includes('/refresh-status') || url.includes('/download-status')) {
      return jsonResponse({ ok: true, presets: [], workflows: [], status: 'idle' })
    }
    if (url.includes('/file-metadata')) {
      return jsonResponse({ ok: false, error: 'not found' })
    }
    return jsonResponse({ ok: true })
  }))
}

function contractInputs(): Record<string, unknown> {
  return {
    image: [
      { kind: 'image-ref', local: '/outputs/contract/image.png', url: 'https://tmpfiles.test/image.png' },
    ],
    video: [
      { kind: 'video-ref', local: '/outputs/contract/video.mp4', url: 'https://tmpfiles.test/video.mp4' },
    ],
    audio: ['/outputs/contract/audio.mp3'],
    text: 'contract prompt',
    metadata: { job_ids: ['job-contract'] },
    dataset: { kind: 'dataset', name: 'contract-dataset', images: [] },
    loras: [],
  }
}

function renderContractBlock(def: BlockDef) {
  const props: BlockComponentProps = {
    blockId: `contract-${def.type}`,
    inputs: contractInputs(),
    setOutput: vi.fn(),
    registerExecute: vi.fn(),
    setStatusMessage: vi.fn(),
    setExecutionStatus: vi.fn(),
    setOutputHint: vi.fn(),
    setHeaderActions: vi.fn(),
    hasUpstreamProducer: vi.fn(() => true),
  }
  const Component = def.component
  const result = render(
    <PipelineTabsProvider>
      <PipelineProvider tabId={`contract-${def.type}`}>
        <Component {...props} />
      </PipelineProvider>
    </PipelineTabsProvider>,
  )
  return { ...result, props }
}

describe('custom block contracts', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
    settingsMocks.getCredential.mockResolvedValue({ value: 'mock-secret' })
    settingsMocks.getEndpoint.mockResolvedValue('mock-endpoint')
    settingsMocks.getInstalledPreset.mockRejectedValue(new Error('no preset'))
    settingsMocks.listInstalledPresets.mockResolvedValue([])
    mockFetch()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('registers every generated custom block with unique metadata', () => {
    const defs = listBlockDefs()
    expect(defs.length).toBeGreaterThan(20)
    expect(new Set(defs.map((def) => def.type)).size).toBe(defs.length)
    for (const def of defs) {
      expect(def.type).toMatch(/^[A-Za-z0-9_]+$/)
      expect(def.label.trim()).not.toBe('')
      expect(def.description.trim()).not.toBe('')
      expect(['sm', 'md', 'lg', 'huge']).toContain(def.size)
      expect(Array.isArray(def.inputs)).toBe(true)
      expect(Array.isArray(def.outputs)).toBe(true)
      expect(typeof def.component).toBe('function')
    }
  })

  it('keeps forwards and iterator declarations tied to declared ports', () => {
    for (const def of listBlockDefs()) {
      const inputNames = new Set(def.inputs.map((port) => port.name))
      const outputNames = new Set(def.outputs.map((port) => port.name))
      for (const forward of def.forwards ?? []) {
        expect(inputNames.has(forward.fromInput), `${def.type} forwards from missing input`).toBe(true)
        expect(outputNames.has(forward.toOutput), `${def.type} forwards to missing output`).toBe(true)
      }
      if (def.iteratorOutput) {
        expect(outputNames.has(def.iteratorOutput), `${def.type} iteratorOutput missing`).toBe(true)
      }
    }
  })

  it.each(listBlockDefs().map((def) => [def.type, def] as const))(
    'mounts %s with mocked pipeline props',
    async (_type, def) => {
      const { props } = renderContractBlock(def)
      await waitFor(() => {
        expect(props.setStatusMessage).toBeDefined()
      })
    },
  )

  it.each(listBlockDefs().map((def) => [def.type, def] as const))(
    'registers an execute callback for %s unless it is declarative-only',
    async (_type, def) => {
      const declarativeOnly = def.type === 'audioViewer'
      const { props } = renderContractBlock(def)
      if (declarativeOnly) {
        expect(props.registerExecute).not.toHaveBeenCalled()
        return
      }
      await waitFor(() => {
        expect(props.registerExecute).toHaveBeenCalledWith(expect.any(Function))
      })
    },
  )
})
