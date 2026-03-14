# sgs-ui

Local-only pipeline UI for submitting video/image generation jobs to RunPod serverless endpoints.

## Tech Stack

- **Frontend**: Next.js 16, React 19, shadcn/ui, Tailwind CSS (dark theme only)
- **Backend**: FastAPI, uvicorn
- **Launch**: `uv run app.py` starts both FastAPI (:8000) and Next.js (:3000)

## Pipeline System

The `/generate` page uses a linear left-to-right pipeline with a tree branching model.

- **Block** is the canonical term (not node, step, or stage)
- One global "Run Pipeline" button — no per-block actions
- Accumulator data model: outputs collected by `PortKind`, resolved as inputs to downstream blocks
- Execute functions receive fresh `inputs` parameter and an `AbortSignal` from the pipeline runner
- **Parallel pipelines**: Multiple tabs can run pipelines simultaneously. Each tab's PipelineProvider is always mounted. Cancellation is tab-scoped (only aborts polls for that tab's blocks). A floating job manager appears when 2+ tabs are running.
- **Pipeline cancellation**: AbortSignal propagated to execute functions. Blocks like ComfyGen register abort listeners to cancel backend jobs (kills subprocess + cancels remote RunPod job).
- **Job manager**: Floating panel (top-right) appears when 2+ tabs are running simultaneously. Shows each running tab's name, current block, and a per-tab stop button. Collapsible.

## ComfyGen Block

The `comfy_gen` block submits ComfyUI workflows to a RunPod serverless endpoint.

- **LoRA detection**: Automatically detects `LoraLoader` and `LoraLoaderModelOnly` nodes in parsed workflows. Shows a collapsible "LoRAs" section with per-LoRA name override (dropdown or text input) and strength sliders.
- **LoRA list caching**: Dual-layer cache — backend in-memory + frontend localStorage (`comfygen_lora_cache`), both with 24h TTL. Fetching spawns a RunPod job via `comfy-gen list loras` (up to 90s). Stale cache auto-prompts refresh.

## Adding a Block

1. Create `custom_blocks/<slug>/frontend.block.tsx` exporting `blockDef: BlockDef`
2. Optionally add `custom_blocks/<slug>/backend.block.py` exporting `router: APIRouter`
3. Registration is automatic via codegen (`npm run predev`)

## Block Sizes

sm (280x220, blue), md (360x320, emerald), lg (440x460, violet), huge (540x580, amber)

## Key Files

| File | Purpose |
|------|---------|
| `app.py` | Single entrypoint, starts FastAPI + Next.js |
| `frontend/src/lib/pipeline/` | Registry, types, pipeline-context, tree-utils |
| `frontend/src/components/pipeline/` | Pipeline view, block card, chain renderer |
| `custom_blocks/` | Self-contained block definitions |
| `backend/main.py` | FastAPI app, auto-loads block sidecars |
| `backend/routes.py` | Shared routes: flows + runs only |
| `frontend/src/components/pipeline/job-manager.tsx` | Floating job manager for parallel pipeline runs |

## Conventions

- Dark theme only (shadcn/ui, `class="dark"` on `<html>`)
- URL-state routing: filters/sort in URL search params
- Block API routes: `/api/blocks/<slug>/...` only
- No Playwright testing — user tests manually, use `npm run build` for verification
