/**
 * Smoke test for the Vitest + jsdom + @testing-library/react + jest-dom stack.
 *
 * Proves the testing pipeline works end-to-end:
 *   - vitest discovers .test.tsx files
 *   - jsdom provides a DOM
 *   - @testing-library/react renders + queries
 *   - @testing-library/jest-dom adds the `toBeInTheDocument` matcher
 *   - @testing-library/user-event simulates real user interaction
 *
 * Real component tests in feature beads exercise actual app components.
 * This file is the canary — if it goes red, the test infra itself is broken.
 */
import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

function Counter({ initial = 0 }: { initial?: number }) {
  const [count, setCount] = useState(initial)
  return (
    <div>
      <p aria-label="count">{count}</p>
      <button onClick={() => setCount((c) => c + 1)}>increment</button>
    </div>
  )
}

describe('RTL smoke test', () => {
  test('renders a component into jsdom', () => {
    render(<Counter />)
    expect(screen.getByRole('button', { name: /increment/i })).toBeInTheDocument()
    expect(screen.getByLabelText('count')).toHaveTextContent('0')
  })

  test('user-event triggers state updates and DOM reflects them', async () => {
    const user = userEvent.setup()
    render(<Counter initial={5} />)

    expect(screen.getByLabelText('count')).toHaveTextContent('5')

    await user.click(screen.getByRole('button', { name: /increment/i }))
    await user.click(screen.getByRole('button', { name: /increment/i }))

    expect(screen.getByLabelText('count')).toHaveTextContent('7')
  })

  test('cleanup runs between tests (no DOM leakage)', () => {
    // If cleanup didn't fire after the previous test, two Counters would be in the DOM.
    render(<Counter />)
    const buttons = screen.getAllByRole('button', { name: /increment/i })
    expect(buttons).toHaveLength(1)
  })
})
