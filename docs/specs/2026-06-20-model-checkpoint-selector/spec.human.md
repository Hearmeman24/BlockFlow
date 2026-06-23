<!-- spec.human.md — 30-second review surface. Veto at ⚠️ and 🎲. -->

# Diffusion-model / checkpoint selector for ComfyGen

**Type:** `feature/app` · **Full spec:** [`spec.claude.md`](./spec.claude.md)

## ✅ What you'll see when this is done
Load a workflow with a `UNETLoader` / `CheckpointLoaderSimple` / `DiffusionModelLoaderKJ` (≈every workflow in your dump), and a new **Model** section appears in the ComfyGen block listing each model loader with an editable **model-name dropdown** (current value preselected). Hit **Sync** and the dropdown fills with the actual model files installed on your endpoint. Pick a different model → that's what the run submits.

## ⚠️ Decisions you're approving
- **Dropdown choices come from an `object_info` fetch piggybacked on Sync** — chose this over extending `comfy-gen info` (the worker's samplers/loras query) because object_info already returns the installed-file lists, so it needs **no sgs-worker change or redeploy**. Sync just fires one extra fetch. ← change if you'd rather pay the worker change to fold it into the single info call.
- **Covers `unet_name` / `ckpt_name` / `model_name` (the model field only)** — the secondary knobs on those nodes (`weight_dtype`, sage/cublas flags) are left to the existing Workflow-Settings / `_ComfyGen` paths, not duplicated here. ← say if you want dtype surfaced too.
- **`UpscaleModelLoader` (26×) included** as a model loader, since it's the same shape (`model_name` from `upscale_models/`). ← drop it if you only meant diffusion models.

## 🎲 Riding on these assumptions
- **`comfy-gen object_info` returns the file-list enum** for `unet_name`/`ckpt_name`/`model_name` (ComfyUI `/object_info` does this natively). If the worker's object_info trims enums, the dropdown falls back to free-text. (verified the CLI command exists; did not run a live object_info job — needs your endpoint.)
- **Folder→field mapping is stable**: UNETLoader→`diffusion_models`/`unet`, CheckpointLoaderSimple→`checkpoints`, Upscale→`upscale_models`. So the right list feeds the right node. (verified field names against your 68 workflows; folder names assumed from ComfyUI convention.)

## 🪤 Gotchas
- Unlike the Power Lora work, **overrides here are free**: these are flat top-level fields, so the existing `--override node_id.unet_name=…` path applies them directly — no backend mutation.
- The model list is endpoint-specific and only populates **after a Sync**; before that (or offline) the field is an editable text input prefilled with the workflow's current value, so it never blocks a run.

## Done when
- [ ] Model loaders are detected and shown in a Model section with the current model preselected.
- [ ] After Sync, the dropdown lists installed model files for that loader's folder.
- [ ] Changing the selection changes the submitted workflow (`node_id.<field>` override).
- [ ] No worker/redeploy needed; offline → editable text fallback, run still works.
- [ ] LoRA/sampler caching and every existing panel are unchanged.

## The plan
1. **Backend detect** — `_detect_model_loaders` (mirrors `_detect_lora_nodes`); parse-workflow returns `model_loaders`.
2. **Backend choices** — Sync's refresh also runs `object_info` for the loader classes, extracts file lists per folder, caches them; `/cache` + refresh-status return `models`.
3. **Frontend** — `availableModels` from cache; a Model `CollapsibleSection` with the same combobox the LoRA rows use; override wired in `buildOverrides`.

## ✂️ Not asked for — cut?
- Surfacing `weight_dtype` / sage flags — defaulting to CUT (use existing override paths).
