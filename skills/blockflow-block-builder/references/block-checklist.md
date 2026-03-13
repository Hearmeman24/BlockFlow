# Block Pre-Flight Checklist

Verify each item before considering your block complete.

## Structure

- [ ] Block lives in `custom_blocks/<slug>/frontend.block.tsx`
- [ ] Slug uses snake_case (e.g., `my_cool_block`)
- [ ] File starts with `'use client'`
- [ ] Exports `blockDef: BlockDef` (named export, not default)
- [ ] `blockDef.type` is camelCase and unique (e.g., `myCoolBlock`)
- [ ] Backend sidecar (if any) is `custom_blocks/<slug>/backend.block.py` and exports `router: APIRouter`

## BlockDef Fields

- [ ] `type`: camelCase string, unique across all blocks
- [ ] `label`: human-readable display name
- [ ] `description`: one-line description of what the block does
- [ ] `size`: one of `'sm'`, `'md'`, `'lg'`, `'huge'` — pick the smallest that fits
- [ ] `canStart`: `true` only if the block makes sense as the first block in a pipeline
- [ ] `inputs`: array of `{ name, kind }` objects. Set `required: false` for optional inputs
- [ ] `outputs`: array of `{ name, kind }` objects
- [ ] `configKeys`: lists all `useSessionState` keys (without the `block_${id}_` prefix)
- [ ] `component`: references your component function

## Execute Function

- [ ] Registered via `useEffect(() => { registerExecute(...) })` — no dependency array
- [ ] Uses `freshInputs` parameter (not `inputs` prop) for data
- [ ] Validates inputs and throws clear errors: `throw new Error('Descriptive message')`
- [ ] Calls `setOutput(portName, value)` for each output port
- [ ] Uses `setStatusMessage()` for progress feedback during long operations
- [ ] Does NOT use `async/await` on `inputs` prop values (they may be stale)

## State & Persistence

- [ ] All user-configurable values use `useSessionState` (not plain `useState`)
- [ ] Session state keys are prefixed: `block_${blockId}_<key>`
- [ ] All session state key suffixes are listed in `configKeys`
- [ ] Sensitive data (API keys entered in UI) uses `localStorage` directly (not sessionStorage)

## Ports & Data

- [ ] Input port names match what upstream blocks output (check the registry)
- [ ] Output values match the expected type for their port kind:
  - `PORT_TEXT`: `string` or `string[]`
  - `PORT_VIDEO`: `string` (URL) or `string[]` (URLs)
  - `PORT_IMAGE`: `string` (URL) or `string[]` (URLs)
  - `PORT_LORAS`: LoRA config object/array
  - `PORT_METADATA`: arbitrary object
- [ ] Forward rules (if any) reference valid input and output port names
- [ ] Bindings (if any) reference valid input port names and have correct mode

## Backend Sidecar

- [ ] Exports `router = APIRouter()`
- [ ] All endpoints wrapped in try/except returning `{"ok": false, "error": str(e)}`
- [ ] API keys read from `os.getenv()`, never hardcoded
- [ ] If block needs an API key, has `/settings` endpoint returning `has_api_key: bool`
- [ ] Frontend shows yellow warning when API key missing: `KEY_NAME missing — configure it in your .env file`
- [ ] Endpoints use `/api/blocks/<slug>/` prefix (automatic from mount)

## UI

- [ ] Uses shadcn/ui components (`@/components/ui/*`)
- [ ] Text sizing follows convention: `text-xs` for labels, `text-[10px]` for secondary
- [ ] Input heights are `h-7` or `h-8`
- [ ] Shows meaningful empty/waiting state when no input data
- [ ] No hardcoded colors that break dark theme

## Codegen Validation

The codegen script validates your blockDef at build time. These will cause build failures:

- Inputs/outputs missing `name` or `kind`
- Bindings with invalid `mode` (must be `upstream_only`, `upstream_or_local`, or `local_only`)
- Bindings with `requiredUpstream` on `local_only` mode
- Bindings with `allowOverride` on non-`upstream_or_local` mode
- Bindings with duplicate `field` values
- Forwards with missing `fromInput` or `toOutput`

## Final Verification

- [ ] Run `npm run gen:custom-blocks` — no errors
- [ ] Run `npm run build` — no TypeScript errors
- [ ] Block appears in the "Add Block" menu (or only in advanced mode if `advanced: true`)
- [ ] Block renders without console errors
- [ ] Pipeline runs end-to-end through your block
