# Diffusion-model / checkpoint selector for ComfyGen

- **Work type:** `feature/app`
- **Status:** `draft` → awaiting Aviv approval (do NOT dispatch until approved)
- **Review surface:** [`spec.human.md`](./spec.human.md)

## 1. Problem / Context
ComfyGen surfaces editable controls for LoRAs, samplers, resolution, etc., but **not the diffusion model /
checkpoint**. A survey of the 68 workflows in `/Users/avivkaplan/Dump/ComfyUI-Workflows` shows model loaders
are near-universal and all use a single flat model-name field:
- `UNETLoader` ×77 → `unet_name` (e.g. `bigLove_zt3.safetensors`)
- `DiffusionModelLoaderKJ` ×12 → `model_name`
- `CheckpointLoaderSimple` ×5 → `ckpt_name`
- `UpscaleModelLoader` ×26 → `model_name`
To change the model today the user must rename the node `…_ComfyGen` (suffix feature) or use Workflow Settings —
both free-text, undiscoverable. This adds a first-class **Model** selector with a real dropdown.

## 2. Approach & why
Mirror the LoRA selector end-to-end; the model field is a flat top-level literal, so two things are cheap:
- **Override application is free.** Overrides flow as `{"node_id.param": value}` → `--override node_id.param=value`
  (`custom_blocks/comfy_gen/backend.block.py:2345-2349`). The CLI splits on the first dot
  (`/Users/avivkaplan/src/comfy/remote_comfy_generator/comfy_gen/cli.py:43`) → `param="unet_name"`, applied
  flat by the worker. No nesting, no backend mutation (unlike the Power Lora work).
- **Detection mirrors `_detect_lora_nodes`** (`backend.block.py:1302`) — scan for the loader class_types, emit one
  row per node with the model field + a `folder` tag.

The only real cost is the **dropdown choices**. The Sync button (`frontend.block.tsx:823,875`) calls
`refresh-cache` (`backend.block.py:158`) → `comfy-gen info` → `query_info.submit_query`, which returns **only**
`samplers/schedulers/loras` (`/Users/avivkaplan/src/comfy/remote_comfy_generator/comfy_gen/query_info.py:81-83`);
it does NOT list model files. Decision (per Aviv: "piggyback on sync command"): in the same refresh-cache flow,
**also run `comfy-gen object_info --classes UNETLoader CheckpointLoaderSimple DiffusionModelLoaderKJ
UpscaleModelLoader`** (CLI command exists: `cli.py:202 cmd_object_info`) and extract the file-list enum from
each loader's `input.required.<field>[0]`. This needs **no sgs-worker change** — object_info returns installed
file enums natively. Cache the result as `models` (keyed by folder) and feed it to the selector, exactly as
`applyCacheData` feeds `availableLoras` (`frontend.block.tsx:706-710`).

## 3. Acceptance Criteria
- [ ] A workflow containing a model loader shows a **Model** section, one row per loader, current value preselected. → (ask: "adding a diffusion model / checkpoint selector")
- [ ] After **Sync**, each row's dropdown lists the installed files for that loader's folder. → (ask: "piggyback on sync command")
- [ ] Selecting a different model changes the submitted workflow via `node_id.<field>` override. → (ask: "selector")
- [ ] Before Sync / offline, the field is an editable text input prefilled with the workflow value; a run still submits. → (graceful-degradation guard)
- [ ] Existing cache (samplers/schedulers/loras) and all other panels are byte-for-byte unchanged. → (regression guard)

## 4. Scope & Non-Goals
**In scope:**
- `custom_blocks/comfy_gen/backend.block.py` — `_detect_model_loaders`, parse-workflow `model_loaders`, extend
  `_run_refresh`/`refresh-status`/`/cache` with `models`.
- `custom_blocks/comfy_gen/frontend.block.tsx` — `availableModels` state, `applyCacheData` extension, Model
  `CollapsibleSection`, run-body override wiring.
- `frontend/src/lib/comfygen-overrides.ts` — emit model overrides into the existing `overrides` map.
- Regenerated `generated/comfy_gen.tsx`; tests both sides.

**Non-goals (explicitly NOT doing):**
- NO sgs-worker / `query_info` changes (object_info path avoids it).
- NOT surfacing secondary loader knobs (`weight_dtype`, sage/cublas flags) — existing override paths cover them.
- NOT adding model *download* here (separate `download-models` flow already exists, `backend.block.py:256`).
- NOT validating that a chosen file exists (the run surfaces `missing_models` already).

## 5. Key Decisions & Constraints
- **Decided:** choices via `object_info` piggybacked on Sync, not via extending `comfy-gen info`. Rationale: no
  worker redeploy; self-contained in BlockFlow + CLI. Alternative (worker returns models in one info call) is
  faster at runtime but cross-repo — left as a future optimization.
- **Decided:** loader→folder map — `UNETLoader`/`DiffusionModelLoaderKJ`→diffusion-model list, `CheckpointLoaderSimple`→checkpoints, `UpscaleModelLoader`→upscale_models. Each row carries `folder` so the right list feeds the right node.
- **Constraint / must-not-break:** the existing cache shape (`samplers/schedulers/loras`, `backend.block.py:31-34,71-73`) and `applyCacheData` LoRA/sampler wiring stay intact; `models` is additive.
- **Constraint:** object_info is an extra serverless job on Sync — run it concurrently/after info in the same
  `_run_refresh` thread; a failure to fetch models must NOT fail the whole Sync (degrade to no model list).
- **Mirror existing:** `_detect_lora_nodes` (`backend.block.py:1302`) for detection; the LoRA combobox in
  `renderOriginalRow` (`frontend.block.tsx` LoRA panel) for the row UI; `availableLoras`/`applyCacheData`
  (`frontend.block.tsx:637,706`) for the choices plumbing.

## 6. Code Surface Map
- `custom_blocks/comfy_gen/backend.block.py:31-99` — `_cache` shape, `/cache` route.
- `:106-202` — `_run_refresh` + `refresh-cache` + `refresh-status` (Sync backend; add object_info model fetch here).
- `:1302-1372` — `_detect_lora_nodes` (mirror for `_detect_model_loaders`).
- `:~2174-2189` — parse-workflow response assembly (add `model_loaders`).
- `:2345-2349` — overrides `{node_id.param}` build (model override flows here unchanged).
- `frontend/src/lib/comfygen-overrides.ts:241-343` — `buildOverrides` (emit model overrides into `overrides`).
- `custom_blocks/comfy_gen/frontend.block.tsx:84-86,637,706-775` — cache endpoints, `availableLoras`, `applyCacheData`, Sync.
- `/Users/avivkaplan/src/comfy/remote_comfy_generator/comfy_gen/cli.py:202` + `object_info.py` — the object_info CLI used for choices.

## 7. Ultracode Dispatch Notes
**Build first (freeze contracts):**
- Row shape + cache field. Backend `_detect_model_loaders` emits `{node_id, class_type, label, field, model_name, folder}`;
  parse-workflow returns `model_loaders`. Cache gains `models: {<folder>: [filenames]}`; `/cache` + refresh-status
  echo it. TS `ModelLoaderInfo` mirrors the row; `applyCacheData` accepts `models`.

**Parallel slices (disjoint files):**
- **Slice A — backend.** `_detect_model_loaders`, parse-workflow wiring, and the object_info model fetch folded into
  `_run_refresh` (concurrent with info, failure-isolated), `models` in `/cache` + refresh-status. Writes:
  `custom_blocks/comfy_gen/backend.block.py`, `tests/test_comfygen_model_loaders.py`.
- **Slice B — frontend.** `availableModels` state + `applyCacheData` extension; Model `CollapsibleSection` reusing the
  LoRA combobox; model override in `buildOverrides`; regenerate the block. Writes:
  `custom_blocks/comfy_gen/frontend.block.tsx`, `frontend/src/lib/comfygen-overrides.ts`,
  `frontend/src/components/pipeline/custom_blocks/generated/comfy_gen.tsx` (regenerated),
  `frontend/src/components/pipeline/__tests__/comfy-gen-model-selector.test.tsx`.

**⛓ Collision audit:** A = Python + its test; B = TS + its test + regenerated artifact. No shared file. Frozen row/cache
shape is the only coupling — agree it first.

**Each agent must:** implement + green its own tests + run the existing cache/lora suites for regression + self-verify §3.

## 8. Assumptions & Open Questions
- **ASSUMPTION:** `comfy-gen object_info` returns full file-list enums for `unet_name`/`ckpt_name`/`model_name`.
  Couldn't run a live job (needs the endpoint). Impact if wrong: dropdown empty → text fallback (still functional).
- **ASSUMPTION:** ComfyUI folder names map as in §5. Field names verified against the 68 workflows; folder names from
  convention. Impact if wrong: a row may get the wrong/empty list; text fallback covers it.
- **OPEN:** object_info on every Sync adds a serverless round-trip + cold-start. Acceptable, or fetch models lazily
  only when a model loader is present in the parsed workflow? (Spec defaults to: only fetch when `model_loaders` non-empty.)

```yaml
dispatch:
  frozen:
    - "/Users/avivkaplan/src/comfy/remote_comfy_generator/comfy_gen/cli.py"
    - "sgs-worker/"
  slices:
    - {key: backend, writes: ["custom_blocks/comfy_gen/backend.block.py", "tests/test_comfygen_model_loaders.py"]}
    - {key: frontend, writes: ["custom_blocks/comfy_gen/frontend.block.tsx", "frontend/src/lib/comfygen-overrides.ts", "frontend/src/components/pipeline/custom_blocks/generated/comfy_gen.tsx", "frontend/src/components/pipeline/__tests__/comfy-gen-model-selector.test.tsx"]}
  testRunner: "uv run pytest tests/test_comfygen_model_loaders.py -ra ; npm --prefix frontend test -- comfy-gen-model-selector"
```
