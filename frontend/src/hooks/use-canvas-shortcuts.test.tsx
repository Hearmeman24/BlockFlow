import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useCanvasShortcuts, isFocusInForm } from './use-canvas-shortcuts'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { ShortcutPrefsProvider } from '@/lib/settings/shortcuts-client'
import { registerBlockDef } from '@/lib/pipeline/registry'

beforeAll(() => {
  registerBlockDef({
    type: 'stub_77x',
    label: 'Stub',
    description: '',
    size: 'sm',
    inputs: [],
    outputs: [],
    canStart: true,
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
})

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', { status: 200 }),
  )
})

// Each renderHook call must get a fresh tabId — PipelineProvider persists to
// localStorage keyed by tabId, so sharing one across tests bleeds state.
let tabCounter = 0
function makeWrapper() {
  const tabId = `hook-test-${++tabCounter}-${Math.random().toString(36).slice(2, 6)}`
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <PipelineTabsProvider>
      <PipelineProvider tabId={tabId}>
        <ShortcutPrefsProvider>{children}</ShortcutPrefsProvider>
      </PipelineProvider>
    </PipelineTabsProvider>
  )
  Wrapper.displayName = 'CanvasShortcutsTestWrapper'
  return Wrapper
}

/** Mount the hook together with usePipeline so tests can drive selection state. */
function useHarness() {
  const pipeline = usePipeline()
  const shortcuts = useCanvasShortcuts()
  return { pipeline, shortcuts }
}

describe('isFocusInForm', () => {
  it('returns true for <input> and <textarea>', () => {
    const input = document.createElement('input')
    expect(isFocusInForm(input)).toBe(true)
    const ta = document.createElement('textarea')
    expect(isFocusInForm(ta)).toBe(true)
  })

  it('returns true for contenteditable (attribute set)', () => {
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    document.body.appendChild(div)
    expect(isFocusInForm(div)).toBe(true)
    document.body.removeChild(div)
  })

  it('returns true when inside [role="dialog"]', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const inner = document.createElement('span')
    dialog.appendChild(inner)
    document.body.appendChild(dialog)
    expect(isFocusInForm(inner)).toBe(true)
    document.body.removeChild(dialog)
  })

  it('returns false for plain elements', () => {
    expect(isFocusInForm(document.createElement('div'))).toBe(false)
  })
})

describe('useCanvasShortcuts dispatch', () => {
  function fireKey(key: string, opts: { shiftKey?: boolean } = {}) {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey: opts.shiftKey ?? false }),
    )
  }

  it('Escape clears selection', async () => {
    const { result } = renderHook(useHarness, { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.pipeline).toBeTruthy())
    let bId: string | undefined
    act(() => {
      bId = result.current.pipeline.addBlock('stub_77x')
    })
    act(() => result.current.pipeline.setSelectedBlockId(bId!))
    expect(result.current.pipeline.selectedBlockId).toBe(bId)
    act(() => {
      fireKey('Escape')
    })
    await waitFor(() =>
      expect(result.current.pipeline.selectedBlockId).toBeNull(),
    )
  })

  it('ArrowRight moves selection to the next block', async () => {
    const { result } = renderHook(useHarness, { wrapper: makeWrapper() })
    let a: string | undefined
    let b: string | undefined
    act(() => {
      a = result.current.pipeline.addBlock('stub_77x')
      b = result.current.pipeline.addBlock('stub_77x')
    })
    act(() => result.current.pipeline.setSelectedBlockId(a!))
    act(() => fireKey('ArrowRight'))
    await waitFor(() =>
      expect(result.current.pipeline.selectedBlockId).toBe(b),
    )
  })

  it('arrow keys with no selection select the first block (frictionless entry)', async () => {
    const { result } = renderHook(useHarness, { wrapper: makeWrapper() })
    act(() => {
      result.current.pipeline.addBlock('stub_77x')
      result.current.pipeline.addBlock('stub_77x')
    })
    await waitFor(() =>
      expect(result.current.pipeline.pipeline.blocks.length).toBe(2),
    )
    const firstId = result.current.pipeline.pipeline.blocks[0].id
    expect(result.current.pipeline.selectedBlockId).toBeNull()
    act(() => fireKey('ArrowRight'))
    await waitFor(() =>
      expect(result.current.pipeline.selectedBlockId).toBe(firstId),
    )
  })

  it('ArrowLeft with no selection also selects the first block', async () => {
    const { result } = renderHook(useHarness, { wrapper: makeWrapper() })
    act(() => {
      result.current.pipeline.addBlock('stub_77x')
    })
    await waitFor(() =>
      expect(result.current.pipeline.pipeline.blocks.length).toBe(1),
    )
    const firstId = result.current.pipeline.pipeline.blocks[0].id
    act(() => fireKey('ArrowLeft'))
    await waitFor(() =>
      expect(result.current.pipeline.selectedBlockId).toBe(firstId),
    )
  })

  it('arrow keys with no blocks at all are a no-op (nothing to select)', async () => {
    const { result } = renderHook(useHarness, { wrapper: makeWrapper() })
    expect(result.current.pipeline.pipeline.blocks).toHaveLength(0)
    act(() => fireKey('ArrowRight'))
    expect(result.current.pipeline.selectedBlockId).toBeNull()
  })

  it('A with no selection is a no-op (picker stays closed)', async () => {
    const { result } = renderHook(useHarness, { wrapper: makeWrapper() })
    act(() => {
      result.current.pipeline.addBlock('stub_77x')
    })
    act(() => fireKey('A'))
    expect(result.current.shortcuts.pickerState.open).toBe(false)
  })

  it('A with selection opens the picker', async () => {
    const { result } = renderHook(useHarness, { wrapper: makeWrapper() })
    let a: string | undefined
    act(() => {
      a = result.current.pipeline.addBlock('stub_77x')
    })
    act(() => result.current.pipeline.setSelectedBlockId(a!))
    act(() => fireKey('A'))
    await waitFor(() =>
      expect(result.current.shortcuts.pickerState.open).toBe(true),
    )
  })

  it('suppresses when focus is in an <input>', async () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    const { result } = renderHook(useHarness, { wrapper: makeWrapper() })
    let a: string | undefined
    let b: string | undefined
    act(() => {
      a = result.current.pipeline.addBlock('stub_77x')
      b = result.current.pipeline.addBlock('stub_77x')
    })
    act(() => result.current.pipeline.setSelectedBlockId(a!))
    act(() => fireKey('ArrowRight'))
    expect(result.current.pipeline.selectedBlockId).toBe(a)
    document.body.removeChild(input)
  })
})
