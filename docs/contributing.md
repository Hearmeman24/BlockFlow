# Contributing to BlockFlow

This page covers what you need to know before opening a PR.

## Before you write code

- Read [`testing.md`](testing.md). TDD is mandatory: no production code without a failing test first.
- Have a real use case in mind. BlockFlow is intentionally narrow — local-only browser pipelines for RunPod-backed AI generation. Features that don't fit that frame should land as discussion proposals first.

## Workflow

1. **File an issue first** for anything non-trivial. A bug report or a feature proposal in GitHub Issues helps surface design conflicts before code lands.
2. **Branch** from `main`. Use `feat/<short-desc>`, `fix/<short-desc>`, or similar. There's no enforced naming convention beyond "tells me what this branch is for at a glance."
3. **Write the test first.** See [`testing.md`](testing.md) for what counts as a good test in this repo.
4. **Make the test pass** with minimal code. No speculative abstractions, no unrequested features.
5. **Open the PR.** CI runs build + type-check + tests + a forbidden-token grep gate. Red blocks merge.
6. **Address review.** This project's reviews tend toward "minimal diff, clear naming, comment only when the WHY is non-obvious."

## What CI enforces

See [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml). At a glance:

- **Frontend**: `npm run gen:custom-blocks` (codegen) + `tsc --noEmit` + `npm test` (Vitest) + `npm run build`.
- **Backend**: `uv sync --extra dev` + `uv run ruff check .` (lint) + `uv run pytest tests/`.
- **Forbidden-token gate** (`scripts/check_no_forbidden_tokens.py`): refuses PRs that introduce tokens belonging to private deployments (private endpoint IDs, internal bucket names, SSH targets). The token list lives in the script.

The lint steps are currently `continue-on-error: true` while pre-existing debt is cleaned up (tracked in sgs-ui-wisp-las.13). New code should still lint clean — that's how the gate becomes hard-fail.

## Public vs private blocks

The repo supports two block sources:

- `custom_blocks/` — public, ships in the source-available build, must not contain hardcoded private values.
- `private_blocks/` — gitignored overlay for blocks that depend on private infrastructure (private RunPod endpoints, internal LoRA volumes, etc.). The codegen + backend block-sidecar loader scan both dirs. See [`private-blocks.md`](private-blocks.md).

If your block can ship with sensible defaults and Settings-based configuration, it belongs in `custom_blocks/`. If it depends on infrastructure that other users won't have, put it in `private_blocks/` and gitignore your local copy.

## Code style

- Default to no comments. Add one only when the WHY is non-obvious (subtle invariants, workarounds for upstream bugs, surprising behavior). Self-evident names beat comments that explain what the code already says.
- Don't add error handling or fallbacks for scenarios that can't happen. Validate at system boundaries (HTTP inputs, external APIs); trust internal calls.
- Prefer editing existing files over creating new ones. New files for genuinely new responsibilities only.

## Where to ask

- Bugs / concrete feature requests: GitHub Issues.
- Questions, "is this a good idea?", show-and-tell: GitHub Discussions.

## License

By contributing you agree that your contribution may be licensed as part of
BlockFlow under the PolyForm Noncommercial License 1.0.0 (see
[`../LICENSE`](../LICENSE)).

You also grant the project maintainers permission to include your contribution
in separately licensed commercial versions of BlockFlow. If you cannot grant
both rights, do not submit the contribution.
