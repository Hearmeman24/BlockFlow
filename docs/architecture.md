# Architecture

A high-level map of how the BlockFlow pieces fit together. Skim this first
if you're about to make a non-trivial change.

## The big picture

```
┌──────────────────────────────────────────────────────────────────┐
│  Your machine (local-only)                                       │
│                                                                  │
│  ┌──────────────────┐         ┌──────────────────┐               │
│  │  Next.js (3000)  │ ◄────►  │  FastAPI (8000)  │               │
│  │  React UI        │         │  + block sidecars│               │
│  └────────┬─────────┘         └────────┬─────────┘               │
│           │                            │                          │
│           │ HTTP (proxied via Next)    │ HTTP                     │
│           ▼                            ▼                          │
│  ┌──────────────────┐         ┌──────────────────┐               │
│  │ /api/wizard/...  │         │ Settings store   │               │
│  │ /api/settings/...│         │ (sqlite)         │               │
│  │ /api/blocks/.../..│         │ + run history    │               │
│  └────────┬─────────┘         └──────────────────┘               │
│           │                                                       │
│           │ outbound (RunPod, R2, OpenRouter, ...)                │
└───────────┼───────────────────────────────────────────────────────┘
            │
            ▼
       ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
       │  RunPod         │  │  Cloudflare R2  │  │  Other APIs     │
       │  serverless     │  │  / AWS S3       │  │  (OpenRouter,   │
       │  endpoints      │  │  (transport)    │  │   CivitAI, ...) │
       └─────────────────┘  └─────────────────┘  └─────────────────┘
```

## Components

### Frontend (`frontend/`)

Next.js 16 + React 19 app. Three primary routes:

- `/generate` — the pipeline canvas. Users drop blocks, connect them, run the pipeline.
- `/artifacts` — saved outputs, history of past runs.
- `/settings` — credentials, endpoints, app preferences. Gated by a gear icon top-right of the NavBar.

The pipeline runs entirely in the browser's main thread; each block's `execute` function is async and receives the accumulated upstream outputs + an `AbortSignal`. Blocks call backend routes (FastAPI) for anything beyond pure DOM logic — including all RunPod traffic, which the backend proxies.

### Backend (`backend/`)

FastAPI app started via `uv run app.py`. Three categories of routes:

- **Shared routes** (`backend/routes.py`): flows + runs storage, feature flags, file metadata.
- **Block sidecars** (`custom_blocks/*/backend.block.py`): auto-loaded at boot via `backend/main.py`, each mounted at `/api/blocks/<slug>/...`. The `.8` overlay (sgs-ui-wisp-las.8) also scans an optional `private_blocks/` directory for private-only blocks.
- **Settings + wizard** (`backend/settings_routes.py`, `backend/wizard_routes.py`): the Settings page's CRUD + validation endpoints, and the ComfyGen setup wizard.

### Settings store (`backend/settings_store.py`)

Three SQLite tables coexisting in `run_history.db`:

- `settings_credentials` — API keys, R2/S3 creds.
- `settings_endpoints` — ComfyGen + AIO trainer config (endpoint ID, template ID/name, volume ID, GPU tier, max workers).
- `settings_app_prefs` — output directory, run history retention.

Repository functions live in `settings_store.py`. The HTTP layer is `settings_routes.py`. Validation (RunPod whoami, R2 round-trip, OpenRouter auth) lives in `settings_validators.py`.

### RunPod client (`backend/runpod_api.py`)

Thin wrapper over RunPod's GraphQL + REST APIs. Used by:

- The setup wizard (`wizard_routes.py`) for provisioning + tear-down.
- The future Settings tear-down action (Stage 5.5).
- The block sidecars for submitting jobs.

All HTTP goes through `curl_cffi.requests` (matches the existing pattern in `topaz_upscaler.py`).

## Data flow: a typical generation

1. User builds a pipeline on `/generate`, hits "Run".
2. The pipeline runner walks blocks left-to-right. Each block's `execute` runs in the browser.
3. The ComfyGen block, when executed, POSTs to `/api/blocks/comfy_gen/run` (backend).
4. The backend sidecar reads the configured ComfyGen endpoint from Settings, calls RunPod's `/v2/{id}/run` with the workflow, polls until done.
5. The result (image URL) comes back through the same chain and ends up in the artifacts page + the current run's outputs.

## Data flow: setting up an endpoint

1. User opens `/settings`, hits "Set up" on the ComfyGen row → ComfyGen wizard modal mounts.
2. Wizard runs `wizardPreflight()` → backend `/api/wizard/comfygen/preflight` reads Settings, returns `{ready, missing}`.
3. If `ready`, user picks a tier + config → wizard calls `wizardProvision()` → backend creates a network volume, a template (with R2 creds baked in as env vars), and an endpoint via the RunPod client.
4. On success, the wizard writes the endpoint record to Settings (including `template_name` so future tear-down can call `deleteTemplate`).
5. Wizard polls `/api/wizard/comfygen/health/{id}` until a worker is ready (or user clicks Skip).

## Storage layout

- `run_history.db` — SQLite. Runs + settings tables.
- `output/` — local image/video outputs (configurable per app pref).
- `flows/` — saved pipelines (gitignored).
- `prompt_packs/` — bundled prompt-writer system prompts.
- `private_blocks/` — local private overlay (gitignored).

## What lives outside this repo

- **`comfy-gen` CLI** ([`Hearmeman24/remote-comfy-gen`](https://github.com/Hearmeman24/remote-comfy-gen) — installed via `pip install comfy-gen`. Submits workflows to ComfyGen RunPod endpoints; some block sidecars shell out to it.
- **ComfyGen worker** — the RunPod serverless image that actually runs ComfyUI. BlockFlow's wizard provisions an endpoint backed by this image.
- **AIO LoRA Trainer** (`sgs-ui-wisp-las.5` will publish this) — the RunPod serverless image for LoRA training.
- **Preset registry** (`sgs-ui-wisp-las.10` will create this) — a separate GitHub repo holding workflow JSONs + model manifests; BlockFlow's preset installer fetches from there.

## Where things will change

The current state of the public-release push is tracked in the `sgs-ui-wisp-las` bead epic. A few in-flight pieces are documented in their own bead notes:

- Tear-down + Recreate actions on the Endpoints tab (Stage 5.5 — RunPod API plumbing is built but UI isn't wired yet).
- Storage tab (deferred until the preset installer ships).
- Preset registry (`sgs-ui-wisp-las.10`) + installer subsystem (`sgs-ui-wisp-las.3`).
