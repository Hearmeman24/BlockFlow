# Private Blocks Overlay

BlockFlow supports a gitignored `private_blocks/` directory at the repo root that mirrors `custom_blocks/`. Blocks placed there are loaded the same way as public blocks but never enter the public source-available build.

## When to use it

The intended use case: maintain blocks that depend on infrastructure or models you don't want to publish — private RunPod endpoints, internal workflows, NSFW-specific generation, customer-specific integrations — without forking BlockFlow.

If your block could ship publicly with sensible defaults, put it in `custom_blocks/` instead.

## Layout

```
sgs-ui/
├── custom_blocks/          <- public blocks; ship in the source-available build
│   └── <slug>/
│       ├── frontend.block.tsx
│       └── backend.block.py  (optional)
└── private_blocks/         ← gitignored overlay; local-only
    └── <slug>/
        ├── frontend.block.tsx
        └── backend.block.py  (optional)
```

Same internal structure as `custom_blocks/`: each block is a directory whose name is the slug, containing a required `frontend.block.tsx` and an optional `backend.block.py`.

## How the overlay loads

Both the frontend codegen (`npm run gen:custom-blocks`) and the backend sidecar auto-loader (`backend.main.load_block_sidecars`) scan both dirs:

1. **Discovery order:** `custom_blocks/` is scanned first, then `private_blocks/`. A dir that doesn't exist is treated as empty.
2. **Sorted output:** the merged result is sorted alphabetically by slug, so order in the registry is deterministic.
3. **Routes mount identically:** a block from `private_blocks/foo/` exposes its routes at `/api/blocks/foo/...` — the same prefix it would use in `custom_blocks/`. The consumer can't tell which dir a block came from.
4. **Frontend-only blocks:** blocks without a `backend.block.py` are valid in either dir; only the frontend is registered.

## Slug collisions

If the same slug exists in both `custom_blocks/` and `private_blocks/`, **both the codegen and the backend loader fail loudly** rather than silently shadowing one side:

```
[custom-blocks] slug collision across source dirs (rename to disambiguate):
  - 'foo' exists in both custom_blocks/ and private_blocks/
```

This is intentional — silent shadowing would create a subtle class of bugs where a public block's behavior differs from what the source code shows. Rename one of the dirs to disambiguate.

## Adding a private block

1. Create `private_blocks/<slug>/frontend.block.tsx` exporting `blockDef`.
2. (Optional) Add `private_blocks/<slug>/backend.block.py` exporting a FastAPI `router`.
3. Run `npm run predev` (frontend codegen) and restart the backend.

That's it. The block appears in the canvas exactly like a `custom_blocks/` entry. No registration code, no env var, no flag.

## What does NOT happen

- **No mirroring.** `private_blocks/` is independent — it is not auto-populated from `custom_blocks/` or vice versa.
- **No shared state.** Two blocks with the same slug aren't merged or overlaid field-by-field; they collide, period.
- **No env-driven enablement.** The overlay is either present on disk or it isn't. There is no `ENABLE_PRIVATE_BLOCKS=1`-style switch.
- **No public exposure.** `private_blocks/` is in `.gitignore`. It will never be committed to the public BlockFlow repo.

## CI behavior

CI runs build against `custom_blocks/` only (since `private_blocks/` is gitignored). The forbidden-token gate (`scripts/check_no_forbidden_tokens.py`) also skips `private_blocks/` — private blocks may legitimately contain tokens that would be forbidden in public code (private endpoint IDs, internal bucket names, etc.).

## Implementation notes

- Frontend codegen: `frontend/scripts/gen-custom-block-registry.mjs`, `discoverBlocks()`. The generated `_register.ts` is identical regardless of which dir a block came from; it does not record the source dir in the consumer-facing output.
- Backend loader: `backend/main.py`, `load_block_sidecars()`. Accepts a list of `(Path, source_label)` pairs and mounts each sidecar at `/api/blocks/<slug>`.
- Both are covered by tests: `frontend/scripts/__tests__/gen-custom-block-registry.test.ts` and `tests/test_block_sidecar_overlay.py`.
