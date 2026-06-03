import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAccumulatedUrls } from './use-accumulated-urls'

describe('useAccumulatedUrls', () => {
  it('returns empty displayUrls and selectedIndex 0 when given empty input', () => {
    const { result } = renderHook(() => useAccumulatedUrls([]))
    expect(result.current.displayUrls).toEqual([])
    expect(result.current.selectedIndex).toBe(0)
  })

  it('shows initial urls as displayUrls on first render', () => {
    const { result } = renderHook(() => useAccumulatedUrls(['a.mp4', 'b.mp4']))
    expect(result.current.displayUrls).toEqual(['a.mp4', 'b.mp4'])
    expect(result.current.selectedIndex).toBe(1)
  })

  it('accumulates new urls without dropping existing ones', () => {
    let urls = ['a.mp4']
    const { result, rerender } = renderHook(() => useAccumulatedUrls(urls))
    expect(result.current.displayUrls).toEqual(['a.mp4'])

    act(() => {
      urls = ['c.mp4', 'd.mp4']
    })
    rerender()

    expect(result.current.displayUrls).toEqual(['a.mp4', 'c.mp4', 'd.mp4'])
  })

  it('re-render with same urls is a no-op (selectedIndex stays stable)', () => {
    const urls = ['x.mp4', 'y.mp4']
    const { result, rerender } = renderHook(() => useAccumulatedUrls(urls))

    const indexAfterInit = result.current.selectedIndex

    act(() => {
      result.current.setSelectedIndex(0)
    })

    rerender()

    expect(result.current.selectedIndex).toBe(0)
    expect(result.current.displayUrls).toEqual(['x.mp4', 'y.mp4'])
    // key hasn't changed so no effect ran — index stays at what we set
    void indexAfterInit
  })

  it('jumps selectedIndex to latest url when new urls arrive', () => {
    let urls = ['a.mp4']
    const { result, rerender } = renderHook(() => useAccumulatedUrls(urls))
    expect(result.current.selectedIndex).toBe(0)

    act(() => {
      urls = ['b.mp4', 'c.mp4']
    })
    rerender()

    // accumulated = ['a.mp4', 'b.mp4', 'c.mp4'] → last index = 2
    expect(result.current.selectedIndex).toBe(2)
    expect(result.current.displayUrls).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
  })

  it('replace mode swaps instead of merging', () => {
    let urls = ['a.jpg']
    const { result, rerender } = renderHook(() =>
      useAccumulatedUrls(urls, { replace: true }),
    )
    expect(result.current.displayUrls).toEqual(['a.jpg'])
    expect(result.current.selectedIndex).toBe(0)

    act(() => {
      urls = ['b.jpg', 'c.jpg']
    })
    rerender()

    expect(result.current.displayUrls).toEqual(['b.jpg', 'c.jpg'])
    expect(result.current.selectedIndex).toBe(0)
  })

  it('replace mode on first render sets selectedIndex to 0', () => {
    const { result } = renderHook(() =>
      useAccumulatedUrls(['img1.jpg', 'img2.jpg'], { replace: true }),
    )
    expect(result.current.displayUrls).toEqual(['img1.jpg', 'img2.jpg'])
    expect(result.current.selectedIndex).toBe(0)
  })

  it('setSelectedIndex allows manual navigation', () => {
    const { result } = renderHook(() =>
      useAccumulatedUrls(['a.mp4', 'b.mp4', 'c.mp4']),
    )

    act(() => {
      result.current.setSelectedIndex(1)
    })

    expect(result.current.selectedIndex).toBe(1)
  })

  it('does not duplicate urls already in accumulation', () => {
    let urls = ['a.mp4', 'b.mp4']
    const { result, rerender } = renderHook(() => useAccumulatedUrls(urls))

    act(() => {
      urls = ['b.mp4', 'c.mp4']
    })
    rerender()

    expect(result.current.displayUrls).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
  })
})
