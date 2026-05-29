import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { KeyboardTab } from './keyboard-tab'
import { ShortcutPrefsProvider } from '@/lib/settings/shortcuts-client'
import { KEYMAP } from '@/lib/pipeline/keymap'

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.method === 'PUT') {
      return new Response(init.body as string, { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
})

function renderTab() {
  return render(
    <ShortcutPrefsProvider>
      <KeyboardTab />
    </ShortcutPrefsProvider>,
  )
}

describe('KeyboardTab', () => {
  it('renders a row per KEYMAP entry, plus the master row', async () => {
    renderTab()
    await waitFor(() =>
      expect(screen.getByLabelText('Enable keyboard shortcuts')).toBeTruthy(),
    )
    for (const def of KEYMAP) {
      expect(screen.getByTestId(`shortcut-row-${def.id}`)).toBeTruthy()
    }
  })

  it('toggling the master switch PUTs __master__ false', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderTab()
    const masterSwitch = await waitFor(() =>
      screen.getByLabelText('Enable keyboard shortcuts'),
    )
    await act(async () => {
      masterSwitch.click()
    })
    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(
        ([, opts]) =>
          (opts as RequestInit | undefined)?.method === 'PUT' &&
          ((opts as RequestInit).body as string).includes('__master__'),
      )
      expect(putCalls.length).toBeGreaterThan(0)
    })
  })

  it('row switches are disabled when masterEnabled is false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ __master__: false }), { status: 200 }),
    )
    renderTab()
    await waitFor(() => {
      const row = screen.getByTestId(`shortcut-row-${KEYMAP[0].id}`)
      const sw = row.querySelector('button[role="switch"]')
      expect(sw?.getAttribute('disabled')).not.toBeNull()
    })
  })

  it('toggling a row switch PUTs that id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderTab()
    const target = KEYMAP.find((k) => k.id === 'insert-downstream')!
    const row = await waitFor(() =>
      screen.getByTestId(`shortcut-row-${target.id}`),
    )
    const sw = row.querySelector('button[role="switch"]') as HTMLButtonElement
    await act(async () => {
      sw.click()
    })
    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(
        ([, opts]) =>
          (opts as RequestInit | undefined)?.method === 'PUT' &&
          ((opts as RequestInit).body as string).includes('insert-downstream'),
      )
      expect(putCalls.length).toBeGreaterThan(0)
    })
  })
})
