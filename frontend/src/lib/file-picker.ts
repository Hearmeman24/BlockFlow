// Per-slug "last used directory" file picker.
//
// On Chromium browsers that expose window.showOpenFilePicker, we save the
// FileSystemFileHandle of the chosen file in IndexedDB keyed by slug, and
// pass it back as `startIn` next time the same slug opens a picker — the
// browser opens the picker in that file's parent directory.
//
// On Firefox/Safari we fall back to a transient <input type="file"> click,
// which uses the browser's single shared "last directory" — the existing
// behavior.

type AcceptMap = Record<string, string[]>

export interface PickFilesOptions {
  slug: string
  accept?: string
  multiple?: boolean
  description?: string
}

const DB_NAME = 'sgs-ui-file-picker'
const DB_VERSION = 1
const STORE = 'handles'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no indexedDB'))
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function getHandle(slug: string): Promise<FileSystemFileHandle | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(slug)
      req.onsuccess = () => resolve((req.result as FileSystemFileHandle | undefined) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function setHandle(slug: string, handle: FileSystemFileHandle): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(handle, slug)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // ignore — persistence is best-effort
  }
}

// Convert a comma-separated accept string ("image/*,video/*", ".cube",
// "image/png", ".json,application/json") into the File System Access API's
// `types` array. MIME types accumulate under one entry; bare extensions are
// attached to it.
function parseAccept(accept: string | undefined, description: string): { types?: { description?: string; accept: AcceptMap }[] } {
  if (!accept) return {}
  const parts = accept.split(',').map((s) => s.trim()).filter(Boolean)
  const acceptMap: AcceptMap = {}
  const looseExts: string[] = []
  for (const p of parts) {
    if (p.startsWith('.')) {
      looseExts.push(p)
    } else if (p.includes('/')) {
      acceptMap[p] = acceptMap[p] || []
    }
  }
  if (looseExts.length > 0) {
    // Attach extensions under a generic */* entry; if there's a MIME already,
    // attach to the first one.
    const target = Object.keys(acceptMap)[0]
    if (target) {
      acceptMap[target] = [...new Set([...(acceptMap[target] || []), ...looseExts])]
    } else {
      acceptMap['*/*'] = looseExts
    }
  }
  if (Object.keys(acceptMap).length === 0) return {}
  return { types: [{ description, accept: acceptMap }] }
}

interface ShowOpenFilePickerOptions {
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: { description?: string; accept: AcceptMap }[]
  startIn?: FileSystemFileHandle | FileSystemDirectoryHandle | string
  id?: string
}

// The browser remembers the last-used directory per `id`. Without an `id`,
// every picker on the origin shares one "recently used" directory and our
// startIn is ignored. Chromium accepts at most 32 chars, [a-z0-9_].
function pickerIdFor(slug: string): string {
  return slug.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 32)
}

type ShowOpenFilePicker = (opts?: ShowOpenFilePickerOptions) => Promise<FileSystemFileHandle[]>

function getNativePicker(): ShowOpenFilePicker | null {
  if (typeof window === 'undefined') return null
  const fn = (window as unknown as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker
  return typeof fn === 'function' ? fn : null
}

async function pickWithNative(opts: PickFilesOptions, picker: ShowOpenFilePicker): Promise<File[] | null> {
  const stored = await getHandle(opts.slug)
  const typeSpec = parseAccept(opts.accept, opts.description ?? 'Files')
  try {
    const handles = await picker({
      multiple: opts.multiple ?? false,
      excludeAcceptAllOption: false,
      id: pickerIdFor(opts.slug),
      ...typeSpec,
      ...(stored ? { startIn: stored } : {}),
    })
    if (!handles || handles.length === 0) return null
    // Persist the first chosen handle as the next startIn anchor. Await so
    // an immediate follow-up pickFiles call sees the new handle.
    await setHandle(opts.slug, handles[0])
    const files = await Promise.all(handles.map((h) => h.getFile()))
    return files
  } catch (err) {
    // AbortError → user cancelled. NotAllowedError / SecurityError → fall back.
    if (err instanceof DOMException && err.name === 'AbortError') return null
    return pickWithInput(opts)
  }
}

function pickWithInput(opts: PickFilesOptions): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (opts.accept) input.accept = opts.accept
    if (opts.multiple) input.multiple = true
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    let settled = false
    const settle = (value: File[] | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }
    input.addEventListener('change', () => {
      const files = input.files ? Array.from(input.files) : []
      settle(files.length > 0 ? files : null)
    })
    // The "cancel" event fires when the user dismisses the picker (Chromium 113+,
    // Safari 16.4+, Firefox 91+). It's our only signal for cancellation in the
    // fallback path.
    input.addEventListener('cancel', () => settle(null))
    document.body.appendChild(input)
    input.click()
  })
}

export async function pickFiles(opts: PickFilesOptions): Promise<File[] | null> {
  const native = getNativePicker()
  if (native) return pickWithNative(opts, native)
  return pickWithInput(opts)
}
