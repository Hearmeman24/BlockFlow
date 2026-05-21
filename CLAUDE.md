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

## Test-Driven Development (mandatory)

**No production code without a failing test first.** Write the test, watch it fail, write minimal code to pass, watch it pass. Tests written after implementation prove nothing — they pass immediately because they were shaped by the code they "test."

### What "passing" actually means

A test that says "route returns 200" is **not enough**. The test must verify the **actual behavior produced**:

- If the endpoint writes a file → assert the file exists with the right contents
- If it updates state (DB, Settings, cache) → assert the new state is correct
- If it calls a downstream service → assert the call was made with the right payload
- If it returns data → assert every field that matters, not just the status code

Build green ≠ feature works.

### Edge cases are mandatory (not bonus)

Every bead's test list must include explicit cases for: empty/missing/malformed inputs, network failures, partial failures, concurrency, boundary values, unicode, auth failures, cancellation mid-op (`AbortSignal` in the pipeline runtime).

### Regression scope analysis (cross-block contagion)

Before starting implementation on any bead that touches a block or shared module, write the **regression scope**: what else depends on the contract being changed? What other blocks consume the API / Settings / cache being touched? Tests must cover those neighbors, not just the changed surface.

### Test infrastructure

- **Backend (Python):** `pytest` — tests in `tests/`. Run with `uv run pytest tests/`.
- **Frontend logic (TS):** `vitest` — colocated `*.test.ts`.
- **Frontend components (React):** `vitest` + `@testing-library/react` (jsdom). `*.test.tsx` colocated or in `__tests__/`.
- **No Playwright** — full-browser E2E out of scope.

### External-resource carve-out

If a test would require GPU hardware, real RunPod API calls that cost money, real worker provisioning, or human visual verification — **stop and flag** before building. Default substitute is a mocked test at the boundary; never mock the logic under test.

### CI enforcement

Every PR runs the full pytest + vitest suite. Red blocks merge. See `.github/workflows/ci.yml`.

### Definition of done for any bead

- [ ] Tests written first; each watched to fail for the expected reason
- [ ] Minimal code makes them pass
- [ ] Regression scope covered
- [ ] All tests pass; no warnings
- [ ] External-resource items flagged + mocked or human-approved

See `/docs/testing.md` for worked examples.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
