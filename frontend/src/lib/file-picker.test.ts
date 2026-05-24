import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// We don't use fake-indexeddb here because its structured-clone semantics
// reject plain objects containing functions — and our test "handles" expose
// a getFile() method. Stub a tiny reference-equality IDB instead so tests can
// store and retrieve the actual handle object.
const memoryStore = new Map<string, unknown>()
const fakeIdb = {
  open: () => {
    const req: { onupgradeneeded: (() => void) | null; onsuccess: (() => void) | null; onerror: (() => void) | null; result: unknown } = {
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      result: {
        objectStoreNames: { contains: () => true },
        transaction: () => ({
          objectStore: () => ({
            get: (key: string) => {
              const r: { onsuccess: (() => void) | null; onerror: (() => void) | null; result: unknown } = { onsuccess: null, onerror: null, result: memoryStore.get(key) }
              queueMicrotask(() => r.onsuccess?.())
              return r
            },
            put: (value: unknown, key: string) => {
              memoryStore.set(key, value)
              return {}
            },
          }),
          oncomplete: null,
          onerror: null,
          set oncomplete(fn: (() => void) | null) { if (fn) queueMicrotask(fn) },
        }),
      },
    }
    queueMicrotask(() => req.onsuccess?.())
    return req
  },
}
vi.stubGlobal('indexedDB', fakeIdb)

import { pickFiles } from './file-picker'

type ShowOpenFilePickerCall = {
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: { description?: string; accept: Record<string, string[]> }[]
  startIn?: unknown
}

function makeFile(name: string, type = 'text/plain'): File {
  return new File([new Blob(['x'])], name, { type })
}

function makeHandle(file: File): { getFile: () => Promise<File> } {
  return { getFile: () => Promise.resolve(file) }
}

describe('pickFiles — native (showOpenFilePicker) path', () => {
  let nativeCalls: ShowOpenFilePickerCall[]
  beforeEach(() => {
    nativeCalls = []
    memoryStore.clear()
  })

  afterEach(() => {
    // Each test installs its own; clean up so other tests start fresh.
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker
  })

  it('first call has no startIn; second call passes back the previously picked handle', async () => {
    const file = makeFile('img.png', 'image/png')
    const handle = makeHandle(file)
    ;(window as unknown as { showOpenFilePicker: (opts: ShowOpenFilePickerCall) => Promise<unknown[]> }).showOpenFilePicker = async (opts) => {
      nativeCalls.push(opts)
      return [handle]
    }

    const first = await pickFiles({ slug: 'unit-test-slug-1', accept: 'image/*', description: 'Images' })
    expect(first?.[0]).toBe(file)
    expect(nativeCalls[0].startIn).toBeUndefined()
    expect(nativeCalls[0].types).toEqual([{ description: 'Images', accept: { 'image/*': [] } }])

    const second = await pickFiles({ slug: 'unit-test-slug-1', accept: 'image/*' })
    expect(second?.[0]).toBe(file)
    // The handle persisted from the first call must come back as startIn.
    expect(nativeCalls[1].startIn).toBe(handle)
  })

  it('different slugs persist independently', async () => {
    const fileA = makeFile('a.png', 'image/png')
    const fileB = makeFile('b.mp4', 'video/mp4')
    const handleA = makeHandle(fileA)
    const handleB = makeHandle(fileB)
    let next: typeof handleA | typeof handleB = handleA
    ;(window as unknown as { showOpenFilePicker: (opts: ShowOpenFilePickerCall) => Promise<unknown[]> }).showOpenFilePicker = async (opts) => {
      nativeCalls.push(opts)
      return [next]
    }

    next = handleA
    await pickFiles({ slug: 'slug-A', accept: 'image/*' })
    next = handleB
    await pickFiles({ slug: 'slug-B', accept: 'video/*' })

    // Now pick again from each slug; each should see its own handle as startIn.
    next = handleA
    await pickFiles({ slug: 'slug-A', accept: 'image/*' })
    expect(nativeCalls.at(-1)?.startIn).toBe(handleA)

    next = handleB
    await pickFiles({ slug: 'slug-B', accept: 'video/*' })
    expect(nativeCalls.at(-1)?.startIn).toBe(handleB)
  })

  it('returns null when the user cancels (AbortError)', async () => {
    ;(window as unknown as { showOpenFilePicker: () => Promise<unknown[]> }).showOpenFilePicker = async () => {
      throw new DOMException('cancelled', 'AbortError')
    }
    const result = await pickFiles({ slug: 'slug-cancel', accept: 'image/*' })
    expect(result).toBeNull()
  })

  it('falls back to <input> on non-Abort errors (e.g. SecurityError)', async () => {
    ;(window as unknown as { showOpenFilePicker: () => Promise<unknown[]> }).showOpenFilePicker = async () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    // Spy on createElement to capture the fallback input and trigger 'cancel' so the promise resolves.
    const origCreate = document.createElement.bind(document)
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag)
      if (tag === 'input') {
        queueMicrotask(() => el.dispatchEvent(new Event('cancel')))
      }
      return el
    })
    const result = await pickFiles({ slug: 'slug-fallback', accept: 'image/*' })
    expect(result).toBeNull()
    createSpy.mockRestore()
  })

  it('translates bare extensions like .cube into a types entry', async () => {
    ;(window as unknown as { showOpenFilePicker: (opts: ShowOpenFilePickerCall) => Promise<unknown[]> }).showOpenFilePicker = async (opts) => {
      nativeCalls.push(opts)
      return [makeHandle(makeFile('x.cube'))]
    }
    await pickFiles({ slug: 'slug-cube', accept: '.cube', description: 'LUT' })
    expect(nativeCalls[0].types).toEqual([
      { description: 'LUT', accept: { '*/*': ['.cube'] } },
    ])
  })

  it('mixes MIME and bare extensions (".json,application/json") into one types entry', async () => {
    ;(window as unknown as { showOpenFilePicker: (opts: ShowOpenFilePickerCall) => Promise<unknown[]> }).showOpenFilePicker = async (opts) => {
      nativeCalls.push(opts)
      return [makeHandle(makeFile('x.json', 'application/json'))]
    }
    await pickFiles({ slug: 'slug-json', accept: '.json,application/json', description: 'Workflow JSON' })
    expect(nativeCalls[0].types).toEqual([
      { description: 'Workflow JSON', accept: { 'application/json': ['.json'] } },
    ])
  })
})

describe('pickFiles — fallback (<input>) path', () => {
  afterEach(() => {
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker
  })

  it('resolves with the chosen file from the <input> change event', async () => {
    // No showOpenFilePicker installed → fallback path.
    const file = makeFile('ff.png', 'image/png')
    const origCreate = document.createElement.bind(document)
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag)
      if (tag === 'input') {
        queueMicrotask(() => {
          Object.defineProperty(el, 'files', { value: [file], configurable: true })
          el.dispatchEvent(new Event('change'))
        })
      }
      return el
    })
    const result = await pickFiles({ slug: 'fallback-slug', accept: 'image/*' })
    expect(result).toEqual([file])
    createSpy.mockRestore()
  })

  it('resolves null on the cancel event', async () => {
    const origCreate = document.createElement.bind(document)
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag)
      if (tag === 'input') {
        queueMicrotask(() => el.dispatchEvent(new Event('cancel')))
      }
      return el
    })
    const result = await pickFiles({ slug: 'fallback-cancel', accept: 'image/*' })
    expect(result).toBeNull()
    createSpy.mockRestore()
  })
})
