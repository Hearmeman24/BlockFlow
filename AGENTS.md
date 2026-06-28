# sgs-ui / BlockFlow

Distributed visual pipeline UI for AI image and video generation. BlockFlow runs
locally for each user, but this repository is a released source-available/npm
project rather than a private scratch app.

## Tech Stack

- **Frontend**: Next.js 16, React 19, shadcn/ui, Tailwind CSS (dark theme only)
- **Backend**: FastAPI, uvicorn
- **Launch**: `uv run app.py` starts FastAPI on `:8000` and Next.js on `:3000`
- **Package**: npm package `@hearmeman24/blockflow`

## Product Model

- BlockFlow is local-first software distributed through npm and GitHub releases.
- The main backend path is ComfyUI through ComfyGen on RunPod serverless.
- Direct provider blocks may call providers such as PiAPI, OpenRouter, RunPod,
  CivitAI, or other hosted services.
- Users provide their own credentials and pay providers directly.

## Pipeline System

The `/generate` page uses a linear left-to-right pipeline with a tree branching
model.

- **Block** is the canonical term. Do not call blocks nodes, steps, or stages in
  user-facing product copy.
- One global **Run Pipeline** button. Do not add per-block run actions.
- Accumulator data model: outputs are collected by `PortKind` and resolved as
  downstream inputs.
- Execute functions receive fresh `inputs` from the pipeline runner.
- Execute functions that do async work must honor `AbortSignal` cancellation.
- Multiple pipeline tabs can run simultaneously; cancellation is tab-scoped.

## Adding a Block

1. Create `custom_blocks/<slug>/frontend.block.tsx` exporting `blockDef: BlockDef`.
2. Optionally add `custom_blocks/<slug>/backend.block.py` exporting
   `router: APIRouter`.
3. Registration is automatic through codegen: `npm run predev`.

Block API routes must live under `/api/blocks/<slug>/...`.

## Block Sizes

- `sm`: 280x220, blue
- `md`: 360x320, emerald
- `lg`: 440x460, violet
- `huge`: 540x580, amber

## Key Files

| File | Purpose |
|------|---------|
| `app.py` | Single entrypoint, starts FastAPI + Next.js |
| `frontend/src/lib/pipeline/` | Registry, types, pipeline context, tree utils |
| `frontend/src/components/pipeline/` | Pipeline view, block card, chain renderer |
| `custom_blocks/` | Public self-contained block definitions |
| `private_blocks/` | Gitignored local-only block overlay |
| `backend/main.py` | FastAPI app, auto-loads block sidecars |
| `backend/routes.py` | Shared routes: flows and runs only |
| `docs/testing.md` | Testing/TDD standard |
| `docs/npm-release.md` | npm release flow |

## Branches

- Use a branch for every non-trivial task.
- Keep changes scoped to the task. Do not fold unrelated cleanup into the same
  branch.
- Small documentation-only edits may happen directly on `main` when the user
  explicitly asks for an immediate update.

## Test-Driven Development

TDD is mandatory for production code changes.

No production code without a failing test first:

1. Write the test.
2. Run it and verify it fails for the expected reason.
3. Write the minimal implementation.
4. Run the test and verify it passes.
5. Refactor only after the test is green.

Tests must assert the behavior produced, not just that a route returns 200 or a
component renders without throwing.

Examples:

- If an endpoint writes a file, assert the file exists with the right contents.
- If code updates Settings, DB state, or cache state, assert the new state.
- If code calls a downstream service, assert the payload and call behavior.
- If code returns data, assert the fields that matter.

Every non-trivial change must identify edge cases before implementation:

- empty, missing, malformed, null, or undefined inputs
- network and external-service failures
- partial failures in multi-step flows
- concurrent calls and race conditions
- boundary values and large inputs
- Unicode or special characters for user text
- auth failures
- cancellation through `AbortSignal`

External-resource tests that require GPU hardware, paid APIs, real provider
credentials, real worker provisioning, or human visual judgment must be flagged
for the user before implementation. Default to mocked tests at the external
boundary; do not mock the logic under test.

## Blast Radius Before Fixing

Before applying a block-specific bug fix, classify the bug:

1. **Local defect**: caused only by this block's implementation.
2. **Contract defect**: caused by shared pipeline semantics, media refs,
   settings, credentials, cancellation, artifacts, provider input shape, or
   generated block patterns.
3. **Sibling-pattern defect**: this block copied a pattern used by other blocks.

If the issue may be a contract or sibling-pattern defect, do not patch only the
visible block and call the bug fixed. First audit the relevant sibling blocks and
shared helpers, then decide whether the fix belongs in:

- a shared helper or contract
- the pipeline runner
- generated block glue
- each consuming block, with explicit per-block semantics

For every non-trivial bug fix, record:

- observed failing surface
- likely shared contract involved
- sibling blocks or modules audited
- why the fix is local or shared
- regression tests covering the affected class, not only the first failing block

A surgical fix is allowed only when it is clearly labeled as an immediate local
fix and follow-up work is tracked for the broader class of bug.

## CI And Verification

No Playwright testing in this repo. Use Vitest/RTL for frontend behavior and
manual browser testing only where visual or provider behavior cannot be automated.

CI is defined in `.github/workflows/ci.yml` and runs on pushes to `main` and PRs
if a PR is explicitly requested.

Required gates:

```bash
uv run ruff check .
uv run pytest tests/ -ra
npm --prefix frontend run gen:custom-blocks
npm --prefix frontend exec tsc -- --noEmit
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
```

Run the focused gate first while developing, then run the relevant full gate
before claiming completion. For docs-only changes, verify by inspecting rendered
Markdown or line-numbered output and by checking for contradictory instructions.

## Delivery Workflow

Default project-owner workflow:

1. Work on a branch for non-trivial changes.
2. Validate with the appropriate gates.
3. Merge locally to `main` after user review/approval.
4. Push directly to `origin/main` only after validation and explicit
   in-conversation user confirmation.

Do not push autonomously. Do not push merely because a session is ending. Do not
say work is done only because it is committed locally.

PRs are not the default workflow for this repo. Do not open a PR unless the user
explicitly asks for one.

## Release Flow

This repo is released as an npm package. Release work must follow
`docs/npm-release.md` and verify package behavior, not just source tests.

Typical release checks include:

```bash
npm run build
npm run pack:check
npm run smoke:npm-package
```

When changing packaged files, update the root `package.json` `files` list if
needed. Publishing uses the npm/GitHub release flow documented in
`docs/npm-release.md` and `.github/workflows/publish-npm.yml`.

## Conventions

- Dark theme only: shadcn/ui with `class="dark"` on `<html>`.
- URL-state routing: filters and sort state belong in URL search params.
- Block routes live under `/api/blocks/<slug>/...`.
- Credentials belong in the Settings store / backend credential path, not
  frontend localStorage.
- Use structured parsers and shared helpers instead of ad hoc string handling
  when the codebase already provides them.
- Prefer existing block and pipeline patterns over new abstractions unless the
  abstraction clearly reduces duplicated behavior or formalizes a real contract.

## UI Design System (Tightening Contract)

These rules keep the UI consistent and prevent re-introducing the divergence the
UI Tightening Audit (`docs/ui-tightening-audit.md`) catalogued.

**Primitive-first.** Do not hand-roll a control when a `components/ui/*` shadcn
primitive exists. Specifically: no raw `<button>` where `Button` fits, no raw
`<input>`/`<select>`/`<textarea>` where `Input`/`Select`/`Textarea` fit, no
bespoke `fixed inset-0` overlay where `Dialog`/`AlertDialog` fits, no hand-rolled
progress `<div>` where `Progress` fits. Native `confirm()`/`alert()`/`prompt()`
are not allowed in UI flows — use `AlertDialog` or a `Dialog`.

**Tokens, not ad-hoc utilities.**
- Dense text uses the named `text-2xs` / `text-3xs` / `text-4xs` utilities, not
  arbitrary `text-[11px]` / `text-[10px]` / `text-[9px]`.
- Semantic state colors use the `--success` / `--warning` / `--info` / `--link`
  tokens (e.g. `text-success`, `border-warning/40`, `text-link`), not raw
  `emerald-*` / `amber-* `/ `blue-*` Tailwind colors. Destructive uses the
  existing `destructive` token. Block-size category colors (see Block Sizes) are
  a separate, decorative concern and stay as-is.

**Shared atoms over copies.** Reuse the shared components/utilities rather than
re-inlining: `StatusBadge`, `AlertPanel`, `EmptyState`, `PageHeader`,
`FavoriteButton`, `DeleteIconButton`, `BlockField`, `pipeline/collapsible-section`,
and `lib/` helpers (time formatting, tmpfiles upload, value coercers, the
accumulated-URLs and block-health hooks). Add to a shared module before pasting a
second copy.

**Three-state contract.** Every data-driven surface must implement all three
states before the happy path ships, in a form consistent with the rest of the app:
- **Loading** — a `Skeleton` matching the shape of the expected content. Not a
  bare "Loading…" string and not `Suspense fallback={null}`.
- **Empty** — `EmptyState` with a headline and one actionable CTA.
- **Error** — a human-readable message plus one recovery action; distinguishable
  from empty. Transient feedback uses `sonner` toasts.

**One primary action per view.** Exactly one element per screen carries the
primary/filled treatment. Everything else is `outline`/`ghost`/`link`. The global
**Run Pipeline** button is the canonical primary on `/generate`.

**Layout.** Content pages use one of the two standard max-widths and the shared
`PageHeader`; do not introduce new per-page width/header treatments.

## Completion

Before handing off:

1. Run `git status --short` and identify all changed files.
2. Confirm no unrelated user changes were modified or reverted.
3. Run the relevant verification gates.
4. Report what changed, what was verified, and what remains unpushed.

Push only when the user explicitly confirms the validated change should be pushed
to `main`.
