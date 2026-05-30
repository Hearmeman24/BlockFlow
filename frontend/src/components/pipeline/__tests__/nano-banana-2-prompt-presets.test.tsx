import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { blockDef } from '../custom_blocks/generated/nano_banana_2'

type ExecuteFn = (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
}

function mockFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/blocks/nano_banana_2/health') {
      return jsonResponse({ ok: true, runpod_key_present: true })
    }
    if (url === '/api/prompt-library' && (!init || init.method === undefined || init.method === 'GET')) {
      return jsonResponse({
        ok: true,
        prompts: [
          {
            id: 'user-1',
            name: 'Product hero edit',
            type: 'user',
            content: 'Turn the product photo into a crisp catalog hero image.',
            created_at: '2026-05-29T00:00:00Z',
          },
        ],
      })
    }
    if (url === '/api/blocks/nano_banana_2/run') {
      return jsonResponse({ ok: true, job_id: 'nb2-job' })
    }
    if (url === '/api/blocks/nano_banana_2/status/nb2-job') {
      return jsonResponse({ ok: true, job: { job_id: 'nb2-job', status: 'COMPLETED', image_url: 'https://cdn.test/out.png' } })
    }
    if (url.startsWith('/api/prompt-library')) {
      return jsonResponse({
        ok: true,
        prompt: {
          id: 'new-user',
          name: 'Saved',
          type: 'user',
          content: 'Saved content',
          created_at: '2026-05-29T00:00:00Z',
        },
      })
    }
    return Promise.reject(new Error(`Unhandled fetch: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderBlock(blockId = 'nb2') {
  const setOutput = vi.fn()
  const setStatusMessage = vi.fn()
  let execute: ExecuteFn | null = null
  const Comp = blockDef.component
  render(
    <Comp
      blockId={blockId}
      inputs={{
        image: [
          { kind: 'image-ref', local: '/outputs/a.png', url: 'https://tmpfiles.test/a.png' },
          'https://tmpfiles.test/b.png',
        ],
      }}
      setOutput={setOutput}
      registerExecute={(fn) => {
        execute = fn as ExecuteFn
      }}
      setStatusMessage={setStatusMessage}
    />,
  )
  return { setOutput, setStatusMessage, getExecute: () => execute }
}

describe('Nano Banana 2 prompt presets', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
    mockFetch()
  })

  it('does not describe itself as a single-image block', () => {
    expect(blockDef.label).toBe('Nano Banana 2 (RunPod)')
    expect(blockDef.description.toLowerCase()).not.toContain('single-image')
    expect(blockDef.description.toLowerCase()).toContain('multi-image')
  })

  it('fills the prompt textarea from a saved user prompt', async () => {
    const user = userEvent.setup()
    renderBlock()

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/prompt-library'))

    await user.click(screen.getByRole('button', { name: /prompt presets/i }))
    await user.click(await screen.findByText('Product hero edit'))

    expect(screen.getByLabelText('Prompt')).toHaveValue('Turn the product photo into a crisp catalog hero image.')
  })

  it('opens the save dialog with the current prompt as a user prompt', async () => {
    const user = userEvent.setup()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    renderBlock()

    const prompt = screen.getByLabelText('Prompt')
    await user.clear(prompt)
    await user.type(prompt, 'Make these references feel like one editorial campaign.')

    await user.click(screen.getByRole('button', { name: /save prompt/i }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('textbox', { name: /content/i })).toHaveValue(
      'Make these references feel like one editorial campaign.',
    )
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'Editorial campaign')
    await user.click(within(dialog).getByRole('button', { name: /^save$/i }))

    expect(fetchMock).toHaveBeenCalledWith('/api/prompt-library', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        name: 'Editorial campaign',
        type: 'user',
        content: 'Make these references feel like one editorial campaign.',
      }),
    }))
  })

  it('submits every upstream and restored local reference image', async () => {
    sessionStorage.setItem('block_nb2_local_refs', JSON.stringify(['https://tmpfiles.test/local.png']))
    sessionStorage.setItem('block_nb2_prompt', JSON.stringify('Unify these references into one final image.'))
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/blocks/nano_banana_2/health') {
        return jsonResponse({ ok: true, runpod_key_present: true })
      }
      if (url === '/api/prompt-library' && (!init || init.method === undefined || init.method === 'GET')) {
        return jsonResponse({ ok: true, prompts: [] })
      }
      if (url === '/api/blocks/nano_banana_2/run') {
        return jsonResponse({ ok: false, error: 'stop after submit' })
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`))
    })

    const { getExecute } = renderBlock('nb2')
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/blocks/nano_banana_2/health'))

    await expect(getExecute()!({
      image: [
        { kind: 'image-ref', local: '/outputs/a.png', url: 'https://tmpfiles.test/a.png' },
        'https://tmpfiles.test/b.png',
      ],
    }, new AbortController().signal)).rejects.toThrow('stop after submit')

    expect(fetch).toHaveBeenCalledWith('/api/blocks/nano_banana_2/run', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        prompt: 'Unify these references into one final image.',
        quality: '1k',
        aspect_ratio: '1:1',
        reference_image_urls: [
          '/outputs/a.png',
          'https://tmpfiles.test/b.png',
          'https://tmpfiles.test/local.png',
        ],
      }),
    }))
  })
})
