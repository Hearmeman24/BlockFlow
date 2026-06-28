import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { McpJob } from '@/lib/api'
import { McpPlaceholderCard, isActiveJob } from './mcp-placeholder-card'

function job(over: Partial<McpJob> = {}): McpJob {
  return {
    job_id: 'j1', status: 'RUNNING', batch_id: 'b1', prompt: 'a red fox in the snow',
    seed: 42, url: '', error: '',
    overrides: { '2.steps': '12', '2.sampler_name': 'lcm', '2.seed': '99', '6.text': 'a red fox in the snow' },
    progress: null, created_at: null, updated_at: null, ...over,
  }
}

describe('isActiveJob', () => {
  it('treats non-terminal statuses as active', () => {
    expect(isActiveJob(job({ status: 'RUNNING' }))).toBe(true)
    expect(isActiveJob(job({ status: 'SUBMITTING' }))).toBe(true)
  })
  it('treats terminal statuses as inactive', () => {
    for (const s of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'COMPLETED_WITH_WARNING']) {
      expect(isActiveJob(job({ status: s }))).toBe(false)
    }
  })
})

describe('McpPlaceholderCard', () => {
  it('shows the full prompt and status, mirroring run-card chrome', () => {
    render(<McpPlaceholderCard job={job()} />)
    expect(screen.getByText('a red fox in the snow')).toBeInTheDocument()
    expect(screen.getByText('RUNNING')).toBeInTheDocument()       // header status badge
    expect(screen.getByText('ComfyGen (MCP)')).toBeInTheDocument() // block chip
    expect(screen.getByText(/steps 12/)).toBeInTheDocument()       // settings dial
    expect(screen.getByText(/sampler lcm/)).toBeInTheDocument()
  })

  it('drops seed and the prompt text field from the settings line', () => {
    render(<McpPlaceholderCard job={job()} />)
    expect(screen.queryByText(/seed/)).not.toBeInTheDocument()
    expect(screen.queryByText(/text a red fox/)).not.toBeInTheDocument()
  })

  it('renders the full prompt with no line clamp (whitespace-pre-wrap)', () => {
    const long = 'word '.repeat(120).trim()
    render(<McpPlaceholderCard job={job({ prompt: long })} />)
    const el = screen.getByText(long)
    expect(el.className).toContain('whitespace-pre-wrap')
    expect(el.className).not.toContain('line-clamp')
  })
})
