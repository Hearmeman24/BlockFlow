---
name: blockflow-block-builder
description: Build new blocks for BlockFlow, the visual pipeline editor for AI video and image generation. Use this skill whenever the user wants to create a new block, extend BlockFlow's functionality, add a pipeline step, build a custom node, or asks about the block architecture. Also trigger when the user mentions "custom_blocks", "frontend.block.tsx", "backend.block.py", block inputs/outputs, port types, or block registration. Even casual requests like "add a block that does X" or "I want a new pipeline step for Y" should use this skill.
---

# BlockFlow Block Builder

Build new pipeline blocks for BlockFlow — the visual pipeline editor for AI video and image generation.

BlockFlow uses a left-to-right pipeline where **blocks** are the atomic units. Each block lives in a self-contained directory, is auto-discovered at startup, and connects to other blocks via typed ports. This skill teaches you how to build them correctly.

## Quick Reference

```
custom_blocks/<your_block_slug>/
├── frontend.block.tsx    (required — UI + logic)
└── backend.block.py      (optional — server-side API routes)
```

That's it. Drop a folder with a `frontend.block.tsx` into `custom_blocks/` and restart. The codegen system discovers it automatically, copies it to the generated directory, and registers it in the pipeline.

## Architecture Overview

### How Blocks Work

1. **Discovery**: `npm run predev` (runs automatically before `npm run dev`) scans `custom_blocks/*/frontend.block.tsx`
2. **Codegen**: Each block is copied to `frontend/src/components/pipeline/custom_blocks/generated/` and an `_register.ts` file is generated that imports and calls `registerBlockDef()` for every block
3. **Backend sidecars**: `backend/main.py` scans `custom_blocks/*/backend.block.py` at startup and mounts each router at `/api/blocks/<slug>/`
4. **Runtime**: The pipeline runner calls each block's `execute` function in sequence, passing resolved inputs from upstream blocks

### Data Flow Model

Blocks communicate through an **accumulator** — a typed collection of outputs from all upstream blocks, keyed by `PortKind`. When a block runs, the pipeline resolves its declared inputs by matching port kinds against the accumulator. The closest upstream producer wins by default, but users can pick a specific source when multiple blocks produce the same kind.

### Port Kinds

These are the built-in port types. You can also define custom kinds (any string).

| Constant | String | Use For |
|----------|--------|---------|
| `PORT_TEXT` | `'text'` | Prompts, descriptions, any text |
| `PORT_VIDEO` | `'video'` | Video URLs (string or string[]) |
| `PORT_IMAGE` | `'image'` | Image URLs |
| `PORT_LORAS` | `'loras'` | LoRA adapter selections |
| `PORT_METADATA` | `'metadata'` | Generation metadata (params, seeds, etc.) |

Note: `PORT_PROMPT` is deprecated — use `PORT_TEXT` instead. The system auto-canonicalizes `'prompt'` to `'text'`.

## Creating a Frontend Block

Every block must export a `blockDef: BlockDef` from `frontend.block.tsx`. Here's the minimal structure:

```tsx
'use client'

import {
  PORT_TEXT,
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

function MyBlock({ blockId, inputs, setOutput, registerExecute, setStatusMessage }: BlockComponentProps) {
  // Your UI + logic here

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      // Called when pipeline runs — do your work here
      // freshInputs are resolved at execution time (not stale closures)
      setStatusMessage('Working...')

      // ... your logic ...

      setOutput('output_name', result)
    })
  }) // Re-register every render to capture latest local state

  return (
    <div className="space-y-3">
      {/* Your UI */}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'myBlock',                    // camelCase, unique across all blocks
  label: 'My Block',                  // Display name in UI
  description: 'What this block does',
  size: 'md',                         // sm | md | lg | huge
  canStart: false,                    // true if this can be the first block
  inputs: [{ name: 'text', kind: PORT_TEXT }],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  configKeys: ['my_setting'],         // sessionStorage keys to persist (without block_${id}_ prefix)
  component: MyBlock,
}
```

### BlockComponentProps — What You Receive

| Prop | Type | Purpose |
|------|------|---------|
| `blockId` | `string` | Unique ID for this block instance |
| `inputs` | `Record<string, unknown>` | Live data from upstream, keyed by port name |
| `setOutput` | `(portName, value) => void` | Push output for downstream blocks |
| `registerExecute` | `(fn) => void` | Register the function the pipeline runner calls |
| `setStatusMessage` | `(msg \| undefined) => void` | Show a status badge while running |
| `setExecutionStatus` | `(status, error?) => void` | Override block status (for polling/resume) |

### The Execute Function

This is the heart of your block. Key rules:

1. **Re-register every render** — use `useEffect(() => { registerExecute(...) })` with no dependency array. This ensures the execute function captures the latest local state (form values, settings) via closures.

2. **Use `freshInputs`, not `inputs`** — the `freshInputs` parameter contains data resolved at execution time. The `inputs` prop may be stale.

3. **Throw on error** — thrown errors automatically set the block to error state with the message displayed.

4. **Return values** are optional:
   - `{ terminateChain: true }` — gracefully stop the pipeline after this block (like HITL "Stop")
   - `{ partialFailure: true }` — some work failed but block produced usable output

5. **Call `setOutput`** to push data downstream. This is how blocks communicate.

### Block Sizes

Pick the smallest size that fits your UI comfortably.

| Size | Dimensions | Border Color | Best For |
|------|-----------|--------------|----------|
| `sm` | 280x220 | Blue | Simple controls, gates |
| `md` | 360x320 | Emerald | Settings + small preview |
| `lg` | 440x460 | Violet | Rich forms, media display |
| `huge` | 540x580 | Amber | Complex UIs, large previews |

### State Persistence with useSessionState

Use `useSessionState` instead of `useState` for any value the user configures. It persists to sessionStorage and survives client-side navigation.

```tsx
import { useSessionState } from '@/lib/use-session-state'

// Always prefix keys with block_${blockId}_ to avoid collisions
const prefix = `block_${blockId}_`
const [model, setModel] = useSessionState(`${prefix}model`, 'default-model')
const [temperature, setTemperature] = useSessionState(`${prefix}temperature`, 0.7)
```

List these keys (without the `block_${id}_` prefix) in `configKeys` so the pipeline save/load system knows to persist them:
```tsx
configKeys: ['model', 'temperature'],
```

### Forward Rules

For pass-through blocks (viewers, gates), use `forwards` to automatically copy input to output without writing execute logic:

```tsx
forwards: [{ fromInput: 'video', toOutput: 'video', when: 'if_present' }],
```

- `when: 'if_present'` — only forward if the input exists (most common)
- `when: 'always'` — forward even if undefined

### Input Bindings (Advanced)

For blocks where an input can come from upstream OR be typed locally (like a prompt field), use bindings:

```tsx
import { useBlockBindings } from '@/lib/pipeline/block-bindings'

// In your component:
const { byField } = useBlockBindings(blockId, blockDef.type, inputs)
const promptBinding = byField.prompt

// In your blockDef:
bindings: [
  {
    field: 'prompt',           // logical field ID in your UI
    input: 'text',             // input port name
    mode: 'upstream_or_local', // upstream_only | upstream_or_local | local_only
    allowOverride: true,       // user can toggle between upstream and manual
  },
],
```

Binding modes:
- `upstream_only` — always from upstream, no local editing
- `upstream_or_local` — dropdown to choose: upstream source or "Manual" entry
- `local_only` — always local, no upstream connection

### Starter Blocks and Prerequisites

If your block can start a pipeline (`canStart: true`) but needs an upstream block to function, use `starterPrereqs`:

```tsx
canStart: true,
starterPrereqs: ['uploadImageToTmpfiles'], // auto-inserted when used as first block
```

When the user picks your block as the first block in an empty pipeline, the prerequisite blocks are automatically added before it.

## Creating a Backend Sidecar

If your block needs server-side logic (API calls with secrets, file I/O, heavy processing), add a `backend.block.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()

@router.post("/run")
async def run(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
        # ... your server logic ...
        return JSONResponse({"ok": True, "result": "..."})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

@router.get("/settings")
async def settings() -> JSONResponse:
    import os
    return JSONResponse({
        "ok": True,
        "has_api_key": bool(os.getenv("MY_API_KEY", "")),
    })
```

The router is auto-mounted at `/api/blocks/<your_slug>/`. Your frontend calls it like:

```tsx
const res = await fetch('/api/blocks/my_block/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'hello' }),
})
const data = await res.json()
```

### Backend Conventions

- Always wrap endpoints in try/except and return `{"ok": false, "error": str(e)}` on failure
- Use `os.getenv()` for API keys — never hardcode secrets
- If your block needs an API key, expose a `/settings` endpoint that returns `has_api_key: bool`
- Show a warning in the frontend when the key is missing: `<span className="text-xs text-yellow-500">MY_API_KEY missing — configure it in your .env file</span>`
- Backend can import from `backend.config` for shared config (output dir, env vars)

## UI Conventions

BlockFlow uses a dark theme with shadcn/ui components. Follow these patterns:

- **Dark theme only** — all blocks render in dark mode (shadcn `class="dark"` on html)
- **Text sizes**: Labels use `text-xs`, secondary text uses `text-[10px]` or `text-[11px]`
- **Input heights**: Use `h-7` or `h-8` for compact inputs
- **Spacing**: Use `space-y-3` for main sections, `space-y-1` or `space-y-1.5` for label+input pairs
- **shadcn components**: Import from `@/components/ui/*` — Button, Input, Label, Select, Textarea, Collapsible, Badge, etc.
- **Waiting states**: Show `text-muted-foreground` placeholder text like "Waiting for input..."
- **Status messages**: Use `setStatusMessage('Processing 3/5...')` during execution for progress

## Complete Examples

For reference implementations, read these source files:

| Pattern | File | What It Demonstrates |
|---------|------|---------------------|
| Minimal viewer | `custom_blocks/video_viewer/frontend.block.tsx` | Simple input→display→forward, no backend |
| File upload | `custom_blocks/upload_image_to_tmpfiles/` | Starter block, dual mode, backend sidecar |
| API integration | `custom_blocks/prompt_writer/` | LLM API call, model picker, settings persistence |
| Polling pattern | `custom_blocks/upscale/` | Long-running jobs, progress display, API key handling |
| Manual gate | `custom_blocks/hitl/frontend.block.tsx` | Promise-based user interaction, terminateChain |
| Bindings | `custom_blocks/generation/frontend.block.tsx` | upstream_or_local prompt binding, multi-output |

Read the reference file at `references/block-checklist.md` in this skill directory for a pre-flight checklist to verify your block before shipping.
