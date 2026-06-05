<div align="center">

# BlockFlow

[![npm](https://img.shields.io/npm/v/@hearmeman24/blockflow?color=CB3837&label=npm)](https://www.npmjs.com/package/@hearmeman24/blockflow)
[![CI](https://github.com/Hearmeman24/BlockFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Hearmeman24/BlockFlow/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Hearmeman24/BlockFlow?display_name=tag)](https://github.com/Hearmeman24/BlockFlow/releases)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](LICENSE)

Source-available visual pipelines for AI image and video generation.

BlockFlow's main path runs ComfyUI workflows through ComfyGen on your own
RunPod serverless endpoint. Provider-specific blocks let you mix in models from
RunPod, PiAPI, OpenRouter, CivitAI, and more.

```bash
npx @hearmeman24/blockflow
```

---

### Pipeline Editor
![Pipeline View](docs/screenshots/pipeline-view.png)

### ComfyUI Gen Block
![ComfyUI Gen Block](docs/screenshots/comfyui-gen-block.png)

### Artifacts
![Artifacts Page](docs/screenshots/artifacts-page.png)

</div>

## Why BlockFlow

ComfyUI is powerful, but production workflows often need more than one graph
run. You may need prompt generation, reference images, a ComfyUI workflow,
post-processing, review, publishing, and repeated runs across many inputs.

BlockFlow turns that into a left-to-right pipeline. Blocks can branch, but you
do not have to wire low-level graph nodes together for every production flow.

The scale model is RunPod serverless: if your endpoint has 10 available workers,
BlockFlow can submit work in parallel instead of waiting for one local GPU queue.
You can also run multiple pipeline tabs at the same time, each with its own state,
cancellation, outputs, and artifacts.

## Generation Backends

BlockFlow can orchestrate multiple generation backends in one pipeline.

### ComfyUI via ComfyGen

The primary backend path is ComfyUI through
[ComfyGen](https://github.com/Hearmeman24/ComfyGen). BlockFlow provisions or
attaches a RunPod serverless endpoint, sends ComfyUI workflows to it, monitors
jobs, handles cancellation, and stores outputs locally.

This is the path for:

- arbitrary ComfyUI workflow JSONs
- installed workflow/model presets
- LoRA-aware ComfyUI generation
- model downloads to the endpoint's network volume
- serverless worker scaling

### Direct Provider Blocks

Some blocks call hosted models directly instead of going through ComfyUI:

- **Nano Banana 2** on RunPod
- **Seedance 2** through PiAPI
- **GPT Image** through PiAPI
- **Prompt and multimodal prompt writing** through OpenRouter
- **CivitAI sharing** for publishing generated media

You can mix these in one pipeline: generate a prompt, create or edit an image
with one provider, animate it with another, upscale it, review it, and publish
the result.

## Presets

BlockFlow can install ComfyGen presets: packaged workflow + model bundles that
land on your own ComfyUI RunPod endpoint.

The public preset registry lives here:

[github.com/Hearmeman24/blockflow-presets](https://github.com/Hearmeman24/blockflow-presets)

Current examples include:

- `gbrx-mop-pro`
- `hidream-o1`
- `ltx-2-3`
- `qwen-image-lighting`
- `wan-animate`
- `wan22-svi-4pass`

Presets are useful when a workflow needs a specific model set, hidden internal
nodes, exposed user controls, or repeatable setup across machines.

## What You Can Build

- ComfyUI generation pipelines backed by RunPod serverless workers
- prompt -> image -> video -> upscale flows
- image and video reference workflows
- dataset creation and captioning flows
- LoRA training and upload-to-ComfyGen flows
- batch and sweep-style runs across prompts, LoRAs, settings, or references
- human review gates before downstream steps
- artifacts that can be restored, inspected, or submitted to CivitAI

## Quick Start

Run the published package:

```bash
npx @hearmeman24/blockflow
```

BlockFlow starts a local FastAPI backend and a prebuilt Next.js frontend, then
opens the browser UI.

On first use:

1. Open **Settings** and add the credentials for the services you want to use.
2. Set up or attach a **ComfyGen** RunPod endpoint.
3. Install a preset, paste a ComfyUI workflow, or add direct provider blocks.
4. Build a pipeline and click **Run Pipeline**.

BlockFlow runs locally and uses your own API keys, RunPod account, and storage.
Generation costs are paid directly to the services you connect.

## Common Workflows

### ComfyUI at Serverless Scale

Install a preset or paste a workflow, configure the exposed controls, then run it
through a ComfyGen endpoint. Increase the endpoint worker count when you need
more parallel generation.

### Content Pipelines

Use prompt blocks, image/video generation blocks, viewers, upscalers, and
publishing blocks as one repeatable workflow instead of a folder of disconnected
scripts.

### LoRA and Dataset Workflows

Create datasets, caption images, submit LoRA training jobs, and upload trained
LoRAs back to the ComfyGen endpoint so downstream generation can use them.

## Local Development

For repository development:

```bash
git clone https://github.com/Hearmeman24/BlockFlow.git
cd BlockFlow
uv run app.py
```

The dev entrypoint starts FastAPI on `:8000` and Next.js on `:3000`.

Useful commands:

```bash
uv run pytest
npm --prefix frontend test
npm --prefix frontend run build
```

## Documentation

- [Architecture](docs/architecture.md)
- [Testing](docs/testing.md)
- [ComfyGen sidecar resolution](docs/comfygen-sidecar.md)
- [npm release flow](docs/npm-release.md)
- [Private blocks](docs/private-blocks.md)
- [Contributing](docs/contributing.md)

## License

BlockFlow is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE).

You may use, study, modify, and share BlockFlow for non-commercial purposes under
that license.

Commercial use is not permitted without a separate written commercial license.
This includes using BlockFlow in a revenue-generating product, service, website,
client project, SaaS offering, hosted service, or internal business workflow.

For commercial licensing, contact: hearmeman@hearmemanai.xyz.
