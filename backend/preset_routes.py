"""Preset installer (sgs-ui-wisp-las.3 Stages A + B).

Routes:
  Stage A (read-only):
    - GET  /api/presets/manifest[?refresh=1]      → fetch registry manifest
    - GET  /api/presets/manifest/{preset_id}      → one preset's full detail
    - GET  /api/presets/installed                 → list installed presets
    - GET  /api/presets/installed/{preset_id}     → one installed preset

  Stage B (install / uninstall):
    - POST /api/presets/install         { preset_id }   → kicks off batch download
    - GET  /api/presets/install/progress             → snapshot of current install
    - POST /api/presets/uninstall/{preset_id}        → drops Settings row

The manifest is fetched from a single public URL (per .3 design grilling):
`https://raw.githubusercontent.com/Hearmeman24/blockflow-presets/main/manifest.json`.
1-hour in-memory cache + on-disk fallback for offline cases.

Install flow (Stage B):
  1. Fetch the full preset.json from manifest[preset_id].preset_url
  2. Pre-check disk space: RunPod gives volume total size; subtract sum of
     installed_presets.disk_size_gb in Settings → free estimate. Reject
     install when preset.disk_size_estimate_gb > free_estimate.
  3. Build a comfy-gen batch download spec, write to a temp file
  4. Spawn `comfy-gen download --batch <file> --endpoint-id <ep>` in a
     daemon thread; track state in module-level _install_state
  5. On success: settings_store.record_installed_preset(...)
  6. Concurrency: one install at a time (409 if busy)
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from curl_cffi import requests as _cffi_requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend import config, runpod_api, settings_store

router = APIRouter()

# Where to fetch the canonical manifest from.
_MANIFEST_URL = (
    "https://raw.githubusercontent.com/Hearmeman24/blockflow-presets/main/manifest.json"
)
_CACHE_TTL_SEC = 3600  # 1 hour
_HTTP_TIMEOUT_SEC = 15

# Persistent fallback cache (survives process restarts → offline-friendly).
_CACHE_PATH: Path = config.ROOT_DIR / "preset_manifest_cache.json"

# In-memory cache
_cache: dict[str, Any] = {
    "fetched_at": 0.0,
    "manifest": None,
}


def _cache_reset() -> None:
    """Test helper — wipe both layers of cache."""
    _cache["fetched_at"] = 0.0
    _cache["manifest"] = None
    try:
        _CACHE_PATH.unlink(missing_ok=True)
    except OSError:
        pass


def _force_cache_expired() -> None:
    """Test helper — make the in-memory cache look stale without nuking the
    on-disk fallback. Used to simulate TTL expiry."""
    _cache["fetched_at"] = 0.0


def _load_disk_cache() -> dict | None:
    if not _CACHE_PATH.exists():
        return None
    try:
        return json.loads(_CACHE_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _save_disk_cache(manifest: dict) -> None:
    try:
        _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CACHE_PATH.write_text(json.dumps(manifest, indent=2) + "\n")
    except OSError:
        pass  # best-effort; in-memory cache still works


def _cache_is_fresh() -> bool:
    if _cache["manifest"] is None:
        return False
    return (time.time() - _cache["fetched_at"]) < _CACHE_TTL_SEC


def _fetch_manifest() -> dict:
    """Hit the registry URL and return the parsed manifest. Raises on
    network failure or non-JSON response."""
    resp = _cffi_requests.get(_MANIFEST_URL, timeout=_HTTP_TIMEOUT_SEC)
    if resp.status_code >= 400:
        raise RuntimeError(f"registry returned HTTP {resp.status_code}")
    try:
        return resp.json()
    except (ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"registry returned non-JSON: {exc}") from exc


@router.get("/api/presets/manifest")
def get_manifest(refresh: int = 0) -> JSONResponse:
    """Return the registry manifest. Cached in-memory for ~1h; on network
    failure with no cache, returns 502."""
    if not refresh and _cache_is_fresh():
        return JSONResponse(_cache["manifest"])

    try:
        manifest = _fetch_manifest()
    except Exception as exc:
        # Network / parse error. Try the disk fallback so we degrade gracefully.
        # If the in-memory cache is populated (just expired), prefer that —
        # it's at least as fresh as the disk copy.
        fallback = _cache["manifest"] or _load_disk_cache()
        if fallback is not None:
            payload = {**fallback, "cache": "stale", "fetch_error": str(exc)}
            return JSONResponse(payload)
        raise HTTPException(
            status_code=502,
            detail=f"could not reach preset registry: {exc}",
        ) from exc

    # Success — refresh both layers of cache
    _cache["manifest"] = manifest
    _cache["fetched_at"] = time.time()
    _save_disk_cache(manifest)
    return JSONResponse(manifest)


@router.get("/api/presets/installed")
def list_installed() -> JSONResponse:
    rows = settings_store.list_installed_presets()
    return JSONResponse({"installed": rows})


@router.get("/api/presets/installed/{preset_id}")
def get_installed(preset_id: str) -> JSONResponse:
    row = settings_store.get_installed_preset(preset_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"preset '{preset_id}' is not installed")
    # workflow_json is stored as a string; parse for the consumer.
    try:
        wf = json.loads(row["workflow_json"]) if row["workflow_json"] else {}
    except (ValueError, json.JSONDecodeError):
        wf = {}
    return JSONResponse({**row, "workflow_json": wf})


# === Stage B: install + uninstall ============================================

class InstallBody(BaseModel):
    preset_id: str = Field(..., min_length=1)


# Module-level install state (single-install-at-a-time per .3 design call)
_install_state: dict[str, Any] = {
    "state": "idle",        # "idle" | "queued" | "running" | "completed" | "error"
    "preset_id": None,
    "started_at": None,
    "completed_at": None,
    "files_total": 0,
    "error": None,
}
_install_lock = threading.Lock()


def _reset_install_state() -> None:
    """Test helper."""
    _install_state.update({
        "state": "idle",
        "preset_id": None,
        "started_at": None,
        "completed_at": None,
        "files_total": 0,
        "error": None,
    })


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _find_manifest_entry(preset_id: str) -> dict | None:
    """Return the manifest entry for preset_id; refresh manifest if empty."""
    manifest = _cache["manifest"]
    if manifest is None or not _cache_is_fresh():
        try:
            manifest = _fetch_manifest()
            _cache["manifest"] = manifest
            _cache["fetched_at"] = time.time()
            _save_disk_cache(manifest)
        except Exception:
            manifest = _cache["manifest"] or _load_disk_cache()
    if not manifest:
        return None
    for entry in manifest.get("presets", []):
        if entry.get("id") == preset_id:
            return entry
    return None


@router.get("/api/presets/manifest/{preset_id}")
def get_preset_detail(preset_id: str) -> JSONResponse:
    entry = _find_manifest_entry(preset_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"preset '{preset_id}' not in registry manifest")
    try:
        resp = _cffi_requests.get(entry["preset_url"], timeout=_HTTP_TIMEOUT_SEC)
        if resp.status_code >= 400:
            raise RuntimeError(f"registry returned HTTP {resp.status_code}")
        detail = resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"could not fetch preset detail: {exc}") from exc
    return JSONResponse(detail)


def _compute_disk_budget() -> dict[str, Any]:
    """Best-effort: ask RunPod for the ComfyGen volume's total size and
    subtract sum of installed-preset disk_size_gb to estimate free space.
    Not exact (the user may have downloaded models out of band), but a
    sane safety net for the install pre-check."""
    api_key = settings_store.get_credential("runpod_api_key") or ""
    ep = settings_store.get_endpoint("comfygen") or {}
    volume_id = ep.get("volume_id")

    total_gb: int | None = None
    if api_key and volume_id:
        try:
            vol = runpod_api.get_network_volume(api_key, volume_id)
            total_gb = vol.get("size")
        except runpod_api.RunPodAPIError:
            total_gb = None
        except Exception:
            total_gb = None

    used_est_gb = sum(
        (p.get("disk_size_gb") or 0) for p in settings_store.list_installed_presets()
    )
    free_est_gb = (total_gb - used_est_gb) if total_gb is not None else None
    return {
        "total_gb": total_gb,
        "used_estimate_gb": used_est_gb,
        "free_estimate_gb": free_est_gb,
    }


@router.get("/api/presets/disk-budget")
def disk_budget() -> JSONResponse:
    return JSONResponse(_compute_disk_budget())


def _run_install_subprocess(
    *,
    preset_id: str,
    version: str,
    disk_size_gb: int,
    workflow_json_str: str,
    batch_spec: list[dict],
    endpoint_id: str,
) -> None:
    """Background worker. Runs `comfy-gen download --batch` then persists
    Settings on success. Updates _install_state throughout."""
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as tf:
            json.dump(batch_spec, tf)
            batch_path = tf.name

        proc = subprocess.run(
            [
                "comfy-gen", "download",
                "--batch", batch_path,
                "--endpoint-id", endpoint_id,
                "--timeout", "3600",  # 1h ceiling for large preset downloads
            ],
            capture_output=True,
            text=True,
            timeout=3600 + 60,
        )

        if proc.returncode != 0:
            error = (proc.stderr or proc.stdout or "comfy-gen download failed").strip()[:2000]
            _install_state.update({
                "state": "error",
                "completed_at": _now_iso(),
                "error": error,
            })
            return

        # Success — persist to Settings.
        settings_store.record_installed_preset(
            preset_id=preset_id,
            version=version,
            disk_size_gb=disk_size_gb,
            workflow_json=workflow_json_str,
        )
        _install_state.update({
            "state": "completed",
            "completed_at": _now_iso(),
            "error": None,
        })

    except Exception as exc:
        _install_state.update({
            "state": "error",
            "completed_at": _now_iso(),
            "error": str(exc)[:2000],
        })
    finally:
        try:
            Path(batch_path).unlink(missing_ok=True)  # type: ignore[name-defined]
        except Exception:
            pass


def _fetch_workflow_for_preset(preset: dict) -> dict:
    """Workflow can be inline (preset.workflow.json) or referenced by URL
    (preset.workflow.url). Always return a dict ready to persist."""
    wf = preset.get("workflow") or {}
    if "json" in wf and isinstance(wf["json"], dict):
        return wf["json"]
    url = wf.get("url")
    if not url:
        return {}
    try:
        resp = _cffi_requests.get(url, timeout=_HTTP_TIMEOUT_SEC)
        if resp.status_code >= 400:
            return {}
        return resp.json()
    except Exception:
        return {}


@router.post("/api/presets/install")
def install_preset(body: InstallBody) -> JSONResponse:
    api_key = settings_store.get_credential("runpod_api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="runpod_api_key not configured in Settings")

    ep = settings_store.get_endpoint("comfygen")
    if ep is None or not ep.get("endpoint_id"):
        raise HTTPException(
            status_code=400,
            detail="no ComfyGen endpoint configured — set one up via Settings → Endpoints first",
        )

    entry = _find_manifest_entry(body.preset_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"preset '{body.preset_id}' not in registry manifest")

    # Fetch full preset detail (models + workflow URL)
    try:
        detail_resp = _cffi_requests.get(entry["preset_url"], timeout=_HTTP_TIMEOUT_SEC)
        if detail_resp.status_code >= 400:
            raise RuntimeError(f"registry returned HTTP {detail_resp.status_code}")
        preset = detail_resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"could not fetch preset detail: {exc}") from exc

    # Disk pre-check (best-effort; RunPod knows volume size, Settings knows
    # what we've already installed — see _compute_disk_budget).
    budget = _compute_disk_budget()
    need_gb = preset.get("disk_size_estimate_gb", 0)
    free_est = budget.get("free_estimate_gb")
    if free_est is not None and need_gb > free_est:
        raise HTTPException(
            status_code=400,
            detail=(
                f"insufficient disk: preset needs {need_gb} GB, "
                f"~{free_est} GB free on the ComfyGen volume "
                f"(total {budget['total_gb']} GB, est. used {budget['used_estimate_gb']} GB). "
                "Uninstall presets or resize the volume."
            ),
        )

    # Concurrency: one install at a time
    with _install_lock:
        if _install_state["state"] in ("queued", "running"):
            raise HTTPException(
                status_code=409,
                detail=f"another install is in progress: {_install_state['preset_id']}",
            )
        # Build the comfy-gen batch download spec from preset.models
        batch_spec: list[dict[str, Any]] = []
        for m in preset.get("models", []):
            dest = m.get("dest", "")
            # dest is in the form "subfolder/filename" — comfy-gen wants them
            # split: --dest <subfolder>, --filename <filename>. Batch entries
            # use the same {dest, filename} shape.
            if "/" in dest:
                subfolder, filename = dest.split("/", 1)
            else:
                subfolder, filename = "checkpoints", dest
            batch_spec.append({
                "source": m.get("source", "url") if m.get("source") in ("civitai", "url") else "url",
                "url": m["url"],
                "dest": subfolder,
                "filename": filename,
            })

        # Fetch workflow JSON (inline or URL) so it's cached locally for the
        # ComfyGen block dropdown to apply later.
        workflow = _fetch_workflow_for_preset(preset)

        _install_state.update({
            "state": "queued",
            "preset_id": body.preset_id,
            "started_at": _now_iso(),
            "completed_at": None,
            "files_total": len(batch_spec),
            "error": None,
        })

    # Kick off the subprocess in a daemon thread so the HTTP response
    # returns immediately.
    def _runner() -> None:
        _install_state["state"] = "running"
        _run_install_subprocess(
            preset_id=body.preset_id,
            version=preset.get("comfygen_min_version", "0.0.0"),
            disk_size_gb=preset.get("disk_size_estimate_gb", 0),
            workflow_json_str=json.dumps(workflow),
            batch_spec=batch_spec,
            endpoint_id=ep["endpoint_id"],
        )

    threading.Thread(target=_runner, daemon=True).start()

    return JSONResponse(
        status_code=202,
        content={
            "preset_id": body.preset_id,
            "state": _install_state["state"],
            "files_total": _install_state["files_total"],
            "started_at": _install_state["started_at"],
        },
    )


@router.get("/api/presets/install/progress")
def install_progress() -> JSONResponse:
    return JSONResponse(dict(_install_state))


@router.post("/api/presets/uninstall/{preset_id}")
def uninstall(preset_id: str) -> JSONResponse:
    deleted = settings_store.remove_installed_preset(preset_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"preset '{preset_id}' is not installed")
    # Note: model files on the volume are NOT deleted by this route. The
    # ComfyGen volume keeps them so re-install is a no-op (comfy-gen download
    # checks if files exist before re-fetching). User can manually run
    # comfy-gen list / wipe the volume if they want disk space back.
    return JSONResponse({"ok": True, "preset_id": preset_id})
