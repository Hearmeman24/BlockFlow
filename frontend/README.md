# AI Generation Pipeline

A local pipeline builder for AI video and image generation using RunPod serverless endpoints. Build visual workflows, chain blocks together, and run them with a single click.

> **Local only** — runs entirely on your machine. Nothing is deployed or hosted.

---

## What it does

You build a pipeline by connecting blocks left-to-right:

- Write a prompt → generate a video → upscale it → share to CivitAI
- Upload a reference image → write a prompt from it → generate an image-to-video
- Load a custom ComfyUI workflow → run it on RunPod serverless with auto-detected overrides

Each block does one thing. Outputs flow automatically into the next block. One "Run Pipeline" button executes the whole chain.

---

## Requirements

| Requirement | Notes |
|-------------|-------|
| Python 3.11+ | Managed via `uv` |
| Node.js 18+ | For the Next.js frontend |
| `uv` | `pip install uv` or `brew install uv` |
| `comfy-gen` CLI | Required for the ComfyUI Gen block only — `pip install comfy-gen` |
| RunPod account | For generation endpoints |

---

## Installation

```bash
# Clone the repo
git clone <repo-url>
cd sgs-ui

# Install Python dependencies
uv sync

# Install Node dependencies
cd frontend && npm install && cd ..
```

---

## Configuration

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

```dotenv
# Required for RunPod-based generation
RUNPOD_API_KEY=your_runpod_api_key

# Required for prompt writing (uses OpenRouter)
OPENROUTER_API_KEY=your_openrouter_api_key

# Optional — only needed for the blocks that use them
CIVITAI_API_KEY=your_civitai_api_key       # CivitAI Share block
TOPAZ_API_KEY=your_topaz_api_key           # Video/Image Upscale blocks
AWS_ACCESS_KEY_ID=your_aws_key             # If using S3 output storage
AWS_SECRET_ACCESS_KEY=your_aws_secret
AWS_REGION=us-east-1
S3_BUCKET=your_bucket_name
```

API keys for Topaz can also be entered directly in the UI — you don't need to set them in `.env`.

---

## Running

```bash
uv run app.py
```

Then open [http://localhost:3000](http://localhost:3000).

This starts both the FastAPI backend (port 8000) and the Next.js frontend (port 3000) together.

### Advanced mode

A small set of blocks are hidden by default for simplicity. To unlock all blocks:

```bash
uv run app.py --advanced
```

---

## Building a pipeline

1. **Open the Generate tab** — you'll see an empty canvas with a `+` button
2. **Add your first block** — click `+` to choose a block type
3. **Chain blocks together** — use the `+` at the end of the chain, or click the `+` between existing blocks to insert in the middle
4. **Configure each block** — click a block to expand its settings
5. **Click "Run Pipeline"** — all blocks execute in order; outputs flow automatically

When a run finishes, a **Continue** button appears. Add new blocks and click Continue to run only the new steps — completed blocks are skipped.

---

## Blocks

### Starters (can begin a pipeline)

| Block | What it does |
|-------|-------------|
| **Prompt Writer** | Write a video/image generation prompt using an LLM. Supports multi-turn refinement and video/image mode. |
| **Upload Image** | Upload a local image or paste a URL. Outputs the image for use in downstream blocks. |
| **Video Loader** | Upload a local video or paste a URL. |
| **ComfyUI Gen** | Load a ComfyUI API-format workflow and run it on a RunPod serverless endpoint. Auto-detects resolution, frame count, text fields, and input nodes. |

### Generation

| Block | What it does | Mode |
|-------|-------------|------|
| **Wan 2.2 T2V** | Text-to-video generation via RunPod | Advanced |
| **Wan 2.2 I2V** | Image-to-video generation via RunPod | Advanced |
| **I2V Prompt Writer** | Describe an image using vision LLM to generate an I2V prompt | — |

### Utilities

| Block | What it does | Mode |
|-------|-------------|------|
| **LoRA Selector** | Pick LoRA models and set their strengths | Advanced |
| **Human-in-the-Loop** | Pause the pipeline and manually approve or reject before continuing | — |
| **Image Viewer** | Display images inline — pass-through, no modification | — |
| **Video Viewer** | Display videos inline — pass-through, no modification | — |

### Post-processing

| Block | What it does |
|-------|-------------|
| **Video Upscale** | Upscale and enhance video using the Topaz Labs API |
| **Image Upscale** | Upscale and enhance images using the Topaz Labs API |
| **CivitAI Share** | Publish video or image output to CivitAI with auto-generated tags and metadata | Advanced |

---

## ComfyUI Gen block — tips

This block is the most powerful and flexible.

**Workflow format**: You need the **API format** JSON, not the regular ComfyUI save format. To get it:
1. In ComfyUI, enable Dev Mode in Settings
2. Use "Save (API Format)" to export

**What gets auto-detected** when you load a workflow:
- Image/video input nodes → automatically inserts the right upstream block
- Text fields (prompts, negative prompts) → editable override fields
- Resolution (width/height) → editable W/H fields
- Frame count → editable with 4n+1 snapping (required by video models)
- Reference video controls (for Wan Animate workflows)
- KSampler settings (steps, CFG, denoise)

**Upstream text**: Any text field can optionally be driven by a Prompt Writer block upstream — use the source selector on each field.

**From PNG**: If you saved a workflow as a PNG from ComfyUI, you can drop that PNG directly into the block and it will extract the embedded workflow automatically.

---

## Output files

All generated files are saved to the `outputs/` folder inside the `sgs-ui` directory.

Every output file has **generation metadata embedded** directly into it:
- MP4 videos: stored in the `comment` metadata field
- PNG images: stored as a `tEXt` metadata chunk

This means every file is self-describing — you can always recover the prompt, model, seed, LoRAs, and settings from the file itself.

The **Artifacts** tab shows all your output files. Files with embedded metadata show a green **META** badge.

---

## API keys — where each one is used

| Key | Used for |
|-----|---------|
| `RUNPOD_API_KEY` | Submitting jobs to RunPod serverless endpoints |
| `OPENROUTER_API_KEY` | Prompt Writer and I2V Prompt Writer (LLM calls) |
| `CIVITAI_API_KEY` | CivitAI Share block (publishing posts) |
| `TOPAZ_API_KEY` | Video Upscale and Image Upscale blocks |
| AWS credentials | Downloading outputs from S3 (if your RunPod worker writes to S3) |

If you don't use a particular block, you don't need that key.

---

## Troubleshooting

**"comfy-gen CLI not found"** — Install it: `pip install comfy-gen` and restart the app.

**ComfyUI job fails with "model not in list"** — A model file required by your workflow is missing from your RunPod network volume. Check the exact model filename in the error and download it to `/runpod-volume/ComfyUI/models/...`.

**Wrong workflow format** — If you see "This looks like a graph-format workflow", re-export from ComfyUI using Save (API Format) with Dev Mode enabled.

**Job gets stuck / no progress** — The Video Upscale block has stall detection built in (10-minute timeout). For RunPod jobs, check your endpoint status in the RunPod dashboard.

**Pipeline state is lost after closing the browser** — State is stored in session storage, which clears when the tab closes. This is a known limitation — pipeline persistence across sessions is planned.

---

## Development

The app auto-registers new blocks — just drop a `frontend.block.tsx` (and optionally `backend.block.py`) into `custom_blocks/<slug>/`. See `CLAUDE.md` for the full block authoring guide.

```bash
# Type-check and build the frontend
cd frontend && npm run build

# Run only the frontend in dev mode (hot reload)
cd frontend && npm run dev
```
