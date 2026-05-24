from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Iterable

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend import (
    config,
    db,
    preset_routes,
    routes,
    settings_routes,
    settings_store,
    state,
    wizard_routes,
)

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
app.include_router(settings_routes.router)
app.include_router(wizard_routes.router)
app.include_router(preset_routes.router)

# Ensure the settings tables exist before any block sidecar (which may read
# Settings on import in later beads). Safe to call repeatedly — it's a no-op
# once the tables are present.
settings_store.init_db()


def _prune_run_history_on_startup() -> None:
    """Apply the user's retention setting to the run history table on launch.

    Reads `run_history_retention_days` from app_prefs. Accepts:
      - integer days as a string (e.g. "30", "90", "365")
      - the literal "forever" → skip pruning
    Unset → fall back to 90 days (the documented default in the UI).
    Invalid values → log and skip.
    """
    # Ensure the runs table exists before we try to delete from it. db.init_db
    # is idempotent and also runs later via state.init().
    db.init_db()

    raw = settings_store.get_app_pref("run_history_retention_days", default="90")
    if raw == "forever":
        return
    try:
        days = int(raw or "90")
    except ValueError:
        print(f"[run-history] invalid retention pref '{raw}'; skipping prune")
        return
    deleted = db.prune_runs_older_than(days)
    if deleted:
        print(f"[run-history] pruned {deleted} run(s) older than {days} days")


_prune_run_history_on_startup()


def _refresh_installed_presets_on_startup() -> None:
    """Re-fetch installed presets' metadata from the registry on launch so
    author-side edits (e.g. a new workflows[].settings knob, updated
    recommendations) propagate without forcing the user to uninstall and
    reinstall. Runs in a background daemon thread — network I/O must not
    block the FastAPI server's boot, and a slow/offline registry must not
    delay block sidecars or the UI starting up."""
    import threading

    def _runner() -> None:
        try:
            summary = preset_routes.refresh_installed_presets()
            r = len(summary.get("refreshed", []))
            s = len(summary.get("skipped", []))
            e = len(summary.get("errors", []))
            if r or e:
                print(f"[preset-refresh] {r} refreshed, {s} skipped, {e} error(s)")
        except Exception as exc:
            print(f"[preset-refresh] background refresh crashed: {exc}")

    threading.Thread(target=_runner, daemon=True).start()


_refresh_installed_presets_on_startup()


def _discover_sidecars(dirs: Iterable[tuple[Path, str]]) -> list[tuple[str, str, Path]]:
    """Walk each (root, source_label) pair; collect candidate (slug, source, backend_entry).

    Returns sidecars sorted by slug. Raises on cross-dir slug collision so the
    loader can fail before any router is mounted (all-or-nothing semantics).

    A dir that doesn't exist is treated as empty.
    A block dir without `backend.block.py` is skipped (frontend-only block).
    """
    by_slug: dict[str, tuple[str, Path]] = {}  # slug -> (source, backend_entry)
    collisions: list[tuple[str, str, str]] = []  # (slug, source_a, source_b)

    for blocks_root, source in dirs:
        if not blocks_root.exists():
            continue
        for block_dir in sorted(blocks_root.iterdir(), key=lambda p: p.name):
            if not block_dir.is_dir():
                continue
            slug = block_dir.name
            backend_entry = block_dir / "backend.block.py"
            if not backend_entry.exists():
                continue
            if slug in by_slug:
                prior_source, _ = by_slug[slug]
                collisions.append((slug, prior_source, source))
            else:
                by_slug[slug] = (source, backend_entry)

    if collisions:
        lines = [f"  - '{slug}' exists in both {a}/ and {b}/" for slug, a, b in collisions]
        raise RuntimeError(
            "[custom-blocks] slug collision across source dirs (rename to disambiguate):\n"
            + "\n".join(lines)
        )

    return sorted(
        ((slug, source, entry) for slug, (source, entry) in by_slug.items()),
        key=lambda t: t[0],
    )


def load_block_sidecars(target_app: FastAPI, dirs: Iterable[tuple[Path, str]]) -> list[str]:
    """Discover + mount backend sidecars from each (root, source_label) pair.

    Mounts each sidecar's `router` at `/api/blocks/<slug>`. Returns the
    loaded slugs (sorted). Raises RuntimeError on:
      - slug collision across source dirs (raised before any mount)
      - sidecar missing the `router` export
      - sidecar `router` not an APIRouter
      - sidecar import failure
    """
    sidecars = _discover_sidecars(dirs)
    loaded: list[str] = []

    for slug, source, backend_entry in sidecars:
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
        target_app.include_router(router, prefix=prefix)
        loaded.append(slug)
        print(f"[custom-blocks] {slug}: loaded from {source}/ at {prefix}")

    if loaded:
        print(f"[custom-blocks] loaded backend sidecars: {', '.join(loaded)}")
    else:
        print("[custom-blocks] no backend sidecars loaded")

    return loaded


load_block_sidecars(
    app,
    [
        (config.ROOT_DIR / "custom_blocks", "custom_blocks"),
        (config.ROOT_DIR / "private_blocks", "private_blocks"),
    ],
)
app.mount("/outputs", StaticFiles(directory=str(config.LOCAL_OUTPUT_DIR)), name="outputs")

state.init()
