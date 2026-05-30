/**
 * Regression: the pipeline runner resets every block's outputs to {} at the
 * start of a run (pipeline-context: freshStates). canStart producer blocks
 * must therefore RE-EMIT their output from inside registerExecute — the
 * edit-time useEffect emit does not re-fire after the reset because its deps
 * (localUrl/remoteUrl) are unchanged.
 *
 * Before the fix, video_loader's execute only set a status message, so the
 * upstream VideoRef was lost mid-run and downstream blocks (seedance,
 * multimodal_prompt_writer) resolved inputs.video to undefined → 0 refs.
 * upload_image_to_tmpfiles already re-emits, which is why image survived.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { blockDef } from '../custom_blocks/generated/video_loader'
import { toPublicUrls } from '@/lib/video-ref'

type ExecuteFn = (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

function renderBlock(blockId: string) {
  const setOutput = vi.fn()
  const setStatusMessage = vi.fn()
  let execute: ExecuteFn | null = null
  const Comp = blockDef.component
  render(
    <Comp
      blockId={blockId}
      inputs={{}}
      setOutput={setOutput}
      registerExecute={(fn) => {
        execute = fn as ExecuteFn
      }}
      setStatusMessage={setStatusMessage}
    />,
  )
  return { setOutput, setStatusMessage, getExecute: () => execute }
}

describe('video_loader run-time re-emit', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('re-emits a VideoRef from execute when URLs come from restored session state (no re-selected file)', async () => {
    const id = 'vl1'
    // Simulate a "Done" loader after a session restore: both URLs persisted,
    // but selectedFile is null (the File object never survives a reload).
    sessionStorage.setItem(`block_${id}_local_url`, JSON.stringify('/outputs/clip.mp4'))
    sessionStorage.setItem(
      `block_${id}_remote_url`,
      JSON.stringify('https://tmpfiles.org/dl/abc/clip.mp4'),
    )

    const { getExecute, setOutput } = renderBlock(id)
    const execute = getExecute()
    expect(execute).toBeTypeOf('function')

    setOutput.mockClear() // ignore the edit-time emit; assert the run-time one
    await execute!({}, new AbortController().signal)

    expect(setOutput).toHaveBeenCalledWith('video', [
      { kind: 'video-ref', local: '/outputs/clip.mp4', url: 'https://tmpfiles.org/dl/abc/clip.mp4' },
    ])

    // And the emitted value must yield a PiAPI/OpenRouter-fetchable URL.
    const emitted = setOutput.mock.calls.find((c) => c[0] === 'video')?.[1]
    expect(toPublicUrls(emitted)).toEqual(['https://tmpfiles.org/dl/abc/clip.mp4'])
  })

  it('throws from execute when nothing is loaded', async () => {
    const { getExecute } = renderBlock('vl2')
    await expect(getExecute()!({}, new AbortController().signal)).rejects.toThrow(/select a video/i)
  })
})
