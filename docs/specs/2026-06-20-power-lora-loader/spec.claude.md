# Support "Power Lora Loader (rgthree)" in the ComfyGen block

- **Work type:** `feature/app`
- **Status:** `draft` → awaiting Aviv approval (do NOT dispatch until approved)
- **Bead:** sgs-ui-67rq
- **Review surface:** [`spec.human.md`](./spec.human.md)

## 1. Problem / Context
The ComfyGen block surfaces LoRA loaders for editing (strength, name, enable/bypass, add). It only
recognizes `LoraLoader` and `LoraLoaderModelOnly` (`custom_blocks/comfy_gen/backend.block.py:1299`).
The rgthree **Power Lora Loader** packs *multiple* LoRAs into a single node — each a nested dict
`lora_N = {on, lora, strength}` — and is widely used in the owner's workflows
(`/Users/avivkaplan/Dump/ComfyUI-Workflows/SVI/API_Wan2.2_SVI_4pass_V2.json` has 8 such nodes, e.g.
node `1021` = `{"lora_1": {"on": false, "lora": "...safetensors", "strength": 1}, "model": ["883",0]}`).
These nodes are currently invisible to the block: no rows, no overrides.

## 2. Approach & why
Treat **each `lora_N` as one LoRA row**, integrated into the existing LoRAs panel. The hard constraint
that shapes the whole design:

- The runtime override path is `{"node_id.param": value}` → CLI `--override node_id.param=value`
  (`backend.block.py:2345-2349`; emitted `cmd.extend(["--override", f"{key}={value}"])`). The CLI parses
  it as `node_id, _, param = key.partition(".")` — **split on the first dot only** —
  (`/Users/avivkaplan/src/comfy/remote_comfy_generator/comfy_gen/cli.py:43`), then stores
  `overrides[node_id][param]=value` and the worker applies `inputs[param]=value` **flat**. So a nested
  target like `1021.lora_1.strength` becomes `param="lora_1.strength"` and writes a junk flat key — it
  can never reach `inputs["lora_1"]["strength"]`.
- **Therefore Power-loader edits must be applied by mutating the workflow dict server-side in `/run`**,
  exactly where bypass + insertion already deep-copy and edit the workflow before submission
  (`backend.block.py:2317-2323`). Regular LoRAs keep the `--override` path unchanged.

Chain ordering already follows `inputs.model` (`backend.block.py:1330-1332`); Power-loader nodes have a
wired `model` input, so they slot into the existing chain ordering with no new logic.

## 3. Acceptance Criteria
- [ ] Loading a workflow with `Power Lora Loader (rgthree)` shows **one editable row per `lora_N`**
      (strength + enable toggle + LoRA name) in the existing LoRAs section. → (ask: "add support for the Power LoRA Loader as an acceptable LoRA loader")
- [ ] Disabling a Power row submits that LoRA with `on: false`; enabling submits `on: true`. → (ask: "map the per-LoRA `on` to enable")
- [ ] Editing a row's strength or LoRA name changes the submitted workflow's nested `lora_N` value. → (ask: "one row per lora_N")
- [ ] "Add LoRA" on a Power node appends a new `lora_{N+1}` entry (default `on:true, strength:1`) applied at run time. → (ask: "full parity")
- [ ] `LoraLoader` / `LoraLoaderModelOnly` detection, override, bypass, insertion are byte-for-byte unchanged; existing LoRA tests pass. → (regression guard)

## 4. Scope & Non-Goals
**In scope:**
- `custom_blocks/comfy_gen/backend.block.py` — detection (`_detect_lora_nodes` or a sibling) + a new
  `_apply_power_lora_overrides` step in `/run`.
- `custom_blocks/comfy_gen/frontend.block.tsx` — row rendering + state + run-body wiring.
- `frontend/src/lib/comfygen-overrides.ts` — routing Power rows out of the `--override` map.
- `tests/test_comfygen_*.py` + `frontend/src/.../__tests__/*.test.tsx`.

**Non-goals (explicitly NOT doing):**
- Changing the `comfy-gen` CLI or the RunPod worker to support nested override paths.
- X/Y-plot **axis** support for Power-loader strengths (regular LoRAs get axes via `computeAxesPure`;
  Power rows are edit-only this pass — note in §8).
- Surfacing any rgthree widget beyond `{on, lora, strength}` (no clip-strength / `strengthTwo` variants).
- The regenerated copy under `frontend/src/components/pipeline/custom_blocks/generated/comfy_gen.tsx` is a
  build artifact (`node frontend/scripts/gen-custom-block-registry.mjs`) — regenerate, don't hand-edit.

## 5. Key Decisions & Constraints
- **Decided:** Power rows render in the *existing* LoRAs panel (`renderOriginalRow` region,
  `frontend.block.tsx:2648`), grouped by node. — rationale: "acceptable LoRA loader" = joins existing handling.
- **Decided:** enable=false for a Power row → `on:false` in place (NOT node deletion). Node deletion
  (`_bypass_lora_nodes`, `backend.block.py:2270`) is wrong for a multi-LoRA node. Regular bypass unchanged.
- **Decided:** "Add LoRA" on a Power node appends `lora_{maxN+1}` to that node (not a standalone loader).
- **Constraint / must-not-break:** the regular-LoRA `--override` + `bypass_loras` + `added_loras` payloads
  (`frontend.block.tsx:1763-1764, 1898-1899`) and their apply functions stay exactly as-is.
- **Constraint:** per-row identity/state keys MUST be composite (`node_id::lora_key`) — many rows share a
  `node_id`. Current `loraOverrides` is keyed by `node_id` alone (`comfygen-overrides.ts:316`); Power rows
  need a distinct keyspace.
- **Mirror existing:** `_insert_lora_nodes`/`_bypass_lora_nodes` (`backend.block.py:2195,2270`) for the
  deep-copy-then-mutate pattern; `renderOriginalRow` (`frontend.block.tsx:2648`) for row UI.

## 6. Code Surface Map
- `custom_blocks/comfy_gen/backend.block.py:1299-1372` — `_LORA_CLASS_TYPES`, `_detect_lora_nodes`, chain ordering.
- `custom_blocks/comfy_gen/backend.block.py:2306-2323` — `/run`: deep-copy + bypass + insert hook point; add power apply here.
- `custom_blocks/comfy_gen/backend.block.py:2174-2189` — parse-workflow response assembly (`lora_nodes` emitted).
- `frontend/src/lib/comfygen-overrides.ts:59-70,135-136,241-343` — `LoraNodeInfo`, `LoraOverride`, `buildOverrides` LoRA block.
- `custom_blocks/comfy_gen/frontend.block.tsx:180-204` — TS interfaces; `:601-603` state; `:1122-1139,1288-1303` re-parse seeding; `:1603-1619,1763-1764,1898-1899` run-body; `:2635-2782` LoRA panel render.
- `/Users/avivkaplan/src/comfy/remote_comfy_generator/comfy_gen/cli.py:36-54` — override parse (first-dot split) — the constraint source.

## 7. Ultracode Dispatch Notes
**Build first (sequential — freeze the contracts):**
- The Power-row data shape + run-body field. Backend `_detect_lora_nodes` emits, for each rgthree
  `lora_N`: `{node_id, lora_key, class_type, label, lora_name, strength_model, on, is_power: true, chain_id}`.
  Run body gains `power_lora_overrides: [{node_id, lora_key, on, lora, strength, add?: true}]`. Mirror the
  TS `LoraNodeInfo`/`LoraOverride` shapes to match. These types are frozen before slices start.

**Parallel slices (disjoint files):**
- **Slice A — backend.** Detect rgthree rows (extend or add alongside `_detect_lora_nodes`); add
  `_apply_power_lora_overrides(workflow, entries)` called in `/run` after bypass/insert; `add` allocates
  the next `lora_N` index. Writes: `custom_blocks/comfy_gen/backend.block.py`, `tests/test_comfygen_power_lora.py`.
- **Slice B — frontend.** Render Power rows (composite keys) in the LoRAs panel, enable/strength/name/add
  affordances; collect into a `powerLoraOverrides` state; route them OUT of `buildOverrides`' `--override`
  map and INTO the new run-body field; regenerate the generated block. Writes:
  `custom_blocks/comfy_gen/frontend.block.tsx`, `frontend/src/lib/comfygen-overrides.ts`,
  `frontend/src/components/pipeline/custom_blocks/generated/comfy_gen.tsx` (regenerated),
  `frontend/src/components/pipeline/__tests__/comfy-gen-power-lora.test.tsx`.

**⛓ Collision audit:** A writes only Python + its own test; B writes only TS + its own test + the
regenerated artifact. No shared file. The frozen build-first type shape is the only coupling — agree it
first, then both build against it. (Given the tight coupling and ponytail bias, this is comfortably a
2-slice job; do NOT fan it wider.)

**Each agent must:** implement its slice + write and green its own tests + run the regular-LoRA suite to
prove no regression + self-verify against §3.

## 8. Assumptions & Open Questions
- **ASSUMPTION:** rgthree's API export uses exactly `lora_N = {on, lora, strength}` + wired `model`
  (+ optional `clip`). Verified only against the single on-disk sample. Impact if wrong: a variant with
  separate clip strength / `strengthTwo` won't surface those fields (strength still works).
- **ASSUMPTION:** the worker applies overrides as a flat `inputs[param]=value` (consistent with the CLI's
  first-dot split). Couldn't read the worker handler (separate `sgs-worker` repo). Impact if wrong: none —
  the backend-mutation design sidesteps the override path entirely for Power rows.
- **OPEN (deferred, see §4 non-goals):** X/Y axis sweeps over Power-row strengths are not included this
  pass. Confirm that's acceptable, or it becomes a Slice B follow-up.

```yaml
dispatch:
  frozen:
    - "/Users/avivkaplan/src/comfy/remote_comfy_generator/comfy_gen/cli.py"
  slices:
    - {key: backend, writes: ["custom_blocks/comfy_gen/backend.block.py", "tests/test_comfygen_power_lora.py"]}
    - {key: frontend, writes: ["custom_blocks/comfy_gen/frontend.block.tsx", "frontend/src/lib/comfygen-overrides.ts", "frontend/src/components/pipeline/custom_blocks/generated/comfy_gen.tsx", "frontend/src/components/pipeline/__tests__/comfy-gen-power-lora.test.tsx"]}
  testRunner: "uv run pytest tests/test_comfygen_power_lora.py -ra ; npm --prefix frontend test -- comfy-gen-power-lora"
```
