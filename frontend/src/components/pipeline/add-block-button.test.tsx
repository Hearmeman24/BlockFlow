import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NodeTypeDef } from '@/lib/pipeline/registry'
import { AddBlockButton } from './add-block-button'

function block(
  type: string,
  label: string,
  description: string,
): NodeTypeDef {
  return {
    type,
    label,
    description,
    size: 'sm',
    canStart: true,
    inputs: [],
    outputs: [],
  }
}

describe('AddBlockButton grouped picker', () => {
  it('renders a compact categorized menu with Suggested pinned first', async () => {
    const user = userEvent.setup()
    render(
      <AddBlockButton
        upstreamType="uploadImageToTmpfiles"
        onAdd={vi.fn()}
        validTypes={[
          block('elevenLabsTts', 'ElevenLabs v3 (TTS)', 'Text-to-speech via the ElevenLabs v3 model.'),
          block('videoLoader', 'Video Loader', 'Load a video file and pass it downstream.'),
          block('promptWriter', 'Prompt Writer (OpenRouter)', 'Generate an image or video prompt using an LLM.'),
          block(
            'uploadImageToTmpfiles',
            'Upload Image',
            'Upload one or more images saved locally and to a public URL for remote endpoints automatically.',
          ),
          block('datasetCaption', 'Dataset Caption', 'Auto-caption every image in a dataset via a vision LLM.'),
          block('seedance', 'Seedance 2 (PiAPI)', 'ByteDance Seedance 2 via PiAPI.'),
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /add block/i }))
    const menu = screen.getByRole('menu')

    expect(menu).toHaveClass('w-[min(440px,calc(100vw-2rem))]')

    const headings = within(menu).getAllByTestId('block-picker-group-label')
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'Suggested',
      'Image',
      'Video',
      'Prompts',
      'LoRA',
      'Misc',
    ])

    const description = within(menu).getByText(/public URL for remote endpoints/i)
    expect(description).toHaveClass('line-clamp-2')

    expect(within(menu).getByText('Seedance 2 (PiAPI)')).toBeInTheDocument()
    expect(within(menu).getByText('Suggested')).toBeInTheDocument()
  })

  it('renders starter suggestions for an empty pipeline picker', async () => {
    const user = userEvent.setup()
    render(
      <AddBlockButton
        suggestionContext={{ kind: 'starter' }}
        onAdd={vi.fn()}
        validTypes={[
          block('seedance', 'Seedance 2 (PiAPI)', 'ByteDance Seedance 2 via PiAPI.'),
          block('promptWriter', 'Prompt Writer (OpenRouter)', 'Generate an image or video prompt using an LLM.'),
          block('videoLoader', 'Video Loader', 'Load a video file and pass it downstream.'),
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /add block/i }))
    const menu = screen.getByRole('menu')

    const headings = within(menu).getAllByTestId('block-picker-group-label')
    expect(headings.map((heading) => heading.textContent)).toEqual(['Suggested'])
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Video LoaderLoad a video file and pass it downstream.',
      'Prompt Writer (OpenRouter)Generate an image or video prompt using an LLM.',
      'Seedance 2 (PiAPI)ByteDance Seedance 2 via PiAPI.',
    ])
  })

  it('filters visible block rows from the search field', async () => {
    const user = userEvent.setup()
    render(
      <AddBlockButton
        onAdd={vi.fn()}
        validTypes={[
          block('videoLoader', 'Video Loader', 'Load a video file and pass it downstream.'),
          block('promptWriter', 'Prompt Writer (OpenRouter)', 'Generate an image or video prompt using an LLM.'),
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /add block/i }))
    const menu = screen.getByRole('menu')

    await user.type(within(menu).getByPlaceholderText('Search blocks...'), 'prompt')

    expect(within(menu).getByText('Prompt Writer (OpenRouter)')).toBeInTheDocument()
    expect(within(menu).queryByText('Video Loader')).not.toBeInTheDocument()
  })
})
