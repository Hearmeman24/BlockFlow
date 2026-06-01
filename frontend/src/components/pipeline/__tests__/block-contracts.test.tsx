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

type ExecuteFn = (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
}

function mockFetch(options: {
  failEndpoints?: string[]
  malformedSuccessEndpoints?: string[]
  jobEndpoints?: Record<string, string[]>
  endpointBodies?: Record<string, unknown[]>
} = {}) {
  const jobEndpointCounts = new Map<string, number>()
  const endpointBodyCounts = new Map<string, number>()
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    const bodies = options.endpointBodies?.[url]
    if (bodies?.length) {
      const idx = endpointBodyCounts.get(url) ?? 0
      endpointBodyCounts.set(url, idx + 1)
      return jsonResponse(bodies[Math.min(idx, bodies.length - 1)])
    }
    if (options.failEndpoints?.includes(url)) {
      return jsonResponse({ ok: false, error: 'contract stop' })
    }
    if (options.malformedSuccessEndpoints?.includes(url)) {
      return jsonResponse({ ok: true })
    }
    const jobs = options.jobEndpoints?.[url]
    if (jobs?.length) {
      const idx = jobEndpointCounts.get(url) ?? 0
      jobEndpointCounts.set(url, idx + 1)
      return jsonResponse({ ok: true, job_id: jobs[Math.min(idx, jobs.length - 1)] })
    }
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
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
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

function blockDef(type: string): BlockDef {
  const def = listBlockDefs().find((candidate) => candidate.type === type)
  if (!def) throw new Error(`Missing block def: ${type}`)
  return def
}

async function renderAndCaptureExecute(
  type: string,
  options: {
    blockId?: string
    inputs?: Record<string, unknown>
    waitForFetchUrl?: string
  } = {},
): Promise<{ execute: ExecuteFn; props: BlockComponentProps }> {
  let execute: ExecuteFn | null = null
  const def = blockDef(type)
  const blockId = options.blockId ?? `execute-${type}`
  const props: BlockComponentProps = {
    blockId,
    inputs: options.inputs ?? contractInputs(),
    setOutput: vi.fn(),
    registerExecute: vi.fn((fn) => { execute = fn as ExecuteFn }),
    setStatusMessage: vi.fn(),
    setExecutionStatus: vi.fn(),
    setOutputHint: vi.fn(),
    setHeaderActions: vi.fn(),
    hasUpstreamProducer: vi.fn(() => true),
  }
  const Component = def.component
  render(
    <PipelineTabsProvider>
      <PipelineProvider tabId={`execute-${type}`}>
        <Component {...props} />
      </PipelineProvider>
    </PipelineTabsProvider>,
  )
  await waitFor(() => {
    expect(props.registerExecute).toHaveBeenCalledWith(expect.any(Function))
  })
  if (options.waitForFetchUrl) {
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(options.waitForFetchUrl)
    })
    await waitFor(() => {
      expect((props.registerExecute as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1)
    })
  }
  if (!execute) throw new Error(`No execute registered for ${type}`)
  return { execute, props }
}

function setSession(blockId: string, key: string, value: unknown) {
  sessionStorage.setItem(`block_${blockId}_${key}`, JSON.stringify(value))
}

function postedJson(fetchMock: ReturnType<typeof vi.fn>, endpoint: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([input]) => String(input) === endpoint)
  if (!call) throw new Error(`No fetch call for ${endpoint}`)
  const init = call[1] as RequestInit | undefined
  if (typeof init?.body !== 'string') throw new Error(`No JSON body for ${endpoint}`)
  return JSON.parse(init.body) as Record<string, unknown>
}

const POLLING_MEDIA_BLOCKS = [
  {
    type: 'seedance',
    blockId: 'malformed-seedance',
    submitEndpoint: '/api/blocks/seedance/run',
    healthEndpoint: '/api/blocks/seedance/health',
    statusEndpoint: (jobId: string) => `/api/blocks/seedance/status/${jobId}`,
    cancelEndpoint: '/api/blocks/seedance/cancel/job-seedance',
    setup: (blockId: string) => {
      setSession(blockId, 'prompt', 'seedance prompt')
      setSession(blockId, 'mode', 'omni_reference')
    },
  },
  {
    type: 'gptImagePiapi',
    blockId: 'malformed-gptImagePiapi',
    submitEndpoint: '/api/blocks/gpt_image_piapi/run',
    healthEndpoint: '/api/blocks/gpt_image_piapi/health',
    statusEndpoint: (jobId: string) => `/api/blocks/gpt_image_piapi/status/${jobId}`,
    cancelEndpoint: '/api/blocks/gpt_image_piapi/cancel/job-gptImagePiapi',
    setup: (blockId: string) => setSession(blockId, 'prompt', 'gpt prompt'),
  },
  {
    type: 'nanoBanana2',
    blockId: 'malformed-nanoBanana2',
    submitEndpoint: '/api/blocks/nano_banana_2/run',
    healthEndpoint: '/api/blocks/nano_banana_2/health',
    statusEndpoint: (jobId: string) => `/api/blocks/nano_banana_2/status/${jobId}`,
    cancelEndpoint: '/api/blocks/nano_banana_2/cancel/job-nanoBanana2',
    setup: (blockId: string) => setSession(blockId, 'prompt', 'nano prompt'),
  },
]

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
    vi.useRealTimers()
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

  it.each([
    {
      type: 'seedance',
      blockId: 'execute-seedance',
      failEndpoint: '/api/blocks/seedance/run',
      healthEndpoint: '/api/blocks/seedance/health',
      setup: () => {
        setSession('execute-seedance', 'prompt', 'seedance prompt')
        setSession('execute-seedance', 'mode', 'omni_reference')
      },
      assertPayload: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          prompt: 'seedance prompt',
          mode: 'omni_reference',
          image_urls: ['/outputs/contract/image.png'],
          video_urls: ['/outputs/contract/video.mp4'],
          audio_urls: ['/outputs/contract/audio.mp3'],
        })
      },
    },
    {
      type: 'gptImagePiapi',
      blockId: 'execute-gptImagePiapi',
      failEndpoint: '/api/blocks/gpt_image_piapi/run',
      healthEndpoint: '/api/blocks/gpt_image_piapi/health',
      setup: () => setSession('execute-gptImagePiapi', 'prompt', 'gpt prompt'),
      assertPayload: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          prompt: 'gpt prompt',
          reference_image_urls: ['/outputs/contract/image.png'],
        })
      },
    },
    {
      type: 'nanoBanana2',
      blockId: 'execute-nanoBanana2',
      failEndpoint: '/api/blocks/nano_banana_2/run',
      healthEndpoint: '/api/blocks/nano_banana_2/health',
      setup: () => setSession('execute-nanoBanana2', 'prompt', 'nano prompt'),
      assertPayload: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          prompt: 'nano prompt',
          reference_image_urls: ['/outputs/contract/image.png'],
        })
      },
    },
    {
      type: 'datasetCreate',
      blockId: 'execute-datasetCreate',
      failEndpoint: '/api/blocks/dataset_create/run',
      healthEndpoint: '/api/blocks/dataset_create/health',
      setup: () => setSession('execute-datasetCreate', 'custom_prompt', 'dataset prompt'),
      assertPayload: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          custom_prompts: ['dataset prompt'],
          reference_image_urls: ['/outputs/contract/image.png'],
        })
      },
    },
    {
      type: 'imageUpscale',
      blockId: 'execute-imageUpscale',
      failEndpoint: '/api/blocks/image_upscale/upscale',
      healthEndpoint: '/api/blocks/image_upscale/settings',
      setup: () => {},
      assertPayload: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          source_images: ['/outputs/contract/image.png'],
        })
      },
    },
    {
      type: 'multimodalPromptWriter',
      blockId: 'execute-multimodalPromptWriter',
      failEndpoint: '/api/blocks/multimodal_prompt_writer/generate',
      healthEndpoint: '/api/blocks/multimodal_prompt_writer/settings',
      setup: () => {},
      assertPayload: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          upstream_text: 'contract prompt',
          image_urls: ['/outputs/contract/image.png'],
          video_url: '/outputs/contract/video.mp4',
          audio_url: '/outputs/contract/audio.mp3',
        })
      },
    },
  ])(
    '$type execute preserves backend-resolvable media refs in its backend payload',
    async ({ type, blockId, failEndpoint, healthEndpoint, setup, assertPayload }) => {
      setup()
      const fetchMock = mockFetch({ failEndpoints: [failEndpoint] })
      const { execute } = await renderAndCaptureExecute(type, {
        blockId,
        waitForFetchUrl: healthEndpoint,
      })

      await expect(execute(contractInputs(), new AbortController().signal)).rejects.toThrow('contract stop')

      assertPayload(postedJson(fetchMock, failEndpoint))
    },
  )

  it('comfyGen rejects a mapped video load node before submitting when source resolution has no video value', async () => {
    const blockId = 'execute-comfyGen-missing-video'
    setSession(blockId, 'workflow', JSON.stringify({
      '311': { class_type: 'LoadImage', inputs: { image: 'image.png' } },
      '417': { class_type: 'VHS_LoadVideo', inputs: { video: 'stale.mp4' } },
      '550': { class_type: 'VHS_VideoCombine', inputs: { images: ['417', 0] } },
    }))
    setSession(blockId, 'mappings', [
      { node_id: '311', field: 'image', portKind: 'image' },
      { node_id: '417', field: 'video', portKind: 'video' },
    ])
    const fetchMock = mockFetch({ failEndpoints: ['/api/blocks/comfy_gen/run'] })
    const { execute } = await renderAndCaptureExecute('comfyGen', {
      blockId,
      inputs: { image: contractInputs().image },
      waitForFetchUrl: '/api/blocks/comfy_gen/health',
    })

    await expect(execute({ image: contractInputs().image }, new AbortController().signal))
      .rejects.toThrow(/missing upstream video/i)

    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/blocks/comfy_gen/run')).toBe(false)
  })

  it('comfyGen maps image and video refs into file_inputs before submit', async () => {
    const blockId = 'execute-comfyGen-media-refs'
    setSession(blockId, 'workflow', JSON.stringify({
      '311': { class_type: 'LoadImage', inputs: { image: 'image.png' } },
      '417': { class_type: 'VHS_LoadVideo', inputs: { video: 'stale.mp4' } },
      '550': { class_type: 'VHS_VideoCombine', inputs: { images: ['417', 0] } },
    }))
    setSession(blockId, 'mappings', [
      { node_id: '311', field: 'image', portKind: 'image' },
      { node_id: '417', field: 'video', portKind: 'video' },
    ])
    const fetchMock = mockFetch({ failEndpoints: ['/api/blocks/comfy_gen/run'] })
    const { execute } = await renderAndCaptureExecute('comfyGen', {
      blockId,
      waitForFetchUrl: '/api/blocks/comfy_gen/health',
    })

    await expect(execute(contractInputs(), new AbortController().signal)).rejects.toThrow('contract stop')

    expect(postedJson(fetchMock, '/api/blocks/comfy_gen/run')).toMatchObject({
      file_inputs: {
        '311': { field: 'image', media_url: '/outputs/contract/image.png' },
        '417': { field: 'video', media_url: '/outputs/contract/video.mp4' },
      },
    })
  })

  it.each(POLLING_MEDIA_BLOCKS)(
    '$type rejects malformed submit success before polling an undefined job id',
    async ({ type, blockId, submitEndpoint, healthEndpoint, setup }) => {
      setup(blockId)
      const fetchMock = mockFetch({ malformedSuccessEndpoints: [submitEndpoint] })
      const { execute } = await renderAndCaptureExecute(type, {
        blockId,
        waitForFetchUrl: healthEndpoint,
      })

      vi.useFakeTimers()
      const run = execute(contractInputs(), new AbortController().signal)
      const runExpectation = expect(run).rejects.toThrow(/job/i)
      await vi.advanceTimersByTimeAsync(5500)

      await runExpectation
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/status/undefined'))).toBe(false)
      vi.useRealTimers()
    },
  )

  it.each(POLLING_MEDIA_BLOCKS)(
    '$type calls cancel endpoint when aborted after submit',
    async ({ type, blockId, submitEndpoint, healthEndpoint, cancelEndpoint, setup }) => {
      setup(blockId)
      const jobId = cancelEndpoint.split('/').pop()!
      const fetchMock = mockFetch({ jobEndpoints: { [submitEndpoint]: [jobId] } })
      const { execute } = await renderAndCaptureExecute(type, {
        blockId,
        waitForFetchUrl: healthEndpoint,
      })
      const controller = new AbortController()

      vi.useFakeTimers()
      const run = execute(contractInputs(), controller.signal)
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(submitEndpoint, expect.objectContaining({ method: 'POST' }))
      })
      const runExpectation = expect(run).rejects.toThrow(/abort/i)
      controller.abort()
      await vi.advanceTimersByTimeAsync(5500)

      expect(fetchMock).toHaveBeenCalledWith(cancelEndpoint, expect.objectContaining({ method: 'POST' }))
      await runExpectation
      vi.useRealTimers()
    },
  )

  it.each(POLLING_MEDIA_BLOCKS)(
    '$type rejects malformed ok status snapshots with a clear job error',
    async ({ type, blockId, submitEndpoint, healthEndpoint, statusEndpoint, cancelEndpoint, setup }) => {
      setup(blockId)
      const jobId = cancelEndpoint.split('/').pop()!
      const fetchMock = mockFetch({
        jobEndpoints: { [submitEndpoint]: [jobId] },
        endpointBodies: { [statusEndpoint(jobId)]: [{ ok: true }] },
      })
      const { execute } = await renderAndCaptureExecute(type, {
        blockId,
        waitForFetchUrl: healthEndpoint,
      })

      vi.useFakeTimers()
      const run = execute(contractInputs(), new AbortController().signal)
      const runExpectation = expect(run).rejects.toThrow(/job/i)
      await vi.advanceTimersByTimeAsync(5500)

      await runExpectation
      expect(fetchMock).toHaveBeenCalledWith(statusEndpoint(jobId))
      vi.useRealTimers()
    },
  )

  it.each(POLLING_MEDIA_BLOCKS)(
    '$type rejects completed status snapshots missing their output artifact',
    async ({ type, blockId, submitEndpoint, healthEndpoint, statusEndpoint, cancelEndpoint, setup }) => {
      setup(blockId)
      const jobId = cancelEndpoint.split('/').pop()!
      mockFetch({
        jobEndpoints: { [submitEndpoint]: [jobId] },
        endpointBodies: { [statusEndpoint(jobId)]: [{ ok: true, job: { status: 'COMPLETED' } }] },
      })
      const { execute } = await renderAndCaptureExecute(type, {
        blockId,
        waitForFetchUrl: healthEndpoint,
      })

      vi.useFakeTimers()
      const run = execute(contractInputs(), new AbortController().signal)
      const runExpectation = expect(run).rejects.toThrow(/completed without/i)
      await vi.advanceTimersByTimeAsync(5500)

      await runExpectation
      vi.useRealTimers()
    },
  )

  it.each(POLLING_MEDIA_BLOCKS)(
    '$type propagates failed status snapshot errors',
    async ({ type, blockId, submitEndpoint, healthEndpoint, statusEndpoint, cancelEndpoint, setup }) => {
      setup(blockId)
      const jobId = cancelEndpoint.split('/').pop()!
      mockFetch({
        jobEndpoints: { [submitEndpoint]: [jobId] },
        endpointBodies: { [statusEndpoint(jobId)]: [{ ok: true, job: { status: 'FAILED', error: 'provider failed' } }] },
      })
      const { execute } = await renderAndCaptureExecute(type, {
        blockId,
        waitForFetchUrl: healthEndpoint,
      })

      vi.useFakeTimers()
      const run = execute(contractInputs(), new AbortController().signal)
      const runExpectation = expect(run).rejects.toThrow(/provider failed/i)
      await vi.advanceTimersByTimeAsync(5500)

      await runExpectation
      vi.useRealTimers()
    },
  )
})
