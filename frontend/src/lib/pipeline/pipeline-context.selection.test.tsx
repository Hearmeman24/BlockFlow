import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { PipelineProvider, usePipeline } from './pipeline-context'
import { PipelineTabsProvider } from './tabs-context'

// Minimal flow JSON to seed the provider with one trunk block.
const flowJson = JSON.stringify({
  version: 1,
  blocks: [{ id: 'seed-1', type: 'text_block' }],
})

const wrapper = ({ children }: { children: ReactNode }) => (
  <PipelineTabsProvider>
    <PipelineProvider tabId="test-tab">{children}</PipelineProvider>
  </PipelineTabsProvider>
)

beforeEach(() => {
  // Provider persists to localStorage — reset between tests so state doesn't bleed.
  localStorage.clear()
})

describe('PipelineProvider selection state (sgs-ui-77x)', () => {
  it('selectedBlockId starts null and round-trips through setSelectedBlockId', () => {
    const { result } = renderHook(() => usePipeline(), { wrapper })
    expect(result.current.selectedBlockId).toBeNull()
    act(() => result.current.setSelectedBlockId('seed-1'))
    expect(result.current.selectedBlockId).toBe('seed-1')
    act(() => result.current.setSelectedBlockId(null))
    expect(result.current.selectedBlockId).toBeNull()
  })

  it('addBlock returns the id of the newly created block', () => {
    const { result } = renderHook(() => usePipeline(), { wrapper })
    let newId: string | undefined
    act(() => {
      newId = result.current.addBlock('text_block')
    })
    expect(typeof newId).toBe('string')
    expect(newId!.length).toBeGreaterThan(0)
    expect(result.current.pipeline.blocks.some((b) => b.id === newId)).toBe(true)
  })

  it('removeBlock clears selection when the removed block was selected', () => {
    const { result } = renderHook(() => usePipeline(), { wrapper })
    let newId: string | undefined
    act(() => {
      newId = result.current.addBlock('text_block')
    })
    act(() => result.current.setSelectedBlockId(newId!))
    expect(result.current.selectedBlockId).toBe(newId)
    act(() => result.current.removeBlock(newId!))
    expect(result.current.selectedBlockId).toBeNull()
  })

  it('removeBlock leaves selection alone when an unrelated block is removed', () => {
    const { result } = renderHook(() => usePipeline(), { wrapper })
    let aId: string | undefined
    let bId: string | undefined
    act(() => {
      aId = result.current.addBlock('text_block')
      bId = result.current.addBlock('text_block')
    })
    act(() => result.current.setSelectedBlockId(aId!))
    act(() => result.current.removeBlock(bId!))
    expect(result.current.selectedBlockId).toBe(aId)
  })
})
