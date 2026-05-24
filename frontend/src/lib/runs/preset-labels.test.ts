/**
 * sgs-ui-10h: helper that pulls per-comfy_gen preset/workflow labels out
 * of a saved flow snapshot so the artifact card can show "Preset:
 * wan-animate · Replace Face" without depending on a separate run-record
 * column.
 *
 * The workflow_name config key is already populated by the ComfyGen block
 * whenever a preset (or a JSON / PNG workflow) is loaded — we just need
 * to dig it out of the snapshot in tree order.
 */
import { describe, expect, test } from 'vitest'
import { extractComfyGenPresetLabels } from './preset-labels'

describe('extractComfyGenPresetLabels', () => {
  test('returns empty list when no comfy_gen blocks in snapshot', () => {
    const snapshot = {
      name: 'x',
      version: 1,
      created_at: '',
      blocks: [
        { type: 'upload_image', config: {} },
        { type: 'prompt_writer', config: { positive: 'hi' } },
      ],
    }
    expect(extractComfyGenPresetLabels(snapshot)).toEqual([])
  })

  test('returns workflow_name from each comfy_gen block in tree order', () => {
    const snapshot = {
      name: 'x',
      version: 1,
      created_at: '',
      blocks: [
        { type: 'comfy_gen', config: { workflow_name: 'wan-animate · Replace Face' } },
        { type: 'upscale', config: {} },
        { type: 'comfy_gen', config: { workflow_name: 'qwen-image-lighting · Default' } },
      ],
    }
    expect(extractComfyGenPresetLabels(snapshot)).toEqual([
      'wan-animate · Replace Face',
      'qwen-image-lighting · Default',
    ])
  })

  test('walks into branches recursively', () => {
    const snapshot = {
      name: 'x',
      version: 2,
      created_at: '',
      blocks: [
        { type: 'upload_image' },
        {
          type: 'fork',
          branches: [
            [{ type: 'comfy_gen', config: { workflow_name: 'preset-A · v1' } }],
            [
              { type: 'hitl' },
              { type: 'comfy_gen', config: { workflow_name: 'preset-B · v2' } },
            ],
          ],
        },
      ],
    }
    expect(extractComfyGenPresetLabels(snapshot)).toEqual([
      'preset-A · v1',
      'preset-B · v2',
    ])
  })

  test('skips comfy_gen blocks with empty or missing workflow_name', () => {
    const snapshot = {
      name: 'x',
      version: 1,
      created_at: '',
      blocks: [
        { type: 'comfy_gen', config: {} },
        { type: 'comfy_gen', config: { workflow_name: '' } },
        { type: 'comfy_gen', config: { workflow_name: 'kept · entry' } },
      ],
    }
    expect(extractComfyGenPresetLabels(snapshot)).toEqual(['kept · entry'])
  })

  test('tolerates malformed snapshots (no blocks array, non-object, null)', () => {
    expect(extractComfyGenPresetLabels(null as unknown as Record<string, unknown>)).toEqual([])
    expect(extractComfyGenPresetLabels({} as Record<string, unknown>)).toEqual([])
    expect(extractComfyGenPresetLabels({ blocks: 'oops' } as unknown as Record<string, unknown>)).toEqual([])
  })

  test('coerces non-string workflow_name to nothing (defensive)', () => {
    const snapshot = {
      blocks: [
        { type: 'comfy_gen', config: { workflow_name: 123 } },
        { type: 'comfy_gen', config: { workflow_name: { wrong: 'shape' } } },
      ],
    }
    expect(extractComfyGenPresetLabels(snapshot as Record<string, unknown>)).toEqual([])
  })
})
