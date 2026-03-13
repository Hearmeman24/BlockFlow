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
- Execute functions receive fresh `inputs` parameter from the pipeline runner

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

## Conventions

- Dark theme only (shadcn/ui, `class="dark"` on `<html>`)
- URL-state routing: filters/sort in URL search params
- Block API routes: `/api/blocks/<slug>/...` only
- No Playwright testing — user tests manually, use `npm run build` for verification
