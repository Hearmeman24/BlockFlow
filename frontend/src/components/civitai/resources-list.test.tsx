/**
 * Tests for ResourcesList — the shared grouped/categorised resources view
 * used by the live pipeline block's gate and the artifacts-page modal.
 *
 * Coverage focuses on the bucket logic since the rest is presentational:
 *   - LoRA-family types (LORA, LoCon, LyCORIS) merge into one "LoRAs" group
 *   - Unresolved rows go to the "Unknown" bucket
 *   - Manual links are always last and never merged with auto-detected
 *   - Section order: checkpoints → LoRAs → workflows → unknown
 */
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ResourcesList } from './resources-list'
import type { GateResolvedRow, GateManualResource } from './approval-gate'

function r(
  type: string,
  name: string,
  resolved = true,
  strength?: number,
): GateResolvedRow {
  return {
    filename: `${name}.safetensors`,
    sha256: name + '-sha',
    resolved,
    modelVersionId: 1,
    modelId: 10,
    name,
    versionName: 'v1',
    type,
    strength,
  }
}

describe('ResourcesList grouping', () => {
  it('renders an empty-state message when nothing is detected or linked', () => {
    render(<ResourcesList resolved={[]} manualResources={[]} />)
    expect(screen.getByText(/no resources detected/i)).toBeInTheDocument()
  })

  it('renders one section per CivitAI type, in display order', () => {
    render(
      <ResourcesList
        resolved={[
          r('Workflows', 'Workflow A'),
          r('LORA', 'LoRA A', true, 0.8),
          r('Checkpoint', 'Checkpoint A'),
        ]}
        manualResources={[]}
      />,
    )
    const headings = screen.getAllByText(/^Checkpoints$|^LoRAs$|^Workflows$/)
    // Expected order: Checkpoints, LoRAs, Workflows (regardless of input order).
    expect(headings.map((n) => n.textContent)).toEqual(['Checkpoints', 'LoRAs', 'Workflows'])
  })

  it('merges LORA / LoCon / LyCORIS into the same LoRAs bucket', () => {
    render(
      <ResourcesList
        resolved={[
          r('LORA', 'Lora1', true, 1.0),
          r('LoCon', 'Locon1', true, 0.5),
          r('LyCORIS', 'Lycoris1', true, 0.3),
        ]}
        manualResources={[]}
      />,
    )
    expect(screen.getAllByText('LoRAs')).toHaveLength(1) // only one heading
    expect(screen.getByText('Lora1')).toBeInTheDocument()
    expect(screen.getByText('Locon1')).toBeInTheDocument()
    expect(screen.getByText('Lycoris1')).toBeInTheDocument()
  })

  it('puts unresolved rows in an Unknown bucket', () => {
    render(
      <ResourcesList
        resolved={[
          r('Checkpoint', 'good'),
          { ...r('', 'bad', false), name: undefined, type: undefined },
        ]}
        manualResources={[]}
      />,
    )
    expect(screen.getByText('Checkpoints')).toBeInTheDocument()
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.getByText(/bad\.safetensors.*Unknown, not on CivitAI/)).toBeInTheDocument()
  })

  it('renders Manual links section separately, after auto-detected groups', () => {
    const manual: GateManualResource[] = [
      { modelVersionId: 999, modelId: 555, name: 'Pasted Workflow', type: 'Workflows', versionName: 'v1.0' },
    ]
    render(
      <ResourcesList
        resolved={[r('Checkpoint', 'AutoCheckpoint')]}
        manualResources={manual}
      />,
    )
    // Both auto and manual sections present.
    expect(screen.getByText('Checkpoints')).toBeInTheDocument()
    expect(screen.getByText('Manual links')).toBeInTheDocument()
    // Manual entry is rendered with its own type label as a side badge,
    // not collapsed into the Workflows auto bucket.
    expect(screen.getByText('Pasted Workflow')).toBeInTheDocument()
  })

  it('renders LoRA strength as a per-row trailing label', () => {
    render(
      <ResourcesList
        resolved={[r('LORA', 'StrongLora', true, 0.75)]}
        manualResources={[]}
      />,
    )
    expect(screen.getByText('@ 0.75')).toBeInTheDocument()
  })

  it('does not repeat the type on every row (only as a section header)', () => {
    // Specifically: there should not be a "Checkpoint" badge on the row
    // because the section header already says "Checkpoints". This was the
    // user complaint that drove the grouping refactor — every row used to
    // say "checkpoint" on the right.
    render(
      <ResourcesList
        resolved={[r('Checkpoint', 'C')]}
        manualResources={[]}
      />,
    )
    const rowText = screen.getByText('C').closest('div')
    // The row container should not contain a literal "Checkpoint" label
    // on the right side. We assert by checking no element inside the row
    // matches /^Checkpoint$/ (only the section header above does).
    expect(rowText).toBeInTheDocument()
    const within_ = within(rowText as HTMLElement)
    expect(within_.queryByText(/^Checkpoint$/)).not.toBeInTheDocument()
  })
})
