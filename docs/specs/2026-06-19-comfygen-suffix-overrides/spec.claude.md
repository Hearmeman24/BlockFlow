# Tag any workflow node `*_ComfyGen` to expose its value as an editable override

- **Work type:** `feature/app`
- **Status:** `draft` → awaiting Aviv approval (do NOT dispatch until approved)
- **Review surface:** [`spec.human.md`](./spec.human.md)

## 1. Problem / Context
The ComfyGen block auto-detects a fixed set of overrideable knobs (resolution, KSampler, LoRA, text prompts, frame count, reference video) plus preset-author-declared "Workflow Settings". A workflow author who wants to expose an *arbitrary* node value (a custom seed, a strength, a label string) has no way to do it without writing a preset `settings[]` block. This feature lets the author tag any node by **naming it `<something>_ComfyGen`**, and that node's primitive `value` becomes an editable override in the block — no preset authoring required.

## 2. Approach & why
Reuse the existing "Workflow Settings" machinery end-to-end; the only new thing is a **second source of `WorkflowSetting`-shaped entries**, derived from node titles instead of a preset. A tagged node emits **one entry per literal non-bool str/int/float input** (not just `value`), keyed `<node_id>.<input>`.

- The settings panel already renders `{node_id, field, label, type: 'int'|'float'|'string'|...}` with type-correct inputs — `custom_blocks/comfy_gen/frontend.block.tsx:2730-2810` (int/float→number `Input`, string→text `Input`, the exact shape we need).
- It already applies them as `<node_id>.<field>` via `mergeSettingsOverrides(overrides, settings, values)` — `frontend.block.tsx:1516`, helper at `frontend/src/lib/workflow-settings.ts:109` ("Auto-detected fields win: keys already present in `existing` are not overwritten").
- It already dedupes against other panels via `collectAutoDetectedKeys` / `filterVisibleSettings` — `frontend.block.tsx:1451-1458`, helpers `workflow-settings.ts:36,95`.
- The `WorkflowSetting` type is `{node_id, field, label, type: 'int'|'float'|'string'|'bool'|'combo', ...}` — `frontend/src/lib/settings/client.ts:408`.
- Backend detection is a list-returning `_detect_*` function wired into `/parse-workflow`; the closest analog is `_detect_text_overrides` returning `{node_id, input_name, current_value, label}` — `custom_blocks/comfy_gen/backend.block.py:1555`. The response is assembled at `backend.block.py:2063-2074`, detectors called at `:2051-2059`.

So: backend emits a new `comfygen_overrides` array; frontend feeds it into a **dedicated** section (its own state + `CollapsibleSection`) but routes apply + dedupe through the same helpers.

## 3. Acceptance Criteria
- [ ] A `*_ComfyGen`-titled node surfaces an editable field for **each** of its literal non-bool str/int/float inputs (number input for int/float, text for string) in a **"Workflow-Specific Overrides"** section; a single-input node labels by stripped title, a multi-input node labels each `<stripped title> · <input>`; editing + running sends `<node_id>.<input>` per field. → (ask: "the value of this node will be overrideable" / "String Int Float are supported")
- [ ] Per input: a wired (`[id, slot]`), absent, or Python `bool` input is NOT surfaced; sibling literal inputs on the same node still are. → (ask: "Only nodes that have: String Int Float are supported")
- [ ] A tagged node *input* already claimed by another auto-detected panel (key `<node_id>.<input>` in `collectAutoDetectedKeys`, e.g. a KSampler `steps` or a resolution source `value`) is NOT duplicated in the new section. → (ask: overlap decision, this spec)
- [ ] An untagged workflow shows no new section and no behavior change to existing panels. → (ask: implied — no regression)

## 4. Scope & Non-Goals
**In scope:**
- `custom_blocks/comfy_gen/backend.block.py` — new `_detect_comfygen_overrides` + response wiring.
- `custom_blocks/comfy_gen/frontend.block.tsx` (+ regenerated `frontend/src/components/pipeline/custom_blocks/generated/comfy_gen.tsx`) — consume array, new state, new section, dedupe, apply, `configKeys` persistence.
- New backend test; new/extended frontend test.

**Non-goals (explicitly NOT doing):**
- NOT supporting `bool`/`combo`/wired inputs (per-input skip).
- NOT changing the existing Workflow Settings panel, preset `settings[]`, or any other detector.
- NOT adding batch/automation axes for these overrides (single-run apply only).
- NOT a new backend route — extend `/parse-workflow` only.

## 5. Key Decisions & Constraints
- **Decided:** entry shape is `WorkflowSetting` + `current_value`: `{node_id, field: <input_name>, label, type: 'int'|'float'|'string', current_value}`. One entry **per qualifying input**. Mirror `settings/client.ts:408`.
- **Decided:** stripped title = `title[:-len("_ComfyGen")]` then `.rstrip(" _")`. Label = stripped title when the node yields exactly one field; `<stripped> · <input_name>` when it yields more than one. (Input iteration order = insertion order of the `inputs` dict, which ComfyUI preserves.)
- **Decided:** type from the literal: `bool`→excluded; `int`→`'int'`; `float`→`'float'`; `str`→`'string'`. **`bool` must be checked before `int`** (Python `isinstance(True, int)` is `True`).
- **Constraint / must-not-break:** apply path must not clobber values another panel set — keep using `mergeSettingsOverrides`' "don't overwrite existing key" semantics (`workflow-settings.ts:109`).
- **Constraint:** new session state must be listed in the block's `configKeys` so Restore-from-Artifacts rehydrates it (same as `text_overrides`, `workflow_settings`).
- **Mirror existing:** `frontend.block.tsx:2730-2810` (Workflow Settings panel) for rendering; `_detect_text_overrides` (`backend.block.py:1555`) for the detector.
- **Scale:** personal/local tool — omit.

## 6. Code Surface Map
- `custom_blocks/comfy_gen/backend.block.py:1555` — `_detect_text_overrides`, the detector pattern to mirror.
- `custom_blocks/comfy_gen/backend.block.py:2051-2074` — `/parse-workflow` detector calls + response dict to extend with `comfygen_overrides`.
- `custom_blocks/comfy_gen/frontend.block.tsx:1046` — where parse results are consumed (`setTextOverrides(...)` etc.); add `setComfygenOverrides(...)`.
- `custom_blocks/comfy_gen/frontend.block.tsx:1451-1468` — `collectAutoDetectedKeys` / `filterVisibleSettings` / `extractWorkflowSettingDefaults`; reuse to dedupe + seed current values.
- `custom_blocks/comfy_gen/frontend.block.tsx:1512-1518` — `buildBaseOverrides` merge point; add a `mergeSettingsOverrides` pass for the comfygen entries (after the existing one, so existing keys win).
- `custom_blocks/comfy_gen/frontend.block.tsx:2730-2810` — Workflow Settings `CollapsibleSection`; clone as "Workflow-Specific Overrides".
- `custom_blocks/comfy_gen/frontend.block.tsx` `configKeys` list (~3018) — add `comfygen_overrides`, `comfygen_override_values`.
- `frontend/src/lib/settings/client.ts:408` — `WorkflowSetting` type to reuse.
- `frontend/src/lib/workflow-settings.ts:36,95,109` — dedupe + merge helpers.
- `frontend/src/lib/comfygen-overrides.ts:241` — `buildOverrides` (only if apply isn't done purely via `mergeSettingsOverrides`; preferred: no change here).

## 7. Ultracode Dispatch Notes
> Per Aviv: build with a small `/spawn-team` — one developer (builder) + one breaker. Not a full fan-out.

**Build first (sequential — freezes the contract both sides code to):**
- **Frozen interface:** the `/parse-workflow` response gains `comfygen_overrides: Array<{node_id: string, field: string, label: string, type: "int"|"float"|"string", current_value: number|string}>`, **one element per qualifying input** (`field` = the input name, e.g. `"value"`, `"steps"`, `"cfg"`). Both slices implement against exactly this shape.

**Parallel slices (each declares the files/state it writes):**
- **Slice A — backend detection.** `_detect_comfygen_overrides(workflow)` + wire into `/parse-workflow` response. Writes: `custom_blocks/comfy_gen/backend.block.py`, `tests/test_comfygen_suffix_overrides.py`.
- **Slice B — frontend surface + apply.** Consume array; `comfygenOverrides` (`WorkflowSetting[]`) + `comfygenOverrideValues` (`Record<string,string>`) session state; dedupe vs `collectAutoDetectedKeys` + visible preset settings; "Workflow-Specific Overrides" `CollapsibleSection`; apply via second `mergeSettingsOverrides`; add `configKeys`; regenerate generated block; frontend test. Writes: `custom_blocks/comfy_gen/frontend.block.tsx`, `frontend/src/components/pipeline/custom_blocks/generated/comfy_gen.tsx`, frontend test file (e.g. `frontend/src/components/pipeline/__tests__/comfy-gen-suffix-overrides.test.tsx`).

**⛓ Collision audit:** A writes backend + backend test; B writes frontend block + generated + frontend test. Disjoint. Shared dependency is the frozen response shape (declared above), not a co-written file. No collisions. (Breaker then attacks the integrated result — adversarial, writes only its own probe tests.)

**Each agent must:** implement its slice + write and green its own tests + self-verify against §3. Breaker proves any defect with a failing test (bool-as-int leak, wired-input dead field, multi-input node missing a field, dedupe miss on one input but not siblings, Restore drops state, suffix false-match).

```yaml
dispatch:
  frozen:
    - "docs/specs/2026-06-19-comfygen-suffix-overrides/"   # the contract itself
  slices:
    - {key: backend, writes: ["custom_blocks/comfy_gen/backend.block.py", "tests/test_comfygen_suffix_overrides.py"]}
    - {key: frontend, writes: ["custom_blocks/comfy_gen/frontend.block.tsx", "frontend/src/components/pipeline/custom_blocks/generated/comfy_gen.tsx", "frontend/src/components/pipeline/__tests__/comfy-gen-suffix-overrides.test.tsx"]}
  testRunner: "uv run pytest tests/test_comfygen_suffix_overrides.py -q  ||  npm --prefix frontend test -- --run comfy-gen-suffix-overrides"
```

## 8. Assumptions & Open Questions
- **ASSUMPTION:** every literal value on a node's `inputs` dict is patchable in place via `<node_id>.<input>`. This is exactly how existing detectors/overrides work (e.g. KSampler `steps`/`cfg`, `backend.block.py:412`+; resolution source `value`). Impact if wrong: an override wouldn't take — but the mechanism is shared with shipped panels, so low risk.
- **ASSUMPTION:** `_meta.title` is present and is the node's display name in API-format workflows (the same field every other detector reads, e.g. `backend.block.py:1574`). Impact if wrong: nothing surfaces.
- **ASSUMPTION:** exact, case-sensitive suffix `_ComfyGen` is what authors will type. Impact if wrong: false negatives only (no incorrect surfacing).
- **ASSUMPTION:** ComfyUI primitive inputs that are genuinely user-editable scalars are the str/int/float literals; combo/enum fields are also strings but excluded only if typed `combo` — we have no per-field schema, so a combo (e.g. `sampler_name`) WILL surface as a free-text string field. Impact: editable as text; user could type an invalid enum. Acceptable for v1 (same risk the preset `string` knob already carries). Flagged for the breaker.
- **OPEN:** if two *different* tagged nodes strip to the same label, both still surface (keyed by `node_id`); labels may visually collide. Acceptable (node_id-keyed, distinct fields).
