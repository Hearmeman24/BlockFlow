from __future__ import annotations

import importlib.util

from fastapi import FastAPI
from fastapi import APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend import config, state, routes

app = FastAPI(title="BlockFlow API")

# Local-only app — tighten origins if ever deployed publicly
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes.router)


def _load_custom_block_sidecars() -> None:
    """Discover and mount optional backend sidecars from custom_blocks/*/backend.block.py."""
    blocks_root = config.ROOT_DIR / "custom_blocks"
    if not blocks_root.exists():
        print(f"[custom-blocks] directory not found: {blocks_root}")
        return

    block_dirs = sorted((path for path in blocks_root.iterdir() if path.is_dir()), key=lambda path: path.name)
    if not block_dirs:
        print("[custom-blocks] no blocks found")
        return

    loaded: list[str] = []
    for block_dir in block_dirs:
        slug = block_dir.name
        backend_entry = block_dir / "backend.block.py"
        if not backend_entry.exists():
            print(f"[custom-blocks] {slug}: frontend-only")
            continue

        module_name = "custom_block_" + "".join(ch if ch.isalnum() else "_" for ch in slug) + "_backend"
        spec = importlib.util.spec_from_file_location(module_name, backend_entry)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"[custom-blocks] {slug}: failed to create import spec from {backend_entry}")

        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            raise RuntimeError(f"[custom-blocks] {slug}: failed importing {backend_entry}: {exc}") from exc

        router = getattr(module, "router", None)
        if router is None:
            raise RuntimeError(f"[custom-blocks] {slug}: backend sidecar must export `router`")
        if not isinstance(router, APIRouter):
            raise RuntimeError(f"[custom-blocks] {slug}: `router` must be APIRouter, got {type(router)}")

        prefix = f"/api/blocks/{slug}"
        app.include_router(router, prefix=prefix)
        loaded.append(slug)
        print(f"[custom-blocks] {slug}: loaded backend sidecar at {prefix}")

    if loaded:
        print(f"[custom-blocks] loaded backend sidecars: {', '.join(loaded)}")
    else:
        print("[custom-blocks] no backend sidecars loaded")


_load_custom_block_sidecars()
app.mount("/outputs", StaticFiles(directory=str(config.LOCAL_OUTPUT_DIR)), name="outputs")

state.init()
