# ComfyGen Sidecar Resolution

BlockFlow shells out to the ComfyGen CLI for workflow submission, model
listing, preset installation, model downloads, and cancellation. Packaged
BlockFlow installs ComfyGen inside the managed Python environment, so callers
must not assume a global `comfy-gen` on `PATH`.

Resolution order:

1. `BLOCKFLOW_COMFY_GEN_BIN`: explicit executable override for local debugging
   or portable installs.
2. `BLOCKFLOW_COMFY_GEN_VENV`: managed venv path. BlockFlow resolves
   `bin/comfy-gen` on macOS/Linux and `Scripts/comfy-gen.exe` on Windows.
3. `PATH`: development fallback for repo checkouts with a globally installed
   `comfy-gen`.

The ComfyGen block health endpoint returns the resolved `mode` and `path`.
The block UI displays the mode so packaged runs can distinguish sidecar,
override, and PATH resolution.
